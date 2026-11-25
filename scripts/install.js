#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// valxos-messenger installer — places CLI links, the Claude Code plugin
// symlink, and (on request) the launchd plists; with --codex it does none of
// that and wires Codex instead (see doCodex).  Its modes and flags are
// listed ONCE, in USAGE below: `--help` prints that list, and any argument
// it does not name is refused before anything is touched.
//
// The installer separates CORE (links, npm, plugin symlink) from OPTIONAL
// (Claude Code validate/enable).  A machine without Claude Code gets a
// green core install; the optional steps report their failure without
// making the whole verdict red.  The launchd step only runs when asked for,
// and then it counts: a plist it could not write makes the verdict red.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  LEGACY_PLUGIN_DIR, baseDir, claudeHomeDir, ensureRuntimeDirs, homeDir, nowIso, pluginTargetPath, repoRoot, validateAgentId,
  valeurDeLEnvironnement
} from "../src/lib/config.js";
import {
  RELAIS_LABEL, SERVICES, bootstrapArgs, launchAgentsDir, legacyLabels, planPlists, planRelaisPlist, plistPath, stableNodePath, verdict, writtenByInstaller
} from "./launchd/plists.js";
import { labelsDesactives, plistsHistoriquesPresents } from "../src/lib/launchd-labels.js";
// `backupName` is taken here (the links' and plists' `.bak.<iso>`): the Codex
// files carry their own, shorter, minute-stamped name.
import {
  FEATURES_BLOCK, HOOK_MARKER, INSTALL_DOORS, MCP_SERVER_KEY, backupName as codexBackupName, hooksTemplatePath, lineDiff,
  commenceParUnBOM, mcpServerBlock, mergedConfigProblem, planCodexConfig, planCodexHooks, renderHooks, tomlProblem
} from "./codex/codex-setup.js";

function hasFlag(name) {
  return process.argv.includes(name);
}

// `--name value` or `--name=value`; null when absent.  A flag given without
// its value is reported as the empty string so the caller can refuse it.
function flagValue(name) {
  const argv = process.argv;
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const at = argv.indexOf(name);
  if (at < 0) return null;
  const next = argv[at + 1];
  return next === undefined || next.startsWith("--") ? "" : next;
}

// ─────────────────────────── usage ───────────────────────────

// The one list of what this installer understands.  `--help`/`-h` prints it;
// an argument it does not name is refused with it (exit 2) BEFORE any file
// is touched.  Until Run 6 an unknown flag was ignored and the default mode
// ran: `install.js --help` performed a real install.
const USAGE = `usage: node scripts/install.js [flags]

  (no flag)                 install
  --dry-run                 show what would be done, change nothing
  --uninstall               remove links, plugin symlink, and our plists
  --force                   replace conflicting links/plists (backups kept)
  --no-enable               skip \`claude plugin enable valxos-messenger@skills-dir\`
  --launchd                 also write the two launchd plists
  --launchd-load            ...and \`launchctl bootstrap\` them
  --operator NAME           the web door's operator (default: operator);
                            with --launchd or --launchd-load only
  --uninstall --launchd-unload
                            ...and \`launchctl bootout\` the services it names,
                            the legacy cc2cc-v2 labels included (each legacy
                            label is then \`launchctl disable\`d, so launchd
                            does not load it again at the next login)
  --relais                  the relay's launchd plist (com.valxos.messenger.relais),
                            on the Mac that runs the relay: a mode of its own,
                            a dry run unless --write; nothing is loaded
                            (see docs/RELAIS.md)
  --codex --self NAME       print the Codex wiring for NAME (lifecycle hooks
                            and MCP server) and change nothing; --self is
                            required with --codex
  --codex-home DIR          with --codex: the Codex home to wire (default:
                            $CODEX_HOME, else ~/.codex)
  --porte app|cli           with --codex: pin one door in the hook command,
                            for every session of that Codex home (default:
                            none; each session's VALXOS_CODEX_PORTE decides,
                            and unset means app: the Facteur may open the
                            desktop app on a waiting thread; cli never does)
  --write                   with --codex: merge it into config.toml and
                            hooks.json (dated backups, a diff; a value already
                            there is never changed: a conflict writes nothing)
  --help, -h                print this list and exit
`;

const BOOLEAN_FLAGS = new Set(["--dry-run", "--uninstall", "--force", "--no-enable", "--launchd", "--launchd-load", "--launchd-unload", "--codex", "--write", "--relais"]);

// The flags that take a value: the next word (unless that word is itself a
// flag, which flagValue() reports as a missing value) or an inline `=VALUE`.
const VALUE_FLAGS = ["--operator", "--self", "--codex-home", "--porte"];

// The first argument this installer does not know, or null.
// A boolean flag with `=value` is unknown: `--dry-run=1` is not a dry run.
function firstUnknownArg(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (BOOLEAN_FLAGS.has(arg) || arg === "--help" || arg === "-h") continue;
    const valued = VALUE_FLAGS.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (valued) {
      if (arg === valued && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) i += 1;
      continue;
    }
    return arg;
  }
  return null;
}

const unknownArg = firstUnknownArg(process.argv.slice(2));
const helpRequested = unknownArg === null && (hasFlag("--help") || hasFlag("-h"));

const relaisMode = hasFlag("--relais");
// `--relais` writes only with `--write` (like `--codex`): without it, a dry run.
const dryRun = hasFlag("--dry-run") || (relaisMode && !hasFlag("--write"));
const uninstall = hasFlag("--uninstall");
const force = hasFlag("--force");
const skipEnable = hasFlag("--no-enable");
// `--launchd` writes the plists and nothing more; `--launchd-load` writes them
// AND hands them to launchctl.  Loading is a separate, explicit word: writing
// a file is reversible, starting a daemon is a gesture.
const launchdLoad = hasFlag("--launchd-load");
const launchdRequested = hasFlag("--launchd") || launchdLoad;
// Uninstall only: stopping a service is a gesture too, so `--uninstall` names
// the labels still loaded and only `--launchd-unload` boots them out.
const launchdUnload = hasFlag("--launchd-unload");
// null when not given: the web door's operator then comes from web.env, and
// the plist carries no key that would override the file in silence.
const operator = flagValue("--operator");
// `--codex` is a mode of its own, like --uninstall: it wires Codex and touches
// nothing else.  --self is its identity (never guessed), --codex-home its
// target, --porte the door its hooks declare, and --write the only word that
// writes.
const codexMode = hasFlag("--codex");
const codexWrite = hasFlag("--write");
const codexSelf = flagValue("--self");
const codexHomeFlag = flagValue("--codex-home");
const codexDoor = flagValue("--porte");
// The launchctl to run — overridable so a test can prove the exact command
// with a stand-in that records instead of loading.
const launchctl = process.env.VALXOS_MESSENGER_LAUNCHCTL || "launchctl";
const root = repoRoot();
// `homeDir()` and not `require("node:os")`: this file is an ES module, and
// `require` does not exist here — the old fallback threw the moment HOME was unset.
const home = homeDir();
// The Claude Code home to install the plugin into: the launcher's
// CLAUDE_CONFIG_DIR when set (a machine may host several homes), else ~/.claude.
// rc2 read `claudeHome` inside its own initialiser (temporal dead zone): every
// install without CLAUDE_CONFIG_DIR crashed with a ReferenceError before doing anything.
// One rule for the directory, the link, the doctor and the uninstall — it
// lives in config.js, next to pluginTargetPath(), so the two cannot drift.
const claudeHome = claudeHomeDir();
const binDir = path.join(home, ".local", "bin");
const target = pluginTargetPath();

// ─────────────────────────── helpers ───────────────────────────

function tryRun(command, args, options = {}) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })
    };
  } catch (error) {
    return {
      ok: false,
      status: typeof error.status === "number" ? error.status : null,
      stdout: error.stdout?.toString() || "",
      stderr: error.stderr?.toString() || error.message
    };
  }
}

