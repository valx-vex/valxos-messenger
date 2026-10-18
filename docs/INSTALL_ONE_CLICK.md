# One-Click Install Specification

This document specifies the full one-click installation path for
`valxos-messenger`. The core installer (`valxos-messenger install`) is
**implemented** and supports `--dry-run`, `--uninstall`, and `--force`.
The launchd step is **implemented** too: `--launchd` writes the two plists
from templates, `--launchd-load` also hands them to `launchctl`.

## What "one click" means

For this product, "one click" means a single command that:

1. Installs npm dependencies.
2. Creates CLI symlinks in `~/.local/bin/`.
3. Creates the Claude Code plugin symlink.
4. Creates the office: the runtime directories and the database
   (`~/.valxos-messenger`, or the one `VALXOS_MESSENGER_HOME` names), so the
   doctor that follows has one to read.
5. Validates and enables the Claude Code plugin (optional).
6. Writes the launchd plists for the Facteur and the web door (on request,
   `--launchd`; loading them is a second explicit word, `--launchd-load`).
7. Prints a human-readable summary of what was done.

```bash
valxos-messenger install
```

From a fresh checkout, before any link exists (a checkout has no bins in
`node_modules/.bin`):

```bash
node src/bin/valxos-messenger.js install
```

From the published package, without cloning — the package and its main
bin are both named `valxos-messenger`, and the documented form names the
package explicitly:

```bash
npx --allow-scripts=better-sqlite3 --package valxos-messenger valxos-messenger install
```

npm 12 blocks dependency install scripts by default, and better-sqlite3 needs
its install script to download its prebuilt binary: `--allow-scripts=better-sqlite3`
allows that one script (the global form is `npm i -g valxos-messenger
--allow-scripts=better-sqlite3`). When the binding cannot load, the installer
goes red, the dry run included, and prints the command that repairs it: for a
global install, `npm rebuild -g better-sqlite3 --allow-scripts=better-sqlite3
--prefix <prefix>` (npm 12 refuses `--allow-scripts` inside the package itself).

## Implemented: core installer

The `scripts/install.js` installer handles steps 1–5 and the summary.
It separates **core** (links, npm, plugin symlink, office) from **optional**
(Claude Code validate/enable). A machine without Claude Code gets a
green core install; the optional steps report their failure without
making the whole verdict red.

### Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Print what would be done; change nothing |
| `--uninstall` | Remove the CLI links that point at this package's own `bin` targets (a same-named link to anything else is kept and listed), the plugin symlink, and the plists this installer wrote; preserve runtime data |
| `--force` | Replace conflicting links and plists (timestamped backups kept) |
| `--no-enable` | Skip `claude plugin enable` |
| `--launchd` | Also write the two launchd plists under `~/Library/LaunchAgents/` |
| `--launchd-load` | Write the plists and run `launchctl bootstrap` on them (implies `--launchd`) |
| `--launchd-unload` | With `--uninstall` only: run `launchctl bootout` on the services the uninstall names — ours, and the legacy launchd labels of earlier private installations when a probe confirms them loaded — and `launchctl disable` every legacy label whose plist is in `~/Library/LaunchAgents`, loaded or not. Without it the uninstall only prints the commands |
| `--operator NAME` | Pin `VALXOS_WEB_OPERATEUR` in the web door's plist; it then takes precedence over `web.env`. Without it the plist carries no operator and `web.env` decides. Only with `--launchd` or `--launchd-load`: given alone it is refused, nothing is done |

The Claude Code home receives the plugin symlink: `$CLAUDE_CONFIG_DIR` when
the launcher sets it, else `~/.claude`.

### What the installer does not do

- It does not write plists unless asked (`--launchd`), and does not touch
  `launchctl` unless asked in a second word (`--launchd-load`).
- It does not delete or rewrite the data of an existing office: it opens the
  database once, with the schema and migrations every command applies, and
  `--uninstall` leaves the office alone.
- It does not create MCP server configuration for non-Claude-Code clients.

## Implemented: launchd plists

The Facteur (mail carrier daemon) and the web door run as launchd agents
on macOS. With `--launchd`, the installer renders the two templates in
`scripts/launchd/` and writes them to:

| Service | Label and file | Runs |
|---|---|---|
| Facteur | `~/Library/LaunchAgents/com.valxos.messenger.facteur.plist` | `src/bin/facteur.js` |
| Web door | `~/Library/LaunchAgents/com.valxos.messenger.web.plist` | `src/bin/valxos-web.js` |

```bash
valxos-messenger install --launchd                    # write the plists, load by hand
valxos-messenger install --launchd --operator alice   # the web door's operator
valxos-messenger install --launchd-load               # write and load them
valxos-messenger install --dry-run --launchd          # show the exact files, write nothing
```

### What a written plist contains

The templates carry placeholders that the installer fills with the values
of the machine it runs on:

