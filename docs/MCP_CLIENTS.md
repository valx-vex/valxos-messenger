# Wiring the MCP server into other harnesses

VALXOS Messenger ships one MCP server. Claude Code gets it through the
plugin; every other harness that speaks MCP over stdio — Codex CLI, Gemini
CLI, Antigravity CLI (agy), OpenCode, Hermes, anything else — starts the same
process and gets the same thirteen tools (nine in 1.0.0; 1.1.0 adds `reply`,
`tables`, `table_manage` and `envoi_status`). Codex also gets hooks and a
doorbell since 1.1.0 (Codex section). This page is the wiring guide: what the
server is, how a peer says who it is, where the mail lives, which codes the
answers carry, then one section per client, each ending with a smoke test.

Every client section carries exactly one of two statuses, and nothing in
between:

- **Verified on macOS on `<date>` with `<client>` `<version>`** — the shape
  shown was exercised on that date, with that version of the client, against
  a scratch office: a letter went through it. The section says precisely what
  was exercised, under which conditions, and lists what was not
  ("Not tested:").
- **Written from upstream documentation, not verified on a live client** —
  the shape follows the client's own documentation or source code. Nobody
  has watched a letter go through it on a live client for this release.

Conventions: repository paths are relative to the checkout root;
`<path-to-valxos_messenger>` stands for wherever your checkout lives — after
`npm i -g valxos-messenger`, the `valxos-messenger` folder under
`npm root -g`; `your-agent-name` stands for the name you choose for the peer;
`smoke-b` is a second name the smoke tests write to. Nothing on this page is
specific to one machine.

The test `test/docs-mcp-clients.test.js` keeps this page honest: every
repository path, every binary, every environment variable, the tool table and
the code tables below are checked against the code on each `npm test` (in the
repository; the test suite does not ship in the npm package).

## What the server is

- One process, `src/mcp-server/server.js`, started with `node`, speaking
  MCP over **stdio** — no port, no URL. The client starts it, talks to it on
  its stdin/stdout, and owns its lifetime.
- It announces itself to the client as `valxos_messenger`, with a short
  instructions string that clients may show to their model.
- Requirements: Node.js — `package.json` declares `engines.node >=20`; the
  CI reads its Node version from that same field — and the dependencies, installed once with `npm install`
  in the checkout. `better-sqlite3` is a
  native module: it fetches a prebuilt binary or compiles at install time.
- It reads and writes one SQLite office (see below) and talks to nothing
  outside the machine.

### The tools

| Tool | What it does |
|---|---|
| `whoami` | Returns this peer's derived identity, the peers it can see and the office path. Registers this peer's card as a side effect. |
| `register` | Registers a named peer card (`id`, optional `project_path`, `description`) without session identity. Chairs (`name#session`) come from harness session announcements, not from this tool. |
| `list_peers` | Lists the peers in service; `include_dead: true` also shows the ones marked offline or dead. A Codex chair (1.1.0) shows `harnais: "codex"` and its door, `porte`. |
| `unregister` | Marks a peer offline; the row is never deleted. A chair with a session (`name#session`) is retired only by itself (its own session file derives it) or once its process is dead; otherwise `refus: "desinscription-refusee"`. |
| `send` | Sends a durable letter to one peer: `to`, `body`, optional `from` (checked like a declared `self`; refused as `expediteur-refuse` otherwise — see Identity), `subject`, `thread_id`, `priority` (`low`/`normal`/`high`/`critical`), `msg_type` (`message`/`task`/`response`/`status`), `msg_id` (idempotency key — resending the same key never creates a second letter) and `sender_model`. `to: "table:<name>"` posts one letter to every member of that table (one `msg_id` and one acknowledgement each, linked by `envoi_id`); `reveiller` names members to wake whatever the table's rule (except at `low` priority; 50 names of 200 characters at most, and a chair it names wakes its member only when the office knows that chair), `hors_enclos: true` steps out of an enclosure for that send. A table send answers `table` (the table itself), `envoi_id`, `count` and `results`, one per member with its `to`, `msg_id`, `wake`, `sans_reveil` and `motif_reveil`. |
| `broadcast` | Sends one letter to every lineage that has a registered peer. No peers means no letters. `from` is checked as for `send`. |
| `inbox` | Reads unread letters for this peer and marks them delivered by default (`mark_delivered: false` to peek; `limit` 1–100; `include_injected`). One result stays under 16,000 bytes, so the client shows it whole (measured on Claude Code 2.1.330 with default settings; a client configured with a lower MCP output limit can still move a result to a file, so re-run the `inbox` probe on each Claude Code release): when the mail does not fit, the oldest letters that fit are shown and marked, a `waiting` key and a closing line say how many wait, and `after` (the last `seq` shown) reads the rest; a letter too long for one result is read part by part with `msg_id` and `offset` (`body_offset`, `body_chars`, `next_offset`), and is marked delivered once every part has been shown; a letter whose header alone does not fit is refused (`entete-trop-grande`, below) with its `seq` and `after`, so the letters behind it are still reached. The `valxos-inbox` command has no such budget and marks every letter it prints delivered: it is for a human at a terminal, and an agent that runs it through a shell tool passes `--mark-delivered false`. Each letter line carries `table` (the table's name, or null), `envoi_id`, `reponse_a`, `position` (hidden from non-members of a closed table) and `rappel` (how many times it was served again). |
| `history` | Shows correspondence with a `peer` or a `thread_id`, bounded to what involves you (`limit` 1–200); a chair reads what is addressed to it or to its lineage and what it posted under either. Its letter lines carry the same table fields as `inbox`. A letter of a closed table (or a direct reply to one) is left out for a reader who is neither its recipient, nor the chair that posted it, nor a member of the table; the reader is this session's identity from the environment, never the declared `self` (a declared chair other than this session's own is refused, `identite-refusee`). |
| `ack` | Acknowledges a letter (`msg_id`) as handled — the only terminal gesture. Only the recipient or the chair the lineage's mail is routed to may sign it: a chair cannot ack a lineage letter that is only its cc copy, and a bare name (a client without a session file) never acks mail that leads to a live session chair. |
| `reply` | Answers a letter (`msg_id`, `body`, optional `subject`, `priority`, `sender_model`) to its author — its chair when known — in the letter's thread, as `msg_type: "response"` with `reponse_a`. For a table letter, `toute_la_table: true` answers the whole table (one letter per member, linked by `envoi_id`); in a `direct` table that is the default, a quiet reaction nobody is woken for, and `toute_la_table: false` brings it back to the author. `reveiller` names members to wake anyway; `hors_enclos` steps out of an enclosure. A direct reply to a letter that carries `sans_copie` (a closed table's letter, or a reply to one) carries it too: no other chair of the author's lineage gets it as a cc copy. Only the letter's recipient or sender may reply; when the letter carries the chair that posted it (`sender_chaise`), the sender is that chair, not its bare lineage. |
| `tables` | Lists the tables you are a member of (`membre: true`: you post to them with `send` to `table:<name>`) plus the open tables you are not a member of (`membre: false`: to discover them; join one with `table_manage add`, then post). A closed table is listed only to its members. Each table carries its members, wake rule, mode, shared position and `mon_reveil` (the rule that applies to you). |
| `table_manage` | Creates an open table (`action: "create"`; the caller joins it). On an open table, `add` without `adresse` (or with one of your own names) joins it and `remove` without `adresse` leaves it (`retire` says whether anything was removed); adding or removing another member, or setting another member's wake rule, needs you to be a member. Sets your own wake rule on any table you belong to (`reveil` without `adresse`), switches a table you belong to between `normal` and `direct` (`mode`), or updates its shared `position` (120 characters). Closed tables and enclosures are a human gesture at the command line. |
| `envoi_status` | For an `envoi_id` returned by a table send, shows each letter's recipient, the chair it resolves to, its states (`cree`; `sonne`, a direct wake or the Facteur's carry — for a Codex chair, the instant of the ring, shared by the letters of one envelope; `montre`, the first delivery or injection, not the last; `accuse`), its waiting notice, and `tournee`, the Facteur's last attempt for it, `{ state, reason, at }` (for instance `reason: "sonnette-codex-impossible"` when a Codex chair could not be rung), null before any attempt. Served to the sender only (the chair that posted, when the letters carry one); there is no "read" state. |

`inbox`, `history` and `ack` also accept a `self` argument. It is legacy:
identity comes from the environment (next section), and a declared `self`
is checked against that derived identity and refused outside its own
family — never silently honoured.

## Identity: who is speaking

For reading and acknowledging — `inbox`, `history`, `ack` — the server
never takes a name given in a tool call at its word: a declared `self` is
checked for consistency with the identity it **derives** from its own
process environment, in this order (`deriveSelf` in `src/lib/config.js`):