// The legacy labels (cc2cc-v2 era, see legacyLabels()) that launchd still has
// loaded.  THREE OUTCOMES, classified here and nowhere else: `launchctl print
// gui/<uid>/<label>` exits 0 for a loaded service ("loaded") and 113 for
// "Could not find service" ("not-loaded").  Anything else — launchctl not
// found, not executable, any other exit code — is "impossible": a probe that
// could not run is never read as "not loaded".  Read-only, never guesses.
function probeLegacyLabel(uid, label) {
  const run = tryRun(launchctl, ["print", `gui/${uid}/${label}`]);
  if (run.ok) return { label, state: "loaded" };
  if (run.status === 113) return { label, state: "not-loaded" };
  return { label, state: "impossible", status: run.status, stderr: String(run.stderr || "").trim().split("\n")[0] };
}

// { loaded: labels confirmed loaded, probe: "ok" | "impossible",
//   detail: the labels that could not be probed, with exit status and stderr }.
function legacyLoaded(uid) {
  const probes = legacyLabels().map((label) => probeLegacyLabel(uid, label));
  const detail = probes.filter((p) => p.state === "impossible").map(({ label, status, stderr }) => ({ label, status, stderr }));
  return {
    loaded: probes.filter((p) => p.state === "loaded").map((p) => p.label),
    probe: detail.length > 0 ? "impossible" : "ok",
    detail
  };
}

// N2 (adversarial pass 2, 28/09): which legacy plists sit in LaunchAgents and
// are NOT disabled.  `launchctl print-disabled gui/<uid>` is read-only; a probe
// that could not run is "impossible", never "all disabled".
function legacyEnabledPlists(uid) {
  const presents = plistsHistoriquesPresents(home, fs);
  if (presents.length === 0) return { probe: "ok", presents, enabled: [] };
  const run = tryRun(launchctl, ["print-disabled", `gui/${uid}`]);
  if (!run.ok) return { probe: "impossible", presents, enabled: presents, stderr: String(run.stderr || "").trim().split("\n")[0] };
  const desactives = labelsDesactives(run.stdout);
  return { probe: "ok", presents, enabled: presents.filter((l) => !desactives.has(l)) };
}

// One line for the operator when the probe could not run: what to check.
function legacyProbeImpossibleLine(detail) {
  const first = detail[0];
  return `the legacy-label probe could not run (${first.label}: ${first.status === null ? "launchctl did not run" : `exit ${first.status}`}` +
    `${first.stderr ? ` — ${first.stderr}` : ""}); check the launchctl in use (${launchctl}) ` +
    `and run by hand: launchctl print gui/$(id -u)/${first.label}`;
}

function backupName(p) {
  return `${p}.bak.${nowIso().replace(/[:.]/g, "-")}`;
}

function safeMkdir(dir) {
  if (dryRun) { console.log(`  mkdir -p ${dir}`); return; }
  fs.mkdirSync(dir, { recursive: true });
}

function safeSymlink(source, link) {
  if (dryRun) { console.log(`  ln -s ${source} ${link}`); return; }
  fs.symlinkSync(source, link);
}

function safeRemove(p) {
  if (dryRun) { console.log(`  rm ${p}`); return; }
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

function safeRename(from, to) {
  if (dryRun) { console.log(`  mv ${from} ${to}`); return; }
  fs.renameSync(from, to);
}

// A dry run shows the whole file, not just its name: what the installer
// would put under ~/Library is exactly what the operator wants to audit.
function safeWrite(file, content) {
  if (dryRun) {
    console.log(`  [would write] ${file}`);
    console.log(content.replace(/^/gm, "    "));
    return;
  }
  fs.writeFileSync(file, content, { mode: 0o644 });
}

function readIfExists(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

// N3 (adversarial pass 2, 28/09): the MANIFEST is not the BINDING.  npm 12
// blocks dependency install scripts by default, so `npm i -g` leaves
// better-sqlite3's package.json in place and no build/Release: every command
// then crashes on "Could not locate the bindings file", while this installer
// said "dependencies resolved" (and, in a dry run, "core install complete").
// The probe loads better-sqlite3 from where Node will find it and opens
// `:memory:`.  Returns null when it works or when the package is not
// resolvable at all (that case is missingDependencies' / the doctor's to name),
// else the one line to show, with the directory to run the rebuild in.
function nativeBindingMissing() {
  const lookup = createRequire(path.join(root, "package.json")).resolve.paths("valxos-messenger") || [];
  const dir = lookup.map((d) => path.join(d, "better-sqlite3")).find((d) => fs.existsSync(path.join(d, "package.json")));
  if (!dir) return null;
  try {
    const Database = createRequire(path.join(dir, "package.json"))(dir);
    new Database(":memory:").close();
    return null;
  } catch {
    // The remedy that WORKS, checked on npm 12.1.0: inside the package,
    // `npm rebuild better-sqlite3 --allow-scripts=…` is refused
    // (EALLOWSCRIPTS: "not allowed in project-scoped installs"); for a global
    // install (<prefix>/lib/node_modules/<pkg>/node_modules/better-sqlite3)
    // the global rebuild does it.  Elsewhere (a clone, a project dependency)
    // the script is allowed in package.json / .npmrc, then rebuilt.
    const paquet = path.dirname(path.dirname(dir));
    const lib = path.dirname(path.dirname(paquet));
    if (path.basename(path.dirname(paquet)) === "node_modules" && path.basename(lib) === "lib") {
      return `native binding missing: run \`npm rebuild -g better-sqlite3 --allow-scripts=better-sqlite3 --prefix ${path.dirname(lib)}\``;
    }
    return `native binding missing: in ${paquet}, allow better-sqlite3's install script ("allowScripts" in package.json, or .npmrc) and run \`npm rebuild better-sqlite3\``;
  }
}

// The line of a crash worth showing: the `Error: …` line when there is one
// (a Node stack starts with the file and the throwing statement), else the
// first non-empty line.
function firstErrorLine(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^(\w*Error\b|error:)/i.test(line)) || lines[0] || "no output";
}

// The dependencies are LOOKED UP where Node will look for them — the
// node_modules chain from the package root upward, as Node's own resolver
// lists it — never guessed from the existence of `<package>/node_modules`:
// an npm-installed (hoisted) package has no node_modules of its own, its
// dependencies live in a parent's, and the old test sent `npm install`
// running INSIDE node_modules/valxos-messenger.
//
// The probe is the package manifest in one of those directories, not
// `require.resolve(name)`: an `exports` map may point the CommonJS entry at
// a file the package does not ship (the MCP SDK does), and this product
// loads it through ESM sub-paths anyway.  Returns the names not found.
function missingDependencies() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const names = Object.keys(packageJson.dependencies || {});
  const lookup = createRequire(path.join(root, "package.json")).resolve.paths("valxos-messenger") || [];
  const missing = names.filter(
    (name) => !lookup.some((dir) => fs.existsSync(path.join(dir, name, "package.json")))
  );
  return { names, missing, lookup };
}

// ─────────────────────────── link ownership ───────────────────────────

// The real path of `p`, even when it (or its tail) does not exist: the
// nearest existing ancestor is resolved and the missing rest appended.  So
// /var and /private/var, or a symlinked checkout, compare as one place, and a
// dangling link still has a comparable target.
function realPathLoose(p) {
  const absolute = path.resolve(p);
  const rest = [];
  let cursor = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cursor), ...rest);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute;
      rest.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

// Where a symlink really leads: its written target resolved against the
// link's own directory (a relative link counts), then real-pathed.
function linkRealTarget(link) {
  return realPathLoose(path.resolve(path.dirname(link), fs.readlinkSync(link)));
}

// THE ONE JUDGE of "this link is ours": it leads to `dir` itself or to a path
// INSIDE it — compared by path segments on real paths, never by a string
// prefix.  Until Run 6 `--uninstall` used `target.startsWith(root)`: a root
// of …/pkg claimed …/pkg-sibling/src/bin/x.js (a sibling checkout, a
// worktree) and removed its link; the plugin link was removed unexamined.
function linkLeadsInto(link, dir) {
  const leadsTo = linkRealTarget(link);
  const owner = realPathLoose(dir);
  return leadsTo === owner || leadsTo.startsWith(owner + path.sep);
}

