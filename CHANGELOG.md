# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-11-25

Tables, replies, the quiet rules, and a doorbell for Codex. Schema 6 → 8,
additive only (new tables and columns, no row rewritten): a 1.0.0 office
migrates in place. Node ≥ 20 and better-sqlite3 12 unchanged; zod's floor
rises to 4.5; no new dependency. One line per change below.

Upgrading from 1.0.0: read the three **Upgrade** lines at the top of
Changed (a declared sender name is now verified, the plugin is renamed,
the Facteur rings only the houses it lists). New command flags, each
described under Added: `--hors-enclos`, `valxos-table creer --fermee`,
`valxos-send --to table:<name>` with `--reveiller`, `valxos-history
--self`, `valxos-messenger install --codex --self <name> [--porte
app|cli]`.

### Added

- Tables: `table:<name>` as a destination of MCP `send`, `valxos-send` and the
  web door. A table is a named address book — lineages, chairs, human
  addresses or bare cards — with a wake rule (`reveil`, `prochain-tour`), a
  mode (`normal`, `direct`), a closed flag and a shared position. One letter
  per member, the sender excluded under every name it goes by, linked by
  `envoi_id`; each letter keeps its own route and acknowledgement. Tables are
  never deleted; a withdrawn member is marked.
- Wake rules decided at the counter and written on each table letter
  (`sans_reveil`, `motif_reveil`): `high`/`critical` always wake, `low` never;
  `reveiller: [...]` wakes the members it names, under any of the names a
  member goes by (the listed address, its lineage, its chair); a reply in a `direct` table
  is a quiet reaction; otherwise the member's rule, then the table's. A quiet
  letter is not carried by the Facteur and never holds a stop; it arrives at
  the next session start, tool call or `inbox`. A direct letter is carried
  and rung as in 1.0.0 whatever its priority, `low` included; only the Stop
  safety net ignores a `low` letter.
- Closed tables (`valxos-table creer --fermee`, `valxos-table fermer`): listed
  to their members only, members moved by the CLI only, the position hidden
  from non-members, and no cc copy of their letters to another chair
  (`sans_copie`) — hooks, `inbox` and the Python monitor alike. `history`
  (MCP, `valxos-history`, the web door) leaves such a letter out for a reader
  who is neither its recipient, nor the chair that posted it, nor a member of
  the table, the reader being the identity from the environment (a declared
  `self` other than the session's own or a name of its family is refused,
  `identite-refusee`; `valxos-history --self` must match the environment's
  identity, a chair included, else exit 2); a chair reads what is addressed to
  it or to its lineage and what it posted under either; `reply` as sender and `envoi_status` belong to the chair that
  posted (`sender_chaise`), not to its bare lineage.
- The enclosure (`valxos-table enclos <sender> <table>`), a seatbelt a sender
  asks for: a letter to anybody outside its closed table is refused before
  any letter is written (the sender's peer card may already be recorded by
  then; `refus: "hors-enclos"`, with `enclos`,
  `destinataires_refuses` and `autres`), unless the call says
  `hors_enclos: true` (`--hors-enclos` at the CLI); `send`, `broadcast`,
  `reply` and the web door honour it. While it holds, the table cannot reopen
  and the sender cannot be removed (`table-sous-enclos`); it holds one table at
  a time, and setting it on another while it holds is refused
  (`enclos-existe`), under any of the sender's forms too (lineage, chair, short
  chair, human address); two such enclosures already in an office refuse that
  sender's letters (`enclos-conflit`, with `tables`) until one is lifted.
- MCP `reply` (always loaded): answers a letter to its author — its chair when
  known — in the letter's thread, as `msg_type: "response"` with `reponse_a`;
  `toute_la_table: true` answers the whole table, the default in a `direct`
  table.
- MCP `tables` (your tables, `membre: true`, and the open ones you could join,
  `membre: false`), `table_manage` (create an open table, join, leave, add or
  remove members, wake rule, mode, position) and `envoi_status` (one table
  send, member by member: `cree`, `sonne`, `montre`, `accuse`, and the
  Facteur's last attempt as `tournee: { state, reason, at }`; served to the
  sender only). Thirteen tools in all.
- A table send that breaks after some letters were written answers its
  refusal's code, or `envoi-interrompu` with the error's code in `cause`, with
  `interrompu: true` and `lettres_ecrites`, at MCP `send` and `reply` and at
  `valxos-send`; the web door answers `500` with a fixed `motif`.
