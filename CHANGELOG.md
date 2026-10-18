# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