function insideNodeModules(dir) {
  return dir.split(path.sep).includes("node_modules");
}

// ─────────────────────────── uninstall ───────────────────────────

function doUninstall() {
  console.log("Uninstalling valxos-messenger...\n");
  const removed = [];
  const kept = [];

  // Plugin symlink — only when it leads into THIS checkout.  Another
  // checkout's link (the live house, a worktree) is named and left alone.
  const pluginStat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (pluginStat?.isSymbolicLink()) {
    if (linkLeadsInto(target, root)) {
      safeRemove(target);
      removed.push(target);
    } else {
      kept.push({ name: target, reason: `points elsewhere: ${fs.readlinkSync(target)}` });
    }
  } else if (pluginStat) {
    kept.push({ name: target, reason: "not a symlink" });
  }

  // CLI links — a link is OURS only when its real target is the `bin` target
  // this package declares FOR THAT NAME, resolved from the package root: the
  // exact file the installer linked.  "Leads somewhere inside the package" was
  // too wide: a hand-made `valxos-send -> <root>/README.md` was removed with
  // ours (adversarial pass, 18/10).  Any other link under a published name is named
  // "not ours" and left alone.
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const [name, declared] of Object.entries(packageJson.bin)) {
    const link = path.join(binDir, name);
    try {
      const stat = fs.lstatSync(link);
      if (stat.isSymbolicLink()) {
        if (linkRealTarget(link) === realPathLoose(path.join(root, declared))) {
          safeRemove(link);
          removed.push(link);
        } else {
          kept.push({ name, reason: `not ours — points elsewhere: ${fs.readlinkSync(link)} (this package declares ${declared})` });
        }
      } else if (stat.isFile() || stat.isDirectory()) {
        // Uninstall never deletes a real file or directory — `--force` is not read here
        // (J2, jury, 18/10: the old hint promised a forced deletion that does not exist).
        kept.push({ name, reason: "not a symlink: left in place (remove it by hand if it is yours)" });
      }
    } catch { /* doesn't exist */ }
  }

  // launchd plists: only the files that carry our marker.  Anything else at
  // those paths — hand-written, or another tool's — is named and left alone.
  const bootout = [];
  for (const label of [...SERVICES.map((s) => s.label), RELAIS_LABEL]) {
    const plist = plistPath(home, label);
    const text = readIfExists(plist);
    if (text === null) continue;
    if (writtenByInstaller(text)) {
      safeRemove(plist);
      removed.push(plist);
      bootout.push(label);
    } else {
      kept.push({ name: label, reason: `launchd plist not written by this installer (no marker): ${plist}` });
    }
  }
  // The legacy labels still loaded are named with ours: their plists are
  // never touched (they carry no marker), but the service is still running.
  // Only CONFIRMED labels are named: on an impossible probe, bootout lists
  // nothing legacy, and the report says the probe could not run.
  const uid = process.getuid();
  const legacy = legacyLoaded(uid);
  for (const label of legacy.loaded) if (!bootout.includes(label)) bootout.push(label);
  if (legacy.probe === "impossible") console.log(`\nNote: ${legacyProbeImpossibleLine(legacy.detail)}.`);

  // Booting out runs only on the explicit word; a dry run shows the command.
  // A LEGACY label booted out is also DISABLED (F1, adversarial pass,
  // 28/09): its plist stays in ~/Library/LaunchAgents (no marker, Camp B), so
  // without `disable` launchd loads it again at the next login and the old
  // door races ours for port 8790.  `disable` is reversible (`enable`), and
  // runs only after that label's bootout succeeded.  Our own labels are never
  // disabled: their plists were just removed.
  const legacyBootout = new Set(legacy.loaded);
  // N2 (adversarial pass 2, 28/09): EVERY legacy label whose plist sits in
  // LaunchAgents is disabled, loaded or not — a plist booted out by hand
  // without `disable` is "enabled on disk" and launchd loads it again at the
  // next login.  `disable` is idempotent and reversible (`enable`).
  const legacyPresent = plistsHistoriquesPresents(home, fs);
  const aDesactiver = [...new Set([...legacy.loaded, ...legacyPresent])];
  let unloaded = null;
  const legacyDisabled = [];
  const legacyDisableFailed = [];
  const desactiver = (label) => {
    const off = tryRun(launchctl, ["disable", `gui/${uid}/${label}`]);
    if (off.ok) legacyDisabled.push(label);
    else legacyDisableFailed.push({ label, stderr: String(off.stderr || "").trim() });
  };
  if (launchdUnload && dryRun) {
    for (const label of bootout) console.log(`  [would run] ${launchctl} bootout gui/${uid}/${label}`);
    for (const label of aDesactiver) console.log(`  [would run] ${launchctl} disable gui/${uid}/${label}`);
  } else if (launchdUnload) {
    const bootoutRate = new Set();
    unloaded = bootout.map((label) => {
      const run = tryRun(launchctl, ["bootout", `gui/${uid}/${label}`]);
      if (!run.ok) bootoutRate.add(label);
      return { label, ok: run.ok, ...(run.ok ? {} : { stderr: run.stderr }) };
    });
    // A loaded legacy label is disabled only after its bootout succeeded; a
    // present, not-loaded one needs no bootout.
    for (const label of aDesactiver) if (!bootoutRate.has(label)) desactiver(label);
  }
  // --launchd-unload asked to stop the legacy services too: with a probe that
  // could not run, none was booted out, and the gesture is not reported green.
  if (launchdUnload && legacy.probe === "impossible") {
    console.log("--launchd-unload: no legacy label was booted out — none could be confirmed loaded (see the note above).");
  }
  const ok = (unloaded === null || unloaded.every((u) => u.ok))
    && legacyDisableFailed.length === 0
    && !(launchdUnload && legacy.probe === "impossible");

  console.log(`\n${dryRun ? "Would remove" : "Removed"}: ${removed.length}`);
  for (const p of removed) console.log(`  ${dryRun ? "would remove" : "✓"} ${p}`);
  if (kept.length) {
    console.log(`\nKept (not managed by this installer): ${kept.length}`);
    for (const k of kept) console.log(`  - ${k.name}: ${k.reason}`);
  }
  if (unloaded !== null) {
    console.log("\nlaunchctl bootout (--launchd-unload):");
    for (const u of unloaded) {
      console.log(`  ${u.ok ? "✓" : "✗"} gui/${uid}/${u.label}`);
      if (!u.ok) console.log(`      ${String(u.stderr).trim()}`);
    }
    if (legacyDisabled.length || legacyDisableFailed.length) {
      console.log("\nlaunchctl disable (legacy labels, so launchd does not load them again at the next login):");
      for (const label of legacyDisabled) console.log(`  ✓ gui/${uid}/${label}`);
      for (const f of legacyDisableFailed) console.log(`  ✗ gui/${uid}/${f.label}\n      ${f.stderr}`);
    }
    if (legacyDisabled.length) {
      // M2 (adversarial pass 3, 28/09): the rollback is not F1 in reverse.
      // Our agents are booted out AND disabled first (`;`, not `&&`: a
      // bootout of an agent that is not loaded answers an error, the disable
      // must still run); otherwise, at the next login, four RunAtLoad agents
      // race for port 8790.
      console.log("To undo (rollback to the legacy services), by hand — our agents first, bootout and disable:");
      for (const { label } of SERVICES) {
        console.log(`  launchctl bootout gui/$(id -u)/${label}; launchctl disable gui/$(id -u)/${label}`);
      }
      console.log("then the legacy ones:");
      for (const label of legacyDisabled) {
        console.log(`  launchctl enable gui/$(id -u)/${label} && launchctl bootstrap gui/$(id -u) ${plistPath(home, label)}`);
      }
    }
  } else if (bootout.length) {
    console.log("\nThese services may still be loaded in launchd (a removed plist, or a legacy label).");
    console.log("To stop them, pass --launchd-unload, or by hand:");
    for (const label of bootout) console.log(`  launchctl bootout gui/$(id -u)/${label}`);
  }
  if (unloaded === null && aDesactiver.length) {
    console.log("\nLegacy plists still in LaunchAgents: disable them, or launchd loads them again at the next login (pass --launchd-unload, or by hand):");
    for (const label of aDesactiver) console.log(`  launchctl disable gui/$(id -u)/${label}`);
  }
  console.log(dryRun
    ? `\nUninstall dry run: nothing was changed. Runtime data (${baseDir()}) is preserved.`
    : `\nUninstall ${ok ? "complete" : "complete, but a bootout failed — see above"}. Runtime data (${baseDir()}) is preserved.`);
  // In a dry run nothing was removed: the list is the PLAN, under its own key.
  process.stdout.write(JSON.stringify({
    ok, mode: "uninstall", dry_run: dryRun, removed: dryRun ? [] : removed, ...(dryRun ? { would_remove: removed } : {}), kept, bootout, unloaded,
    legacy_disabled: legacyDisabled,
    ...(legacyDisableFailed.length ? { legacy_disable_failed: legacyDisableFailed } : {}),
    legacy_probe: legacy.probe, legacy_probe_detail: legacy.detail
  }) + "\n");
  if (!ok) process.exitCode = 1;
}