- `inbox` and `history` lines carry `table` (the table's name), `envoi_id`,
  `reponse_a`, `position` and `rappel`; `valxos-inbox` adds `chaise_nom`. The
  hooks (Claude Code and Codex) and the Python monitor show
  `Table: <name> (<mode>) · position: "<text>"`, `From: <sender> (<chair name>)`
  and `Reminder: <n>` in a letter's header; the web page shows the table line.
- `valxos-table` (alias `cc2cc-table`): `creer`, `ajouter`, `retirer`,
  `fermer`, `ouvrir`, `reveil`, `mode`, `position`, `enclos`,
  `enclos --retirer`, `lister`, `voir`, `--json`; exit 0, 1 (refused by the
  address book) or 2 (usage). `valxos-history` (alias `cc2cc-history`):
  `--thread`, `--table` or `--envoi`, `--format markdown|json`, `--limit`,
  your own correspondence only. Both answer `-h`/`--help` without opening an
  office. 27 CLI entry points with the relay's `valxos-relais`.
- `valxos-send --to table:<name>`, `--reveiller a,b`, `--hors-enclos`; a
  refusal is JSON with exit code 2.
- The web door posts to `a: "table:<name>"` through the same counter and
  answers one result per member; `403 hors-enclos`, `403 enclos-conflit`, `404 table-inconnue`,
  `403 pas-membre`, `400 nom-de-table-invalide`; its feed carries the table,
  its mode and position, the chair name and the reminder count, and the page
  shows the table line.
- Short chair ids: `name#<prefix>` with eight or more hexadecimal characters
  reaches the one chair in service whose session id starts with it; when
  several match, the letter waits (`attente.motif: "chaise-ambigue"`).
- The Codex hook (`src/hooks/codex/codex-hook.js`), one executable for
  `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `Stop`: it serves only
  the name in `--serves`, injects pending mail as untrusted text (8,000
  characters at most) with no grace period for a letter the doorbell rang,
  never acknowledges, and holds a stop for `high`/`critical` only, three times
  at most, with the envelope as its reason.
- The Codex chair card `<office>/codex/<lineage>.json` (`0600`), written by
  `SessionStart`, which records the thread as the session of the lineage's card.
- The Facteur's Codex door (`src/facteur/porte-codex.js`), the doorbell:
  `codex queue --thread <id> --message <envelope>` under the card's
  `CODEX_HOME`, run from `<office>/run/` (never the Facteur's own directory;
  when `run/` cannot be made a directory, the ring is impossible,
  `run-inaccessible`), 5 s per attempt with one retry, one envelope per round and
  chair, never a second ring for a letter the queue took, and the round's
  reason `sonnette-codex-impossible` when it fails. The envelope never carries
  a body. It is one line (every Unicode line separator flattened), and each
  value a peer could set — sender, chair name, subject, priority — is bounded
  and quoted as a JSON string.
- The Facteur opens the Codex desktop app on a waiting thread
  (`codex://threads/<uuid>`), once per letter, for a chair whose door is `app`
  (`VALXOS_CODEX_PORTE`; unset means `app`), when no session holds the thread
  or the app is closed (`lsappinfo`); `VALXOS_CODEX_OUVRIR_APP=0` disables it.
- `valxos-messenger install --codex --self <name> [--porte app|cli]
  [--codex-home <path>] [--write]`: prints the three pieces for `$CODEX_HOME`
  (`[features] hooks = true`, the hooks from `scripts/codex/hooks.template.json`
  with an absolute `node` and the identity and office inline, the
  `[mcp_servers.valxos_messenger]` entry) and writes them only with `--write`,
  after dated backups, printing the diff; a conflict, or a file it cannot read
  or validate (`config.toml` is checked whole against TOML 1.0 before any plan
  or backup, by the same reading that splits it into tables, and the merged
  file is checked again before anything is written, `fusion-invalide`;
  `hooks.json` must be JSON), writes nothing and exits 1.
- `valxos-doctor` has a `codex` section (`codex --version`, the chair cards,
  live pids, the daemon socket), and `valxos-doctor --reap` marks a Codex card
  `dead_at` once its process is gone and no hook has seen it for 24 h;
  `valxos-peers` and `list_peers` show `harnais` and the door (`porte`) of a
  Codex chair.

- The relay, `valxos-relais` (`echanger`, `etat`, `tournee [--une]`): it carries
  letters between two Macs over ssh, as the only carrier on the route, and
  nothing is synchronised or shared between the offices. It adds schema 8
  on top of 7, additive only: the address book (`carnet`: which Mac each chair lives on),
  the columns that mark a carried letter (`via`, `mac_origine`, `porte_vers`,
  `porte_at`, `remise_rendue_at`, `accuse_rendu_at`) and `peers.designe_at`. A carried letter shows `Via: relais · from: <Mac>`
  and keeps its real sender. Optional launchd service
  `com.valxos.messenger.relais`, written only by
  `node scripts/install.js --relais --write` (a dry run without `--write`,
  never loaded by the installer, never part of `--launchd`). How it works and
  where it stops: [`docs/RELAIS.md`](docs/RELAIS.md). A hand-run check of the
  whole release, relay included: [`docs/ACCEPTANCE_1_1_0.md`](docs/ACCEPTANCE_1_1_0.md).
- `VALXOS_MAISONS` accepts an entry ending in `/*`: every directory directly
  under that path is a house, read again at each round, so a house created
  later needs no re-install (the daemon no longer freezes the list at startup).
  The Facteur rings a live chair in such a house.
- A letter to a name no one has ever carried: `send` answers `No one has this
  name; did you mean …?` with `suggestions`, and when the letter is still
  waiting after `VALXOS_RETOUR_APRES_S` seconds (900 by default; `0` turns
  returns off) the Facteur sends its sender one calm letter, `Returned to
  sender: …`, low priority, that wakes nobody, saying how long the letter
  waited. The original letter stays and still arrives if someone takes the
  name. A name has been "carried" when the registry still has an entry for it,
  or when it was renamed, was the sender of a letter, or was the chair of a
  delivery. Nothing records a registration once its registry entry is gone, so
  a house that is closed right now has carried its name only if it sent a
  letter or received a delivery: then it is asleep, not a name no one carried,
  and a letter to it is never returned. Upgrade note: on the first rounds
  after the upgrade, older letters already waiting for a name no one ever
  carried come back to their senders, once each, as calm letters.
- `inbox` (MCP) takes `after` (only letters past that `seq`), and `msg_id`
  with `offset` (one letter, part by part); above its result budget it
  answers a `waiting` key (`letters`, `copies`, `after`) and a closing line.

### Changed

- **Upgrade: a declared sender name is verified.** `valxos-send --self
  <name>` (or `--from`) and the `from` of MCP `send` must belong to the
  identity the environment derives (`VALXOS_SELF`, see Addressing): that
  name, its lineage, one of its old names, or a human address that leads
  to it. Any other name posts nothing: `refus: "expediteur-refuse"`, and
  `valxos-send` exits 1. In 1.0.0 the declared name was taken as written.
  A script that sends under a name must export it: `VALXOS_SELF=<name>
  valxos-send --to … --self <name>`.
- **Upgrade: the Claude Code plugin's id is `valxos-messenger`** (it was
  `cc2cc-v2`). Restart each Claude Code session to load it. Its MCP tools
  are now named `mcp__plugin_valxos-messenger_valxos-messenger__*` instead
  of `mcp__plugin_cc2cc-v2_cc2cc-v2__*`, so a permission rule that names an
  old tool must be rewritten.