1. `VALXOS_SELF` — the name you choose for this peer. Expected shape:
   `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` — enforced by `register` (and by the
   web door for its operator name), not by the derivation: the value is
   used as is. A part of it longer than 64 characters (the lineage, or what
   follows its first `#` or `@`), or an empty lineage (`#name`), is refused:
   the server and the CLI do not start and say why on stderr
   (`identite-invalide`); the name is never cut or rewritten.
2. `VALXOS_SESSION_NAME` — used when `VALXOS_SELF` is unset.
3. Otherwise the first label of the machine's hostname, normalised. Every
   client on the machine that sets nothing shares that one name. Set
   `VALXOS_SELF`.

A plain client's `VALXOS_SELF` must never be a lineage name that Claude Code
sessions also use. A client without a session file (Codex CLI, Gemini CLI, agy, OpenCode, Hermes…)
speaks under a bare name, and a bare name never takes as owner, acknowledges or
looks up the history of mail that leads to a live session chair — so under a lineage
that has live Claude sessions its inbox stays empty (with a `raison`), by
design. Give each plain client a name of its own.

`from` on `send` and `broadcast` is checked like a declared `self`: a name
other than the derived one is accepted only when it belongs to this peer (its
lineage, an old name, a human address that leads to it — never another
session's chair); otherwise the send is refused (`refus: "expediteur-refuse"`)
and nothing is posted. An accepted name goes out as the derived name, except a
chair's own lineage name, which is kept as written. Without `from` the derived
name is used and this peer's card is registered.

These checks are not authentication: both names belong to whoever runs the
session (SECURITY.md, "Threat model").

`CC2CC_SELF` and `CC2CC_SESSION_NAME` are the historical, still-honoured aliases of the two variables above (compatibility only).
When a `VALXOS_*` variable is present, its alias is ignored — even if the `VALXOS_*` value is empty (compatibility rule: the new family always wins). One exception: an empty `VALXOS_MESSENGER_HOME` counts as unset (see the office section).

The identity must reach the **server process**. MCP clients start the
server themselves, and several of them filter the environment they pass to
subprocesses — Hermes, for one, passes only a short allow-list. Declare the
variables in the client's `env` block (each section shows where) rather
than relying on your shell.

`whoami` shows which name was derived. When a refusal mentions the derived
name, it also says where that name came from (which variable, or the
hostname fallback), so a wrong name is traced to the right configuration
file, not guessed.

What a plain MCP client is, seen from the office: the first tool call
(`whoami`, or `send`/`broadcast` without `from`) registers a **peer card**
under the derived name — a lineage without a live session. Chairs
(`name#session`) exist only for harnesses whose hooks announce sessions
(Claude Code). A Codex session with the 1.1.0 hooks is in between: its
`SessionStart` hook records the thread as the session of its bare card, so the
Facteur can ring it, and it still speaks and acknowledges under its bare name
(see "Codex: hooks and the doorbell"). Consequences for every other harness —
Codex without those hooks, Gemini CLI, agy, OpenCode, Hermes:

- Letters to you are addressed to your bare name.
- Nothing wakes you. `send` to such a peer reports `wake.ok: false` and
  `attente.motif: "chaise-sans-session"` (or `"destinataire-inconnu"` before
  the peer's first call registers its card; see Answer codes) — the letter is
  safely in the office, but the Facteur has no live session to knock on. The
  client must call `inbox` itself: at the start of a turn, or on a schedule.

## The office: where the mail lives

- `VALXOS_MESSENGER_HOME` — the runtime directory. Default:
  `~/.valxos-messenger`. Layout: `broker.db` (SQLite: letters, peers,
  events), `run/` (Unix sockets, stop guards), `status/` (heartbeats),
  `logs/`, `exports/`. Created with mode `0700` on first use.
- Legacy fallback: if only the former `~/.cc2cc-v2` directory exists, it keeps being used and the server says so once on stderr; `valxos-migrate-home` copies it explicitly (README, "Runtime directory and migration").
- `CC2CC_V2_HOME` is the compatibility alias of `VALXOS_MESSENGER_HOME` and loses when both are set (an empty `VALXOS_MESSENGER_HOME` counts as unset).
- One office per machine is the normal setup: every harness that should
  exchange mail must resolve the **same** directory. The default uses
  `HOME` and falls back to the account home when `HOME` is unset, empty or relative; when a
  client filters the environment, set `VALXOS_MESSENGER_HOME` explicitly in
  its `env` block.
- Use an absolute path in a client's `env` block: no shell expands it there.
  A leading `~/` is expanded against `HOME`, and a relative value is refused
  (one line on stderr, exit 2) instead of creating an office under the
  client's working directory.
- To try a client without touching the real office, point it at a scratch
  one: `VALXOS_MESSENGER_HOME=$(mktemp -d)`. The smoke tests below run
  against whatever office the client's `env` resolves, and they leave a
  `smoke-b` card in it.
- `VALXOS_GARDE_BUREAU=1` (historical alias `CC2CC_GARDE_BUREAU`; either one arms the guard, and since 1.1.0 an empty one never disarms the other) makes every
  process refuse to open the default office (`~/.valxos-messenger`, or the
  legacy `~/.cc2cc-v2`) for writing: a scratch run that forgot
  `VALXOS_MESSENGER_HOME` fails instead of writing into the real office. The
  refusal names the key that armed it. The 2026-10-18 verifications ran every
  client under it.

## Answer codes

`refus` and `attente.motif` carry stable codes: they are the contract between
the server and a client, and they stay exactly as written below. The prose
fields next to them — `message`, `raison`, and the `motif` sentence that comes
with a `refus` — are for humans, and their wording may change. A client that
branches on an answer branches on the code.

### `attente.motif` on `send` and `broadcast`

A letter that the Facteur cannot carry yet is still posted (`sent: true`):
`attente` says why it waits. It never blocks the send.

| Code | Meaning |
|---|---|
| `lignee-ambigue` | Several chairs of the lineage are in service and none is designated (`candidats` counts them). The letter is held until a human designates one (`valxos-chaise designer`) or harvests the dead ones (`valxos-chaise moissonner`). |
| `chaise-ambigue` | A short chair id (`lineage#<8+ hex>`) matches several chairs in service (`candidats` counts them). The letter waits under the address as written; once a single chair in service matches it, that chair's hooks and its MCP `inbox` collect it. To reach the chair now, send it again with more characters of the session id (`list_peers` or `valxos-peers` show the whole id). |
| `chaise-sans-session` | The recipient is a peer card without a live session (every harness but Claude Code, and Codex without its hooks or before its first turn). The Facteur has nobody to knock on; the recipient collects with `inbox`. |
| `destinataire-inconnu` | No peer of that name is registered yet. Observed on 2026-10-18 with Codex CLI, Gemini CLI, agy and OpenCode on a first letter to a peer that had never called the server. The letter waits until a peer of that name registers, or until a forwarding order is set (`valxos-chaise reexpedier`). When no one has ever carried the name (no card, dead or alive, no forwarding, nothing in the relay's address book), `attente.suggestions` lists up to five lineages in service that come close (those starting with `<name>-`, then those within two typos), and if the letter is still waiting after `VALXOS_RETOUR_APRES_S` (900 s by default; `0` turns returns off), the Facteur sends the sender a calm `status` letter from `facteur` with the subject, the reason and the suggestions. The original stays in the office, unacknowledged and marked returned: it still arrives if someone takes the name. |
| `a-porter` | The recipient (a chair, or the lineage) lives on the other Mac, as the relay's address book last saw it; `mac` names that Mac. The letter is accepted and waits here until the relay carries it there; the Facteur does not deliver it on this Mac. |
| `maison-non-renseignee` | A live session whose house is not recorded in the registry: the Facteur does not know where to ring. |
| `maison-inconnue` | A live session in a house that the Facteur's round does not scan. By default the round scans `~/.claude` and, when set, `$CLAUDE_CONFIG_DIR`; a `VALXOS_MAISONS` declaration (absolute paths written out in full; neither `~` nor `$HOME` is expanded; an entry ending in `/*` stands for every directory directly under that path, read again at each round) replaces that default list, `$CLAUDE_CONFIG_DIR` included (README, "Addressing and route"). Under launchd the list is the `VALXOS_MAISONS` pinned in the plists (`docs/INSTALL_ONE_CLICK.md`). |
| `boite-endormie` | A session in a known house, but no mailbox answers there now: the session process is gone or asleep. |

### `refus`: refused calls

A refusal never raises: the tool answers with `refus` and changes nothing.
One exception, a breakdown rather than a refusal: a table send (or a reply
to a whole table) that breaks after some letters were written answers
`interrompu: true` with `lettres_ecrites` (the letters already posted),
`envoi_id`, `table` and `adresse` (the member where it stopped). Its `refus`
is the refusal's own code when one of the refusals below stopped it, and
`envoi-interrompu` otherwise, with the stopping error's raw code in `cause`.
`refus` only ever carries a code of this table.

| Code | Tools | Meaning |
|---|---|---|
| `expediteur-refuse` | `send`, `broadcast` | `from` names somebody other than this peer; nothing is posted. |
| `chaise-refusee` | `whoami`, `inbox`, `history`, `ack`, `reply`, `tables`, `table_manage`, `envoi_status` | This process is not the chair of its own session (a duplicate, or another session's card): `whoami` answers without identity, `inbox` is empty, `ack`, `history`, `reply` and the table tools are refused. `send` and `broadcast` do not refuse: they post under the bare lineage, marked `sans_chaise: true`. |
| `releve-refusee` | `inbox` | The declared `self` is not this peer; the mailbox is not opened. |
| `entete-trop-grande` | `inbox` | The letter at the head of the mail (or the one `msg_id` names) has a header — its `msg_id`, sender or subject — larger than one result can carry, so no part of it can be shown. Nothing is marked and the letter stays waiting; the answer gives its `seq` (its `msg_id` may be the oversized field), and without `msg_id` also `waiting` and the closing line, whose `after` reaches the letters behind it. |
| `identite-refusee` | `history` | The declared `self` is neither this session's own identity (its chair, or its lineage) nor a name of its family: another chair of the lineage, live or out of service, or a name the family check refuses. It is checked first, and nothing is returned. History always reads as the identity from the environment, its chair when it has one. |
| `accuse-refuse` | `ack` | The declared `self` is not this peer; the letter stays unacknowledged and comes back. |
| `accuse-refuse-lettre` | `ack` | The signer is legitimate for its session but may not sign this letter (a cc copy, or mail routed to the designated chair); the letter stays unacknowledged. The answer also carries `refuse: true`, kept for compatibility. |
| `desinscription-refusee` | `unregister` | A chair with a session is retired only by itself, or once its process is dead. |
| `hors-enclos` | `send`, `broadcast`, `reply` | The sender is enclosed (an enclosure is set at the command line, never by a session): a recipient outside its closed table is refused before any letter is written (the caller's peer card may already be recorded by then); `enclos` names the table, `destinataires_refuses` lists the refused recipients (20 at most, `autres` counts the rest). `hors_enclos: true` steps out for that call. |
| `enclos-conflit` | `send`, `broadcast`, `reply` | Two active enclosures hold the sender under two of its forms (its lineage, a chair, a short chair, a human address) in different closed tables, an office state set before the second one was refused: every letter is refused before any is written until the operator lifts one of them (`valxos-table enclos --retirer`); `tables` names the tables, `enclos_poses` the enclosed forms. `hors_enclos: true` steps out for that call. |
| `table-inconnue` | `send`, `reply`, `table_manage` | No table of that name. |
| `pas-membre` | `send`, `reply`, `table_manage` | The caller (or, for `table_manage reveil` with `adresse`, that address) is not a member of the table under any of its names. On an open table, anyone may join or leave it, but adding or removing another member, or setting another member's wake rule, needs the caller to be a member. |
| `nom-de-table-invalide` | `send`, `table_manage` | A table name is 1 to 32 lowercase letters, digits or hyphens, starting with a letter or a digit. |
| `table-existe` | `table_manage` | `create` on a name already taken: tables are never deleted. |
| `reveil-invalide` | `table_manage` | `reveil` is `reveil` or `prochain-tour`. |
| `parametre-manquant` | `table_manage` | The action needs a parameter that is missing: `reveil` for `reveil`, `mode` for `mode`, `position` for `position`, or an `adresse` given blank for `add`, `remove` or `reveil` (omit `adresse` to act for yourself); `parametre` names it, and nothing is changed. |
| `parametre-invalide` | `send`, `reply` | `reveiller` names more than 50 members, or one longer than 200 characters: the whole send is refused before any letter is written; `parametre` names it. |
| `adresse-invalide` | `send`, `table_manage` | `add` with an address that cannot be a member: one word without spaces (a lineage, a chair, a human address or a card), never `table:<name>`; or a `send` whose `to` is blank: a letter always has a recipient, and nothing is written. |
| `table-fermee` | `table_manage` | `add` or `remove` on a closed table, `create` with `fermee: true`, or `enclos`: the members of a closed table and enclosures move only by a human gesture at the command line. |
| `lettre-inconnue` | `reply` | No letter carries this `msg_id`. |
| `pas-destinataire` | `reply` | The caller is neither the recipient (under any of its names) nor the sender of the letter (the chair that posted it when the letter carries one, otherwise the posted name) — or holds only a cc copy of it (a lineage letter that belongs to another, designated chair, or that is held until one is designated): a copy is not answered as its recipient. |
| `toute-la-table-sans-table` | `reply` | `toute_la_table: true` on a letter that was not sent to a table. |
| `pas-expediteur` | `envoi_status` | Only the sender of a table send reads its status. |
| `envoi-inconnu` | `envoi_status` | No letter carries this `envoi_id`. |
| `envoi-interrompu` | `send`, `reply` | A table send broke after some letters were written, on an error that is none of these refusals; `cause` carries that error's own code when it has one (a database code, for instance), and `lettres_ecrites` lists what left (see above). |

## Claude Code

**Status: Verified on macOS on 2026-10-18 with Claude Code 2.1.302.**
Exercised on that date against a scratch office, with the plugin loaded from
the repository (`claude --plugin-dir <path-to-valxos_messenger>`) and the
identity in `VALXOS_SELF`, in headless `claude -p` sessions and in two
interactive sessions:

- The plugin's MCP server connects on 2.1.302, whose default is the
  2026-07-28 negotiation (`claude mcp list`: `✔ Connected`; the negotiation
  itself was not observed). This server
  speaks the 2025-11-25 generation (SDK 1.32); Claude Code's changelog says it
  connects such a server the older way after one slow first connect and
  remembers that for 7 days. If a connection fails after a Claude Code update,
  set `MCP_PROTOCOL_NEGOTIATION=legacy` in the environment that starts Claude
  Code.
- With tool search on (the default), `inbox`, `send` and `ack` are loaded up
  front — they carry `_meta['anthropic/alwaysLoad']` — and `whoami`,
  `history`, `register`, `list_peers`, `unregister` and `broadcast` stay
  deferred until the model loads them through ToolSearch. The previous plugin
  without `_meta` had all nine deferred. A client that disallows ToolSearch
  loads every tool up front. (This was the 1.0.0 server; 1.1.0 also marks
  `reply` always-load and leaves `tables`, `table_manage` and `envoi_status`
  deferred, which the test suite reads on the running server; not
  re-observed in a live session.)
- The round trip: a letter posted by the CLI was injected at session start;
  the session called `inbox`, `ack`, `send` and `history`; the CLI read the
  reply.
- The three hooks: `SessionStart` injected a waiting letter; `PostToolUse`
  injected a letter posted during the session; `Stop` held the stop once for
  an unread letter of high priority, and let the session end once the letter
  was acknowledged. Each hook ran well inside its declared timeout (the
  slowest call took 435 ms of a 10 s budget).
- The monitor is armed in an interactive session (it listens on
  `run/<name>.sock` in the office) and presented a letter 13 ms after it was
  posted. In a second interactive session it stayed armed for the whole
  40-minute session, past the 30-minute deadline Claude Code gives Monitor
  watches (2.1.271 and later), and presented a letter posted at minute 33
  within 20 ms. That letter came as a cc copy, because a chair left by an
  earlier headless run was still in service (see the next point). Under
  `claude -p` the monitor is not armed: a `send` to that session reports
  `wake.ok: false`, `ENOENT`, and the hooks deliver instead.
- Every `claude -p` session left its chair in service after it exited.
  Nothing marks such a chair dead on its own: as soon as a lineage has more
  than one chair in service and none is designated, a letter to the bare
  lineage is held (`attente.motif: "lignee-ambigue"`). Between headless runs
  under one name, harvest (`valxos-chaise moissonner`, or
  `valxos-doctor --reap`), designate a chair (`valxos-chaise designer`), or
  address a chair directly (`name#session`).
- The Facteur's push into a live Claude Code 2.1.302 session was observed the
  same day in the authors' house: eight letters delivered to the session
  socket by the previous release's courier. Its connection logic is unchanged
  in 1.0.0, and the 1.0.0 courier was verified against a stand-in socket (the
  test suite, and a scratch-office bench the same day).

Not tested: the plugin as linked by `valxos-messenger install`, which was not
loaded in a Claude Code session; the plugin monitor beyond 40
minutes; a session closed with `/exit` rather than by a signal; the second and
third `Stop` holds; the `Stop` hold
replayed on the final commit (it ran on a tree whose `Stop` hook differed only
in comments); the `claude mcp add` form below.

Claude Code needs no hand-written server entry: the repository **is** a
plugin.

- `.claude-plugin/plugin.json` declares the MCP server (`mcp.json`), the
  hooks (`hooks/hooks.json`), the skills (`skills/messaging/SKILL.md`,
  `skills/chaise/SKILL.md`) and the monitor (`monitors/monitors.json`).
- `mcp.json` starts `node ${CLAUDE_PLUGIN_ROOT}/src/mcp-server/server.js` — the same process as everywhere else — under the server key `valxos-messenger`, the same id as the plugin (formerly `cc2cc-v2`).
- The hooks are what the other harnesses do not get (Codex has its own since
  1.1.0, Codex section): `SessionStart`
  (`src/hooks/startup_sync.js`) injects the backlog, `PostToolUse`
  (`src/hooks/piggyback_fetch.js`) piggybacks pending letters into the
  turn, `Stop` (`src/hooks/safety_net_poll.js`) holds the stop (up to three
  times) while unread mail above low priority waits. Claude Code moves any
  hook output above about 10,000 characters into a file and shows the model a
  2,000-character preview, so `SessionStart` and `PostToolUse` inject 9,000
  characters at most, cc copies included, in the usual order, and mark a
  letter delivered only when its whole body is in that output. A letter that
  does not fit waits, unmarked, for the next hook (a smaller one after it still
  goes), and the output then ends with a line saying how many letters wait and
  that `inbox` reads them now. A letter too long to ever fit is announced
  instead (its header, its size, its first 1,500 characters or so, and "This
  letter is long (N characters); it is not marked delivered. Read it in full
  with the `inbox` tool."), at most three times (`announced` in the delivery
  log, never a delivery); after that it is only counted in that line, when
  the hook has other mail to show. Measured on 2026-11-21 with Claude Code
  2.1.330: a 12,000-character `PostToolUse` context (a probe's stand-in
  output) was moved to a file, an 8,520-character one arrived whole, and an
  `inbox` result carrying a 16,000-character letter (17,119 characters)
  arrived whole, while `inbox` results of 68,344 and 180,272 characters were
  moved to a file and the model read none of them; `inbox` now keeps each
  result under 16,000 bytes (see `inbox` above). Codex's own hooks cut a
  letter that does not fit their budget; a cut letter is announced the same
  way (`announced`, at most three times), never marked delivered. The monitor wakes on the peer's Unix socket, in interactive
  sessions. The hooks also announce the
  live session as a chair, so a letter can be addressed to one session
  (`name#session`).
- Identity: the server process inherits the environment Claude Code was
  started with. Export `VALXOS_SELF` in the launcher of that home; without
  it, rule 3 above applies to the server, and the hooks may take the name of
  the most recent card registered for the same directory.

Install from the published package:

```bash
npm i -g valxos-messenger --allow-scripts=better-sqlite3
valxos-messenger install --dry-run   # preview
valxos-messenger install             # install
```

The `skills-dir` link written by `valxos-messenger install` and
`claude plugin enable valxos-messenger@skills-dir` were not exercised end to end
in a Claude Code session in this release; the plugin was verified from the same
tree with `--plugin-dir`.

Do not install the package as a Claude Code plugin from an npm marketplace
source: since Claude Code 2.1.275 such installs run `npm pack --ignore-scripts`,
and better-sqlite3 then has no native binding.

Install from the checkout:

```bash
cd <path-to-valxos_messenger>
npm install
node scripts/install.js            # --dry-run, --uninstall, --no-enable, --force, --launchd, --launchd-load, --operator
# from the published package instead: npx --allow-scripts=better-sqlite3 --package valxos-messenger valxos-messenger install
```

`scripts/install.js` runs, in this order: `npm install` only when a dependency does not resolve (never from a package that lives under `node_modules`); the plugin symlink of the checkout at `<claude-home>/skills/valxos-messenger`; the CLI links into `~/.local/bin`; the office: the runtime directories and the database, created when absent; then the optional Claude Code steps `claude plugin validate` and `claude plugin enable valxos-messenger@skills-dir` (skipped with `--no-enable`), the launchd plists only when `--launchd` is passed, and an informational `valxos-doctor` run. Without a `claude` binary the core install still succeeds.
`<claude-home>` is `$CLAUDE_CONFIG_DIR` when that variable is set — a machine
may host several Claude Code homes — and `~/.claude` otherwise: export
`CLAUDE_CONFIG_DIR` before running the installer to target another home.
`valxos-doctor` reports whether the install is complete.

A home that ran the plugin under its former id keeps its legacy link,
the legacy `<claude-home>/skills/cc2cc-v2`, when that link points at this
checkout: the sessions already running there still read it. The installer
names it in its summary (`legacy_plugin_link` in the JSON report) and prints
the gesture to retire the legacy id, `claude plugin disable cc2cc-v2@skills-dir`
then removing the link, to run once no session of that home is running. It
never removes the legacy link itself.

Without the plugin — a home where you want the tools but no hooks, no
monitor, no chair:

```bash
claude mcp add --scope user valxos_messenger \
  -e VALXOS_SELF=your-agent-name \
  -- node <path-to-valxos_messenger>/src/mcp-server/server.js
```

Tool names as the model sees them: through the plugin, `mcp__plugin_valxos-messenger_valxos-messenger__send` and so on (plugin id and server key are both `valxos-messenger`; formerly `mcp__plugin_cc2cc-v2_cc2cc-v2__send`); through `claude mcp add`, `mcp__valxos_messenger__send`.

### Smoke test (Claude Code)

Each call below ran on 2026-10-18 under other peer names (`preuve-*`), in
headless runs and in one interactive session, not as this one sequence; the
names here are placeholders.

In one interactive session where the tools are loaded, ask for these calls
and read the results:

1. `whoami` — note `id` (your chair, `your-agent-name#<session>`) and
   `runtime` (the office).
2. `send` with `to` = `smoke-b`, `body` = `smoke` — `sent: true`.

Then, from a shell against the same office:

```bash
VALXOS_SELF=smoke-b valxos-inbox      # one letter from your chair
VALXOS_SELF=smoke-b valxos-send --to 'your-agent-name#<session>' --body "from the shell"
```

3. Back in the session: the hooks show the shell's letter after the next tool
   call (and the monitor at once); `inbox` lists it with `etat: "reçue"`.
4. `ack` with its `msg_id` — `acked: true`.

A headless check is one `claude -p` run with the same prompt for steps 1 and
2. Each such run leaves its chair in service: run `valxos-chaise moissonner`
before the next headless run under the same name, or a letter to the bare
name will wait with `attente.motif: "lignee-ambigue"`.

## Codex CLI

**Status: Verified on macOS on 2026-10-18 with codex-cli 0.162.1 (headless `codex exec`); the 2026-08-29 wiring without the approval setting no longer works on 0.162.1.**
Exercised on that date against a scratch office: `whoami` and `send` in one
`codex exec` pass, the CLI reading the recipient's inbox, `inbox` and `ack`
in a second pass under the recipient's name, then `history` under the
sender's name. The entry was passed with `-c mcp_servers.<name>.…` overrides;
the TOML below writes the same keys into `~/.codex/config.toml`.

```toml
# ~/.codex/config.toml
[mcp_servers.valxos_messenger]
command = "node"
args = ["<path-to-valxos_messenger>/src/mcp-server/server.js"]
default_tools_approval_mode = "approve"

[mcp_servers.valxos_messenger.env]
VALXOS_SELF = "your-agent-name"
# VALXOS_MESSENGER_HOME = "/absolute/path/to/an/office"   # when the office is not the default
# VALXOS_GARDE_BUREAU = "1"                               # scratch runs: refuse the default office
```

`default_tools_approval_mode = "approve"` is required: codex-cli 0.162.1
refuses every MCP tool call under `codex exec` otherwise: "MCP tool call
requires approval, but approval policy is never". It does so with the
user's config and with Codex's default config alike (`--ignore-user-config`).
The server declares no tool annotations; whether that is what makes Codex ask
for an approval is plausible, not measured.

Notes:

- The identity lives in the `[mcp_servers.valxos_messenger.env]` table. Add
  `VALXOS_MESSENGER_HOME` there when the office is not the default.
- Every value in `env` is a TOML string: write `VALXOS_GARDE_BUREAU = "1"`,
  never `= 1`. On the command line too: `-c 'mcp_servers.valxos_messenger.env.VALXOS_GARDE_BUREAU="1"'`.
  An integer stops Codex before anything starts (``invalid type: integer `1`, expected a string``).
- The 2026-08-29 install also set `startup_timeout_sec = 30.0`; the
  2026-10-18 runs did without it.
- If Codex cannot find `node` on the PATH it gives its servers, put the
  absolute path of the binary in `command`. `valxos-messenger install --codex`
  (below) writes the absolute path itself.

The same entry on the command line, the form the verification ran:

```bash
codex exec \
  -c 'mcp_servers.valxos_messenger.command="node"' \
  -c 'mcp_servers.valxos_messenger.args=["<path-to-valxos_messenger>/src/mcp-server/server.js"]' \
  -c 'mcp_servers.valxos_messenger.default_tools_approval_mode="approve"' \
  -c 'mcp_servers.valxos_messenger.env.VALXOS_SELF="your-agent-name"' \
  "Call the valxos_messenger MCP tool whoami and print its JSON result."
```

`codex mcp add valxos_messenger --env VALXOS_SELF=your-agent-name -- node <path-to-valxos_messenger>/src/mcp-server/server.js`
is said by `codex mcp add --help` to write an entry; not tested here. If you
use it, read the file afterwards and add `default_tools_approval_mode = "approve"`
to it.

Not tested: the MCP round trip of this section on codex-cli 0.163.0 (the
2026-10-18 verification ran on 0.162.1, which updated itself during that run;
on 0.163.0 the 2026-10-21 doorbell probes saw the woken model call `inbox`
through the 1.0.0 server in the interactive TUI, below); `codex mcp add`; the
`~/.codex/config.toml` file form of the entry under the key `valxos_messenger`
(the 2026-10-18 runs passed the same keys with `-c`; the 2026-10-21 probe ran
a hand-written `config.toml` entry under another key, `valxos`); a per-tool
approval setting; the CLI → Codex
direction under `codex exec` (a letter from the CLI collected by
`codex exec`).

### Smoke test (Codex CLI)

The sequence below ran on 2026-10-18 under other peer names (`preuve-*`); the
names here are placeholders.

```bash
codex exec "Call the valxos_messenger MCP tool whoami and print its JSON; then call send with to='smoke-b', subject='smoke', body='hello', and print the result."
VALXOS_SELF=smoke-b valxos-inbox      # one letter from your-agent-name
codex exec -c 'mcp_servers.valxos_messenger.env.VALXOS_SELF="smoke-b"' \
  "Call the valxos_messenger MCP tool inbox and print its JSON; then call ack with the msg_id of the letter you found, and print the result."
codex exec "Call the valxos_messenger MCP tool history with peer='smoke-b' and print its JSON."
```

Expected: `whoami.id` is `your-agent-name` (not a hostname); `send` returns
`sent: true` with `attente.motif: "destinataire-inconnu"` (`smoke-b` has never
called the server); the CLI shows `count: 1`; the second pass lists the
letter with `etat: "reçue"` and `ack` returns `acked: true`; `history` shows
it with `etat: "accusée"`. A `mcp_tool_call` that fails with the approval
error means the entry lacks `default_tools_approval_mode`.

### Codex: hooks and the doorbell

**Verified on macOS on 2026-10-22 with codex-cli 0.163.0** — on a scratch
`CODEX_HOME` with a local model (Ollama, a 7B model), in the TUI with hook
trust bypassed (`--dangerously-bypass-hook-trust`; the hooks were the ones
`install --codex --write` had just written there): the shipped hook
(`src/hooks/codex/codex-hook.js`) wrote the chair card at the first turn
(`porte: "cli"`); a letter to that chair was rung by the Facteur's door
(`src/facteur/porte-codex.js`) 0.35 s after it was posted (`codex queue --thread
<uuid>`); an autonomous turn started 5.7 s after the letter (`turn_trigger: "queue"`);
`UserPromptSubmit` injected the whole letter, framed as untrusted text, and
the model called `inbox`. Two letters posted during one round shared one
envelope. A letter rung after Escape stayed in the queue until the next typed
prompt, which carried it. The model never acknowledged: a 7B's choice, not the
chain's. The test suite proves the hook and the door against a stand-in
`codex` on a scratch PATH (`test/codex-hook.test.js`, `test/porte-codex.test.js`).

Seen earlier on macOS on 2026-10-21 with codex-cli 0.163.0,
against a scratch `CODEX_HOME` with a local model (Ollama), a hand-written
stand-in hook script and the 1.0.0 package: `codex queue --thread <uuid>
--message <text>`
woke an idle interactive session: a turn started on its own
(`turn_trigger: "queue"`), in under a second with Codex's shared daemon and
about 9 s without it. A message queued during a turn waited for the turn to
end. Text from a `UserPromptSubmit` hook reached the model's request as a
developer message (whether a hosted model heeds it was not measured: the
local model did not). A `Stop` hook answering `{"decision":"block","reason":…}`
re-ran the turn with the reason as a user message, and the second `Stop`
carried `stop_hook_active: true`. And the chain ran once end to end: a
letter, `codex queue`, an autonomous turn, the model calling `inbox` by itself
and seeing the letter. The hooks were approved in `/hooks` of that scratch
TUI. The same day, on the authors' desktop app, `codex queue` by the thread's
exact name woke a thread open in the app, and, with the app closed,
`open codex://threads/<uuid>` reopened it on that thread and the queued turn
started by itself.

Not tested: a regular Codex home (the walk used a scratch one, with hook trust
bypassed); the door opening a closed app (`open codex://threads/<uuid>` was run
by hand on 2026-10-21, never by the Facteur); the hooks in the
desktop app; the `/hooks` approval of the hooks the installer writes, and
whether an approval survives the installer rewriting `hooks.json`; what
`lsappinfo` answers for a quit app (the door reads anything unexpected as
unknown and does not open the app); `codex exec resume` (the Facteur never
runs it); the iPhone app (no door exists).

What ships:

- **The hook**, one executable for four events, declared in
  `$CODEX_HOME/hooks.json` from the template `scripts/codex/hooks.template.json`
  (timeouts: 10 s for `SessionStart`, 5 s for the three others);
  `[features] hooks = true` in `config.toml` turns hooks on. Its command names
  an absolute `node` and carries the identity and the office inline:
  `env VALXOS_SELF=<name> VALXOS_MESSENGER_HOME=<office> <node>
  <package>/src/hooks/codex/codex-hook.js --serves <name>`. A hook whose
  identity — `VALXOS_SELF`, or its historical alias `CC2CC_SELF` when
  `VALXOS_SELF` is unset — is
  missing, empty, or not in `--serves <name>` answers `{}` and opens no office.
  It drains stdin within 4 s, opens the office with a 3 s
  busy timeout, injects pending letters framed as untrusted text (8,000
  characters at most, its preamble included; 50 letters at `SessionStart`, 20
  after), marks them delivered and never acknowledges (the letter comes back
  if the model ignores it); a letter too long for that budget is cut, with a
  line saying it is long and not marked delivered and that `inbox` reads it
  in full, and it is announced (`announced`, at most three times), never
  marked delivered; the hooks serve a rung letter at once (a letter the
  doorbell marked carried has no grace period here, so the turn the envelope
  starts already carries it), and they hold a stop for unread `high`/`critical`
  letters only, three times at most, with the envelope as the reason — never a
  body: Codex hands that reason to the model as a user message. It names no
  identity on stderr; with `VALXOS_HOOK_TRACE` set, it writes a trace under
  the office's `logs/codex-hook/` only. A sub-agent's hook call delivers
  nothing.
- **The chair card**: at a session's first turn, `SessionStart` writes
  `<office>/codex/<lineage>.json` (`lineage`, `thread_id`, `codex_home`,
  `pid`, `proc_start`, `porte`, `cwd`, `started_at`, `last_seen`, `dead_at`)
  atomically, mode `0600`, and
  records the thread as the session of the lineage's own card
  (`instance_session_id` = the thread id, `house` = the `CODEX_HOME`); the
  Codex session keeps speaking under its bare name, and its MCP client reads
  and acknowledges its letters under it. `UserPromptSubmit` and `Stop` refresh
  `last_seen`. `list_peers` and `valxos-peers` show `harnais: "codex"` and the
  door (`porte`) of a Codex chair. One card per lineage: the last session that
  writes it wins (its `SessionStart`, or a prompt or `Stop` of a session whose
  thread the card does not name).
- **The Facteur's door**: when a letter leads to a chair that has a card, the
  round runs `codex queue --thread <thread_id> --message <envelope>` with
  `CODEX_HOME` set from the card, kills its process group after 5 s (a
  grandchild that left the group, with `setsid`, survives), and
  marks the letter carried when the queue took the envelope. The letters of
  one round for the same chair share one envelope, and a letter the queue took
  is never rung again. A direct letter is rung whatever its priority, `low`
  included, as in 1.0.0: the quiet rules (`sans_reveil`) are a table letter's,
  and only the Stop safety net never holds a stop for a `low` letter; on a
  Codex chair, a ring starts a turn. On `No active session` or `no rollout found` it tries
  once more by the uuid. A `codex` missing from the Facteur's PATH, a hung or
  failing `codex`, a thread no session holds: the letter is not marked carried,
  the round's reason is `sonnette-codex-impossible` (its detail, such as
  `codex-introuvable` or `codex-fil-sans-session`, goes to the Facteur's
  journal), the hooks present the letter at the next turn, and a later round
  tries again. A letter that arrived during a ring waits for the next round in
  its own envelope (`sonnette-codex-differee`). `envoi_status` shows the last
  attempt of each letter of a table send as `tournee` (`tournee.reason`); for
  a direct letter, read the Facteur's journal or run one round by hand
  (smoke test below).
- **Opening the desktop app**: when no session holds the thread
  (`No active session`), or when the queue took the envelope while the app is
  closed (`lsappinfo find bundleid=com.openai.codex`), the door opens the app
  on the thread (`open codex://threads/<uuid>`, macOS), once per letter, never
  on `no rollout found`, and only for a chair whose door is `app`. The door is
  the session's `VALXOS_CODEX_PORTE`: unset or empty means `app` (the desktop
  app has no launcher), `cli` never opens the app, and anything unknown reads
  as `cli`. A terminal launcher should export `VALXOS_CODEX_PORTE=cli`.
  `VALXOS_CODEX_OUVRIR_APP=0` in the Facteur's environment turns the opening
  off. A new letter keeps its own opening even when it shares an envelope with
  an older letter that already had one. The Facteur never runs `codex exec resume`: that would start a paid
  turn with nobody at the keyboard.

The envelope is one line, the same for the queue and for the `Stop` reason
(`enveloppeDeSonnette` in `src/lib/sonnette.js`):

```text
📬 VALXOS Messenger: 1 letter waiting for your-agent-name — from "alice" ("atelier"), table team-test, subject "Beat 7", priority "normal"; 2 other unread. Call the inbox tool.
```

The sender and chair names are cut at 64 characters, the subject is cut at 60
characters and the priority at 20, each quoted as a JSON string, and every line separator
(CR, LF, VT, FF, U+0085, U+2028, U+2029) is flattened to a space; no body ever
enters it. The counts
are a hint: a round may carry fewer letters than the envelope announces.

Install:

```bash
valxos-messenger install --codex --self your-agent-name            # prints the three pieces, writes nothing
valxos-messenger install --codex --self your-agent-name --write    # dated backups, merge, diff
# --codex-home <path>: another CODEX_HOME (default: $CODEX_HOME, else ~/.codex)
# --porte app|cli: pin one door in the hook command for every session of that Codex home
```

`valxos-messenger install --codex --self your-agent-name` prints the three
pieces: `[features] hooks = true` and the `[mcp_servers.valxos_messenger]`
entry (an absolute `node`, `default_tools_approval_mode = "approve"`, and
`VALXOS_SELF` and `VALXOS_MESSENGER_HOME` in its `env` table) for
`config.toml`, and the four hooks for `hooks.json`. `--self` is required;
`--codex-home <path>` targets another Codex home (default: `$CODEX_HOME`, else
`~/.codex`).
Without `--write` nothing is touched; a conflict, or a file it cannot read or
validate, exits 1 (`refus: "fichier-illisible"` or `"fichier-invalide"`) with
nothing written and no backup: `config.toml` is validated whole against TOML
1.0 before any plan (a form it cannot validate, TOML 1.1 included, is refused
too, and so is a file that starts with a UTF-8 byte-order mark, `motif: "bom"`), and `hooks.json` must be JSON. The same reading finds the tables the
merge completes, so a `[features]` written inside a string is never taken for
one, and a CRLF file keeps its line endings. The merged `config.toml` is then
read again before any backup, and `features.hooks = true` and the MCP entry are
looked up in it as TOML reads them: a merge that would not give that file exits
1 (`refus: "fusion-invalide"`), with nothing written and no backup. `--write` backs `config.toml` and `hooks.json` up with a dated
suffix (`.bak-<YYYYMMDD-HHMM>`), merges, and prints the diff; a value already
there is never changed, and a conflict writes nothing. The hooks and the MCP
entry name the `node` that ran the installer, through its stable link when one
is on PATH (`/opt/homebrew/bin/node` rather than a versioned path); when there
is none the installer says so, and a Node upgrade that removes that binary
breaks the hooks until you edit the path (a re-run sees a conflict and writes
nothing). Without `--porte app|cli` the hook command pins no door, and each session's
`VALXOS_CODEX_PORTE` decides; changing a pinned door later is a conflict to
fix by hand.

Then start Codex and approve the hooks once in `/hooks` (press `t` on each).
On the scratch home of 2026-10-21 the approval was stored in `config.toml`
under `[hooks.state]`, one `trusted_hash` per hook keyed by the `hooks.json`
path and the event; editing `hooks.json` probably asks again (not measured).
Never `--dangerously-bypass-hook-trust` on a real home: it also forces Codex's
embedded mode, where a queued message took about 9 s instead of under a
second.

Facts about Codex 0.163.0 worth knowing before you wire it: the TUI and
`codex exec` clone `github.com/openai/plugins` into `$CODEX_HOME/.tmp/plugins`
at startup, even with `--oss` (network access, no auth); `--oss`, `-p` and
`--dangerously-bypass-hook-trust` each force the embedded mode; a session that
has not had a turn yet cannot be queued to (`no rollout found`; during that
first turn, not measured), and `SessionStart` runs at the first turn, not at
launch. Each `codex queue` the Facteur runs may leave a
`$CODEX_HOME/.tmp/git-XXXXXX` directory behind (an empty git skeleton, never
cleaned) and touches `$CODEX_HOME/tmp/arg0-macos`: seen on the walk of
2026-10-22 with codex-cli 0.163.0, one directory per ring; watch it on a real
home. The Facteur runs `codex queue` from `<office>/run/` (never the Facteur's
own directory, which is often a repository); an office kept inside a git
repository still gives Codex that repository to inspect. When `<office>/run/`
cannot be made a directory, the ring is declared impossible
(`sonnette-codex-impossible`, with `run-inaccessible`) and the letter waits for
the hooks and a later round. For a scratch run, point
`VALXOS_MESSENGER_HOME` at a scratch office and add `VALXOS_GARDE_BUREAU=1` to
the hook commands and to the MCP entry's `env` table yourself: the installer
never writes the guard.

`valxos-doctor` has a `codex` section: the `codex --version` it gets (run
under a `CODEX_HOME` that cannot exist, because `codex --version` otherwise
writes `tmp/arg0-macos` into its home), and each card with its thread, door,
`CODEX_HOME`, whether its pid is alive and the same process, `last_seen`, the
thread's link, and whether the daemon socket
(`app-server-control/app-server-control.sock` under that `CODEX_HOME`) exists.
`valxos-doctor --reap` marks a card `dead_at` when its process is gone and no
hook has seen it for 24 h; the file stays, and the session's next hook call
clears the mark. `valxos-chaise moissonner` leaves Codex chairs to it.

The limits: after **Escape** in the TUI the queue freezes and shows nothing
until the next prompt a human types; the Facteur cannot know it. The letter
stays carried, and `UserPromptSubmit` injects it at that prompt. A
`codex queue` that queued the envelope but did not exit within 5 s counts as
failed: the next round may ring again, and the session sees the envelope
twice. Two Codex sessions served under one name ring the session that wrote the
card last: `SessionStart` writes it, and a prompt or a `Stop` of a session
whose thread the card does not name rewrites it. A lineage served both by Claude Code hooks and by the
Codex hook may see a carried letter twice, once through each door: the Codex
hook serves a letter with no carried grace, the Claude Code hooks after their
90 s. That is the at-least-once choice (A8): a duplicate rather than a lost
letter.

### Smoke test (Codex doorbell)

```bash
valxos-messenger install --codex --self your-agent-name --write
codex                                         # approve the hooks in /hooks, send one prompt, leave the session idle
VALXOS_SELF=smoke-b valxos-send --to your-agent-name --body "ring"
facteur --une-tournee                         # one round by hand, when no Facteur daemon runs
```

Expected: `send` answers `sent: true` and `wake.ok: false` (`ENOENT`: a Codex
chair has no socket; the Facteur rings it), with no `attente`; `valxos-doctor`
lists the card with a live pid; the round's tally counts `sonnee-codex` (or
`sonnee-codex-app-ouverte`), and the idle session starts a turn by itself
whose text is the envelope; the model calls `inbox` and sees the letter with
its body, and `ack` closes it. A tally that counts `sonnette-codex-impossible` was not
rung: the Facteur's journal line `facteur_echec` names the detail —
`codex-introuvable` (no `codex` on the Facteur's PATH), `codex-fil-sans-session`
(no session holds the thread), `codex-delai`. A letter that waits with
`attente.motif: "chaise-sans-session"` has no card yet: the hooks write it at
the first turn, not at launch.

## Gemini CLI

**Status: Verified on macOS on 2026-10-18 with gemini 0.58.0 (headless `gemini -p`, API-key auth).**
Exercised on that date against a scratch office: `whoami`, `send`, `ack` and
`history` over MCP from a project `.gemini/settings.json` with two entries,
one per identity; the CLI reading the recipient's inbox; and the reverse
direction, a letter sent by the CLI, then `inbox` and `ack` by Gemini.

The project file, `<project>/.gemini/settings.json`:

```json
{
  "mcp": { "allowed": ["valxos_messenger"] },
  "mcpServers": {
    "valxos_messenger": {
      "command": "node",
      "args": ["<path-to-valxos_messenger>/src/mcp-server/server.js"],
      "env": { "VALXOS_SELF": "your-agent-name" },
      "timeout": 30000,
      "trust": true
    }
  },
  "security": { "auth": { "selectedType": "gemini-api-key" } }
}
```

Conditions, each one seen on 2026-10-18:

- **The folder must be trusted.** In an untrusted folder Gemini CLI 0.58.0
  ignores the project settings and suppresses the user-level servers:
  `gemini mcp list` shows every server `Disabled`. For headless runs, set
  `GEMINI_CLI_TRUST_WORKSPACE=true` in the environment that starts `gemini`.
  `--skip-trust` is not enough: it is applied after the settings are loaded,
  and the project config stays ignored.
- **Authentication.** The runs used an API key (`GEMINI_API_KEY`, selected by
  `security.auth.selectedType: "gemini-api-key"`). Google refused the personal
  OAuth login for this client: `IneligibleTierError: This client is no longer
  supported for Gemini Code Assist for individuals`. That refusal is on
  Google's side, not the Messenger's.
- `trust: true` skips the per-call confirmation; every headless run used it.
- `mcp.allowed` (or `--allowed-mcp-server-names valxos_messenger` on the
  command line) keeps the user-level servers from starting during a run.

Notes:

- `timeout` is in milliseconds (Gemini's convention).
- Gemini's `env` values may reference shell variables (`"$VAR"`); a literal
  name is simpler and cannot silently resolve to nothing.
- Add `VALXOS_MESSENGER_HOME` to `env` when the office is not the default.
- Gemini names the tools `mcp_<server>_<tool>` in its stats
  (`mcp_valxos_messenger_send`).

The same entry from the command line, checked against `gemini mcp add --help`
on 2026-08-29 only (default scope is `project`; `-s user` writes the user
file):

```bash
gemini mcp add -s user -e VALXOS_SELF=your-agent-name valxos_messenger \
  node <path-to-valxos_messenger>/src/mcp-server/server.js
gemini mcp list
```

Not tested: the personal OAuth login (refused); the user-level
`~/.gemini/settings.json`; `gemini mcp add`; interactive mode and its trust
dialog; an entry without `trust: true`; `broadcast`, `list_peers`, `register`
and `unregister`.

### Smoke test (Gemini CLI)

The sequence below ran on 2026-10-18 under other peer names (`preuve-*`); the
names here are placeholders.

From the project folder:

```bash
export GEMINI_CLI_TRUST_WORKSPACE=true
gemini --allowed-mcp-server-names valxos_messenger --output-format json \
  -p "Call the whoami tool of the valxos_messenger MCP server exactly once and print its raw JSON result."
gemini --allowed-mcp-server-names valxos_messenger --output-format json \
  -p "Call the send tool of the valxos_messenger MCP server exactly once with to='smoke-b', subject='smoke', body='hello'. Print its raw JSON result."
VALXOS_SELF=smoke-b valxos-inbox      # one letter from your-agent-name
VALXOS_SELF=smoke-b valxos-send --to your-agent-name --body "from the shell"
gemini --allowed-mcp-server-names valxos_messenger --output-format json \
  -p "Call the inbox tool of the valxos_messenger MCP server, then call its ack tool with the msg_id of the letter it returns. Print both raw JSON results."
```

Expected: `whoami.id` is `your-agent-name`; `send` returns `sent: true`; the
CLI shows `count: 1`; `inbox` lists the shell's letter with `etat: "reçue"`,
and `ack` returns `acked: true`.

## Antigravity CLI (agy)

Antigravity CLI (`agy`) is not Gemini CLI: it is another binary, with its own
configuration. It has no project-level MCP file and no flag that points at
one. Its MCP servers come from the global `~/.gemini/config/mcp_config.json`
(what `agy mcp add|list|remove` manage) and from plugins. A **workspace
plugin** is the per-project route.

**Status: Verified on macOS on 2026-10-18 with agy 1.3.5 (headless only).**
Exercised on that date against a scratch office: `whoami`, `send`, `inbox`,
`ack` and `history` over MCP from a workspace plugin with two servers, one
per identity; the CLI reading the recipient's inbox; and a reverse letter
sent by the CLI and collected by agy with `inbox`. Every run used
`-p --sandbox --dangerously-skip-permissions`.

Two files in the project. `<project>/.agents/plugins/valxos/plugin.json`:

```json
{ "name": "valxos", "description": "VALXOS Messenger for this project." }
```

`<project>/.agents/plugins/valxos/mcp_config.json`:

```json
{
  "mcpServers": {
    "messenger": {
      "command": "node",
      "args": ["<path-to-valxos_messenger>/src/mcp-server/server.js"],
      "env": { "VALXOS_SELF": "your-agent-name" }
    }
  }
}
```

agy names a plugin's server `<plugin>_<server>`: here `valxos_messenger`.

Conditions, each one seen on 2026-10-18:

- The plugin loaded in headless mode although the workspace was not trusted.
  The project was a git repository (`git init`), which agy uses to find the
  workspace root.
- Headless runs auto-deny MCP calls ("a tool required the "mcp" permission
  that headless mode cannot prompt for, so it was auto-denied") unless
  `--dangerously-skip-permissions` is passed. agy suggests an allow-rule under
  `permissions.allow` in its settings (`mcp(<target>)`) instead; that was not
  tested.
- **Every server of the global `~/.gemini/config/mcp_config.json` also starts
  on each agy call** — even `agy agents` — and inherits the caller's
  environment. A messenger entry in that global file starts too, and opens the
  office that the caller's environment names (or the default office). Set
  `VALXOS_MESSENGER_HOME` in the environment of the agy command itself when
  you test against a scratch office.
- Write an absolute path in `args`.
- agy updates itself. On 2026-10-18 the first command that started its
  language server replaced 1.3.5 with 1.4.2 in the background; the
  verification ran on 1.3.5.

Not tested: agy 1.4.2; the interactive TUI and its workspace trust dialog; an
`mcp(...)` allow-rule instead of `--dangerously-skip-permissions`; runs
without `--sandbox`; the project custom-agent route (`.agents/agents/*.md`
with `mcpServers`, which agy answered with `unknown agent`); `~` expansion in
plugin `args`; a way to keep the global servers from starting.

### Smoke test (Antigravity CLI)

The sequence below ran on 2026-10-18 under other peer names (`preuve-*`); the
names here are placeholders.

From the project folder, one tool per call:

```bash
agy --sandbox --dangerously-skip-permissions --output-format json \
  -p "Use only the MCP server valxos_messenger. Call its whoami tool once and print the raw JSON result."
agy --sandbox --dangerously-skip-permissions --output-format json \
  -p "Use only the MCP server valxos_messenger. Call its send tool once with to='smoke-b', subject='smoke', body='hello', and print the raw JSON result."
VALXOS_SELF=smoke-b valxos-inbox      # one letter from your-agent-name
VALXOS_SELF=smoke-b valxos-send --to your-agent-name --body "from the shell"
agy --sandbox --dangerously-skip-permissions --output-format json \
  -p "Use only the MCP server valxos_messenger. Call its inbox tool once and print the raw JSON result."
```

Expected: `whoami.id` is `your-agent-name`; `send` returns `sent: true`; the
CLI shows `count: 1`; `inbox` lists the shell's letter. A run whose JSON
reports `denied_actions` with `CallMcpTool` lacked
`--dangerously-skip-permissions`.

## OpenCode

**Status: Verified on macOS on 2026-10-18 with opencode 1.18.30 (headless `opencode run` only).**
Exercised on that date against a scratch office: `whoami`, `send`, `inbox`,
`ack` and `history` over MCP from a project `opencode.json`, with the
recipient as a second `mcp` entry of the same file; the CLI reading the
recipient's inbox; and a reverse letter sent by the CLI, then collected with
`inbox` and `ack`.

The project file, `<project>/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "valxos_messenger": {
      "type": "local",
      "command": ["node", "<path-to-valxos_messenger>/src/mcp-server/server.js"],
      "enabled": true,
      "environment": { "VALXOS_SELF": "your-agent-name" }
    }
  }
}
```

Notes:

- `command` is an array: the program, then its arguments. The identity and
  the office go in `environment`; add `VALXOS_MESSENGER_HOME` there when the
  office is not the default.
- `opencode mcp list` shows `✓ valxos_messenger connected`.
- OpenCode names the tools `<server>_<tool>` (`valxos_messenger_send`). It
  starts the server for each `opencode run` and stops it at the end.
- The verification also denied OpenCode's own `bash`, `edit` and `webfetch`
  tools in the project file, so that the model called only the messenger
  tools. That is optional.

Not tested: the TUI; the global config (`~/.config/opencode`); `register`,
`list_peers`, `broadcast` and `unregister`; two OpenCode sessions running in
parallel.

### Smoke test (OpenCode)

The sequence below ran on 2026-10-18 under other peer names (`preuve-*`); the
names here are placeholders.

From the project folder (add `-m <provider/model>` as you usually do):

```bash
opencode mcp list
opencode run "Call the MCP tool valxos_messenger_whoami exactly once, then reply with its raw JSON result."
opencode run "Call the MCP tool valxos_messenger_send exactly once with to='smoke-b', subject='smoke', body='hello'. Reply with its raw JSON result."
VALXOS_SELF=smoke-b valxos-inbox      # one letter from your-agent-name
VALXOS_SELF=smoke-b valxos-send --to your-agent-name --body "from the shell"
opencode run "Call valxos_messenger_inbox once, then valxos_messenger_ack once with the msg_id it returned. Reply with both raw JSON results."
```

Expected: `whoami.id` is `your-agent-name`; `send` returns `sent: true` with
`attente.motif: "destinataire-inconnu"` (`smoke-b` has never called the
server); the CLI shows `count: 1`; `inbox` lists the shell's letter with
`etat: "reçue"`, and `ack` returns `acked: true`.

## Hermes

**Status: Written from upstream documentation, not verified on a live client.**
Source: the upstream Hermes Agent tree — the `mcp_servers`
section of `cli-config.yaml.example`, the MCP client in `tools/mcp_tool.py`
(environment filtering, tool naming) and the `hermes mcp` command — plus
the published guide (https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).
An earlier live proof (25/08/2026) exists in the authors' records; the wiring
below is written from upstream documentation and was not re-verified for
1.0.0.

Hermes has a built-in MCP client. Servers are declared under `mcp_servers`
in `~/.hermes/config.yaml`:

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  valxos_messenger:
    command: node
    args: ["<path-to-valxos_messenger>/src/mcp-server/server.js"]
    env:
      VALXOS_SELF: your-agent-name
    # connect_timeout: 60     # seconds, initial connection + tool discovery (code default 60)
    # timeout: 300            # seconds, per tool call — default 300 in the code (tools/mcp_tool.py); the upstream example says 120
```

Facts from the upstream source that matter here:

- **The environment is filtered.** A stdio server receives only `PATH`,
  `HOME`, `USER`, `LANG`, `LC_ALL`, `TERM`, `SHELL`, `TMPDIR`, the `XDG_*`
  variables (and Windows equivalents) — plus what you write under `env`.
  `VALXOS_SELF` exported in your shell never reaches the server; it must be
  in `env`. `HOME` passes, so the default office resolves; set
  `VALXOS_MESSENGER_HOME` under `env` otherwise.
- Tools are registered as `mcp__valxos_messenger__<tool>`:
  `mcp__valxos_messenger__whoami`, `mcp__valxos_messenger__send`, and so
  on.
- If Hermes cannot find `node`, its own error suggests adding the Node
  `bin` directory to `mcp_servers.<name>.env.PATH`.
- Hermes scans each server's entry and tool descriptions for known
  indicators of compromise before registering; a plain local `node` command
  is what it expects.

The same entry from the command line (`--args` must be last: it swallows
the rest of the line; the command is "discovery-first" — it connects to the
server and lets you pick which tools to keep):

```bash
hermes mcp add valxos_messenger --command node \
  --env VALXOS_SELF=your-agent-name \
  --args <path-to-valxos_messenger>/src/mcp-server/server.js
hermes mcp list
```

Without the MCP client, or as a fallback: Hermes can post and collect mail
through its terminal tool with the CLI binaries. The identity is then
whatever environment the terminal tool gets, so pass it explicitly:

```bash
VALXOS_SELF=your-agent-name valxos-send --to some-peer --body "hello"
VALXOS_SELF=your-agent-name valxos-inbox --mark-delivered false   # no output budget: read without marking
VALXOS_SELF=your-agent-name valxos-inbox --ack <msg_id>   # acknowledge a collected letter
```

A Hermes skill wrapping those commands is enough; this repository ships
Claude Code skills only (the `skills/` directory), no Hermes skill.

### A Hermes chair in the registry (contract; the Facteur's door comes later)

This is the contract a Hermes integration writes to; the Facteur does not
act on it in this release.

- **No card file.** A Codex chair has a card (`<office>/codex/<lineage>.json`);
  a Hermes chair has none. Its registry row carries everything.
- **`house`** is the absolute path of the chair's `HERMES_HOME`, written out
  in full (for example `/opt/valxos/hermes/alice`; neither `~` nor `$HOME`).
- **`metadata_json.harnais`** is `"hermes"`: the key a Codex chair's row
  already carries (with `"codex"`), read in one place by the chair listings.

The Facteur's Hermes door (ringing a Hermes chair through its lineage's
socket) is not in this release; it is planned for 1.2.0. Until then the
Facteur does not ring a Hermes chair: depending on its row, a letter to it
waits with `chaise-sans-session`, `maison-non-renseignee` or `maison-inconnue`
(see "Answer codes"), and the chair collects it with `inbox` or
`valxos-inbox`, as above. Adding a `HERMES_HOME` to `VALXOS_MAISONS` does
not make the Facteur ring it: the round looks for Claude Code session records
there, a Hermes home has none, and the letter then waits as `boite-endormie`.

### Smoke test (Hermes)

Start `hermes` interactively and ask:

> Using the valxos_messenger tools: call whoami; then send a letter to your
> own id with body 'smoke'; then call inbox; then ack that letter. Report
> id, msg_id and the ack result.

Expected: `whoami.id` is `your-agent-name`, `inbox` holds the letter with
`etat: "reçue"`, `ack` returns `acked: true`. Then from a shell:

```bash
VALXOS_SELF=your-agent-name valxos-peers      # the Hermes peer card is listed
VALXOS_SELF=your-agent-name valxos-send --to your-agent-name --body "from the shell"
# back in Hermes: ask it to call inbox and ack every letter it finds.
```

## Troubleshooting (all clients)

- `whoami.id` looks like a hostname → `VALXOS_SELF` did not reach the
  server. Put it in the client's `env` block, not in your shell.
- Two clients cannot see each other's letters → they resolve different
  offices. Compare `whoami.runtime` on both sides, then set
  `VALXOS_MESSENGER_HOME` explicitly.
- A letter is sent but nothing happens on the other side → for an
  MCP-only peer that is normal: `send` reports `wake.ok: false` and
  `attente.motif: "chaise-sans-session"` (or `"destinataire-inconnu"` for a
  name that never called the server), and the letter waits in the office
  until the recipient calls `inbox`. Every code is in Answer codes above.
- Every Codex tool call fails with "MCP tool call requires approval, but
  approval policy is never" → the entry lacks
  `default_tools_approval_mode = "approve"` (Codex CLI section).
- A Codex session is not rung → `valxos-doctor` must list its chair card (the
  hooks write it at the first turn, not at launch: send one prompt first);
  `codex` must be on the Facteur's PATH (a launchd plist's PATH is the `node`
  directory, `/usr/local/bin`, `/usr/bin` and `/bin`: add the directory of
  `codex` to its `EnvironmentVariables` if it lives elsewhere); after Escape,
  type a prompt. The Facteur's journal names the reason
  (`sonnette-codex-impossible`) and its detail (Codex section).
- Gemini CLI lists the server as `Disabled` → the folder is not trusted; set
  `GEMINI_CLI_TRUST_WORKSPACE=true` (Gemini CLI section).
- A letter to a Claude Code lineage waits with `"lignee-ambigue"` after
  headless runs → dead `claude -p` chairs are still in service; run
  `valxos-chaise moissonner` (Claude Code section).
- A stderr line mentioning `bureau historique` → the legacy office `~/.cc2cc-v2` is in use; see the README, "Runtime directory and migration".
- The client times out at startup → run
  `node <path-to-valxos_messenger>/src/mcp-server/server.js` by hand: a
  missing `npm install` (no `node_modules`) or a `better-sqlite3` binary
  built for another Node version fails loudly there.
- `valxos-doctor` checks the installation; it does not test a client.