// ─────────────────────────── install ───────────────────────────

function doInstall() {
  const mode = dryRun ? "dry-run" : "install";
  console.log(`${dryRun ? "[DRY RUN] " : ""}Installing valxos-messenger...\n`);

  // ── CORE: npm dependencies ──
  // `npm install` runs only when a dependency is missing, and never from a
  // package that lives under node_modules: there it would nest a second copy
  // of the dependencies instead of fixing the install that placed the package.
  const dependencies = missingDependencies();
  let npmInstall;
  if (dependencies.missing.length === 0) {
    npmInstall = { ok: true, stdout: `dependencies resolved (${dependencies.names.join(", ")})` };
  } else if (insideNodeModules(root)) {
    npmInstall = {
      ok: false,
      stdout: "",
      stderr: `dependencies missing (${dependencies.missing.join(", ")}) and this package lives under node_modules — ` +
        "the installer never runs npm install there; reinstall the package with its dependencies " +
        "(npm install, from the project that depends on it) and run again"
    };
  } else if (dryRun) {
    npmInstall = { ok: true, stdout: `[would run] npm install — missing: ${dependencies.missing.join(", ")}` };
  } else {
    npmInstall = tryRun("npm", ["install"], { cwd: root });
  }
  // N3: dependencies present is not dependencies usable — prove the native
  // binding, in the dry run too (a dry run that says "complete" over a
  // binding that cannot load is the false green the stranger hit).
  if (npmInstall.ok && !(dryRun && dependencies.missing.length > 0)) {
    const binding = nativeBindingMissing();
    if (binding) npmInstall = { ok: false, stdout: "", stderr: binding };
  }

  // ── CORE: plugin symlink ──
  safeMkdir(path.join(claudeHome, "skills"));
  let pluginOk = true;
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    const current = stat.isSymbolicLink() ? fs.readlinkSync(target) : null;
    if (stat.isSymbolicLink() && current === root) {
      // already linked
    } else if (force) {
      safeRename(target, backupName(target));
      safeSymlink(root, target);
    } else if (!dryRun) {
      pluginOk = false;
      console.error(`Refusing to replace existing plugin path: ${target}\nUse --force to move it aside.\n`);
    }
  } else {
    safeSymlink(root, target);
  }

  // ── CORE: CLI links ──
  safeMkdir(binDir);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const commands = Object.fromEntries(
    Object.entries(packageJson.bin).map(([name, cible]) => [name, path.join(root, cible)])
  );
  const cliLinks = [];
  for (const [name, source] of Object.entries(commands)) {
    const link = path.join(binDir, name);
    let status = "linked";
    if (fs.existsSync(link)) {
      const stat = fs.lstatSync(link);
      const current = stat.isSymbolicLink() ? fs.readlinkSync(link) : null;
      if (stat.isSymbolicLink() && current === source) {
        status = "already-linked";
      } else if (force) {
        safeRename(link, backupName(link));
        safeSymlink(source, link);
      } else if (!dryRun) {
        status = "conflict";
      } else {
        status = "conflict (would need --force)";
      }
    } else {
      safeSymlink(source, link);
    }
    cliLinks.push({ name, link, source, status });
  }
  const linksOk = cliLinks.every((e) => e.status !== "conflict");

  // ── CORE: runtime dirs ──
  if (!dryRun) ensureRuntimeDirs();
  else console.log("  mkdir -p ~/.valxos-messenger/{run,status,logs,exports}");

  // ── CORE: the office itself ──
  // `valxos-doctor` reports on the office and never creates it, so the office is
  // born HERE: opened once by the code every command opens it with (schema and
  // migrations included).  Without this the first doctor after a clean install —
  // the very next step the README gives — would say "no office" and turn red on a
  // sound install.  Done in a child so the installer stays loadable before its
  // dependencies are (an install from a clone runs `npm install` first).
  const officeDb = path.join(baseDir(), "broker.db");
  let office;
  if (dryRun) {
    console.log(`  [would open] ${officeDb} (the office database, created when absent)`);
    office = { ok: true, path: officeDb, note: "dry run: not opened" };
  } else if (!npmInstall.ok) {
    office = { ok: false, path: officeDb, error: "not attempted: the dependencies are not usable (see above)" };
  } else {
    const databaseModule = pathToFileURL(path.join(root, "src", "lib", "database.js")).href;
    const opened = tryRun(
      process.execPath,
      ["--input-type=module", "-e", `import { openDatabase } from ${JSON.stringify(databaseModule)}; openDatabase().close();`],
      { cwd: root }
    );
    office = opened.ok
      ? { ok: true, path: officeDb }
      : { ok: false, path: officeDb, error: firstErrorLine(opened.stderr) };
  }

  // ── legacy plugin link (cc2cc-v2 era) ──
  // The plugin id was `cc2cc-v2` until Run 6; the sessions already running in
  // this house still read that link.  When it points at this checkout it is
  // kept and named, with the gesture to retire it once no session runs.  The
  // installer never removes it.  A link that points elsewhere is not ours.
  const legacyLink = path.join(claudeHomeDir(), "skills", LEGACY_PLUGIN_DIR);
  let legacyPluginLink = null;
  try {
    if (fs.lstatSync(legacyLink).isSymbolicLink() && linkRealTarget(legacyLink) === realPathLoose(root)) {
      legacyPluginLink = legacyLink;
    }
  } catch {
    // absent, or a dangling link: nothing of ours to name
  }

  // ── OPTIONAL: Claude Code integration ──
  const optional = {};
  optional.validate = dryRun
    ? { ok: null, stdout: `[would run] claude plugin validate ${root}` }
    : tryRun("claude", ["plugin", "validate", root]);
  optional.enable = skipEnable
    ? { ok: true, stdout: "skipped (--no-enable)" }
    : dryRun
      ? { ok: true, stdout: "[would run] claude plugin enable valxos-messenger@skills-dir" }
      : tryRun("claude", ["plugin", "enable", "valxos-messenger@skills-dir"]);

  // ── launchd plists (only when asked for) ──
  const launchd = launchdRequested
    ? installLaunchd()
    : { requested: false, note: "not requested — pass --launchd to write the plists" };

  // ── doctor ──
  // Its verdict stays informational: a green install with a stopped Facteur
  // is a complete install.  But a doctor that could NOT RUN — a dependency
  // whose native build is missing, a module not found — is the net behind
  // the dependency decision above: it is named here, and the verdict goes
  // red.  Run with the node running this install, never a `node` on PATH.
  let doctorVerdict = null;
  let doctorError = null;
  if (!dryRun) {
    const doctor = tryRun(process.execPath, [`${root}/src/bin/valxos-doctor.js`], { cwd: root });
    if (!doctor.ok) {
      doctorError = firstErrorLine(doctor.stderr);
    } else {
      try { doctorVerdict = JSON.parse(doctor.stdout).ok; } catch { doctorError = "the doctor's report is not JSON"; }
    }
  }
  const doctorRan = doctorError === null;

  // ── verdict ──
  const coreOk = npmInstall.ok && pluginOk && linksOk && office.ok;
  // Like the links: a dry-run conflict ("would need --force") is a warning,
  // only a real refusal is a failure.
  const launchdOk = !launchd.requested
    || (launchd.plists.every((p) => p.status !== "conflict")
      && (launchd.loaded === null || launchd.loaded.every((l) => l.ok)));
  const ok = coreOk && launchdOk && doctorRan;

  // ── human-readable summary ──
  console.log(`\n${dryRun ? "[DRY RUN] " : ""}Install summary:`);
  console.log(`  npm dependencies:    ${npmInstall.ok ? "✓" : "✗"}  ${(npmInstall.ok ? npmInstall.stdout : npmInstall.stderr || "").trim().split("\n")[0]}`);
  if (!npmInstall.ok && /^native binding missing/.test(npmInstall.stderr || "")) console.log(npmInstall.stderr);
  console.log(`  plugin symlink:     ${pluginOk ? "✓" : "✗"}  ${target}`);
  console.log(`  CLI links:           ${linksOk ? "✓" : "✗"}  ${cliLinks.length} commands in ${binDir}`);
  console.log(
    `  office database:     ${office.note ? "—" : office.ok ? "✓" : "✗"}  ` +
      `${office.ok ? office.path : office.error}${office.note ? ` (${office.note})` : ""}`
  );
  console.log(`  Claude Code validate:${optional.validate.ok ? "✓" : "— (claude not found or validation failed)"}`);
  console.log(`  Claude Code enable:  ${optional.enable.ok ? "✓" : "— (skipped or failed)"}`);
  if (legacyPluginLink) {
    console.log(`  legacy plugin link kept (live sessions read it): ${legacyPluginLink}`);
    console.log(`  when no session of this house is running:  claude plugin disable ${LEGACY_PLUGIN_DIR}@skills-dir && rm ${legacyPluginLink}`);
  }
  if (!launchd.requested) {
    console.log(`  launchd plists:      — ${launchd.note}`);
  } else {
    console.log(`  launchd plists:      ${launchdOk ? "✓" : "✗"}  ${launchd.plists.length} in ${launchd.dir}`);
    for (const p of launchd.plists) console.log(`    ${p.label.padEnd(30)} ${p.status.padEnd(12)} ${p.path}`);
    console.log(`    web operator:  ${launchd.operatorNote}`);
    if (launchd.loaded === null) {
      console.log(`  To load them now (not done — pass --launchd-load to have the installer run this):`);
      for (const command of launchd.loadCommands) console.log(`    ${command}`);
    } else {
      for (const l of launchd.loaded) {
        console.log(`    ${l.ok ? "✓" : "✗"} ${l.command.join(" ")}`);
        if (l.alreadyLoaded && l.ok) {
          console.log("      already loaded — plist unchanged, nothing to reload");
        } else if (l.alreadyLoaded) {
          console.log("      already loaded — the service still runs the previous plist; to make this one live, by hand:");
          console.log(`      launchctl bootout gui/$(id -u)/${l.label} && launchctl bootstrap gui/$(id -u) ${l.path}`);
        } else if (!l.ok) {
          console.log(`      ${l.stderr.trim()}`);
        }
      }
    }
  }
  if (!dryRun) {
    console.log(`  doctor:              ${
      !doctorRan ? `✗ could not run — ${doctorError}` : doctorVerdict ? "✓ green" : "✗ issues found"
    }`);
  }
  // The overall line names the step that failed: "core install failed" is
  // for the core, not for a launchd plist that was refused or a doctor that
  // could not run above a complete core.
  const overall = ok
    ? "✓ core install complete"
    : !coreOk
      ? "✗ core install failed"
      : !doctorRan
        ? "✗ core install complete, but the doctor could not run — see above"
        : "✗ core install complete, launchd step failed — see above";
  console.log(`\nOverall: ${overall}`);
  if (!optional.validate.ok || !optional.enable.ok)
    console.log("  (Claude Code integration is optional — CLI and MCP work without it.)");
  console.log(`\nNext: add ${binDir} to your PATH if not already there, then run: valxos-doctor`);

  // ── machine-readable ──
  process.stdout.write(JSON.stringify({
    ok, mode, repo: root, pluginTarget: target, legacy_plugin_link: legacyPluginLink,
    npmInstall, pluginOk, cliLinks, linksOk, office, optional, launchd, doctorVerdict, doctorError
  }, null, 2) + "\n");

  if (!ok) process.exitCode = 1;
}