- **Upgrade: the Facteur rings only the houses it lists.** The launchd
  plists pin `VALXOS_MAISONS` (below). A house the list leaves out is not
  rung: the Facteur's journal and the `send` notice say `maison-inconnue`,
  and the letter arrives through the hooks and the monitor at the
  session's next turn.
- Schema 7 (schema 8 is the relay's, under Added): tables `tables`, `table_membres`, `enclos`; columns
  `messages.envoi_id`, `table_nom`, `reponse_a`, `sans_reveil`, `sans_copie`,
  `sender_chaise`, `reservices`. A schema-6 office migrates in place to 8 without
  moving a row.
- Reminders space out: a letter presented and not acknowledged comes back
  after 10, 20, 40, then every 60 minutes (`VALXOS_REDELIVER_CAP_MS`), counted
  in `reservices`, where 1.0.0 brought it back every 10 minutes; its header
  says `Reminder: <n>`, the Codex hook's preamble announces the next window
  of the letters it delivers, and a letter is never lost (A9).
- The "compatibility - using historical runtime" line is printed once per
  session, at `SessionStart`; the other hooks stay silent about it.
- The Claude Code Stop hook names a letter's sender and its chair name like
  the Codex envelope: each one flattened, bounded to 64 code points and quoted
  as a JSON string (`from "alice" ("atelier")`), and the body excerpt is
  flattened by the same rule (every control character and Unicode line or
  paragraph separator becomes a space); its `systemMessage` bounds the
  letter's key. The name the MCP server and the CLI derive from `VALXOS_SELF`
  or `VALXOS_SESSION_NAME` is still taken as written, as in 1.0.0; a part of
  it longer than 64 characters (the lineage, or what follows its first `#` or
  `@`) or an empty lineage (`#name`) makes the server and the CLI refuse to
  start (`identite-invalide`, the limit said), never a name cut or rewritten,
  and the hooks deliver nothing to an empty lineage.
- The CC block of the Claude Code hooks carries the untrusted-text line of a
  batch of letters, as the Python monitor's copies already did.
- The Python monitor follows the 1.1.0 delivery rules (no copy of a closed
  table's letter; the table, chair-name and reminder headers; the new event
  keys), and its help says what it does: bodies and subjects verbatim, never
  HTML-escaped, and no event names a tool to call.
- `valxos-chaise moissonner` and the doctor's chair harvest no longer count
  Codex chairs in `checked`: `valxos-doctor --reap` harvests Codex cards.
- A live office guard key set to blanks only now counts as unset, like an
  empty one (a blank `CC2CC_GARDE_BUREAU` armed the guard in 1.0.0).
- zod's floor is `^4.5.0`: from 4.5 a string's `max` counts code points, which
  the 120-character position bound relies on; the lockfile keeps 4.6.7.
- The lockfile follows the dependency versions npm resolves today (MCP SDK
  1.32.2): what a fresh `npm install -g` of this package receives.
- README: the Codex row of the harness table says hooks and a doorbell, with
  dated evidence and what was not seen live; new Tables and Doorbell for Codex
  sections. `docs/MCP_CLIENTS.md` documents thirteen tools, `envoi_status`,
  the Codex hooks, the doorbell and its smoke test; `docs/FACTEUR.md` the
  quiet letter and the Codex door; `SECURITY.md` says the envelope never
  carries a body and that tables and enclosures are conveniences, not
  boundaries.
- Both launchd plists (the Facteur and the web door) pin `VALXOS_MAISONS`: the
  declaration the installer runs with, as written, else `<home>/.claude`.
  Upgrade note: if you had written `VALXOS_MAISONS` or `CLAUDE_CONFIG_DIR` into
  the plists by hand, run the installer again with your declaration
  (`VALXOS_MAISONS="$HOME/.claude:$HOME/agents/*" valxos-messenger install --launchd`);
  `CLAUDE_CONFIG_DIR` is never pinned, and under a declaration it is not
  scanned, so put its path in the list if you want it read.

### Deprecated

- `cc2cc-table` and `cc2cc-history` are published as legacy aliases like the
  ten other `cc2cc-*` executables: twelve, 27 entry points in all (with `valxos-relais`).

### Fixed

- An empty `VALXOS_GARDE_BUREAU` no longer disarms a `CC2CC_GARDE_BUREAU` set
  beside it, and the guard's refusal names the key that armed it (it always
  named `CC2CC_GARDE_BUREAU`).
- A letter to a lineage's bare name goes to the chair that holds it. A helper
  (a subagent) is never handed its chair's mail by the hooks. If it calls
  `inbox` itself, it reads its chair's box, since the MCP server cannot tell
  which agent calls it; unless the helper also calls `ack`, the letter stays
  unacknowledged, and the hooks serve it to the chair again as a reminder at
  its next tool call, ten minutes later at the earliest. A session whose tool
  calls are served for another session (`served:`) is not a chair. When the
  designated chair's life cannot be decided (no pid, or a probe that cannot
  run), a sister chair collects the bare-name letter too: a duplicate rather
  than a loss.