| Placeholder | Value |
|---|---|
| `__REPO_ROOT__` | absolute path of the repository (`ProgramArguments`, `WorkingDirectory`) |
| `__HOME__` | the home directory (`HOME` in the service environment) |
| `__NODE__`, `__NODE_DIR__` | the `node` that ran the installer, through its **stable** entry point when one exists: the `node` on `PATH` (or the one the operator invoked) whose real path is the running binary — `/opt/homebrew/bin/node` rather than the versioned `…/Cellar/node/<version>/bin/node` that a `brew upgrade node` removes; the binary itself otherwise. launchd starts services with a bare environment, so the plist names a node rather than hoping one is on the path; `__NODE_DIR__` is its directory, first on the service's `PATH`. A plist names a path and launchd does not follow upgrades: re-run `install --launchd` after updating Node, as after moving the repository |
| `__RUNTIME_HOME__` | the office the daemons serve, pinned as `VALXOS_MESSENGER_HOME`; it is the office the install ran against (`~/.valxos-messenger` by default) |
| `__OPERATOR_ENTRY__` | the web door's `VALXOS_WEB_OPERATEUR` entry when `--operator` was given — the door reads its environment before `web.env`, so a pinned operator takes precedence over the file, and the summary says so; without `--operator` the entry is a comment saying that `web.env` decides. `web.env` is the one place meant to configure the door: the installer never contradicts it in silence, and it warns when neither names an operator, since the door refuses to start without one |

Both services have `RunAtLoad` and `KeepAlive` set. Their output goes to
`<runtime home>/logs/facteur.log` and `<runtime home>/logs/web.log`
(`~/.valxos-messenger/logs/` by default). Values are XML-escaped; a
template with a placeholder the installer cannot fill is refused, never
written half-filled.

Every plist the installer writes starts with the marker

```xml
<!-- written by valxos-messenger install -->
```

That marker is the only thing the installer trusts afterwards: it is how
`--uninstall` recognises its own files, and how a re-run tells "mine" from
"somebody else's".

### Loading

`--launchd` writes files and stops there. The summary prints the commands
to run by hand:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.valxos.messenger.facteur.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.valxos.messenger.web.plist
```

`--launchd-load` runs exactly those commands, one per plist that was
written or already ours, and reports each result; a failed bootstrap
makes the verdict red and shows `launchctl`'s complaint. A service that
is already loaded refuses a second bootstrap (`Bootstrap failed: 5`); the
installer recognises that answer: when the plist is unchanged there is
nothing to reload and the step is green; when the plist was just written
or refreshed, the running service still reads the previous file, the step
is red, and the summary prints the gesture that makes the new plist live —
`launchctl bootout gui/$(id -u)/<label> && launchctl bootstrap …` — for
you to run by hand. An install never boots a service out itself; only
`--uninstall --launchd-unload` does, and it also disables the legacy labels.

### Re-running, conflicts, `--force`

- A plist already in place that **carries the marker** is left alone when
  identical, and refreshed when the rendered content differs (moved
  repository, new operator); the previous file survives as
  `<plist>.bak.<timestamp>`.
- A plist already in place that **does not carry the marker** — written by
  hand, or by another tool — is refused, the file is left byte-for-byte as
  it was, and the verdict is red. `--force` moves it aside to a
  timestamped backup and writes ours.

### Removal

```bash
valxos-messenger uninstall
```

removes the plists that carry the marker and nothing else: a plist at one
of our paths without the marker is reported under "Kept" and left in
place. Removing the file does not stop a service that launchd already
loaded; the uninstall summary prints the command for that:

```bash
launchctl bootout gui/$(id -u)/com.valxos.messenger.facteur
launchctl bootout gui/$(id -u)/com.valxos.messenger.web
```

Legacy note: earlier, private installations of this software ran the
Facteur and the web door from hand-written plists under other labels.
The installer never edits or deletes those plists — they carry no marker.
`--launchd-load` refuses to bootstrap while one of the legacy launchd
labels is still loaded. `--uninstall` probes them read-only and names the
ones still loaded; booting them out is a second explicit word:

```bash
valxos-messenger uninstall --launchd-unload
```

A probe that could not run is reported as such and never counts as "not
loaded": the gesture then boots nothing legacy out and the verdict is red.

### Testing without launchd

`--dry-run --launchd` prints every file exactly as it would be written and
touches nothing — not even the `LaunchAgents` directory. The test suite
proves it by listing the temporary home before and after. `--launchd-load`
runs whatever `VALXOS_MESSENGER_LAUNCHCTL` names instead of `launchctl`
when that variable is set; the suite points it at a script that records
its arguments, which is how the exact `bootstrap gui/<uid> <plist>`
command is proven without ever loading a service.

## Why this path (and not the alternatives)

### (a) `npx --allow-scripts=better-sqlite3 --package valxos-messenger valxos-messenger install` — CHOSEN

A single binary that the operator runs once. It can be tested with
`--dry-run` without touching launchd. It handles the symlink-heavy
installation that is easy to get wrong by hand. It works from a tarball
or a git checkout. It degrades gracefully when Claude Code is absent.

### (b) Claude Code marketplace (`/plugin marketplace add …`) — not yet

The product is not yet listed in a Claude Code marketplace. When it is,
the marketplace path will handle the plugin symlink and MCP server
registration, but will not handle CLI links or launchd plists — those
still need the installer. The marketplace is a complement, not a
replacement.

### (c) `curl | sh` — rejected

Piping a remote script to a shell is convenient but opaque. The product
is a local-first post office; an installer that hides what it does
contradicts the product's stance. The `npx` path is explicit, auditable,
and works from a published npm package.
