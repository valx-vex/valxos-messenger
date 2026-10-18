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
- **Interfaces:** an MCP server and 22 CLI entry points work from any shell;
  Claude Code also gets native hooks and a monitor.
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
- **Hooks** — Claude Code session hooks that inject pending mail and gate stops.

## Harness support

| Harness | MCP | CLI | Hooks | Monitor | Woken by the Facteur | Status (evidence) |
|---|---|---|---|---|---|---|
| **Claude Code** | ✓ | ✓ | ✓ | ✓ interactive only | yes, interactive sessions (see details) | **Proven on 18/10/2026 with Claude Code 2.1.302**: MCP, CLI and the three hooks in headless (`claude -p`) and interactive sessions; the monitor is armed in interactive sessions only, not under `claude -p` ([details](docs/MCP_CLIENTS.md#claude-code)) |
| **Codex CLI** | ✓ | ✓ | — | — | no — collects with `inbox` | **Proven on 18/10/2026 with codex-cli 0.162.1**, headless `codex exec`: the MCP round trip and the CLI, provided the server entry sets `default_tools_approval_mode = "approve"`; the interactive TUI was not tested ([details](docs/MCP_CLIENTS.md#codex-cli)) |
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

**What wakes a session.** Only Claude Code sessions are woken: the Facteur
delivers to the session's own messaging socket, and, on a wake, the plugin
monitor prints it (in interactive sessions); the hooks inject pending mail at
session start, after each tool call, and before a stop. The Facteur's push
into a live Claude Code 2.1.302 session was observed in the authors' house on
18/10/2026 (eight letters delivered to the session socket by the previous
release's courier, whose connection logic the 1.0.0 courier keeps unchanged);
the test suite verifies the 1.0.0 courier against a stand-in socket; the
in-session wake through the plugin monitor was verified live the same day.
Under `claude -p` the monitor is not armed; the hooks still
present mail. Every other harness collects its mail
by calling `inbox` (MCP) or `valxos-inbox` (CLI) itself; nothing rings. In the
authors' 25/08/2026 setup, Hermes saw its mail at the start of its next turn
through a Hermes-side plugin that this package does not ship.

Hooks and the monitor are Claude Code-specific. Any agent that can start
a process can post and collect mail through the CLI or any MCP client.

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
The plists carry no `VALXOS_MAISONS` and no `CLAUDE_CONFIG_DIR`: under launchd
the Facteur scans `~/.claude` only, and the web door's `attente` advice on a
send uses that same list (see Known limitations).

```bash
npx --allow-scripts=better-sqlite3 --package valxos-messenger valxos-messenger install --launchd --operator alice   # write the plists
npx --allow-scripts=better-sqlite3 --package valxos-messenger valxos-messenger install --launchd-load               # write and load them
```

Details, re-runs, and removal: [`docs/INSTALL_ONE_CLICK.md`](docs/INSTALL_ONE_CLICK.md).

### Published commands

```text
valxos-send          valxos-peers         valxos-inbox
valxos-unregister    valxos-chaise        valxos-monitor
valxos-doctor        valxos-web           valxos-migrate-v1
valxos-migrate-home  valxos-messenger     facteur
```

The ten `cc2cc-*` executables are deprecated aliases for the same programs.
Together with the ten `valxos-*` names, `valxos-messenger`, and `facteur`,
the package publishes 22 CLI entry points.

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
`CLAUDE_CONFIG_DIR` path if you still want it scanned.

Reservation, lease, retry, rate-limit, and shutdown details are in
[`docs/FACTEUR.md`](docs/FACTEUR.md) (in French).
The courier's design doctrine (it delivers, it never judges) is in
[`docs/DOCTRINE_FACTEUR.md`](docs/DOCTRINE_FACTEUR.md) (in French).

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
continues to use it and reports the fallback. To copy it explicitly to
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
- Harness parity is incomplete. MCP and CLI are general interfaces; hooks, the
  monitor, and the default house inventory are Claude Code-specific.
- Claude Code 2.1.292 and later negotiate MCP protocol 2026-07-28 with stdio
  servers by default. This server speaks the 2025-11-25 generation (SDK 1.32).
  Claude Code's changelog says such a server is connected the older way after
  one slow first connect, and that this is remembered for 7 days. Proven on
  18/10/2026 with Claude Code 2.1.302: the server connects in headless and
  interactive sessions (see `docs/MCP_CLIENTS.md`). If a connection fails after
  a Claude Code update, set `MCP_PROTOCOL_NEGOTIATION=legacy` in the
  environment that starts Claude Code.
- Recent Claude Code defers MCP tools behind tool search. `inbox`, `send` and
  `ack` are marked always-load (`_meta['anthropic/alwaysLoad']`); the other six
  tools may need to be loaded before they are called. Proven on 18/10/2026 with
  Claude Code 2.1.302, tool search on (the default): only `inbox`, `send` and
  `ack` are loaded up front; `whoami`, `history`, `register`, `list_peers`,
  `unregister` and `broadcast` stay deferred until the model loads them through
  ToolSearch.
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
  `VALXOS_MAISONS` and no `CLAUDE_CONFIG_DIR`: under launchd the Facteur scans
  `~/.claude` only, and the web door's `attente` advice on a send uses that
  same list. If your Claude Code configuration lives elsewhere, add the
  variable to both plists' environment before loading them: `VALXOS_MAISONS`
  (the complete list) or `CLAUDE_CONFIG_DIR`.
- The web door's page and the `message`/`motif` prose of the MCP and HTTP
  answers are English (since this release); the MCP `refus` and
  `attente.motif` codes are stable identifiers documented in
  `docs/MCP_CLIENTS.md`.

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

- **Not a chat server.** There is no real-time push outside a Claude Code
  session, no presence, no typing indicator. Elsewhere a letter waits until
  the recipient collects it.
- **Not a message queue.** There is no broker federation, no topic
  routing, no partitioning. One SQLite database, one machine.
- **Not encrypted.** There is no end-to-end encryption. The transport is
  a local Unix socket. Physical volume loss is the operator's
  responsibility.
- **Not multi-tenant.** One operator, one web door, one broker. The
  product does not isolate users from each other.
- **Not a Claude Code plugin only.** The MCP server and CLI work with
  any harness. But hooks and the monitor are Claude Code-specific, and
  harness parity is incomplete.
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