// ─────────────────────────── launchd ───────────────────────────

// Writes the two plists under ~/Library/LaunchAgents from the templates in
// scripts/launchd/, then — only with --launchd-load — bootstraps them.  A
// plist already there that we did not write is refused unless --force moves
// it aside (timestamped backup, like the links); one we did write is left
// alone when identical and refreshed (backup kept) when it changed.
function installLaunchd() {
  const dir = launchAgentsDir(home);
  // The office the daemons will serve is the one this install runs against:
  // launchd starts them with a bare environment, so the path is pinned in
  // the plist rather than left to a default they cannot see.
  const runtimeHome = baseDir();
  // The node named in the plists is the stable entry point to the one running
  // this install (the PATH's node when it leads here), never the versioned
  // binary a `brew upgrade node` removes — see stableNodePath().
  // The houses, pinned the same way: the VALXOS_MAISONS declaration (alias
  // CC2CC_MAISONS) this install runs with, as written; unset or blank, the
  // plists carry <home>/.claude (see maisonsDuPlist).
  const maisons = String(valeurDeLEnvironnement(process.env, "CC2CC_MAISONS") || "").trim() || null;
  const plan = planPlists({ home, root, runtimeHome, node: stableNodePath(), operator, maisons });
  // Where the web door's operator comes from, said plainly: pinned by
  // --operator (then it beats web.env), named in web.env, or nowhere — and a
  // door without an operator refuses to start, so that last case is said loud.
  // Presence only: the operator's name is private, the doctor says the same.
  const webEnvPath = path.join(runtimeHome, "web.env");
  const webEnvText = readIfExists(webEnvPath);
  const webEnvOperator = webEnvText !== null && /^\s*(VALXOS_WEB_OPERATEUR|CC2CC_WEB_OPERATEUR)=\S/m.test(webEnvText);
  const operatorNote = operator !== null
    ? `${operator} — pinned in the plist (VALXOS_WEB_OPERATEUR); it takes precedence over web.env`
    : webEnvOperator
      ? `from web.env (${webEnvPath})`
      : `NOT SET — set VALXOS_WEB_OPERATEUR in ${webEnvPath} or pass --operator; the door refuses to start without one`;
  const uid = process.getuid();
  // A legacy label (cc2cc-v2 era) still loaded holds port 8790: loading ours
  // next to it would double-bind.  Nothing is bootstrapped while one runs;
  // the bootout to do first is printed, never run from here.
  // A probe that could not run refuses too (fail-closed): port 8790 is not
  // confirmed free.  legacy_probe is null when no load was attempted.
  // PROBED BEFORE ANY PLIST IS WRITTEN (F1, adversarial pass, 28/09): a
  // refused load used to leave our new plists in LaunchAgents next to the
  // legacy ones, and launchd loaded all four at the next login — two doors on
  // 8790.  A refused load now writes nothing.
  const legacy = launchdLoad && !dryRun ? legacyLoaded(uid) : { loaded: [], probe: null, detail: [] };
  // N2: a legacy plist present in LaunchAgents and NOT disabled refuses the
  // load too — at the next login launchd would start it beside ours.
  const enabledLegacy = launchdLoad && !dryRun ? legacyEnabledPlists(uid) : { probe: null, presents: [], enabled: [] };
  const loadRefused = legacy.probe === "impossible" || legacy.loaded.length > 0 || enabledLegacy.enabled.length > 0;
  if (!loadRefused) safeMkdir(dir);

  const plists = [];
  for (const plist of plan) {
    const entry = { label: plist.label, path: plist.path };
    if (loadRefused) {
      entry.status = "not written (load refused)";
      plists.push(entry);
      continue;
    }
    let status = verdict(plist, readIfExists(plist.path));
    if (status === "conflict" && force) {
      entry.backup = backupName(plist.path);
      safeRename(plist.path, entry.backup);
      status = "write";
    }
    if (status === "conflict") {
      entry.status = dryRun ? "conflict (would need --force)" : "conflict";
      if (!dryRun) {
        console.error(
          `Refusing to replace a launchd plist this installer did not write: ${plist.path}\n` +
          `Use --force to move it aside (a timestamped backup is kept).\n`
        );
      }
    } else if (status === "unchanged") {
      entry.status = "unchanged";
    } else {
      if (status === "update") {
        entry.backup = backupName(plist.path);
        safeRename(plist.path, entry.backup);
      }
      safeWrite(plist.path, plist.content);
      entry.status = dryRun
        ? (status === "update" ? "would-update" : "would-write")
        : (status === "update" ? "updated" : "written");
    }
    plists.push(entry);
  }

  const loadCommands = plists.map((p) => `launchctl bootstrap gui/$(id -u) ${p.path}`);
  let loaded = null;
  if (legacy.probe === "impossible") {
    const line = legacyProbeImpossibleLine(legacy.detail);
    loaded = [{ label: legacy.detail[0].label, path: null, command: [], ok: false, alreadyLoaded: false, stderr: line }];
    console.log(`  Refusing to load: ${line}. Nothing was written or bootstrapped.`);
  } else if (legacy.loaded.length === 0 && enabledLegacy.enabled.length > 0) {
    loaded = enabledLegacy.enabled.map((label) => ({
      label, path: null, command: [], ok: false, alreadyLoaded: false,
      stderr: enabledLegacy.probe === "impossible"
        ? `legacy plist ${label} present; launchctl print-disabled could not run (${enabledLegacy.stderr || "no output"}) — its state is unknown`
        : `legacy plist ${label} present and not disabled — launchd would load it at the next login, beside ours`
    }));
    console.log("  A legacy launchd plist is present and not disabled; nothing was written or bootstrapped. Disable it first:");
    for (const label of enabledLegacy.enabled) console.log(`  launchctl disable gui/$(id -u)/${label}`);
  } else if (legacy.loaded.length > 0) {
    loaded = legacy.loaded.map((label) => ({
      label, path: null, command: [], ok: false, alreadyLoaded: false,
      stderr: `legacy label ${label} still loaded — port 8790 would double-bind`
    }));
    console.log("  A legacy launchd label is still loaded; nothing was written or bootstrapped. Stop it first:");
    for (const label of legacy.loaded) {
      console.log(`  launchctl bootout gui/$(id -u)/${label} && launchctl disable gui/$(id -u)/${label}`);
    }
  } else if (launchdLoad) {
    const loadable = plists.filter((p) => !p.status.startsWith("conflict"));
    if (dryRun) {
      for (const p of loadable) console.log(`  [would run] ${launchctl} ${bootstrapArgs(p.path, uid).join(" ")}`);
    } else {
      loaded = loadable.map((p) => {
        const args = bootstrapArgs(p.path, uid);
        const run = tryRun(launchctl, args);
        // Exit 5 ("Bootstrap failed: 5: Input/output error") is launchctl for
        // "already loaded".  Fine when the plist did not change; not fine when
        // it was just written or refreshed — the running service still reads
        // the OLD file, and only a bootout + bootstrap makes this one live.
        // That gesture is printed, never run from here.
        const alreadyLoaded = !run.ok && (run.status === 5 || /Bootstrap failed: 5\b/.test(run.stderr || ""));
        return {
          label: p.label,
          path: p.path,
          command: [launchctl, ...args],
          ok: run.ok || (alreadyLoaded && p.status === "unchanged"),
          alreadyLoaded,
          stderr: run.ok ? "" : run.stderr
        };
      });
    }
  }

  return { requested: true, operator, webEnvOperator, operatorNote, dir, plists, loadCommands, loaded,
    legacy_loaded: legacy.loaded, legacy_probe: legacy.probe, legacy_probe_detail: legacy.detail,
    legacy_enabled_plists: enabledLegacy.enabled, legacy_disabled_probe: enabledLegacy.probe };
}