- `ack` accepts the `Receipt:` identifier shown in the Facteur's delivery as
  well as the `msg_id`.
- Letters delivered by the SessionStart and PostToolUse hooks now fit under
  Claude Code's hook output limit (about 10,000 characters): a letter that does
  not fit stays waiting, and a long letter is announced and read in full with
  `inbox`.
- `inbox` keeps each result under 16,000 bytes, so Claude Code shows it whole
  (results of 68,344 and 180,272 characters were moved to a file the model
  never read, while every letter in them was marked delivered): only what is
  shown is marked delivered, a closing line says how many letters wait and
  gives `after`, and a letter too long for one result is read part by part
  with `msg_id` and `offset`, marked delivered once every part was shown.
- The Codex hooks no longer mark delivered a letter they cut to fit their
  budget: it is announced (at most three times) and waits for `inbox`.

### Known limitations

- The shipped Codex hook and the Facteur's Codex door are verified against a
  stand-in `codex` in the test suite and were seen live once, on 2026-10-22
  with codex-cli 0.163.0 on a scratch Codex home (TUI, a local model, hook
  trust bypassed): a letter rang the session and an autonomous turn read it.
  The hooks in the desktop app, the `/hooks` approval of the hooks the
  installer writes and the door opening a closed app were not seen on screen.
- `inbox`'s 16,000-byte result was measured whole on Claude Code 2.1.330 with
  default settings; a client configured with a lower MCP output limit can
  still move a result to a file. Re-run the `inbox` probe on each Claude Code
  release. The `valxos-inbox` command has no output budget and marks what it
  prints delivered: an agent runs it with `--mark-delivered false`.
- After Escape in the Codex TUI, a queued envelope waits until the next prompt
  a human types; the Facteur cannot see it. During a session's first turn
  `codex queue` may fail (`no rollout found`). No door exists to the iPhone
  app.
- One Codex chair card per lineage: two Codex sessions served under one name
  ring the session that wrote the card last (its `SessionStart`, or a prompt
  or `Stop` of a session whose thread the card does not name).
- A `codex queue` that queued the envelope but did not exit within 5 s counts
  as failed, and the next round may ring again.
- Tables are administered by `valxos-table` and `table_manage`; the web page
  shows table letters but its composer does not offer a table.
- The enclosure is not a security boundary (SECURITY.md).
- A subagent that calls `inbox` itself reads its chair's box: it marks the
  letters it reads delivered and the cc copies seen. The MCP server cannot
  tell which agent calls it; only the hooks are told (`agent_id`). Unless the
  subagent also calls `ack`, a letter stays unacknowledged, and the hooks
  serve it to the chair again as a reminder at its next tool call, 10 minutes
  later at the earliest (20, 40, then 60 if it had already been served). A cc
  copy it saw is not shown to the chair again.
- The hooks and the Python monitor read the identity in their own alphabet
  (letters, digits, dot, dash, underscore; 64 characters), as in 1.0.0, while
  the MCP server and the CLI take it as written: `alice opus` is `alice_opus`
  to the hooks and the monitor. Give each house a name in that alphabet.
- A bare sender (the CLI, or an MCP client without a chair) listed in a table
  under its lineage and under one of its chairs receives its own letter at
  that chair: the counter does not guess which chair a bare name is.
- A Codex chair whose door is `app` (the default when `VALXOS_CODEX_PORTE` is
  unset, or pinned by `install --codex --porte app`) gets the desktop app
  opened on its thread when a letter rings while the app is closed, even from
  a terminal session.
- The Codex door's deadline kills the process group of `codex queue`; a
  grandchild that left that group (`setsid`) survives it.
- `reply` is marked always-load like `inbox`, `send` and `ack`; the 1.1.0
  marks were read on the running server by the test suite, not re-observed in
  a live Claude Code session.
- The markdown export of `valxos-history` counts entries in its `letter(s)`
  line: a folded table send counts once.
- `valxos-inbox` and the Python monitor do not collect a short chair id that
  waited while ambiguous; the hooks and the MCP `inbox` do.
- `history` (MCP, CLI, web) applies its limit before the read guard: when
  closed-table letters the reader may not see fall inside the window, it
  returns fewer rows than asked (`--limit 1` may return nothing where
  `--limit 2` returns one); no body ever leaks. The MCP tool's limit stops at
  200 rows and the web page's window at 500, so a letter behind that many
  hidden ones does not show there. A wider `valxos-history --limit`, which is
  not capped, finds it; narrowing to its thread (`thread_id`,
  `valxos-history --thread`) finds it unless the hidden letters share that
  thread.
- The web door's `/api/pairs` (and the first `pairs` event of its stream)
  tells a bare lineage that a closed-table letter posted by one of its chairs
  waits at a recipient: the box, the count, the age, the carry attempts and the
  last reason, never the body; the feed's `au_dela_du_plafond` counts it too.
- In a Claude Code session that bypasses permission prompts, Claude Code
  can hold the Facteur's doorbell ("The sender did not attest its
  permission mode, and this session bypasses permission prompts.") until
  somebody answers its prompt: the Facteur is not a session and attests no
  mode. The letter still arrives through the hooks and the monitor. The
  README section "When Claude Code holds the doorbell" lists the user's
  choices. Seen on Claude Code 2.1.331.
- The `maison-inconnue` notice of `send` is computed with the sender's own
  `VALXOS_MAISONS`, not the Facteur's; when the two lists differ, the notice
  can be wrong either way. The Facteur's journal says what it did.

## [1.0.0] — 2026-10-18

