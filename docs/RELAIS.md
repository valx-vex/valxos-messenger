# The relay: letters between two Macs

VALXOS Messenger keeps one office per Mac. The relay is the optional piece
that carries letters from one office to the other, over ssh. Without it,
nothing changes: each Mac keeps its own mail, as before. This page says how
the relay works, how to set it up, how to read what it reports, and where it
stops.

The two Macs in the examples are called `MacBook` and `Studio`. The relay runs
on one of them (`Studio`) and visits the other.

## The four rules

1. **One carrier per route: the relay.** It is the only thing that carries
   mail from one Mac to the other. A chair never drops a letter into another
   Mac's office itself.
2. **The relay goes through each Mac's door, never through the window.** It
   enters over ssh and writes into the office the way any carrier of that Mac
   would: from the inside, on that Mac's own disk. No office is ever opened
   across the network, and none is synchronised or placed on a shared disk. The
   right to carry mail comes from the ssh key, that is, from you.
3. **A carried letter is recognisable and does not lie.** It keeps its real
   sender, and it shows where it came from: `Via: relais · from: MacBook`
   (`relais` is the relay's proper name). The relay reports the delivery, then
   the acknowledgement, in that order: a letter is never acknowledged without
   having been received.
4. **When a Mac sleeps or the network drops, the letter waits; it is not
   lost.** It stays in the office it was written in, marked "on its way", and
   the relay tries again until the other Mac answers. If the same letter were
   deposited twice, the office recognises it by its `msg_id` and keeps one.
   Letters from one sender arrive in the order they were written.

## How a round goes

The relay is a loop (`valxos-relais tournee`). Each round, for each other Mac
listed in `relais.json`, it makes **one** `valxos-relais echanger` call over
ssh. That single call does three things on the other Mac, in this order: it
records the marks of the previous round (what was carried, what was
acknowledged, which of its letters the relay refused), it imports the packet
sent from here, and it hands back that Mac's own packet.

- The export lays an **offer** on each letter (`porte_vers`); `porte_at` is the
  **confirmation**, set only once the other Mac has imported it. Delivery
  receipts and acknowledgements travel both ways, and every event carries the
  Mac it came from.
- A step that fails marks nothing of its own, and the report of the round names
  the error code and the step (`exporter`, `echanger`, `marquer`, `importer`).
  The marks an earlier step of the same round already wrote stay, because they
  are true. On the relay's side: once the other Mac has answered and its packet
  checks out, the relay marks what it carried (`porte_at`) and the events it
  delivered, and only then imports the other Mac's packet; if that import
  fails, those marks stay (the other Mac really accepted those letters), the
  acknowledgements owed to the other Mac are dropped, and it gives its letters
  again next round, as replays with no effect. If ssh, the timeout or the
  answer's parsing fails, nothing is marked here. On the other Mac, `echanger`
  first applies the marks of the previous round (carried, delivered), then
  imports the packet it was sent, then answers; if the import fails, those
  marks stay too (the relay really reported those events), and the relay,
  seeing the failure, marks nothing of that round.
- Two rounds never run together on one office: `tournee` takes
  `run/relais.verrou` (exit code 3 if a live round holds it).
- **When the relay stops** (SIGTERM or SIGINT; `launchctl bootout` sends
  SIGTERM), it starts no new round: the round in progress finishes, then the
  relay makes **one last exchange** with each Mac it owes something. The marks
  of the last round (what it carried, the events it reported, the refusals)
  exist only in the relay's memory, so this exchange hands them back, with the
  delivery receipts and acknowledgements learned here. It offers no new letter,
  and it sends the real list of this Mac's chairs, so the other Mac's address
  book loses no entry. What the other Mac offers in its answer is not imported:
  those letters stay offered on that Mac (`porte_vers` set, `porte_at` empty),
  to be carried when the relay runs again, or served there once the relay is
  removed. Then the relay exits 0 and releases its lock. If that last exchange
  fails (the Mac sleeps), the relay logs it (`relais_dernier_echange`, with its
  `erreur`) and exits anyway: nothing is marked, and `valxos-relais etat` on
  the other Mac shows the letters still in flight (`offertes`). Stop it with
  SIGTERM, never with `kill -9`: a killed relay hands back nothing.

## Configuration: `relais.json`

Each Mac that takes part has a `relais.json` at the root of its office
(`<office>/relais.json`; the office is `~/.valxos-messenger`, or the path in
`VALXOS_MESSENGER_HOME`). Without the file, that Mac runs no relay and takes
no exchange: `etat`, `tournee` and `echanger` refuse with exit code 2. Removing
the file does not make the office forget the other Mac, though: its address
book (the chairs the other Mac showed at the last exchange) stays, and names
that live there stay "on their way". To take the relay out, follow
[Remove the relay](#remove-the-relay).

On `Studio`, the Mac that runs the relay and visits the other one:

```json
{
  "moi": "Studio",
  "macs": {
    "MacBook": {
      "ssh": "macbook",
      "node": "/opt/homebrew/bin/node",
      "depot": "/opt/valxos/cc2cc-v2",
      "bureau": "/opt/valxos/bureau"
    }
  }
}
```

On `MacBook`, which is only visited:

```json
{ "moi": "MacBook" }
```

- `moi` is this Mac's name. A Mac never lists itself under `macs`.
- `ssh` is the ssh alias (or host) of the other Mac, from `~/.ssh/config`.
- `node` is the Node binary on the other Mac, `depot` the Messenger checkout
  there, `bureau` its office. All three **must be absolute paths** (the
  `/opt/valxos/...` ones above are an example: put your own). The relay
  refuses a `~`: the shell ssh opens on the other Mac (zsh on macOS) does not
  expand a tilde that follows an `=`, so the relay would open an office in a
  directory literally named `~`.
- `intervalle_ms` (optional, default 2000) is the pause between two rounds.

## What ssh needs

- **Remote Login** switched on, on the Mac that is visited (System Settings,
  General, Sharing).
- **A key without a passphrase** for `BatchMode`: the relay runs with
  `-o BatchMode=yes`, so it never prompts, and a key that needs a passphrase
  makes every round fail with `mac-injoignable`. The key lives in the account
  that runs the relay, and its public half in `~/.ssh/authorized_keys` of the
  other Mac; without it there, every round fails with `mac-injoignable` too,
  exactly like a Mac that sleeps (`detail` says `Permission denied`). Check it
  once by hand from the Mac that runs the relay: `ssh -o BatchMode=yes
  <alias> true` must exit 0.
- **The alias** in `~/.ssh/config` of the account that runs the relay:

  ```text
  Host macbook
    HostName macbook.local
    User alice
    IdentityFile ~/.ssh/id_ed25519
  ```

  (Here `~` is fine: ssh itself reads that file.)

Every exchange opens its own ssh connection (`-o ControlMaster=no`): the relay
never shares one connection between rounds. Measured between two Macs over
Tailscale SSH, a shared connection (`ControlMaster=auto`) sometimes made ssh
exit 255 after the command on the other Mac had completed:
16 exchanges out of 270, each read as `mac-injoignable` from a Mac that was
awake, and its letters waited one more round. Without sharing: 0 out of 210.
The price is one ssh handshake per round, about 0.4 s.

## Running it

By hand, one round, to see what it does:

```bash
valxos-relais tournee --une
```

It prints `{ "rapports": [...], "derniers_echanges": [...] }`: one report per
Mac for the round (counts and `msg_id`s, never a letter body), then one per
Mac for the last exchange it made at its end to hand back what it owed (the
same as when the loop stops; a Mac it owed nothing is not visited). Each last
exchange reports `confirmees`, `rendus` and `refus_rendus` (what the other Mac
received) and `evenements_emportes`, with `erreur`, `pas` and `detail`. It
exits 1 if an exchange or a last exchange failed.

As a service, on the Mac that runs the relay only:

```bash
node scripts/install.js --relais            # dry run: shows what would be written
node scripts/install.js --relais --write    # writes the plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.valxos.messenger.relais.plist
```

- The service is **optional**. A default install, and `--launchd`, never write
  it; only `--relais` does, and `--relais` writes only with `--write`.
- The installer never loads it: the `launchctl bootstrap` line is printed, and
  you run it. `--relais` does not combine with any other mode.
- The plist runs `relais.js tournee` with `KeepAlive`, with
  `VALXOS_MESSENGER_HOME` set to the office. Its logs are
  `<office>/logs/relais.out.log` and `relais.err.log` (the relay's journal is
  JSON lines on stderr, so in the second one).
- The plist gives the relay 45 seconds to exit (`ExitTimeOut`): when launchd
  stops it, the relay finishes its round, then makes its last exchange (up to
  15 seconds each), and launchd's default of 20 seconds could cut that exchange.
- It names the Node it was written with: run `--relais --write` again after
  moving the checkout or updating Node.
- `install --uninstall` removes this plist too, but it removes **the whole
  Messenger from this Mac**: the plugin link, the CLI links, and the plists of
  the Facteur, the web door and the relay. To remove only the relay, follow
  [Remove the relay](#remove-the-relay).
- A plist at that path that the installer did not write is refused, unless you
  pass `--force` (the old file is moved aside, with a dated backup).

## Remove the relay

Each office keeps the address book of the other Mac until it is told to forget
it. While it remembers, a lineage whose designated chair was last seen on the
other Mac stays held there: a letter to its bare name waits "on its way", and
the chair on this Mac neither collects nor acknowledges it. So the relay comes
out in this order:

1. **Stop the relay with SIGTERM** on the Mac that runs it, never with
   `kill -9`, and remove its plist. `launchctl bootout` sends SIGTERM; a loop
   started by hand stops with `kill <pid>` (TERM by default) or Ctrl-C. On
   SIGTERM the relay hands back what it owes in one last exchange before it
   exits (see [How a round goes](#how-a-round-goes)); killed, it hands back
   nothing.

   ```bash
   launchctl bootout gui/$(id -u)/com.valxos.messenger.relais
   rm ~/Library/LaunchAgents/com.valxos.messenger.relais.plist
   ```

2. **Check `valxos-relais etat` on both Macs.** Nothing may be in flight: for
   every Mac, `en_route` and `offertes` must be 0, except for the letters
   listed under `refusees` (a refused letter is offered at every round and
   never accepted, so it stays counted). If something is in flight (the last
   exchange failed, or a letter was written during the stop), run
   `valxos-relais tournee --une` once on the Mac that runs the relay (it
   carries the letters, then hands back what it owes), and check again.
   `portees_non_accusees` counts the letters already carried that nobody has
   acknowledged yet: see the paragraph after these steps.

3. **Forget the other Mac, on each Mac** (on `Studio`, `valxos-relais oublier
   MacBook`; on `MacBook`, `valxos-relais oublier Studio`):

   ```bash
   valxos-relais oublier Studio
   ```

   It marks every address-book entry of that Mac as gone (`parti_at`; nothing
   is deleted) and prints `{ "mac": "Studio", "parties": 2 }`, the number of
   entries it marked. It works with or without `relais.json`, refuses this
   Mac's own name when `relais.json` gives it, and says so on stderr when the
   address book has no entry for that name (Mac names are case-sensitive).
   While a relay round holds `run/relais.verrou` it does nothing and exits 3:
   stop the relay first, or its next round writes the address book again.

4. **Remove `relais.json`** from each office.

Afterwards each office resolves names on its own again: a bare lineage name
goes to its chair on this Mac, and a letter to a chair that lived only on the
other Mac has no recipient here any more (the Facteur notes it as an unknown
recipient). Letters already carried stay in the office they arrived in. If the
other Mac is gone for good (reinstalled, sold, never coming back), step 3 on
the Mac that remains is the one that matters.

**A carried letter that nobody has acknowledged yet can be served twice.** It
lives in both offices until its acknowledgement comes back. After step 3, if
it was written to a lineage's **bare name** and each Mac has a chair of that
lineage, it is served on both: the Mac it was carried to serves its copy, and
the Mac it was written on serves the original too, because delivery follows
how each Mac resolves the name, not whether the letter was carried. This is
on purpose: if the other Mac is gone for good, the original is the only copy
left, and a duplicate is better than a lost letter.

To avoid it, let the carried letters be acknowledged **before step 1**, while
the relay still runs. `valxos-relais etat`, on the Mac a letter was written
on, counts them per Mac under `portees_non_accusees`; when the recipient on the
other Mac acknowledges one, the acknowledgement comes back at the next round,
and the count goes down. Wait for 0 on both Macs. A letter nobody will ever
acknowledge keeps its count above 0: it is the duplicate described above. A
letter to a chair's full name is not affected: after step 3, the Mac it was
written on has no such chair, and does not serve it.

## Reading `valxos-relais etat`

```bash
valxos-relais etat
```

prints one JSON line:

```json
{
  "moi": "Studio",
  "en_route": { "MacBook": 1 },
  "offertes": { "MacBook": 1 },
  "portees_non_accusees": { "MacBook": 0 },
  "refusees": {
    "nombre": 1,
    "lettres": [
      { "msg_id": "report-2026-11-20", "mac": "MacBook", "raison": "conflit", "at": "2026-11-16T20:58:00.000Z" }
    ]
  },
  "derniere_tournee": {
    "at": "2026-11-16T21:00:00.000Z",
    "mac": "MacBook",
    "apportees": 0, "emportees": 0, "conflits": 0,
    "evenements_apportes": 0, "evenements_emportes": 0,
    "refus_la_bas": [], "refus_ici": [],
    "duree_ms": 140, "erreur": null, "pas": null, "detail": null
  }
}
```

- `en_route` counts, per Mac, the letters here that wait to be carried. The
  Macs are those of `relais.json` and those of the address book, so the Mac
  that is only visited (`{ "moi": "MacBook" }`) sees its own letters waiting
  for `Studio` too. A count that stays above 0 means the other Mac has not
  answered, or has refused those letters (see below).
- `offertes` counts, per Mac they were offered to, the letters written here
  that were offered (`porte_vers`) and whose confirmation has not come back
  (`porte_at` empty), and that nobody has acknowledged: the other Mac may
  already hold them. It is 0 for every Mac once the relay has stopped cleanly,
  apart from refused letters (which are offered again at every round). A
  letter the other Mac offered in the relay's last exchange, after the last
  round, is counted there too until the relay runs again: it was not carried.
- `portees_non_accusees` counts, per Mac, the letters written here that were
  carried there (confirmed) and that nobody has acknowledged yet. They are in
  both offices until the acknowledgement comes back; read it before removing
  the relay (see [Remove the relay](#remove-the-relay)).
- `etat` only reads; it writes nothing, on either Mac.
- `refusees` lists the letters written here that the other Mac refused and
  that still wait (neither carried nor acknowledged): `nombre`, then each
  letter with the Mac that refused it, its reason, and when (the latest
  refusal of that letter). On `MacBook`, which only takes exchanges, this is
  where its sender sees a refusal.
- `derniere_tournee` is the report of ONE Mac plus `at` (the time of the
  round): the last Mac visited in the order of `relais.json`, as written in
  `<office>/status/relais.json`. With two or more Macs in `relais.json`, the
  others do not appear in `etat` or in that file (their reports go to the
  relay's journal when something moved or their error changes). Its fields:
  `mac`, `apportees` (new letters written here), `emportees` (letters from
  here confirmed carried), `conflits`, `evenements_apportes` and
  `evenements_emportes`, `refus_la_bas` and `refus_ici` (letters refused on
  either side, each `{ msg_id, raison }`), `duree_ms`, and `erreur`, `pas`,
  `detail` (all `null` when the exchange went well). `null` means no round has
  run yet.
- A **refusal** is for one letter (a `msg_id` that conflicts with another
  letter, or a sender outside the enclosure of the office that receives it). It
  is counted and visible, and that letter stays on its way at home and comes
  back at every round; the other letters go through. The refusal also comes
  back to the letter itself: the office it was written in records
  `relais_refus` (`{ mac, raison }`) on it, once per reason, and lists it under
  `refusees`. The relay records it at once for its own letters; a letter of
  the other Mac learns it at the next exchange.
- The error codes of a round:

  | `erreur` | Meaning |
  | --- | --- |
  | `mac-injoignable` | ssh could not reach the Mac (exit 255): it is asleep, off, the key needs a passphrase, or the key is not authorized on that Mac (`detail` then says `Permission denied`) |
  | `relais-distant-echanger` | the command on the other Mac failed; the end of its stderr is in `detail` |
  | `relais-absent-de-l-autre-mac` | the other Mac has no `relais.js` at that `depot` (exit 127) |
  | `relais-delai-depasse` | the exchange took too long; nothing was marked |
  | `paquet-*` | the packet is unreadable, of another version or schema, or wrongly addressed: update both Macs |

Exit codes of `valxos-relais`: 0 done; 1 any other error (its code is on
stderr) or, for `tournee --une`, a failed exchange or last exchange; 2 refused
before acting
(command line, no ssh, relay not configured, unreadable input, a Mac name
`oublier` does not take); 3 a relay round holds `run/relais.verrou`.

## Cost at rest

Every `intervalle_ms` (2 seconds by default), each round opens one ssh
connection and starts one Node process on the Mac that is visited (the
`echanger` call), even when there is no mail: an import scans the houses on
every round, empty or not, on both Macs. The relay itself is one long-lived
process. The idle CPU figure with this ssh setting (no shared connection) has
not been measured yet on a real pair of Macs; it is the open P8b measurement
of the relay's test plan, and this page will give the number when there is
one. Until then, a longer `intervalle_ms` in
`relais.json` is the lever: a letter then waits up to that long to cross.

## Known limits

- **A dead designated chair holds the lineage on both Macs.** If a lineage's
  designated chair is local, dead, not harvested, and has the largest key, the
  lineage's bare name waits, on both Macs, until a human acts.
- **A caller with no chair of a remote lineage gets an empty inbox**, with the
  reason, and no copies.
- **Aliases, human addresses and short chair names aimed at the other Mac stay
  `unknown` or local.** Address a chair of the other Mac by its full name.
- **The Python monitor and the web page do not show the `Via:` line.** The
  monitor follows the address book for its lineage, with the same rule as the
  hooks: when the other Mac's designated chair holds the lineage, the monitor
  does not deliver the bare-name letter on this Mac, and the chairs here see it
  only as a copy. On an office not yet at schema 8 (no address book), it
  resolves locally, as before the relay.
- **The Facteur notes `a-porter` attempts** for a letter that waits for the
  relay: it records them while the letter waits for the relay.
- **A letter whose sender leaves its enclosure on Mac A is refused on Mac B**
  if B has the same enclosure. It stays on its way and is offered at every
  round.
- **Around a change of designation, two windows last until the next exchange:**
  both Macs hold the lineage (each serves its own chair), or neither does (the
  letter waits, to be carried from both sides). Nothing is lost; everything
  heals at the next exchange. A designation made while the other Mac sleeps
  leaves each Mac serving its own chair until the first exchange.
- **A letter shown by the Python monitor is reported delivered to the Mac it
  was written on only when it is acknowledged.** The monitor marks the letter
  it shows as injected (`injected_at`), and that mark does not travel: the
  relay carries the delivery (`delivered_at`) and the acknowledgement, nothing
  else. Until the recipient acknowledges it, the Mac it was written on sees
  the letter carried but not delivered; the acknowledgement then brings both.
- **A bare-name letter carried and not yet acknowledged is served on both Macs
  after the relay is removed**, when each Mac has a chair of that lineage: a
  duplicate rather than a lost letter. `etat` counts these letters
  (`portees_non_accusees`); let them be acknowledged before the removal (see
  [Remove the relay](#remove-the-relay)).