// ─────────────────────────── relais ───────────────────────────

function relaisUsageError() {
  const other = ["--uninstall", "--launchd", "--launchd-load", "--launchd-unload", "--no-enable", "--codex"].find((flag) => hasFlag(flag))
    || (operator !== null ? "--operator" : null);
  if (other) return `--relais does not combine with ${other}: it only writes the relay's plist.`;
  if (hasFlag("--dry-run") && codexWrite) return "--write and --dry-run contradict each other (--relais without --write is already a dry run).";
  if (codexSelf !== null || codexHomeFlag !== null || codexDoor !== null) return "--self, --codex-home and --porte apply to --codex only.";
  return null;
}

// Writes `com.valxos.messenger.relais.plist` under ~/Library/LaunchAgents, and
// nothing else: it never loads it (the command is printed), never writes the
// Facteur's or the door's plists.  Without --write it only says what it would
// write.  A plist there that we did not write is refused unless --force moves
// it aside; one we wrote is left when identical and refreshed (backup kept)
// when it changed.
function doRelais() {
  const runtimeHome = baseDir();
  const plan = planRelaisPlist({ home, root, runtimeHome, node: stableNodePath() });
  console.log(dryRun ? "valxos-messenger install --relais (dry run: pass --write to write it)" : "valxos-messenger install --relais");
  const existing = readIfExists(plan.path);
  let status = verdict(plan, existing);
  let backup = null;
  if (status === "conflict" && force) {
    backup = backupName(plan.path);
    safeRename(plan.path, backup);
    status = "write";
  }
  if (status === "conflict") {
    console.error(`Refusing to replace a launchd plist this installer did not write: ${plan.path}\nUse --force to move it aside (a timestamped backup is kept).`);
    console.log(`  ${plan.label}  conflict${dryRun ? " (would need --force)" : ""}  ${plan.path}`);
    process.exitCode = dryRun ? 0 : 1;
    return;
  }
  if (status === "unchanged") {
    console.log(`  ${plan.label}  unchanged  ${plan.path}`);
  } else {
    if (status === "update") {
      backup = backupName(plan.path);
      safeRename(plan.path, backup);
    }
    safeMkdir(path.dirname(plan.path));
    safeMkdir(path.join(runtimeHome, "logs"));
    safeWrite(plan.path, plan.content);
    console.log(`  ${plan.label}  ${dryRun ? "would-" : ""}${status === "update" ? "update" : "write"}  ${plan.path}`);
  }
  if (!fs.existsSync(path.join(runtimeHome, "relais.json"))) {
    console.log(`  note: ${path.join(runtimeHome, "relais.json")} does not exist yet; the relay refuses to start without it (see docs/RELAIS.md)`);
  }
  console.log("  Not loaded. To start it, by hand:");
  console.log(`    launchctl bootstrap gui/$(id -u) ${plan.path}`);
}

// ─────────────────────────── codex ───────────────────────────