First public release, on npm and on
`https://github.com/valx-vex/valxos-messenger`. The commits and tags before
this one are private and stay in the private repository; their release notes
are kept below. 1.0.0-rc.1 to rc.3 were cut on 26–29 August 2026; rc.3 was
tagged 1.0.0 in the private repository on 26 September, unchanged and never
published; this release adds the rename-and-hardening run of 27–28 September
2026 ("VALXOS Messenger partout", everywhere) and the publication run of 18
October. The public repository starts at this release. One line per change
below.

### Added

- `valxos-inbox --ack <msg_id>` acknowledges a letter from the CLI, with the
  same guards as the MCP `ack` tool.

### Changed

- The npm package is named `valxos-messenger`; `repository`, `homepage` and
  `bugs` point at `https://github.com/valx-vex/valxos-messenger`.
- Install with `npm i -g valxos-messenger --allow-scripts=better-sqlite3`:
  npm 12 blocks dependency install scripts by default and better-sqlite3
  needs its prebuilt download. Every documented `npx` line carries the flag.
- The Claude Code plugin id is `valxos-messenger` (`valxos-messenger@skills-dir`,
  tools `mcp__plugin_valxos-messenger_valxos-messenger__*`); the installer keeps
  the legacy `skills/cc2cc-v2` link that running sessions still read.
- The MCP server announces itself as `valxos_messenger`, an identifier; the
  public name is `valxos-messenger`.
- The default office is `~/.valxos-messenger`. A new office counts only when
  it is the Phase A symlink to `~/.cc2cc-v2` or carries the marker
  `.valxos-messenger-home`; otherwise the legacy office is used and the
  fallback is said once on stderr (Node and the Python monitor alike).
- An explicit office (`VALXOS_MESSENGER_HOME`, legacy `CC2CC_V2_HOME`): `~` and
  `~/…` expand against HOME, an absolute path is normalised, a relative value is
  refused with one line and exit 2 (exit 1 in a hook, never 2).
- An empty `VALXOS_MESSENGER_HOME` counts as unset and says so when it would
  have hidden `CC2CC_V2_HOME`.
- A HOME that is empty or relative falls back to the account's passwd home,
  else one line and exit 2.
- Schema 6: priority aliases (`valxos-chaise alias`) that no card masks, chained
  and read first; old names (`valxos-chaise reexpedier`) resolve exactly like
  their lineage; history under an alias or old name is bounded to letters after
  its `depose_at`, and `alias` over a name with past letters needs `--force`.
- Chairs: only the real process of a session receives (a sub-agent and a twin
  are refused and journaled once); the MCP server derives its chair from the
  harness session file, like the hooks.
- Lineage mail goes to the designated chair; every other live chair of the
  lineage sees one cc copy, never delivered, never ackable, never a Stop block;
  without a designation the letter is held (`sans-chaise-designee`).
- A designated chair whose process is dead no longer receives (the letter is
  held and the lineage says *designated chair dead*), with no status written.
- A bare name (a client without a session file, the CLI) never reads as owner,
  acks or reads the history of an address that leads to a live session chair,
  one or several, designated or not.
- A declared `self` naming a chair is honoured only when the caller's own
  session file derives that chair; a refused twin reads and acks nothing and
  sends flagged `sans_chaise`.
- A declared sender (`from` at MCP `send`/`broadcast`, `--self`/`--from` at
  `valxos-send`) is verified like a declared `self`; otherwise
  `expediteur-refuse` and nothing is posted.
- A caller-chosen `msg_id` that belongs to someone else's letter is set aside
  (`clef_ecartee`) at every door; the letter goes out under a new key.
- `unregister` of a chair with a session: only by itself or once its process is
  dead; `valxos-unregister` needs `--force` for a live chair (journaled).
- The Stop guard is keyed per chair (`lignée#session`).
- `valxos-doctor` reports and never writes by default; `valxos-doctor --reap`
  and `valxos-chaise moissonner` are the explicit gestures that mark dead chairs.
- The doctor is red when a legacy launchd plist that is not disabled sits
  beside ours (`checks.launchdLegacyOk`).
- `valxos-migrate-home` copies entry by entry (Node 26.10 `cpSync`), keeps
  symlinks verbatim and lists links that leave the office, refuses while a
  writer holds the database (three-outcome `lsof` probe), uses the SQLite backup
  API when sidecars exist, and writes the marker; a non-empty target needs
  `--force` and is set aside, dated.
- Legacy launchd labels: a three-outcome probe (`launchctl print`, 113 = not
  loaded, anything else refuses); `--uninstall --launchd-unload` boots them out
  and `disable`s every legacy label whose plist is present, loaded or not
  (rollback `enable` printed); `--launchd-load` refuses, writing nothing, while
  a legacy label is loaded or a present one is not disabled per
  `launchctl print-disabled`; `VALXOS_LEGACY_LABELS=` (empty) counts as unset.
- The installer proves the native binding (loads better-sqlite3, opens
  `:memory:`) and goes red, dry run included, with the command that repairs it.
- Every CLI declares its flags: an unknown flag, a stray `-x` or a bare word
  where none is taken exits 2 before anything opens; `-h` prints the usage;
  a value-taking flag takes the next token as its value whatever it looks like.
- `valxos-messenger` returns its child's exit code (a signal is 128 + n, a
  launch failure 2) and runs children under the node that runs it.
- Every CLI exits once, after stdout and stderr have drained.
- The MCP tools `inbox`, `send` and `ack` carry
  `_meta['anthropic/alwaysLoad']`: recent Claude Code (2.1.287+) defers MCP
  tools behind tool search, and the hooks and skills ask the model to call
  these three without a detour; the skills say to load the other six first.
