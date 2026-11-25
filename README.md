# VALXOS Messenger

[Lire en français](README.fr.md)

A local, durable post office between coding sessions. A session writes a
letter to SQLite; the Facteur attempts delivery across restarts until the
recipient acknowledges it. Works with Claude Code natively; any agent that
can run a command can post and collect mail.


## At a glance

- **License:** GNU Affero General Public License v3.0 only
  (`AGPL-3.0-only`).
- **Runtime:** fully local — SQLite and Unix sockets, with no external service.
- **Dependencies:** 3 direct runtime dependencies
  (`@modelcontextprotocol/sdk`, `better-sqlite3`, and `zod`), 0 development
  dependencies, and 130 dependency package entries in `package-lock.json`.
- **Interfaces:** an MCP server and 27 CLI entry points work from any shell;
  Claude Code also gets native hooks and a monitor; Codex gets hooks and a
  doorbell.
- **Evidence:** From a clone of the repository (the test suite does not ship
  in the npm package): the gate is `node --test test/*.test.js`; `npm test`
  runs exactly that command, and the suite prints its own count.

## Schema

```
  ┌──────────┐    writes    ┌──────────┐   carries    ┌───────────┐
  │  Session │ ───────────► │  Broker  │ ───────────► │  Facteur  │
  │ (agent) │              │ (SQLite)  │              │ (daemon)  │
  └──────────┘              └──────────┘              └─────┬─────┘
       │                         │                          │ delivers
       │ reads                   │ reads                    ▼
       │                    ┌──────────┐              ┌───────────┐
       └──────────────────►│  Guichet │              │  Mailbox  │
                             │  (MCP)   │              │ (socket)  │
                             └──────────┘              └───────────┘
                                  │                          │
                                  │ hooks                    │ acks
                                  ▼                          ▼
                             ┌──────────┐              ┌───────────┐
                             │  Hooks   │              │  Letter   │
                             │ (Claude) │              │  acked    │
                             └──────────┘              └───────────┘
                                  │
                                  ▼
                             ┌──────────┐
                             │ Web door │  ← operator reads/writes
                             │ (loopback)│
                             └──────────┘
```

- **Broker** — SQLite database; the durable letter store.
- **Facteur** — daemon that carries letters from the broker to mailboxes.
- **Guichet** — MCP server; the counter where agents post and collect.
- **Web door** — local-only HTTP page where one operator reads and writes.
- **Hooks** — Claude Code and Codex session hooks that inject pending mail and gate stops.

## Harness support