// The refusal of a --codex invocation, or null.  Checked before anything is
// read; like --operator, a word that applies to nothing is refused, never
// swallowed.
function codexUsageError() {
  const other = ["--uninstall", "--launchd", "--launchd-load", "--launchd-unload", "--force", "--no-enable"].find((flag) => hasFlag(flag))
    || (operator !== null ? "--operator" : null);
  if (other) return `--codex does not combine with ${other}: it only wires Codex.`;
  if (codexWrite && dryRun) return "--write and --dry-run contradict each other (--codex without --write is already a dry run).";
  if (!codexSelf) return "--codex needs --self NAME: the identity the Codex hooks and MCP server serve (it is never guessed from the hostname).";
  if (!validateAgentId(codexSelf)) {
    return `--self "${codexSelf}" is not an acceptable identity (letters, digits, dot, dash or underscore; 64 characters at most).`;
  }
  if (codexDoor === "") return `--porte needs ${INSTALL_DOORS.join(" or ")}.`;
  if (codexDoor !== null && !INSTALL_DOORS.includes(codexDoor)) {
    return `--porte ${codexDoor} is not a door this installer wires (${INSTALL_DOORS.join(" or ")}).`;
  }
  if (codexHomeFlag === "") return "--codex-home needs a DIR.";
  if (codexHomeFlag !== null && !path.isAbsolute(codexHomeFlag)) return `--codex-home ${codexHomeFlag} is not an absolute path.`;
  const fromEnv = String(process.env.CODEX_HOME || "").trim();
  if (codexHomeFlag === null && fromEnv && !path.isAbsolute(fromEnv)) {
    return `CODEX_HOME=${fromEnv} is not an absolute path; set an absolute path or pass --codex-home DIR.`;
  }
  return null;
}

// The Codex home: --codex-home, else $CODEX_HOME (what Codex itself reads),
// else ~/.codex.  Never written to without --write.
function resolveCodexHome() {
  if (codexHomeFlag !== null) return path.resolve(codexHomeFlag);
  const fromEnv = String(process.env.CODEX_HOME || "").trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(home, ".codex");
}

// THREE OUTCOMES for a file of the user's Codex home (round 1): absent
// (ENOENT, and only that), its text, or unreadable.  `readIfExists`, shared
// by the rest of this installer, reads EVERY error as "absent": a config.toml
// in mode 000 was then planned as new, replaced without a backup, and the
// report said ok.  A symlink is followed; a broken one is unreadable (it is
// never replaced by a file).  The text must be UTF-8, byte for byte: a lossy
// decoding would rewrite bytes the user never asked us to touch.
function readCodexFile(file) {
  const cause = (error) => String(error?.message || error);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return error?.code === "ENOENT" ? { state: "absent" } : { state: "unreadable", cause: cause(error) };
  }
  if (stat.isSymbolicLink()) {
    try {
      stat = fs.statSync(file);
    } catch (error) {
      return { state: "unreadable", cause: error?.code === "ENOENT" ? "it is a symlink whose target does not exist" : cause(error) };
    }
  }
  if (!stat.isFile()) return { state: "unreadable", cause: stat.isDirectory() ? "it is a directory" : "it is not a regular file" };
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    return { state: "unreadable", cause: cause(error) };
  }
  try {
    return { state: "content", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { state: "unreadable", cause: "it is not valid UTF-8" };
  }
}

// Why a file read whole cannot be merged, or null: hooks.json must be JSON,
// config.toml must be TOML 1.0 the validator reads whole (tomlProblem).
function codexFileProblem(kind, text) {
  if (kind === "hooks") {
    try {
      JSON.parse(text);
      return null;
    } catch (error) {
      return `it is not valid JSON (${String(error?.message || error)})`;
    }
  }
  return tomlProblem(text);
}

// The node the hooks and the server run, and whether it is a FALLBACK (round
// 1): stableNodePath() found no stable door to the running node (no link on
// PATH, no argv0 alias) and that node is not itself on PATH.  The path pinned
// is then the binary itself, which a node upgrade may remove (Homebrew keeps
// it under a versioned Cellar directory).  Said in the report and on screen;
// never refused.
function codexNode() {
  const chemin = stableNodePath();
  if (chemin !== process.execPath) return { chemin, repli: false };
  let real;
  try {
    real = fs.realpathSync(process.execPath);
  } catch {
    return { chemin, repli: true };
  }
  const onPath = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir))
    .some((dir) => {
      try {
        return fs.realpathSync(path.join(dir, path.basename(process.execPath))) === real;
      } catch {
        return false;
      }
    });
  return { chemin, repli: !onPath };
}