- `tools/export-public.js --exclude <prefix>` (repeatable) keeps a tracked path
  out of the public mirror; the public repository is the release tree minus
  `docs/runbooks/` and `docs/superpowers/`.
- README: the harness table distinguishes Gemini CLI from Antigravity CLI
  (agy), says that only Claude Code sessions are woken by the Facteur, and
  dates every "Proven".
- README: the Known limitations describe the Claude Code 2.1.292+ MCP
  negotiation (`MCP_PROTOCOL_NEGOTIATION=legacy` opts out) and the
  deferred-tools behaviour.
- README: the Known limitations say not to install the package as a plugin from
  an npm source (`npm pack --ignore-scripts` since Claude Code 2.1.275), and
  what was proven about the plugin monitor under Claude Code's Monitor deadline
  (2.1.271).
- Comments and examples, tests included, name no live agent, instance, house
  or private commit any more: example identities are `alice`/`bob`, incident
  notes keep their date and measure; the default house list is `.claude` plus
  `$CLAUDE_CONFIG_DIR` (a `VALXOS_MAISONS` declaration replaces that default);
  `docs/QUARANTAINE.md` stays in the repository and leaves the npm package; the
  private-name guard itself stays out of the public tree.
- Everything the Messenger says is English now: CLI help, errors and outputs,
  the Facteur's acknowledgement line, the monitor's messages, and the
  `motif`/`message` prose of MCP and HTTP answers; the codes are unchanged.
  French verbs stay as the published `valxos-chaise` subcommands.
- The web door's page is English (labels, status lines, the tab title); routes,
  codes and styles are unchanged.
- The lockfile follows the dependency versions npm resolves today (MCP SDK
  1.32.1).
- `valxos-messenger install` creates the office (`~/.valxos-messenger`, or the
  one `VALXOS_MESSENGER_HOME` names) so the doctor that follows has one to
  read.
- `tools/export-public.js` applies the exclusions listed in `.export-exclude`
  by default.
- The Stop hook's reason frames the letter excerpt as untrusted text.

### Deprecated

- The ten `cc2cc-*` executables stay published as legacy aliases of the
  `valxos-*` commands (22 entry points in all).

### Fixed

- Web door: the composer's default destination counts chairs in service again
  (`chaises` was dropped when a mailbox was normalised; the default fell back
  to alphabetical order).
- `valxos-web`, `valxos-migrate-home` and `valxos-monitor` answer `-h`/`--help`
  and refuse unknown flags before opening anything.
- `valxos-messenger doctor` passes its flags to `valxos-doctor` (`--reap` was
  silently dropped).
- `valxos-doctor` creates nothing: without an office it reports
  `dbExists: false`.
- `uninstall` removes only the CLI links that point at this package's own `bin`
  targets; a same-named link to anything else is kept and listed.
- `uninstall` no longer advises `--force` for a CLI path that is not a symlink;
  it leaves it in place.
- The Python monitor creates the office directories `0700`, like the Node side,
  and its own files private (`0600`).
- The web door serves its page from a path that contains a space.
- The web door tightens an existing `web.env` to `0600` when it loads it.
- A forged opening `<cross-session-message` tag in a letter body is neutralised
  like the closing one; the context header says letters are untrusted text.
- MCP `send` and `valxos-send` with a declared sender set to the caller's own
  human address or old name post the letter once (it was posted twice, then
  refused).
- The npm package never carries Python bytecode (`__pycache__/`), which held
  absolute source paths.
- Long help and error texts are no longer cut when piped
  (`valxos-chaise -h | less`).

### Known limitations

- Every door trusts the caller's environment for its derived identity
  (`VALXOS_SELF`); two plain clients that share a name share one mailbox.
- A plain client's `VALXOS_SELF` must not be a lineage that Claude sessions use:
  its inbox would stay empty by design.
- Nothing marks a dead chair automatically: after a session restart that changes
  its id, lineage mail is held until `valxos-chaise moissonner` and
  `valxos-chaise designer` (a human gesture).
- Re-pointing an alias keeps the first `depose_at` as the history bound.
- `run/chaises-refusees/` keeps one empty marker per refused (reason, session,
  sub-agent, pid) and is not pruned.
- A PostToolUse hook runs `ps` twice and one resolution per call: well inside
  the 3 s hook budget on an idle machine, worth knowing on a loaded one.
- The MCP server runs under the `node` Claude Code finds, which may differ from
  the one that built better-sqlite3 (nvm); the installer cannot see that.
- `list_peers` shows every peer's project path, pid and session name to any
  connected MCP client (SECURITY.md).

## [1.0.0-rc.3] — 2026-08-29

### Added

- `valxos-messenger install --launchd` writes the launchd plists of the
  Facteur (`com.valxos.messenger.facteur`) and the web door
  (`com.valxos.messenger.web`) under `~/Library/LaunchAgents/`, rendered
  from the templates in `scripts/launchd/`. `--launchd-load` also runs
  `launchctl bootstrap` on them; `--operator NAME` sets the web door's
  operator. Every written plist carries a marker: `--uninstall` removes
  marked plists only, and a foreign plist at one of our paths is refused
  unless `--force` moves it aside with a timestamped backup.
  `--dry-run --launchd` prints the files and writes nothing.
- `tools/export-public.js`, the replayable public export: it makes the working
  tree of the export repository equal to one commit of this repository — the
  file set of `git archive`, read from the object store, byte for byte with
  the executable bits; a replay is a no-op; a dirty target is refused and
  `--force` overrides only that; `--dry-run` prints the plan. The export is a
  pure mirror: nothing target-only survives a sync except `.git/`. A path that
  changes kind between two commits (a tracked file becomes a directory, or the
  reverse) is planned, and anything untracked standing in the way is refused
  before the first byte moves. The commit line it prints names the repository,
  not the checkout (`--name` overrides). `tools/` is outside the `files`
  whitelist, so the exporter never ships in the npm package;
  `test/export-public.test.js` is its contract.