| Harness | MCP | CLI | Hooks | Monitor | Woken by the Facteur | Status (evidence) |
|---|---|---|---|---|---|---|
| **Claude Code** | ✓ | ✓ | ✓ | ✓ interactive only | yes, interactive sessions (see details) | **Proven on 18/10/2026 with Claude Code 2.1.302**: MCP, CLI and the three hooks in headless (`claude -p`) and interactive sessions; the monitor is armed in interactive sessions only, not under `claude -p` ([details](docs/MCP_CLIENTS.md#claude-code)) |
| **Codex CLI** | ✓ | ✓ | ✓ since 1.1.0 | — | yes (seen live on a scratch home, 22/10/2026) | **Proven on 18/10/2026 with codex-cli 0.162.1**, headless `codex exec`: the MCP round trip and the CLI, provided the server entry sets `default_tools_approval_mode = "approve"`. **Proven on 21/10/2026 with codex-cli 0.163.0**, against a scratch Codex home with a local model: `codex queue` woke an idle interactive session, and the woken model called `inbox` and saw the letter; the same day, on the authors' desktop app, a queued message woke an open thread, and `open codex://threads/<uuid>` reopened the closed app on it. **Seen live on 22/10/2026 with codex-cli 0.163.0**, on a scratch Codex home (TUI, a local model, hook trust bypassed, the hooks written by `install --codex --write`): a letter rang the shipped hook and the Facteur's door end to end — `codex queue` 0.35 s after the letter, an autonomous turn 5.7 s after the letter, the letter injected by `UserPromptSubmit`, the model calling `inbox`. Not seen: the hooks in the desktop app, the `/hooks` approval of the hooks the installer writes, the door opening a closed app ([details](docs/MCP_CLIENTS.md#codex-cli); [what was seen](docs/MCP_CLIENTS.md#codex-hooks-and-the-doorbell)) |
| **Gemini CLI** | ✓ | ✓ | — | — | no | **Proven on 18/10/2026 with Gemini CLI 0.58.0**, headless: the MCP round trip from a project `.gemini/settings.json`, in a trusted folder (`GEMINI_CLI_TRUST_WORKSPACE=true`) with API-key auth; interactive mode was not tested ([details](docs/MCP_CLIENTS.md#gemini-cli)) |
| **Antigravity CLI (agy)** | ✓ | ✓ | — | — | no | **Proven on 18/10/2026 with agy 1.3.5**, headless only (`-p --sandbox --dangerously-skip-permissions`): the MCP round trip from a workspace plugin (`<project>/.agents/plugins/<name>/`); every server of agy's global config also starts; agy 1.4.2 and the TUI were not tested ([details](docs/MCP_CLIENTS.md#antigravity-cli-agy)) |
| **OpenCode** | ✓ | ✓ | — | — | no | **Proven on 18/10/2026 with OpenCode 1.18.30**, headless `opencode run` only: the MCP round trip from a project `opencode.json` `mcp` entry (`type: "local"`); the TUI was not tested ([details](docs/MCP_CLIENTS.md#opencode)) |
| **Hermes** | ✓ | ✓ | — | — | no — next turn | **Proven on 25/08/2026**, MCP and CLI, before 1.0.0; the wiring was not re-verified for 1.0.0 ([details](docs/MCP_CLIENTS.md#hermes)) |
| **Any other MCP client** | ✓ | ✓ | — | — | no | **Promised** — no harness-specific test |

`valxos-inbox` shows up to 20 unacknowledged letters (`--limit N`); acknowledge
with `valxos-inbox --ack <msg_id>` so the next ones surface.

Each status dated 18/10/2026 means: on that date, on macOS, against a scratch
office, `whoami`, `send`, `inbox`, `ack` and `history` ran through the
harness over MCP, and the CLI read or wrote the other side of the letter.
A status dated 21/10/2026 means: on that date, on macOS, against a scratch
Codex home with a local model, `codex queue` woke an idle session, and the
hook events (answered by a stand-in hook script) behaved as the schemas
embedded in Codex describe them; and, on the authors' desktop app, a queued
message woke an open thread,
and `open codex://threads/<uuid>` reopened the closed app on its thread. A
status dated 22/10/2026 means: on that date, on macOS, on a scratch Codex home
with a local model and hook trust bypassed, a letter went through the shipped
hook and the Facteur's door: `codex queue` rang the session and an autonomous
turn read the letter.

**What wakes a session.** Claude Code sessions and Codex sessions are woken;
every other harness collects. For Claude Code, the Facteur delivers to the
session's own messaging socket, and, on a wake, the plugin monitor prints it
(in interactive sessions); the hooks inject pending mail at session start,
after each tool call, and before a stop. The Facteur's push into a live Claude
Code 2.1.302 session was observed in the authors' house on 18/10/2026 (eight
letters delivered to the session socket by the previous release's courier,
whose connection logic the 1.0.0 courier keeps unchanged); the test suite
verifies the 1.0.0 courier against a stand-in socket; the in-session wake
through the plugin monitor was verified live the same day. Under `claude -p`
the monitor is not armed; the hooks still present mail. For Codex (with its
1.1.0 hooks installed; seen live once on 22/10/2026, on a scratch home), the Facteur rings the
chair with `codex queue` — an
envelope, never a letter body — and the Codex hooks inject the mail at the
next turn (see "Doorbell for Codex"). A quiet table letter (`low` priority, a
`prochain-tour` rule, a reaction in a `direct` table) wakes nobody: it waits
for the next turn. Every other harness collects its mail by calling `inbox`
(MCP) or `valxos-inbox` (CLI) itself; nothing rings. In the authors'
25/08/2026 setup, Hermes saw its mail at the start of its next turn through a
Hermes-side plugin that this package does not ship.

The monitor is Claude Code-specific; hooks exist for Claude Code and, since
1.1.0, for Codex. Any agent that can start a process can post and collect mail
through the CLI or any MCP client.

Per-client wiring — Claude Code, Codex CLI, Gemini CLI, Antigravity CLI,
OpenCode, Hermes: the config block that worked, the conditions, how the
peer's identity and office are declared, what was not tested, and a smoke
test for each — lives in [`docs/MCP_CLIENTS.md`](docs/MCP_CLIENTS.md).

## Install

**The easy way:** give this URL to your coding LLM — `https://github.com/valx-vex/valxos-messenger` (the repository is public; this README is the whole contract) — and tell it: "make it good in my setup". It reads this README, runs the installer, and wires the plugin into your harness.

**With npm:**

    npm i -g valxos-messenger --allow-scripts=better-sqlite3
    valxos-messenger install --dry-run   # preview
    valxos-messenger install             # install

npm 12 blocks dependency install scripts by default, and better-sqlite3 needs
its install script to download its prebuilt binary; `--allow-scripts=better-sqlite3`
allows that one script (the `npx` lines below carry it too). If the installer
says `native binding missing`, run the `npm rebuild` command it prints.

**From a clone** (or an extracted tarball):

```bash
npm install
node scripts/install.js
```

The installer creates CLI symlinks in `~/.local/bin/`, the Claude Code
plugin symlink, and the office (`~/.valxos-messenger`, or the one
`VALXOS_MESSENGER_HOME` names), so the doctor that follows has one to read.
With `--launchd` it also writes the two launchd plists. If Claude
Code is not installed, the core install still succeeds; the optional plugin
validation and enable steps report their absence without failing. The
`skills-dir` link written by `valxos-messenger install` and
`claude plugin enable valxos-messenger@skills-dir` were not exercised end to
end in a Claude Code session in this release; the plugin was verified from the
same tree with `--plugin-dir`.

Add `~/.local/bin` to your PATH if it is not already there:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
source ~/.zshrc
```

**Name each house.** Set `VALXOS_SELF=<name>` in the launcher of every harness
that starts the server or the hooks (and `VALXOS_SESSION_NAME` if you want
per-session names). Without it every session on the machine speaks under the
hostname and shares one name; `whoami` shows the name in use. Give each harness
its own name: a CLI or MCP client that uses a Claude Code lineage's name does not
read that lineage's mail while one of its chairs is alive (see
`docs/MCP_CLIENTS.md`).

Verify the installation:

```bash
valxos-doctor
```

The doctor reports an honest verdict: it checks the database, plugin
manifest, CLI links, and reports whether the Facteur daemon and the web
door are running. It never returns a false green.

Without a global install, `npx` runs the same installer from the published
package (the package is named explicitly, `valxos-messenger`):

```bash
npx --allow-scripts=better-sqlite3 --package valxos-messenger valxos-messenger install --dry-run    # preview
npx --allow-scripts=better-sqlite3 --package valxos-messenger valxos-messenger install              # install
npx --allow-scripts=better-sqlite3 --package valxos-messenger valxos-messenger uninstall            # remove links, keep data
```

To run the Facteur and the web door as launchd agents (macOS), add
`--launchd`: the installer writes `com.valxos.messenger.facteur` and
`com.valxos.messenger.web` under `~/Library/LaunchAgents/` and prints the
`launchctl bootstrap` commands to run; `--launchd-load` runs them for you.
Both plists pin `VALXOS_MAISONS`: the declaration the installer runs with, as
written, else your `~/.claude` path. They carry no `CLAUDE_CONFIG_DIR`: under
launchd the Facteur scans that list only, and the web door's `attente` advice
on a send uses that same list (see Known limitations). To declare your houses,
run the installer with the complete list, quoted so that your shell expands
`$HOME` and leaves a trailing `/*` alone:

```bash
npx --allow-scripts=better-sqlite3 --package valxos-messenger valxos-messenger install --launchd --operator alice   # write the plists
npx --allow-scripts=better-sqlite3 --package valxos-messenger valxos-messenger install --launchd-load               # write and load them
VALXOS_MAISONS="$HOME/.claude:$HOME/agents/*" npx --allow-scripts=better-sqlite3 --package valxos-messenger valxos-messenger install --launchd   # pin your houses
```

For Codex, `valxos-messenger install --codex --self <name>` prints the hooks
and the MCP entry to put in `$CODEX_HOME`, and writes them only with `--write`
(see "Doorbell for Codex").

To carry letters between two Macs over ssh, see [`docs/RELAIS.md`](docs/RELAIS.md):
the relay is optional, and its launchd service is written only by
`install --relais --write`, never by a default install or `--launchd`.

Details, re-runs, and removal: [`docs/INSTALL_ONE_CLICK.md`](docs/INSTALL_ONE_CLICK.md).

### Published commands

```text
valxos-send          valxos-peers         valxos-inbox
valxos-unregister    valxos-chaise        valxos-monitor
valxos-doctor        valxos-web           valxos-migrate-v1
valxos-migrate-home  valxos-table         valxos-history
valxos-messenger     facteur              valxos-relais
```

The twelve `cc2cc-*` executables are deprecated aliases for the same programs.
Together with the thirteen `valxos-*` names, `valxos-messenger`, and `facteur`,
the package publishes 27 CLI entry points.

`valxos-messenger` is the public name: the npm package and the GitHub
repository. The MCP server announces itself as `valxos_messenger`, an
identifier. The Claude Code plugin and its MCP server key are
`valxos-messenger`. `cc2cc-v2`, formerly CEREAL, was the former plugin and
server identifier; it remains the root of the compatibility aliases.

## Delivery model

This is not instant messaging. A sending session deposits a letter in a
durable SQLite office; the Facteur attempts delivery; monitors, hooks,
MCP tools, or CLI commands present it to the recipient. The letter
remains available across restarts without requiring a person to copy it
between sessions.

Three rules define the system:

1. **At-least-once delivery.** A duplicate is preferred to a lost
   letter. The system does not promise exactly-once delivery.
2. **No acknowledgement means the letter eventually returns.** There is
   no terminal dead state, infinite quarantine, or deletion that hides a
   letter. Deferrals and leases are finite; only acknowledgement is
   terminal.
3. **Records are not erased.** Removing a peer marks it out of service.
   Letters, attempts, events, and forwarding records remain in the
   registry.

Three markers describe different facts:

| Term | What it proves | Marker |
|---|---|---|
| **carried** | the mailbox accepted the bytes | `messages.carried_at` |
| **delivered** | a carrier reports preparing recipient context | `messages.delivered_at` |
| **acknowledged** | the authorized recipient acknowledged the letter | `messages.acked_at` |

`carried_at`, `delivered_at`, and `injected_at` are historical
observations. They never hide a letter. Only `acked_at`, set by an
authorized recipient, is terminal.

### When Claude Code holds the doorbell

Claude Code can hold a message from another session before it reaches
the model. It does so when the receiving session bypasses permission
prompts (`--dangerously-skip-permissions`, or the bypass mode) and the
sender has not attested a matching permission mode. The Facteur is a
daemon, not a session: it has no permission mode and does not claim one.
So in such a session, each doorbell can open this prompt (seen on Claude
Code 2.1.331 and 2.1.332, 2026-11-25; the socket path shortened here):

```text
Held message from another session
Another Claude session sent a message: from uds:… [verified pid …]
The sender did not attest its permission mode, and this session
bypasses permission prompts.
Message body (this is what will be delivered): …
Deliver by default: /config → Messaging → Messages from your other sessions
❯ Deny — drop it and tell the sender it was declined
  Deliver this message to Claude
ctrl+x a to always deliver ›
```

The letter is not lost. The monitor and the Claude Code hooks still show
it to the session, and `inbox` reads it at any time. On 2026-11-25, in a
fresh install, the monitor showed the letter at once, and the session
answered and acknowledged it while the doorbell was still held. Only the
doorbell waits for a choice, and the doorbell is what wakes an idle
session. What to do about it is the user's choice:

- always deliver, from that prompt (`ctrl+x a`);
- set Claude Code's `crossSessionInbound` setting to `"accept"`
  (`/config` → Messaging → Messages from your other sessions);
- leave those sessions' houses out of the Facteur's `VALXOS_MAISONS`. The
  Facteur then stops ringing there: its journal says `maison-inconnue`,
  and the letters arrive through the hooks and the monitor, without
  waking an idle session;
- or answer each prompt.

## Addressing and route

A **house** is a local installation, an **instance** is a live session,
a **lineage** is the durable name to which mail is addressed, and a
**chair** is an instance's place within that lineage. If several live
chairs claim the same lineage, the letter waits for a human designation
(`valxos-chaise designer`): the office never draws lots. Once a chair is
designated it receives the lineage's mail, and every other live chair of
the lineage sees a cc copy, never delivered and never to be acknowledged.

The courier scans Claude Code installation directories to discover live
chairs. By default it scans `~/.claude` and, when set, `$CLAUDE_CONFIG_DIR`.
A `VALXOS_MAISONS` declaration (colon-separated absolute paths, written out in
full as `echo "$HOME/.claude"` prints them: the Messenger expands neither `~`
nor `$HOME` in this value, and a launchd plist does not either;
`CC2CC_MAISONS` is the historical alias) replaces that default list; it does
not add to it. `$CLAUDE_CONFIG_DIR` is dropped too: put your `~/.claude` path
in the declaration if you still want that home scanned, and include your
`CLAUDE_CONFIG_DIR` path if you still want it scanned. An entry that ends in
`/*` is a street of houses: every directory directly under that path is a
house (a link to a directory too; files and broken links are skipped; the
order is sorted). The street is read again at each round, so a house created
after the Facteur started is scanned without a restart. An entry without `/*`
is that one house, and nothing else in the value is expanded.

Export the same `VALXOS_MAISONS` in the environment of your sessions too (your
shell profile, or the `env` block of the MCP server entry): `send` works out
its `attente` advice in the sending session's own environment, and without the
declaration it may say `maison-inconnue` for a chair the Facteur does deliver.
A street must be a directory only you can write to: every directory created
under it becomes a house the Facteur scans.

Reservation, lease, retry, rate-limit, and shutdown details are in
[`docs/FACTEUR.md`](docs/FACTEUR.md) (in French).
The courier's design doctrine (it delivers, it never judges) is in
[`docs/DOCTRINE_FACTEUR.md`](docs/DOCTRINE_FACTEUR.md) (in French).

## Tables

A **table** is an address book, not a mailbox: a named list of members (a
lineage, a chair `name#session`, a human address `name@label`, or a bare card
such as the web door's operator) with a wake rule, a mode (`normal` or
`direct`), a closed flag and a shared position. Sending to `table:<name>`
posts **one letter per member**, the sender excluded under every name it goes
by; the letters share an `envoi_id`, and each one keeps its own recipient, its
own route and its own acknowledgement, exactly like a letter sent to that
member alone. No letter is ever "at the table": withdrawing a member marks the
membership, nothing is erased, and a table is never deleted.

Who is woken is decided at the counter and written on each letter
(`sans_reveil`, with its reason in `motif_reveil`):

- `high` and `critical` always wake; `low` never does.
- `reveiller: ["<member>", ...]` on `send` or `reply` wakes the members it
  names (except at `low` priority). A member is named by the address the
  table lists, the full form of a short chair, its lineage, or, for a member
  listed as a lineage, one of its chairs (a chair the office knows: an unknown
  `lineage#…` wakes nobody); a sister chair does not wake it. `reveiller` takes
  50 names of 200 characters at most (`refus: "parametre-invalide"` beyond).
- A reply in a `direct` table is a quiet reaction: nobody is woken; the next
  beat wakes.
- Otherwise the member's own rule, then the table's: `reveil` (wake) or
  `prochain-tour` (next turn).

These are the rules of a table letter. A direct letter is carried and rung as
in 1.0.0 whatever its priority, `low` included (on a Codex chair a ring starts
a turn); only the Stop safety net never holds a stop for a `low` letter.

A quiet letter is not carried by the Facteur and never holds a stop: it
arrives at the next session start, tool call or `inbox`, through the hooks
like any other letter.

A **closed** table (`valxos-table creer <name> --fermee`, or
`valxos-table fermer <name>`) is listed to its members only, its members
change only through `valxos-table`, its position is hidden from non-members,
and its letters never give a cc copy to another chair of a member's lineage
(`sans_copie`): while such a letter waits for a designation, nobody else sees
it. A direct `reply` to such a letter keeps `sans_copie`: the answer never
reaches another chair of the author's lineage as a cc copy either. `history`
(MCP and `valxos-history`) leaves such a letter out for a reader who is
neither its recipient, nor the chair that posted it, nor a member of the
table (the reader is the identity from the environment, never a declared
`self`), and the author's rights (`reply` as its sender, `envoi_status`) belong
to the chair that posted the letter, not to its bare lineage. An **enclosure** (`valxos-table enclos <sender> <name>`) binds a sender to
one closed table it belongs to: every letter of that sender to anybody outside
the table is refused before any letter is written (the sender's peer card may already be recorded by then; `refus: "hors-enclos"`, with
`enclos` and `destinataires_refuses`, 20 at most, `autres` counting the rest),
unless the call says `hors_enclos: true` (`--hors-enclos` on `valxos-send`).
While the enclosure holds, the table cannot be reopened and the sender cannot
be removed from it (`table-sous-enclos`); `valxos-table enclos --retirer
<sender>` lifts it. An enclosure holds one table at a time: setting it on
another table while it holds is refused (`enclos-existe`), under any of the
sender's forms too (its lineage, a chair, a short chair, a human address), and
an office that already holds two such enclosures in different tables refuses
that sender's letters (`refus: "enclos-conflit"`, with `tables`) until one is
lifted. The enclosure is a seatbelt for a sender who asked for it,
not a boundary against a process that chooses to step out
([SECURITY.md](https://github.com/valx-vex/valxos-messenger/blob/main/SECURITY.md)).

The MCP tools: `send` with `to: "table:<name>"` answers with the table, the
`envoi_id`, a `count` and one result per member (`to`, `msg_id`, `wake`,
`sans_reveil`, `motif_reveil`); `reply` answers a letter to its author — its
chair when known — in the letter's thread, or to its whole table with
`toute_la_table: true` (the default in a `direct` table, where
`toute_la_table: false` brings it back to the author); `tables` lists the
tables you belong to (`membre: true`) and the open tables you could join
(`membre: false`); `table_manage` creates an open table, joins or leaves one,
adds or removes another member of a table you belong to, sets a wake rule,
switches a table you belong to between `normal` and `direct`, and updates its
shared position; `envoi_status` gives the states of one send, member by
member — `cree`, `sonne`, `montre`, `accuse`, never "read": only the
acknowledgement means seen and handled — and the Facteur's last attempt for
each letter (`tournee: { state, reason, at }`). Closed tables and enclosures
are a human gesture: `valxos-table` only (`table_manage` answers
`table-fermee`). In letter lines (`inbox`, `history`, `valxos-inbox`),
`table` is the table's name; in a send's answer it is the table itself.

A letter of a table shows `Table: <name> (<mode>) · position: "<text>"` in
its header. The position is 120 characters at most (code points). Any member
can set it, so it is untrusted text like a subject, and the header quotes it
as a JSON string.
`valxos-history --thread <id> | --table <name> | --envoi <id>` exports your
own side of a conversation as markdown, or as JSON with `--format json`. JSON
lists every letter; markdown folds the letters of one table send into one
entry, and its count line counts entries.

Two quieter things ship with the tables. A letter that was presented and not
acknowledged comes back with `Reminder: <n>` in its header, and the reminders
space out: where 1.0.0 brought an unacknowledged letter back every 10 minutes,
1.1.0 brings it back after 10, 20, 40, then every 60 minutes. `From:` shows
the sending chair's name when it has one, in the hooks' and the monitor's
header — `From: alice (atelier)` — and a chair can be addressed by its
lineage and the first eight or more hexadecimal characters of its session id,
`alice#<prefix>`, when exactly one chair in service matches; when several
match, the letter waits (`attente.motif: "chaise-ambigue"`).

## Doorbell for Codex

Since 1.1.0 a Codex session can be rung. Three pieces, all in this package:

1. **The Codex hook** (`src/hooks/codex/codex-hook.js`): one executable for
   Codex's `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `Stop`
   events. The installer writes its command with an absolute `node`, the
   identity and the office inline (`env VALXOS_SELF=<name>
   VALXOS_MESSENGER_HOME=<office> …`) and `--serves <name>`; a hook whose
   identity is not served answers `{}` and opens no office. It injects pending
   letters as context framed as untrusted text (8,000 characters at most, its
   preamble included), marks them delivered and never acknowledges them (one
   exception: a letter that had to be cut is shown cut, with a mark that says
   so, announced and never marked delivered; the `inbox` tool reads it), and
   holds a stop for unread `high` or `critical` mail only, three times at
   most, with the envelope as its reason.
2. **The chair card**: at a session's first turn, `SessionStart` writes
   `<office>/codex/<lineage>.json` (the thread id, the `CODEX_HOME`, the pid,
   the door) and records the thread as the session of the lineage's card, so
   `list_peers`, `valxos-peers` and `valxos-doctor` show the Codex chair and
   its door (`porte`).
3. **The Facteur's Codex door** (`src/facteur/porte-codex.js`): when a letter
   leads to a chair that has a card, the round runs
   `codex queue --thread <thread id> --message <envelope>` under that
   `CODEX_HOME`, five seconds per attempt, with one retry, and marks the
   letter carried when the queue took the envelope. The
   letters waiting for one chair in a round share one envelope, and a letter
   the queue took is never rung again. The envelope is one English line —
   sender, chair name, table, subject cut at 60 characters, priority, how many
   other letters wait — and **never a letter body**: a queued message reaches
   the model as the user's own words. The letter itself arrives through the hooks and
   `inbox`, framed as untrusted text.

When no active session holds the thread, or when the queue took the envelope
while the desktop app is closed (`lsappinfo find bundleid=com.openai.codex`),
the Facteur opens the app on the thread (`open codex://threads/<uuid>`,
macOS), once per letter, and only for a chair whose door is `app`. The door is
the session's `VALXOS_CODEX_PORTE`: unset means `app` (the desktop app has no
launcher), and a terminal launcher should export `VALXOS_CODEX_PORTE=cli`;
`install --codex --porte app|cli` pins one door for every session of that
Codex home. `VALXOS_CODEX_OUVRIR_APP=0` turns the opening off. A new letter
keeps its own opening even when it shares an envelope with an older letter
that already had one. It never runs
`codex exec resume`: that would start a paid turn with nobody at the keyboard.

Install it with `valxos-messenger install --codex --self <name>`. Without
`--write` it prints the three pieces for `$CODEX_HOME` — `[features] hooks =
true` and the `[mcp_servers.valxos_messenger]` entry in `config.toml`, the
four hooks in `hooks.json` — and changes nothing; `--write` backs each file up
with a dated suffix, merges, and prints the diff (a value already there is
never changed, and a conflict writes nothing). Codex runs a new hook only after
you approve it once in `/hooks`. `valxos-doctor` shows the chair cards,
whether their process is alive, and the `codex` version. Wiring, conditions
and the smoke test:
[`docs/MCP_CLIENTS.md`](docs/MCP_CLIENTS.md#codex-hooks-and-the-doorbell).

What the doorbell does not do: after **Escape** in the Codex TUI the queue
freezes until the next prompt typed by a human — the Facteur cannot know it;
the letter stays carried, and the hooks inject it at that prompt. A letter
the queue took is not rung again: if it stays unacknowledged, the hooks bring
it back. Before a session's first turn `codex queue` cannot reach it
(`no rollout found`). When a ring fails — no `codex` on the Facteur's PATH, a
`codex` that hangs past five seconds, a thread no session holds — the letter
waits for a
later round, the hooks present it at the next turn, and `envoi_status` shows
the round's reason, `sonnette-codex-impossible`, for a table send (the
Facteur's journal says it for any letter). There is no door to the iPhone
app.

## The web door

`valxos-web` serves one local page, without a framework or third-party
browser dependency, where one configured operator can read and write
mail. Each letter carries a single stamp that fills in four steps, the values
`en attente`, `au guichet`, `reçue` (the delivery observation) and `accusée` of
the API's `etat` field; the page shows them under their English labels,
**Waiting**, **Carried**, **Delivered** and **Acked**, and a letter *en
souffrance* (not acknowledged, past its age or attempt threshold) reads
**Overdue**. The server refuses to listen outside the loopback interface. Any
network exposure must be provided and protected separately.

Opening the page (or `GET /api/fil`) acknowledges ordinary letters to the
operator (`message` type, priority `low` or `normal`); `high`, `critical` and
every other type wait for the Acknowledge button.

`POST /api/poster` accepts `a: "table:<name>"` (the prefix in any case): the
door posts through the same counter as the MCP `send`, one letter per member,
and answers `destinataire`, `table`, `envoi_id`, `count` and `results`, one
entry per member in the shape of the MCP answer. A refused send answers
`403 hors-enclos` (with `enclos` and `destinataires_refuses`),
`403 enclos-conflit` (with `tables`),
`404 table-inconnue`, `403 pas-membre` or `400 nom-de-table-invalide`, and the
body may carry `hors_enclos: true` (a JSON boolean). A table send that breaks
after some letters were written answers `500` with `interrompu: true`, the
`lettres_ecrites` and a fixed `motif`; the database's own message stays on the
door's stderr. The feed (`GET /api/fil` and the event stream) carries `table`,
`table_mode`, `position`, `chaise_nom`, `rappel`, `envoi_id` and `reponse_a`
with each letter, and the page shows the line
`Table: <name> (<mode>) · position: "<text>"` under the header of a table
letter. The operator can be a member of a table; a table letter reaches the
operator like any other. Tables are managed with `valxos-table`; the page's
composer does not offer a table in this release.

The web door requires the unique name of its operator in
`~/.valxos-messenger/web.env`:

```dotenv
VALXOS_WEB_OPERATEUR=alice
# VALXOS_WEB_JETON=<an existing token; otherwise the door creates one as 0600>
# VALXOS_WEB_HOTE=127.0.0.1
# VALXOS_WEB_PORT=8790
# VALXOS_WEB_CADRE_AUTORISE=https://command-center.example
```

Without `VALXOS_WEB_OPERATEUR`, or its historical alias
`CC2CC_WEB_OPERATEUR`, `valxos-web` refuses to start before opening the
office.

## Runtime directory and migration

The default runtime directory is `~/.valxos-messenger`.
`VALXOS_MESSENGER_HOME` can move it; `CC2CC_V2_HOME` remains a historical
alias and loses when both variables are set (an empty `VALXOS_MESSENGER_HOME`
counts as unset, and says so on stderr).

If only the former `~/.cc2cc-v2` installation exists, the software
continues to use it and reports the fallback (the hooks say it once per
session, at session start). To copy it explicitly to
the new directory, stop the services, inspect the simulation, and then
apply it:

```bash
valxos-migrate-home            # dry-run: see what would be copied
valxos-migrate-home --apply    # copy, preserving the source
```

The migration ignores `run/` (ephemeral sockets, PIDs, and locks),
accepts an empty destination and refuses a non-empty one unless `--force`
sets it aside (dated, never erased), refuses while a process still writes
the source database, copies symlinks as written, writes the marker
`.valxos-messenger-home` that makes the new office count, preserves the
source, and performs no implicit move. When the live office cannot be
stopped, the alternative is the Phase A symlink,
`ln -s ~/.cc2cc-v2 ~/.valxos-messenger`: every process then resolves the
same office under both names.

## Known limitations

- The web door is a counter, not a mailbox. The browser collects mail; the
  Facteur does not deliver into it. A letter waits until the page is opened.
- After authentication, `/api/accuser` answers `404 lettre-inconnue` for an
  unknown letter and `403 pas-mon-courrier` for somebody else's. The
  distinction is an existence oracle on message ids, accepted on a
  single-operator door.
- A former `~/.cc2cc-v2` office is used as a fallback and reported; moving it
  to `~/.valxos-messenger` is an explicit, manual step (`valxos-migrate-home`,
  above). Nothing is moved on its own.
- A web door serves one operator only.
- In a Claude Code session that bypasses permission prompts, the
  Facteur's doorbell can be held until somebody answers Claude Code's
  prompt (see "When Claude Code holds the doorbell"). The letter itself
  still arrives through the hooks and the monitor.
- The `maison-inconnue` notice that `send` returns is computed with the
  sender's own `VALXOS_MAISONS`, not with the Facteur's. When the two
  lists differ, the notice can say "will not ring there" where the
  Facteur rings, or the opposite. The Facteur's journal says what it
  did.
- Delivery is at least once, not exactly once. A crash after a letter becomes
  visible and before it is acknowledged can produce a duplicate.
- There is no proof of reading without acknowledgement, no end-to-end
  encryption, and no guarantee against physical volume loss. SQLite runs in
  WAL mode with `synchronous=NORMAL` — better-sqlite3's compiled default for
  WAL (`SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`), no pragma in `src/`, measured by
  the suite; tested backup and restore remain the operator's responsibility.
- There is no quarantine. A poison letter returns after a bounded deferral; a
  visible human-intervention queue has not been built.
- Letters are untrusted text. A letter's body reaches the recipient's model
  unfiltered, by the hooks, the plugin monitor and the Facteur, and the sender
  shown is the name the peer gave itself. Anything that can write to the office
  can put text in front of a model; the header of the hooks' context says to
  treat letters as untrusted text, not as instructions
  ([SECURITY.md](https://github.com/valx-vex/valxos-messenger/blob/main/SECURITY.md)).
- The hooks and the Python monitor read the identity in their own alphabet
  (letters, digits, dot, dash, underscore; 64 characters), as in 1.0.0, while
  the MCP server and the CLI take it as written: `VALXOS_SELF=alice opus` is
  `alice_opus` to the hooks and the monitor, and `alice opus` to MCP and the
  CLI, two mailboxes. Give each house a name in that alphabet.
- Harness parity is incomplete. MCP and CLI are general interfaces; the
  monitor and the default house inventory are Claude Code-specific; hooks
  exist for Claude Code and Codex, and the Facteur rings Claude Code sockets
  and Codex chairs only.
- Claude Code 2.1.292 and later negotiate MCP protocol 2026-07-28 with stdio
  servers by default. This server speaks the 2025-11-25 generation (SDK 1.32).
  Claude Code's changelog says such a server is connected the older way after
  one slow first connect, and that this is remembered for 7 days. Proven on
  18/10/2026 with Claude Code 2.1.302: the server connects in headless and
  interactive sessions (see `docs/MCP_CLIENTS.md`). If a connection fails after
  a Claude Code update, set `MCP_PROTOCOL_NEGOTIATION=legacy` in the
  environment that starts Claude Code.
- Recent Claude Code defers MCP tools behind tool search. `inbox`, `send`,
  `ack` and `reply` are marked always-load (`_meta['anthropic/alwaysLoad']`);
  the other nine tools may need to be loaded before they are called. Proven on
  18/10/2026 with Claude Code 2.1.302, tool search on (the default), for the
  1.0.0 server: only `inbox`, `send` and `ack` were loaded up front; `whoami`,
  `history`, `register`, `list_peers`, `unregister` and `broadcast` stayed
  deferred until the model loaded them through ToolSearch. The 1.1.0 marks
  (`reply` always loaded; `tables`, `table_manage` and `envoi_status`
  deferred) are read by the test suite on the running server and were not
  re-observed in a live session.
- Do not install this package as a Claude Code plugin from an npm marketplace
  source: since Claude Code 2.1.275 such installs run
  `npm pack --ignore-scripts`, and better-sqlite3 then has no native binding.
  Install with `npm i -g valxos-messenger --allow-scripts=better-sqlite3` and
  `valxos-messenger install`.
- Claude Code 2.1.271 and later give Monitor watches a deadline (30 minutes; 10
  in `claude -p`). In an interactive Claude Code 2.1.302 session the plugin
  monitor stayed armed for the whole 40-minute session, past the 30-minute
  deadline Claude Code gives Monitor watches, and presented a letter posted at
  minute 33 within 20 ms (18/10/2026). Under `claude -p` the monitor is not
  armed; the hooks deliver instead. The hooks do not depend on the monitor: pending mail is
  injected after each tool call, and a stop is held while unread mail above
  low priority waits, regardless.
- A Claude Code session's chair stays registered as in service after the
  session exits; nothing marks it dead on its own (observed on 18/10/2026 with
  Claude Code 2.1.302: every `claude -p` session left its chair in service).
  With headless `claude -p` runs this adds up fast: as soon as a lineage has
  more than one chair in service and no designated one, a letter to the bare
  lineage is held (`send` answers `attente.motif: "lignee-ambigue"`, and each
  chair sees only a cc copy flagged `sans-chaise-designee`) until a human
  harvests the dead chairs (`valxos-chaise moissonner` or
  `valxos-doctor --reap`) or designates one (`valxos-chaise designer`).
  Address a chair directly (`name#session`) to bypass the lineage.
- The launchd plists written by `valxos-messenger install --launchd` carry no
  `CLAUDE_CONFIG_DIR`, and their `VALXOS_MAISONS` is your `~/.claude` path
  unless the installer ran with a declaration: under launchd the Facteur scans
  that list only, and the web door's `attente` advice on a send uses that same
  list. If your Claude Code configuration lives elsewhere, run the installer
  again with the complete list in `VALXOS_MAISONS`; a `CLAUDE_CONFIG_DIR`
  added by hand to a plist is not scanned, since the declaration replaces it.
- The web door's page and the `message`/`motif` prose of the MCP and HTTP
  answers are English (since this release); the MCP `refus` and
  `attente.motif` codes are stable identifiers documented in
  `docs/MCP_CLIENTS.md`.
- The Codex doorbell rings once per letter and cannot see an Escape: after
  Escape in the Codex TUI, a queued envelope waits until the next prompt typed
  by a human, and the letter arrives through the hooks at that prompt. A ring
  that fails leaves the letter to the hooks and to a later round
  (`envoi_status` shows `tournee.reason: "sonnette-codex-impossible"` for a
  table send). One
  chair card per lineage: two Codex sessions served under one name ring the
  session that wrote the card last (its `SessionStart`, or a prompt or `Stop`
  of a session whose thread the card does not name). The shipped Codex hook and the Facteur's
  Codex door are verified against a stand-in `codex` in the test suite, and
  were seen live once, on 22/10/2026 with codex-cli 0.163.0 on a scratch Codex
  home (TUI, a local model, hook trust bypassed): a letter rang the session and
  an autonomous turn read it. The hooks in the desktop app, the `/hooks`
  approval of the hooks the installer writes and the door opening a closed app
  were not seen on screen. There is no door to the iPhone app.
- The enclosure is not a security boundary: any call may say
  `hors_enclos: true`, and any process under the account may change the tables
  or lift an enclosure with `valxos-table`
  ([SECURITY.md](https://github.com/valx-vex/valxos-messenger/blob/main/SECURITY.md)).
  A closed table hides
  its letters from other chairs' cc copies; it does not hide the SQLite file.
  Two edges of 1.1.0 are listed in the CHANGELOG: `history` applies its
  limit before the read guard (the MCP tool stops at 200 rows and the web page
  at 500; a wider `valxos-history --limit`, which is not capped, finds a letter
  that hidden ones pushed out of the window, and so does narrowing to its
  thread unless they share it), and the
  web door's `/api/pairs` shows a bare lineage that a closed-table letter of
  one of its chairs waits somewhere (box, count, age, carry attempts and last
  reason; never the body).
- A Codex chair whose door is `app` gets the desktop app opened on its thread
  when a letter rings while the app is closed, even if the session is a
  terminal one: the door is `app` when `VALXOS_CODEX_PORTE` is unset, and
  `install --codex --porte app` pins it for every session of that Codex home.
  Export `VALXOS_CODEX_PORTE=cli` in a terminal launcher, or set
  `VALXOS_CODEX_OUVRIR_APP=0` for the Facteur.

The web guard is described in three separate sets:

- **Structurally closed:** the dispatcher serves only its route table; response
  functions require a private verdict; the listening address is limited to
  loopback.
- **Closed by lists that must be maintained:** known process-launch primitives,
  counted exceptions, route and font contracts, and known accesses to the server
  and transport. The door uses fixed local probes; the guard checks on the real
  path that no user-posted field reaches their command line.
- **Not closed:** a deliberately obscured back door added by an authorized
  repository author, a computed dynamic import never loaded by the probe, or
  transport access written in a form the lists do not recognize. These cases
  also depend on review and repository access control.

The danger is not the hole; it is the sentence claiming there is none.

Additional limits — lease clocks, late acknowledgements, and shutdown between
rounds — are recorded in
[`docs/FACTEUR.md`](docs/FACTEUR.md#ce-que-ce-dessin-ne-r%C3%A9sout-pas-%C3%A0-lire-avant-de-lui-faire-confiance) (in French).

## What it is not

- **Not a chat server.** There is no real-time push outside a Claude Code or
  Codex session, no presence, no typing indicator. Elsewhere a letter waits
  until the recipient collects it.
- **Not a message queue.** There is no broker federation, no topic
  routing, no partitioning. One SQLite database, one machine.
- **Not encrypted.** There is no end-to-end encryption. The transport is
  a local Unix socket. Physical volume loss is the operator's
  responsibility.
- **Not multi-tenant.** One operator, one web door, one broker. The
  product does not isolate users from each other.
- **Not a Claude Code plugin only.** The MCP server and CLI work with
  any harness. But the monitor is Claude Code-specific, the hooks exist for
  Claude Code and Codex only, and harness parity is incomplete.
- **Not a guarantee of exactly-once.** A crash after visibility and
  before acknowledgement can produce a duplicate. This is accepted.

## Verify

From a clone of the repository (the test suite does not ship in the npm package):

```bash
node --test test/*.test.js   # or: npm test — the same command
```

The suite prints its own count. A few tests probe process liveness through
`/bin/ps`; they fail in environments where `/bin/ps` is restricted
(containers, some sandboxes) and pass on a normal macOS or Linux install.
In a clone of the public repository the suite is the same minus the
private-name guard, which only runs in the authors' repository.

## Contributing

Public surfaces are English: the README, the CLI, the error messages a user
reads. **The internals are French** — identifiers, comments, and test names.
That is a real barrier to contributing, it is deliberate, and it is not
hidden: a full translation was measured at roughly 30,000 lines of churn
across tested code, and declined as a worse trade than the barrier itself.

Comments explain *why*, not *what*; many carry the measurement of the defect
that made them necessary. In a clone, the gate is `node --test test/*.test.js`
(`npm test` runs it). Read
[CONTRIBUTING.md](https://github.com/valx-vex/valxos-messenger/blob/main/CONTRIBUTING.md)
before opening a pull request, and
[SECURITY.md](https://github.com/valx-vex/valxos-messenger/blob/main/SECURITY.md)
before reporting a vulnerability — never in a public issue.

**Ledger codes in comments.** Comments cite the private review that preceded
1.0.0 as the provenance of a measure. A8 = at-least-once delivery; A9 = a null
ack means the letter comes back; Camp B = nothing is erased, records are moved
aside; E.1/E.2 = the two Facteur work streams: E.1 built the daemon described
in `docs/FACTEUR.md` (in French), E.2 is the next one, on the recipient side,
which that page cites as not done (launchd support has shipped: see
`docs/INSTALL_ONE_CLICK.md`); Run N, Task N and the F/N/M/C/S/G/I numbers =
items of that private review. T-codes (T4b-b, T4b-c…) number the tasks of the
1.0.0 publication run, cited in a few test comments; the bare T1 to T6 in
`src/facteur/round.js` are the steps of one Facteur round.

## License

The code is distributed under **GNU Affero General Public License v3.0
only** (`AGPL-3.0-only`); see [LICENSE](LICENSE). If users interact over
a network with a modified version, section 13 requires offering them
access to the corresponding source code for that version. This applies
directly to use of the web door.

Source files carry a short SPDX header pointing to the complete license
text.

The bundled **Archivo**, **Literata**, and **DM Mono** fonts under
`src/web/public/polices/` remain under the **SIL Open Font License 1.1**.
Their license texts and attributions are in
[`src/web/public/polices/LICENCE.md`](src/web/public/polices/LICENCE.md).
They are served locally so opening the mailbox does not contact a
third-party font service.