// A file the user's Codex reads is replaced in one rename: Codex never sees
// half of it.  A config.toml that is a symlink (a dotfiles checkout) stays
// one: the file it leads to is the one replaced.  The mode is set after the
// write, so the umask cannot narrow or widen it.
function writeFileAtomic(file, content, mode) {
  const destination = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const tmp = `${destination}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, destination);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw error;
  }
}

// `--codex`: the Codex wiring for ONE identity — `[features] hooks = true`, the
// four lifecycle hooks (scripts/codex/hooks.template.json) and the MCP server
// entry.  Without --write it prints the three pieces and the plan and touches
// nothing.  With --write it merges them into <codex home>/config.toml and
// hooks.json: a dated backup of each file it changes, a diff, and never a
// value changed in place (one conflict, and nothing at all is written).  The
// decisions live in scripts/codex/codex-setup.js; this function reads, prints
// and writes.  The live-office guard of the test suites is never written.
function doCodex() {
  const write = codexWrite;
  const self = codexSelf;
  // null unless --porte pins one (round 1): each session's own door then holds.
  const door = codexDoor;
  const codexHome = resolveCodexHome();
  // The office the hooks and the server open: the one this install runs
  // against, pinned in both (the desktop app has no launcher to export it).
  const office = baseDir();
  // The node the hooks and the server run: the one running this install, by
  // its stable door (stableNodePath, as the launchd plists) — never a bare
  // `node` (the desktop app does not have the shell's PATH), never the
  // versioned binary a `brew upgrade node` removes.
  const node = codexNode();
  const hookScript = path.join(root, HOOK_MARKER);
  const configPath = path.join(codexHome, "config.toml");
  const hooksPath = path.join(codexHome, "hooks.json");
  const report = {
    ok: false, mode: "codex", dry_run: !write, codex_home: codexHome, self, office, porte: door, node, package_root: root,
    hook_script: hookScript, config: null, hooks: null, written: [], backups: [], conflicts: [],
    // A refusal on a file (round 1): its code, the file, and why — else null.
    // `motif` names a refusal's kind when it has one (`bom`, S13).
    refus: null, fichier: null, cause: null, motif: null
  };
  const finish = (ok) => {
    report.ok = ok;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!ok) process.exitCode = 1;
  };

  console.log(`${write ? "" : "[DRY RUN] "}Codex wiring for ${self} — Codex home: ${codexHome}\n`);
  if (!fs.existsSync(hookScript)) {
    report.conflicts.push(`this package has no Codex hook at ${hookScript}`);
    console.error(`${report.conflicts[0]}. Nothing was done.`);
    return finish(false);
  }
  const values = { packageRoot: root, self, office, node: node.chemin, porte: door };
  const hooks = renderHooks(fs.readFileSync(hooksTemplatePath(), "utf8"), values);
  // The three pieces, always printed and indented: what a reader copies by
  // hand — and no line of them starts with "{" (the machine report does).
  const pieces = [
    [configPath, "turn lifecycle hooks on", FEATURES_BLOCK],
    [hooksPath, "the four VALXOS Messenger hooks", JSON.stringify(hooks, null, 2)],
    [configPath, `the MCP server [mcp_servers.${MCP_SERVER_KEY}]`, mcpServerBlock(values)]
  ];
  pieces.forEach(([file, what, text], index) => {
    console.log(`${index + 1}. ${file} — ${what}:`);
    console.log(`${text.replace(/^/gm, "    ")}\n`);
  });
  console.log(door === null
    ? "Door: not pinned. Each session declares its own (VALXOS_CODEX_PORTE in its environment); without one it is app:\n" +
      "when a letter waits and the Codex desktop app is closed, the Facteur may open the app on the thread. A terminal\n" +
      "launcher should export VALXOS_CODEX_PORTE=cli. Pass --porte app or --porte cli to pin one door for every session.\n"
    : door === "app"
      ? "Door: app, pinned for every session of this Codex home, the terminal's included: when a letter waits and the\n" +
        "desktop app is closed, the Facteur may open the app on the thread, even for a terminal session.\n"
      : "Door: cli, pinned for every session of this Codex home, the desktop app's included: the Facteur rings the\n" +
        "thread and never opens the desktop app.\n");

  // Both files are read before anything is planned: one that cannot be used
  // refuses the whole wiring, dry run included — nothing is written, nothing
  // is backed up, and the report names the file and the cause.
  const reads = { config: readCodexFile(configPath), hooks: readCodexFile(hooksPath) };
  for (const [kind, file] of [["config", configPath], ["hooks", hooksPath]]) {
    const read = reads[kind];
    const problem = read.state === "unreadable" ? read.cause : read.state === "content" ? codexFileProblem(kind, read.text) : null;
    if (problem === null) continue;
    report.refus = read.state === "unreadable" ? "fichier-illisible" : "fichier-invalide";
    report.fichier = file;
    report.cause = problem;
    if (kind === "config" && read.state === "content" && commenceParUnBOM(read.text)) report.motif = "bom";
    console.error(`Refusing to wire Codex: ${file} cannot be used (${problem}). Nothing was written.`);
    return finish(false);
  }
  if (node.repli) {
    console.log(`Node: ${node.chemin} is the binary running this install, and no stable link to it is on PATH.\n` +
      "Upgrading node may remove it, and the hooks would stop running: re-run this install from the upgraded node.\n");
  }
  const configBefore = reads.config.state === "content" ? reads.config.text : null;
  const hooksBefore = reads.hooks.state === "content" ? reads.hooks.text : null;
  const config = planCodexConfig(configBefore ?? "", values);
  const hooksPlan = planCodexHooks(hooksBefore, hooks);
  report.config = { path: configPath, exists: configBefore !== null, features: config.features, mcp: config.mcp };
  report.hooks = { path: hooksPath, exists: hooksBefore !== null, status: hooksPlan.status, events: hooksPlan.events };
  report.conflicts.push(...config.conflicts, ...hooksPlan.conflicts);
  console.log(
    `Plan: config.toml [features] ${config.features.status}, [mcp_servers.${MCP_SERVER_KEY}] ${config.mcp.status}; hooks.json ${hooksPlan.status}`
  );
  for (const conflict of report.conflicts) console.log(`  conflict: ${conflict}`);
  // S13: the merged config.toml is read again, whole, before anything is
  // backed up or written — by the validator that read the user's file — and
  // features.hooks and our server are looked up in it as TOML reads them.  A
  // merge that would not give that file is refused, dry run included.
  const mergeProblem = config.conflicts.length === 0 ? mergedConfigProblem(config.text, values) : null;
  if (mergeProblem !== null) {
    report.refus = "fusion-invalide";
    report.fichier = configPath;
    report.cause = mergeProblem;
    console.error(`Refusing to wire Codex: merging into ${configPath} would not give a valid file (${mergeProblem}). Nothing was written.`);
    return finish(false);
  }

  if (!write) {
    console.log(report.conflicts.length > 0
      ? "\nDry run: nothing was changed. --write would refuse until the conflicts above are resolved by hand."
      : `\nDry run: nothing was changed. Run again with --write to merge this into ${codexHome}.`);
    return finish(report.conflicts.length === 0);
  }
  if (report.conflicts.length > 0) {
    console.error("Refusing to write: a value already in place is never changed by this installer; resolve the conflicts above by hand. Nothing was written.");
    return finish(false);
  }
  if (!fs.existsSync(codexHome)) {
    report.conflicts.push(`the Codex home ${codexHome} does not exist (run codex once, or pass --codex-home DIR)`);
    console.error(`Refusing to write: ${report.conflicts[report.conflicts.length - 1]}. Nothing was written.`);
    return finish(false);
  }
  // One date for the run: both backups carry the same minute.  Each file is
  // replaced atomically; an error on the second one (round 1: a full disk, a
  // link into a read-only directory) does not unwrite the first.  It is then
  // SAID — the file that failed, what was already written and the backup to
  // restore it from — in one sentence and in the report, never as a stack.
  const now = new Date();
  const backupOf = new Map();
  for (const [file, before, after] of [[configPath, configBefore, config.text], [hooksPath, hooksBefore, hooksPlan.text]]) {
    if (before === after) continue;
    try {
      let mode = 0o600;
      if (before !== null) {
        const backup = codexBackupName(file, { date: now });
        fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
        report.backups.push(backup);
        backupOf.set(file, backup);
        mode = fs.statSync(file).mode & 0o777;
      }
      writeFileAtomic(file, after, mode);
    } catch (error) {
      report.refus = "ecriture-interrompue";
      report.fichier = file;
      report.cause = String(error?.message || error);
      const undo = report.written.map((done) => (backupOf.has(done)
        ? `restore ${done} from ${backupOf.get(done)}`
        : `remove ${done} (it did not exist before)`));
      console.error(`Writing ${file} failed (${report.cause}). ${undo.length > 0
        ? `Already written: ${report.written.join(", ")}. To undo: ${undo.join("; ")}.`
        : "Nothing was written."}`);
      return finish(false);
    }
    report.written.push(file);
    console.log(`\n${lineDiff(before ?? "", after, file)}`);
  }
  if (report.written.length === 0) {
    console.log("\nNothing to change: this Codex home is already wired for this identity.");
  } else {
    console.log(`\nWritten: ${report.written.join(", ")}`);
    if (report.backups.length > 0) console.log(`Backups: ${report.backups.join(", ")}`);
  }
  if (report.written.includes(hooksPath)) {
    console.log("Next: start Codex and approve these hooks once with /hooks (never --dangerously-bypass-hook-trust).");
  }
  return finish(true);
}

// ─────────────────────────── entry ───────────────────────────

// The operator name lands in the web plist and, from there, in the door's
// environment: it is checked here with the door's own rule, before any
// file is touched.  (exitCode, not exit(): stderr may still be draining.)
if (unknownArg !== null) {
  // Refused before anything else: an argument nobody understood never
  // falls through to the default mode (install).
  console.error(`unknown flag: ${unknownArg}\n\n${USAGE}\nNothing was done.`);
  process.exitCode = 2;
} else if (helpRequested) {
  process.stdout.write(USAGE);
} else if (relaisMode) {
  const refusal = relaisUsageError();
  if (refusal !== null) {
    console.error(`${refusal} Nothing was done.`);
    process.exitCode = 2;
  } else {
    doRelais();
  }
} else if (!codexMode && (codexWrite || codexSelf !== null || codexHomeFlag !== null || codexDoor !== null)) {
  // Same rule as --operator: a flag that applies to nothing is refused, never swallowed.
  console.error("--write, --self, --codex-home and --porte apply to --codex only. Nothing was done.");
  process.exitCode = 2;
} else if (codexMode) {
  const refusal = codexUsageError();
  if (refusal !== null) {
    console.error(`${refusal} Nothing was done.`);
    process.exitCode = 2;
  } else {
    doCodex();
  }
} else if (operator !== null && !launchdRequested) {
  // A flag that applies to nothing is not swallowed: the operator would
  // believe the door was configured while nothing was written anywhere.
  console.error("--operator applies to the launchd plists only: pass --launchd or --launchd-load with it. Nothing was done.");
  process.exitCode = 2;
} else if (launchdUnload && !uninstall) {
  // Same rule as --operator: a flag that applies to nothing is refused, never swallowed.
  console.error("--launchd-unload applies to --uninstall only. Nothing was done.");
  process.exitCode = 2;
} else if (operator !== null && !validateAgentId(operator)) {
  console.error(
    `--operator "${operator}" is not an acceptable VALXOS_WEB_OPERATEUR ` +
    `(letters, digits, dot, dash or underscore; 64 characters at most). Nothing was done.`
  );
  process.exitCode = 2;
} else if (uninstall) {
  doUninstall();
} else {
  doInstall();
}
