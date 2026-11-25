# Acceptance walk for 1.1.0

About twenty minutes, by hand, on a disposable office. Nothing here touches
your real office, and nothing depends on a second reviewer. Codex is optional
(step 10). Names are `alice`, `bob` and `carol`; paths such as
`/opt/valxos/...` are examples, put your own.

Each step says what you do and what you should see. If a step shows something
else, stop and note the step number and the output.

## 0. A disposable office

```bash
export CC2CC_V2_HOME="$(mktemp -d)"
export CC2CC_GARDE_BUREAU=1
HOUSES="$(mktemp -d)"
echo "$CC2CC_V2_HOME" "$HOUSES"
```

You see two fresh paths under your temporary directory. Keep this shell open:
every command below uses these variables. Nothing is installed, no service is
loaded. At the end, remove both directories by their full path.

## 1. Two sessions write to each other (3 min)

Open two Claude Code sessions with the plugin enabled, both with
`CC2CC_V2_HOME` set to the same path as above, and name them `alice` and `bob`
(`VALXOS_SELF=alice` and `VALXOS_SELF=bob` in their environments, or
`register`). A Claude Code config folder that was never used is not logged
in: if you give the sessions a fresh `CLAUDE_CONFIG_DIR`, run `/login` once in
the first one; the others that share that folder are logged in too.

1. In `alice`, ask Claude to send `bob` a letter with the `send` tool.
2. In `bob`, run a tool call, or `inbox`.

You see the letter at `bob`, with `From: alice`, and the `send` answer in
`alice` says `sent: true`. Reply from `bob` with `reply`: the letter arrives at
`alice` in the same thread.

Without Claude, the same exchange from a shell:

```bash
VALXOS_SELF=bob valxos-send --to alice --subject "Hello" --body "First letter"
VALXOS_SELF=alice valxos-inbox
```

You see the letter in the second command's JSON, `sender: "bob"`.

## 2. A letter to a bare name held by a designated chair (3 min)

Open a second session also named `alice` (two chairs of one lineage), then:

```bash
valxos-chaise chaises alice
```

You see two chairs and no designated one: a letter to `alice` waits (the
lineage is ambiguous). Designate one:

```bash
valxos-chaise designer alice <start of the first chair's session id>
VALXOS_SELF=bob valxos-send --to alice --subject "Bare name" --body "For the chair that holds it"
```

You see the letter at the designated chair only, never at the other one. A
helper (a subagent) started inside the designated chair is never handed it by
the hooks. If the helper calls `inbox` itself, it reads the chair's box and
marks the letter delivered (the MCP server cannot tell a helper from its
chair). Unless the helper also calls `ack`, the letter stays unacknowledged:
`inbox` in the chair still lists it, and ten minutes later the chair's next
tool call shows it again with `Reminder: 1`. Free the chair with
`valxos-chaise liberer alice`: the lineage is ambiguous again.

## 3. A letter to a name nobody ever carried (3 min)

A name counts as carried when the registry still has an entry for it, or when
it was renamed, was the sender of a letter, or was the chair of a delivery. Once
a house's registry entry is gone, nothing records that it ever registered: it
counts as having carried its name only if it sent a letter or received a
delivery. Letters to such a house wait for its next wake and are never returned.
A name with none of these traces is returned.

```bash
VALXOS_SELF=bob valxos-send --to alcie --subject "Typo" --body "Anybody there?"
```

You see `sent: true` and an `attente` block with
`motif: "destinataire-inconnu"`, `suggestions` (with `alice` among them while
`alice` is alive) and a message that starts `No one has this name; did you
mean alice?` (the sentence has no suggestion when no live name is close). The
letter is accepted and waits.

Now shorten the return delay and let the Facteur make one round on the
disposable office:

```bash
export VALXOS_RETOUR_APRES_S=1
sleep 2
facteur --une-tournee --maisons "$HOUSES"
VALXOS_SELF=bob valxos-inbox
```

You see a round that counts `retour-a-l-expediteur: 1`, then, in `bob`'s inbox,
one letter from `facteur`, subject `Returned to sender: Typo`, priority `low`,
which names the address written, the reason and the suggestions. It does not
wake anybody. The original stays where it was: if a peer registers as `alcie`
it still arrives.

## 4. Acknowledging with the Receipt id (3 min)

Since step 2 freed the chair, `alice` has two chairs and none is designated: a
letter to the bare name `alice` would be held (`lignee-ambigue`). Address one
chair directly. Copy the whole session id of one of the two chairs:

```bash
valxos-chaise chaises alice
```

Then send to that chair (`alice#` followed by the session id you copied) and
make one round:

```bash
VALXOS_SELF=bob valxos-send --to "alice#<session id>" --subject "Receipt" --body "Acknowledge me"
facteur --une-tournee
```

You see `sent: true` with `"to": "alice#<session id>"`, then a round that
prints `"remises":1`. The round scans `~/.claude` (and `$CLAUDE_CONFIG_DIR`
when set): if your sessions run under another configuration directory, add
`--maisons <that directory>`. In that chair's session the letter arrives with
a header `Letter <msg_id> · from bob · subject: Receipt` and, under it, a line
`Receipt: <uuid>`.

1. In `bob`, call `ack` with that uuid. You see `acked: false` and
   `refus: "accuse-refuse-lettre"`: only the recipient signs, and the letter
   stays unacknowledged.
2. In the chair that got the letter, call `ack` with that uuid. You see
   `acked: true`, and the returned `message` has `acked_at` set.
