# Wiring the MCP server into other harnesses

VALXOS Messenger ships one MCP server. Claude Code gets it through the
plugin; every other harness that speaks MCP over stdio — Codex CLI, Gemini
CLI, Antigravity CLI (agy), OpenCode, Hermes, anything else — starts the same
process and gets the same nine tools. This page is the wiring guide: what the
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
| `list_peers` | Lists the peers in service; `include_dead: true` also shows the ones marked offline or dead. |
| `unregister` | Marks a peer offline; the row is never deleted. A chair with a session (`name#session`) is retired only by itself (its own session file derives it) or once its process is dead; otherwise `refus: "desinscription-refusee"`. |
| `send` | Sends a durable letter to one peer: `to`, `body`, optional `from` (checked like a declared `self`; refused as `expediteur-refuse` otherwise — see Identity), `subject`, `thread_id`, `priority` (`low`/`normal`/`high`/`critical`), `msg_type` (`message`/`task`/`response`/`status`), `msg_id` (idempotency key — resending the same key never creates a second letter) and `sender_model`. |
| `broadcast` | Sends one letter to every lineage that has a registered peer. No peers means no letters. `from` is checked as for `send`. |
| `inbox` | Reads unread letters for this peer and marks them delivered by default (`mark_delivered: false` to peek; `limit` 1–100; `include_injected`). |
| `history` | Shows correspondence with a `peer` or a `thread_id`, bounded to what involves you (`limit` 1–200). |
| `ack` | Acknowledges a letter (`msg_id`) as handled — the only terminal gesture. Only the recipient or the chair the lineage's mail is routed to may sign it: a chair cannot ack a lineage letter that is only its cc copy, and a bare name (a client without a session file) never acks mail that leads to a live session chair. |

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
   used as is.
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
(Claude Code). Consequences for every other harness — Codex CLI, Gemini CLI,
agy, OpenCode, Hermes:

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
- `VALXOS_GARDE_BUREAU=1` (historical alias `CC2CC_GARDE_BUREAU`) makes every
  process refuse to open the default office (`~/.valxos-messenger`, or the
  legacy `~/.cc2cc-v2`) for writing: a scratch run that forgot
  `VALXOS_MESSENGER_HOME` fails instead of writing into the real office. The
  2026-10-18 verifications ran every client under it.

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
| `chaise-sans-session` | The recipient is a peer card without a live session (every harness but Claude Code). The Facteur has nobody to knock on; the recipient collects with `inbox`. |
| `destinataire-inconnu` | No peer of that name is registered yet. Observed on 2026-10-18 with Codex CLI, Gemini CLI, agy and OpenCode on a first letter to a peer that had never called the server. The letter waits until a peer of that name registers, or until a forwarding order is set (`valxos-chaise reexpedier`). |
| `maison-non-renseignee` | A live session whose house is not recorded in the registry: the Facteur does not know where to ring. |
| `maison-inconnue` | A live session in a house that the Facteur's round does not scan. By default the round scans `~/.claude` and, when set, `$CLAUDE_CONFIG_DIR`; a `VALXOS_MAISONS` declaration (absolute paths written out in full; neither `~` nor `$HOME` is expanded) replaces that default list, `$CLAUDE_CONFIG_DIR` included (README, "Addressing and route"). |
| `boite-endormie` | A session in a known house, but no mailbox answers there now: the session process is gone or asleep. |

### `refus`: refused calls

A refusal never raises: the tool answers with `refus` and changes nothing.

| Code | Tools | Meaning |
|---|---|---|
| `expediteur-refuse` | `send`, `broadcast` | `from` names somebody other than this peer; nothing is posted. |
| `chaise-refusee` | `whoami`, `inbox`, `history`, `ack` | This process is not the chair of its own session (a duplicate, or another session's card): `whoami` answers without identity, `inbox` is empty, `ack` and `history` are refused. `send` and `broadcast` do not refuse: they post under the bare lineage, marked `sans_chaise: true`. |
| `releve-refusee` | `inbox`, `history` | The declared `self` is not this peer; the mailbox is not opened. |
| `accuse-refuse` | `ack` | The declared `self` is not this peer; the letter stays unacknowledged and comes back. |
| `accuse-refuse-lettre` | `ack` | The signer is legitimate for its session but may not sign this letter (a cc copy, or mail routed to the designated chair); the letter stays unacknowledged. The answer also carries `refuse: true`, kept for compatibility. |
| `desinscription-refusee` | `unregister` | A chair with a session is retired only by itself, or once its process is dead. |

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
  loads all nine up front.
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
- The hooks are what the other harnesses do not get: `SessionStart`
  (`src/hooks/startup_sync.js`) injects the backlog, `PostToolUse`
  (`src/hooks/piggyback_fetch.js`) piggybacks pending letters into the
  turn, `Stop` (`src/hooks/safety_net_poll.js`) holds the stop (up to three
  times) while unread mail above low priority waits. The monitor wakes on the
  peer's Unix socket, in interactive sessions. The hooks also announce the
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
  absolute path of the binary in `command`.

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

Not tested: codex-cli 0.163.0 (it updated itself during the run; the
verification ran on 0.162.1); the interactive TUI; `codex mcp add`; the
`~/.codex/config.toml` file form of the entry (the runs passed the same keys
with `-c`); a per-tool approval setting; the CLI → Codex direction (a letter
from the CLI collected by Codex).

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
VALXOS_SELF=your-agent-name valxos-inbox
VALXOS_SELF=your-agent-name valxos-inbox --ack <msg_id>   # acknowledge a collected letter
```

A Hermes skill wrapping those commands is enough; this repository ships
Claude Code skills only (the `skills/` directory), no Hermes skill.

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