- The front door — `CONTRIBUTING.md`, `SECURITY.md`, `.editorconfig`, the
  GitHub issue and pull request templates, `dependabot.yml` — is tracked
  here, no longer only in the public export where it drifted at once.
  `test/docs-front-door.test.js` keeps every link, anchor and cited fact
  honest. These files stay out of the npm tarball: README, LICENSE and
  CHANGELOG are enough for the package.

### npm publication readiness

- `package.json` now carries everything the registry needs: `repository`
  (`git+https://github.com/valx-vex/valxos_messenger.git`), `homepage`,
  `bugs`, a fuller `keywords` list, `engines.node >=20` (the floor of
  `better-sqlite3` 12, which publishes no build below Node 20; the code in
  `src/` itself needs nothing beyond Node 16.9), `publishConfig.access:
  public`, and `prepublishOnly: npm test` — no publication without a green
  suite.
- An explicit `files` whitelist: `src/`, `scripts/`, `docs/`,
  `.claude-plugin/`, `skills/`, `hooks/`, `monitors/`, `mcp.json`, the
  READMEs, `LICENSE`, `CHANGELOG.md`. The tarball no longer carries
  `test/` (51 files) or `.github/`.
- `src/bin/valxos-messenger.js` is executable in the git index (mode
  100755) like every other published command; it was 100644.
- `test/package-publishable.test.js` freezes all of the above: manifest
  coherence (version in `package.json`, `package-lock.json`,
  `.claude-plugin/plugin.json`, and this file), the SPDX identifier of every
  header against `license`, the `bin` shebangs and git modes, the
  `npm pack --dry-run` listing, and the one-command dry-run executed from an
  extracted tarball with and without `CLAUDE_CONFIG_DIR`.

### Fixed

- `valxos-messenger install` (and `scripts/install.js`) crashed with
  `ReferenceError: Cannot access 'claudeHome' before initialization` whenever
  `CLAUDE_CONFIG_DIR` was not set — the rc.2 default path. The fallback is
  `~/.claude` again. The same line used `require` in an ES module as the
  fallback for an unset `HOME`; it now uses `homeDir()` from `config.js`.
- The MCP server announced `version: "0.1.0"` to every client while the
  package was 1.0.0-rc.2 (`src/mcp-server/server.js`). It now reads the
  version from `package.json` at start — one truth; the suite checks it on
  the running server.
- `npm publish --dry-run` broke its own gate: `prepublishOnly` → `npm test`
  inherits `npm_config_dry_run=true`, so the proof's nested `npm pack` wrote
  no tarball and the suite went red. The test helper neutralises the
  inherited flag; an explicit `--dry-run` argument still wins.
- The documented one-command install did not work from the registry:
  `npx valxos-messenger …` asks npm for a *package* named after the command
  (E404). The READMEs and `docs/INSTALL_ONE_CLICK.md` now say
  `npx --package valxos_messenger valxos-messenger …`, and a test reads every
  `npx` line of the published documents.
- Under `CLAUDE_CONFIG_DIR`, the installer created `$CLAUDE_CONFIG_DIR/skills`
  but linked the plugin into `~/.claude/skills/cc2cc-v2` — `ENOENT` on a real
  install, a false success on `--dry-run`, and a doctor looking elsewhere.
  `claudeHomeDir()` in `src/lib/config.js` is now the single rule for the
  directory, the link, the summary, the uninstall, and the doctor.
- The installer decided to run `npm install` by testing the existence of
  `<package>/node_modules` — from an npm-installed (hoisted) package that
  directory does not exist, and `npm install` ran inside
  `node_modules/valxos_messenger`. Dependencies are now resolved the way
  Node loads them; `npm install` runs only when one is missing, and never
  from a package that lives under `node_modules` (that case is refused and
  named).
- The README's `## Known limitations` was an empty heading while the bug
  template, `config.yml` and `SECURITY.md` send readers there. The list is
  back and checked line by line against the code: the existence oracle of
  `/api/accuser` (`404 lettre-inconnue`, `403 pas-mon-courrier`), one
  operator per door, at-least-once delivery, no quarantine, incomplete
  harness parity, the three honest sets of the web guard, the
  `docs/FACTEUR.md` anchor. One sentence was checked by measurement rather
  than by grep: no `synchronous` pragma exists in `src/` (WAL, `busy_timeout`
  and `foreign_keys` only), yet `synchronous=NORMAL` is what the database
  really runs — better-sqlite3 compiles `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`,
  so WAL mode defaults to NORMAL. The sentence stays, stated as the compiled
  default, in both READMEs; `test/durabilite-sqlite.test.js` opens the
  product's own database in a throwaway office and reads the pragma, so the
  word follows the engine if the dependency ever changes its default. (A
  first correction on this branch had called the sentence false: the grep
  was right, the conclusion was not.) `README.fr.md` loses "la gate
  n'utilise pas `npm test`", which contradicted `scripts.test`.
- A literal U+0000 byte lived in `src/web/serveur.js` (`signatureDeLaLettre`)
  and in `test/web-garde-spawn.test.js`. git and GitHub saw text (the byte was
  past the first 8000), but `file` said "data" and BSD `grep` treated both
  files as binary: every grep on the door's server answered nothing, without
  a word. The escape `\0` produces the same string; a guard in
  `test/surfaces.test.js` now refuses any 0x00 byte in a tracked text file.

### Changed