3. In the same chair, call `ack` with the letter's `msg_id`. You see
   `acked: true` again, with the same `acked_at`.
4. Call `ack` with an id that does not exist, say `no-such-id`. The answer is:

```text
Message not found: no-such-id (acknowledge with the msg_id shown as `id=` in the delivery)
```

## 5. A house under a street, where the Facteur rings (3 min)

This step uses a new name, `carol`, so that no other chair shares it. Make a
street with one house in it and declare the street:

```bash
mkdir -p "$HOUSES/street/carol-house"
export VALXOS_MAISONS="$HOUSES/street/*"
```

From this shell (so that the session inherits `VALXOS_MAISONS` and
`CC2CC_V2_HOME`), start a Claude Code session named `carol`
(`VALXOS_SELF=carol`) whose `CLAUDE_CONFIG_DIR` is
`$HOUSES/street/carol-house`, with the plugin enabled. Then, from `bob`, send
it a letter and make a round:

```bash
VALXOS_SELF=bob valxos-send --to carol --subject "Street" --body "Is the street read?"
facteur --une-tournee
```

You see `sent: true` with no `maison-inconnue` advice, then a round that
prints `"remises":1`: the letter is taken to the chair of `carol` in that
house. Each round reads the street again, so a house created under it later
needs no re-install.

Re-installing the services: users who had written `VALXOS_MAISONS` or
`CLAUDE_CONFIG_DIR` into the launchd plists by hand should run the installer
again with their declaration, so the plists pin it:

```bash
VALXOS_MAISONS="$HOME/.claude:$HOME/agents/*" valxos-messenger install --launchd --dry-run
```

You see both plists (Facteur and web door) carrying `VALXOS_MAISONS` as
declared. Drop `--dry-run` only on your real machine, when you mean it.

## 6. Between two Macs: one round trip over the relay (5 min)

You need two Macs (or one Mac with ssh to itself, with two offices), Remote
Login on the visited one, and a key without a passphrase. The rules are in
[`RELAIS.md`](RELAIS.md); here is the shortest check, with two disposable
offices.

On the Mac that runs the relay, `$CC2CC_V2_HOME/relais.json`:

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

On the visited Mac, `/opt/valxos/bureau/relais.json` is `{ "moi": "MacBook" }`
(all four paths absolute). Check ssh once: `ssh -o BatchMode=yes macbook true`
must exit 0.

1. On Studio, a session `alice`; on MacBook, a session `dave`, started with
   `CC2CC_V2_HOME=/opt/valxos/bureau`. The relay carries a letter only to a
   session chair that Studio's address book lists, and the book is filled at
   each exchange. A name only used from the command line is never in it, and
   a local name of the same spelling is served first, so the letter stays on
   its Mac: use a name this office has never seen (not `bob`, step 1).
2. On Studio: `VALXOS_SELF=alice valxos-send --to dave --subject "Over the relay" --body "Ping"`
   (it waits: `dave` is not known here yet).
3. On Studio: `valxos-relais tournee --une`, twice: the first exchange fills
   the address book, the second carries the letter.

You see a report for `MacBook` with one letter carried (counts and `msg_id`s,
never a body), and no error. On MacBook, `dave` receives the letter with
`Via: relais · from: Studio` and its real sender `alice`. Reply from `dave`,
run `valxos-relais tournee --une` again on Studio: the reply arrives at
`alice` with `Via: relais · from: MacBook`. `valxos-relais etat` shows the last
exchange without an `erreur`.

## 7. A long letter is announced, then read in full (3 min)

Needs the `alice` and `bob` sessions of step 1, both live. Send `bob` a
letter of exactly 12,000 characters:

```bash
VALXOS_SELF=alice valxos-send --to bob --subject "Long" \
  --body "$(yes 'lorem ipsum dolor ' | head -c 12000)"
```

You see `sent: true`. In `bob`, run any tool call. The hook does not paste the
body (it is over the 9,000 character budget of one hook result). It announces
the letter: under the usual header you see `Size: 12000 characters`, the first
lines of the body, then `This letter is long (12000 characters); it is not
marked delivered. Read it in full with the \`inbox\` tool.`, and a last line
saying one letter waits and that `inbox` reads it now. The announcement is not
a delivery. Check:

```bash
sqlite3 "$CC2CC_V2_HOME/broker.db" \
  "SELECT msg_id, length(body), delivered_at FROM messages WHERE subject = 'Long'"
```

You see the `msg_id`, `12000` and an empty `delivered_at`. Now in `bob`, call
`inbox` with that `msg_id`. You see one message whose `body` is the whole
letter, with `body_offset: 0`, `body_chars: 12000` and `next_offset: null`
(it fit in one result). Run the `sqlite3` command again: `delivered_at` is now
set. A letter too long for one result (about 16,000 bytes) comes in parts:
`next_offset` is a number, and you call `inbox` again with that `msg_id` and
`offset` set to it, until `next_offset` is `null`; only then is it marked
delivered.

## 8. Clean up (1 min)

```bash
rm -rf /full/path/printed/at/step/0   # the office
rm -rf /full/path/printed/at/step/0b  # the houses
```

Use the two paths printed at step 0, written in full. Nothing else was
created: no service, no plist.

## 9. What counts as a pass

Steps 1 to 7 show what they say. A step that could not run (no second Mac,
no ssh) is not a pass: write it down as "not run".

## 10. Optional: Codex

If you use Codex, `valxos-messenger install --codex --self alice` prints the
wiring (it changes nothing without `--write`), and steps 1 to 4 can be repeated
with a Codex chair. Skipping this step does not affect the verdict.