- `npm test` is `node --test test/*.test.js` — the CI's own gesture. Bare
  `node --test` walks the tree: on the main checkout it globbed 12 stale
  copies under `tmp/…/test/`, the origin of the "997 tests" figure.
  `prepublishOnly` stays `npm test`.
- No test count is written in prose any more — README, README.fr,
  CONTRIBUTING, the pull request template: the gate is the phrase
  `node --test test/*.test.js`, `npm test` runs exactly that command, and the
  suite prints its own count. `test/surfaces.test.js` and
  `test/docs-front-door.test.js` refuse a number.
- The README gains a Contributing section: the French wall, `CONTRIBUTING.md`,
  `SECURITY.md`.

### Known limitations for public release

- The web door is a counter, not a mailbox: the browser collects mail,
  but the Facteur does not deliver into it.
- Harness parity is incomplete: MCP and CLI are general interfaces;
  hooks, monitor, and the default house inventory are Claude Code-specific.
- Six tests require `/bin/ps` for process liveness probes; they fail in
  environments where `/bin/ps` is restricted. These tests pass on a normal
  macOS or Linux install.

## [1.0.0-rc.2] — 2026-08-26

Tag `v1.0.0-rc2`. The rc1 adversarial re-verdict (2026-08-26) was a
NO-GO; this candidate answers it. Tests: 997/997 on that checkout, meta-suites
included.

### Fixed

- The class guard (`test/class-guard.test.js`) scanned `.claude/` (Claude
  Code worktrees and caches inside the checkout) and `.superpowers/`
  (local-only ledgers): 308 false positives on the release commit itself. Both
  directories are skipped, and the walk is unit-tested — it never enters the
  harness's own directory.
- `valxos-messenger install --dry-run` really ran `claude plugin validate`;
  it now prints what it would run, like `enable` already did.
- `valxos-migrate-home`'s operator check tolerates an indented
  `VALXOS_WEB_OPERATEUR` key in `web.env`.

### Changed

- The installer creates the plugin's `skills` directory under
  `$CLAUDE_CONFIG_DIR` when the launcher sets it (a machine may host several
  homes), else under `~/.claude`.
- The postbox probe child (`src/lib/postbox.js`) gets a minimal environment
  (`PATH`, `HOME`, `TMPDIR`, `LC_ALL=C`, `TZ=UTC`), never the parent's
  whole environment.

### Added

- `cc2cc-migrate-home`, the deprecated alias of `valxos-migrate-home`,
  published like every other historical name: 22 CLI entry points, README and
  lock in step.

### By design

- The framed 401 of the web door keeps its `frame-ancestors`: it is the
  door's own help page, and the allowed origins come from the operator's
  `web.env`.

## [1.0.0-rc.1] — 2026-08-26

### Release candidate

First release candidate. The product is installable from scratch by following
the README; `valxos-doctor` reports an honest verdict; the home migration
(`valxos-migrate-home`) is dry-run capable, non-destructive, and idempotent;
and a one-command installer (`valxos-messenger install`) provides a `--dry-run`
path that can be tested without touching launchd.

### Added

- `valxos-messenger` — a single-command entry point for install, uninstall,
  and doctor. Supports `--dry-run` (prints what would be done, changes
  nothing) and `--uninstall` (removes links, preserves runtime data).
- `valxos-messenger install` separates core install (CLI links, plugin
  symlink, npm dependencies) from optional Claude Code integration
  (plugin validate/enable). A machine without Claude Code gets a green
  core install.
- `valxos-doctor` now reports Facteur daemon state (lock file presence)
  and web door configuration (`web.env` existence). These are informational;
  `ok` still means the installation is complete, not that all services are
  running.
- Class guard test (`test/class-guard.test.js`) — scans the entire tree for
  machine-specific identifiers (Tailscale IPs, hostnames, session names,
  home paths) and fails if any are found.
- `docs/INSTALL_ONE_CLICK.md` — specification for the full one-click install
  path, including launchd plist templates and MCP server registration.

### Changed

- Version bumped from `0.1.0` to `1.0.0-rc.1` in `package.json` and
  `.claude-plugin/plugin.json`.
- `scripts/install.js` rewritten: core/optional separation, `--dry-run`,
  `--uninstall`, human-readable summary alongside the JSON report. The
  installer no longer hard-fails when `claude plugin enable` is unavailable.
- Author attribution changed from persona names to `VALXOS contributors`.
- README rewritten with: a product description, a text schema, the harness
  matrix (proven vs promised), the verified install section, the mail
  delivery laws, and a "What it is not" section.

### Removed

- Tailscale IP address from test fixtures — replaced
  with a generic private IP (`10.0.0.42`).
- House session name reference from a test comment.

### Historical context

This project has gone through three names:

1. **CEREAL** — the original internal name for a local durable post
   office between coding sessions.
2. **cc2cc-v2** — the second iteration; it was the plugin and MCP server
   identifier until 1.0.0 and remains the root of the `cc2cc-*`
   compatibility aliases.
3. **valxos-messenger** — the public name: the npm package, the GitHub
   repository and, from 1.0.0, the Claude Code plugin id. The MCP server
   identifier is `valxos_messenger`. Public paths and commands use
   `valxos-*`; `cc2cc-*` aliases remain for compatibility.

The rename from CEREAL to cc2cc-v2 was structural (new protocol, new
schema). The rename from cc2cc-v2 to valxos-messenger changed the names
(package, plugin id, commands, office directory `~/.cc2cc-v2` →
`~/.valxos-messenger`, bridged by the Phase A symlink or copied by
`valxos-migrate-home`); the legacy plugin link and the `cc2cc-*` aliases
stay for compatibility.
