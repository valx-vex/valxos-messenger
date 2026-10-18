#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// export-public — mirror one commit of this repository into the public export
// repository, replayably.
//
//   node tools/export-public.js --source <repo> --sha <commit> --target <dir>
//                               [--dry-run] [--force] [--exclude <prefix>]...
//                               [--no-default-exclude]
//
// The public export is a separate git repository with its own (clean)
// history.  This tool makes its working tree equal to the source commit:
//
//   - the file set is the one `git archive <commit>` would produce — every
//     file TRACKED at that commit, read from the object store, never from a
//     working tree: no tmp/, no .claude/, no node_modules/, no stray file;
//   - each of them replaces the target's copy, byte for byte, with its
//     executable bit; a file the target already holds identically is left
//     alone (git's blob hash is the witness, so a replay is a no-op);
//   - a target file the source no longer tracks is deleted — the target's
//     history keeps it.  The export is a pure mirror: since 2026-08-29 the
//     front door (CONTRIBUTING.md, SECURITY.md, .editorconfig, .github/**)
//     is tracked by the source like everything else, and KEEP names only the
//     repository itself (.git/**);
//   - --exclude <prefix> (repeatable) leaves tracked paths out of the mirror:
//     a tracked path whose path relative to the repository root starts with
//     the prefix is treated as if the source did not track it — never
//     written, and deleted from the target by the rule above when the target
//     tracks it (an untracked copy, possible only under --force, survives
//     like any other untracked path).  The prefix is taken as written, with
//     no boundary and no normalisation (a leading `./` is not stripped): end
//     a directory with `/` (`docs/run` would also reach docs/run.md).  The
//     plan lists every prefix under "excluded:" with the number of source
//     paths it matched; a prefix that matches nothing, neither in the source
//     nor in what the target tracks, draws a warning on stderr — never a
//     refusal, since a folder can legitimately have left the source;
//   - the source commit may carry its own exclusion list: a tracked
//     `.export-exclude` at its root, one prefix per line, a line starting with
//     `#` is a comment, blanks around a line are not part of the prefix.  Its
//     prefixes are excluded by default, in addition to every --exclude (a
//     prefix named twice counts once, as a default) — so the internal folders
//     and the private-name guard do not depend on whoever types the command
//     remembering three flags.  The list is read from the COMMIT, in git's
//     object store like every other source file, never from the working tree:
//     an uncommitted edit changes nothing, and a replay of an old sha gets the
//     list that sha had.  A commit without the file excludes nothing by
//     default, as before.  A file that cannot be read as a regular file (a
//     symbolic link) is refused before anything is written: an unreadable list
//     must never turn into "export everything".  The plan names these prefixes
//     "excluded (default):", the report flags them `default: true`, and a
//     listed prefix that matches nothing draws the same warning as a flag's.
//     --no-default-exclude turns the list off (the plan says so) — for the
//     tests that mirror a whole tree, not for a real export.  The file itself
//     stays in the mirror: it holds repository paths, no private name;
//   - a path may change kind between two commits (a tracked file becomes a
//     directory, a tracked directory becomes a file): the plan decides every
//     such transition from what the deletions free, and anything the target
//     does not track that stands in the way is refused BEFORE any mutation —
//     a half-synchronised target is worse than an untouched one.
//
// The target must be the top level of a git repository with a clean working
// tree (--force overrides the cleanliness check, nothing else).  The tool
// never commits: it prints the commit line to use.  It writes nothing outside
// the target — no temporary directory, no cache — and never looks through a
// symbolic link to decide what is there.  Its help, its usage errors and its
// refusals are written whole, synchronously, before it exits: a pipe
// (`| less`, `| wc -c`) never cuts them.
//
// This file lives in tools/, outside the `files` whitelist of package.json:
// it never ships in the npm package (test/export-public.test.js keeps it so).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// Target-only paths that survive a sync: only the repository itself.  A
// pattern ending in `/**` protects everything under that directory; anything
// else would be one exact path.  (Until 2026-08-29 the export's front door
// lived here; it is tracked by the source now — a pure mirror.)
const KEEP = [".git/**"];

// The exclusion list the source commit carries, at its root.
const EXCLUDE_FILE = ".export-exclude";

const USAGE = `usage: node tools/export-public.js --source <repo> --sha <commit> --target <dir>
                                   [--dry-run] [--force] [--exclude <prefix>]...
                                   [--no-default-exclude]

  --source <repo>   the repository to read from (any checkout or worktree of it)
  --sha <commit>    the commit to mirror (a sha, a tag, a branch name)
  --target <dir>    the export repository: top level of a git checkout, clean
  --dry-run         print the plan, write and delete nothing
  --force           proceed on a target with uncommitted changes
  --exclude <prefix>
                    leave every tracked path under <prefix> out of the mirror
                    (repeatable; end a directory with /)
  --no-default-exclude
                    do not apply the prefixes the source commit lists in its
                    ${EXCLUDE_FILE} (applied by default, in addition to --exclude)
  --name <name>     the source's name in the commit line (default: the main
                    repository's directory, even when --source is a worktree)

Kept in the target when absent from the source: ${KEEP.join(", ")} — the export is a pure mirror
`;

// ─────────────────────────── arguments ───────────────────────────

function parseArgs(argv) {
  const options = { dryRun: false, force: false, defaultExclude: true, exclude: [] };
  const values = { source: null, sha: null, target: null, name: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "--force") { options.force = true; continue; }
    if (arg === "--no-default-exclude") { options.defaultExclude = false; continue; }
    if (arg === "--help" || arg === "-h") return { help: true };
    const [name, inline] = arg.includes("=") ? arg.split(/=(.*)/s) : [arg, undefined];
    const key = name.replace(/^--/, "");
    // --exclude accumulates; every other option is set once.
    if (!name.startsWith("--") || !(key in values || name === "--exclude")) usageError(`unknown argument: ${arg}`);
    const value = inline !== undefined ? inline : argv[++i];
    // A separate value that looks like the next flag was forgotten: `--exclude
    // --dry-run` would swallow --dry-run and run for real.  `--name=--x` stays
    // the explicit spelling for a value that really starts with `--`.
    if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) usageError(`${name} needs a value`);
    if (name === "--exclude") { options.exclude.push(value); continue; }
    values[key] = value;
  }
  for (const key of ["source", "sha", "target"]) if (!values[key]) usageError(`--${key} is required`);
  return { ...options, ...values };
}

// Writes the WHOLE text to a descriptor, synchronously, then exits.  `process.exit()` right after
// `process.stdout.write()` cuts the text on a pipe: a macOS pipe is asynchronous, the write leaves in
// two parts and the exit takes the second — the help arrived cut at 1024 or 512 bytes, a usage error
// likewise, and so did a refusal that lists every uncommitted file of the target.  The callers rely on
// never getting control back (a refusal must stop the tool before anything is planned or written), so
// the text is written before the exit instead of waiting for a write callback.
//   - while stdout/stderr has not been touched as a stream, the descriptor is the one the shell gave:
//     on a pipe it blocks, and the write waits for the reader;
//   - if it was already made non-blocking and the pipe is full (EAGAIN), wait two milliseconds for the
//     reader and resume rather than drop the rest;
//   - any other error (EPIPE: the reader left; EBADF: no output) leaves nothing to save, and the exit
//     keeps its code.
// Same mechanism as src/bin/cli-args.js; this file imports nothing from src/.
const PAUSE = new Int32Array(new SharedArrayBuffer(4));
function writeAllThenExit(descriptor, text, code) {
  const bytes = Buffer.from(text, "utf8");
  let written = 0;
  while (written < bytes.length) {
    try {
      written += fs.writeSync(descriptor, bytes, written, bytes.length - written);
    } catch (error) {
      if (error.code !== "EAGAIN") break;
      Atomics.wait(PAUSE, 0, 0, 2);
    }
  }
  process.exit(code);
}

function usageError(message) {
  writeAllThenExit(2, `export-public: ${message}\n\n${USAGE}`, 2);
}

function refuse(message) {
  writeAllThenExit(2, `export-public: ${message}\n`, 1);
}

// ─────────────────────────── git ───────────────────────────

function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...options
  });
}

// The name in the commit line: the main repository's directory — the parent
// of the common .git — so a worktree names the repository it belongs to.
function repositoryName(repo) {
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  return path.basename(path.dirname(common));
}

function topLevel(dir) {
  const probe = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  return fs.realpathSync(probe.stdout.trim());
}

// `<mode> <type> <hash>\t<path>` per entry, NUL-separated: the tree at the commit.
function treeEntries(source, sha) {
  return git(source, ["ls-tree", "-r", "-z", sha])
    .split("\0").filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, hash] = line.slice(0, tab).split(" ");
      return { mode, type, hash, relative: line.slice(tab + 1) };
    });
}

// One `git cat-file --batch` for all the blobs to write: `<hash> blob <size>\n`,
// the bytes, a newline.  Binary-safe (the fonts under src/web/public/polices).
function readBlobs(source, hashes) {
  const contents = new Map();
  if (hashes.length === 0) return contents;
  const out = execFileSync("git", ["-C", source, "cat-file", "--batch"], {
    input: hashes.join("\n") + "\n", maxBuffer: 1024 * 1024 * 1024
  });
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at);
    const [hash, type, size] = out.toString("utf8", at, eol).split(" ");
    if (type !== "blob") refuse(`object ${hash} is not a blob (${type})`);
    const start = eol + 1;
    const end = start + Number(size);
    contents.set(hash, out.subarray(start, end));
    at = end + 1;
  }
  for (const hash of hashes) if (!contents.has(hash)) refuse(`blob ${hash} could not be read from the source`);
  return contents;
}

// git's own witness for "already identical": the blob hash of what is on disk.
function blobHash(buffer) {
  return crypto.createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

// ─────────────────────────── the default exclusions ───────────────────────────

// The prefixes of an exclusion list: one per line, a line starting with `#` is a
// comment, a blank line is nothing, and blanks (and a CR) around a prefix are not
// part of it.  Nothing else is normalised — a prefix is taken as written.
function parseExcludeList(text) {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
}

// What the SOURCE COMMIT lists in its `.export-exclude`: read from git's object
// store, like every source file — the working tree is never looked at.  No file,
// no default exclusion.  A file that is not a regular blob is refused (a symbolic
// link would hand back its target's path as "the list"): a list that cannot be
// read must never degrade into "export everything".
function defaultExclusions(source, sha) {
  const listed = git(source, ["ls-tree", "-z", sha, "--", EXCLUDE_FILE]).split("\0").filter(Boolean);
  if (listed.length === 0) return [];
  const tab = listed[0].indexOf("\t");
  const [mode, type, hash] = listed[0].slice(0, tab).split(" ");
  if (mode === "120000") refuse(`${EXCLUDE_FILE} is a symbolic link at ${sha} — the exclusion list must be a regular file; nothing was written or deleted`);
  if (type !== "blob") refuse(`${EXCLUDE_FILE} is a ${type} at ${sha} — the exclusion list must be a regular file; nothing was written or deleted`);
  return parseExcludeList(readBlobs(source, [hash]).get(hash).toString("utf8"));
}

// The prefixes in force, each with where it comes from: the list first (in the
// order of the file), then the flags; a prefix named twice counts once, as a default.
function exclusionsInForce(listed, flags) {
  const inForce = [];
  for (const [origin, prefixes] of [["default", listed], ["flag", flags]]) {
    for (const prefix of prefixes) if (!inForce.some((e) => e.prefix === prefix)) inForce.push({ prefix, origin });
  }
  return inForce;
}

// ─────────────────────────── paths ───────────────────────────

function isKept(relative) {
  return KEEP.some((pattern) =>
    pattern.endsWith("/**") ? relative.startsWith(pattern.slice(0, -2)) : relative === pattern
  );
}

// git never emits these, and the tool never trusts that: every path stays
// relative, inside the target, and out of .git.
function assertSafe(relative, target) {
  const segments = relative.split("/");
  if (path.isAbsolute(relative) || segments.some((s) => s === ".." || s === "" || s === "."))
    refuse(`refusing an unsafe path from the source tree: ${relative}`);
  if (segments[0] === ".git") refuse(`refusing to write into .git: ${relative}`);
  const absolute = path.join(target, relative);
  if (!absolute.startsWith(target + path.sep)) refuse(`path escapes the target: ${relative}`);
  return absolute;
}

// What the disk holds at a path, without following anything: nothing, a
// regular file, a symbolic link, a directory, or something else.
function kindAt(absolute) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return "missing";
    throw error;
  }
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "other";
}

// The same, in the terms git tracks: a file's blob hash and executable bit, a
// symlink's target hash.  Only called once every ancestor is known to be a
// real directory — a link is never looked through.
function onDisk(absolute) {
  const kind = kindAt(absolute);
  if (kind === "symlink") return { kind, hash: blobHash(Buffer.from(fs.readlinkSync(absolute))) };
  if (kind === "file") {
    return { kind, hash: blobHash(fs.readFileSync(absolute)), executable: Boolean(fs.lstatSync(absolute).mode & 0o100) };
  }
  return { kind };
}

// Every non-directory entry under a directory, as target-relative paths.
function filesUnder(target, relativeDir, out = []) {
  for (const entry of fs.readdirSync(path.join(target, relativeDir), { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) filesUnder(target, relative, out);
    else out.push(relative);
  }
  return out;
}

// Walks up from a deleted file's directory, removing what is empty, and stops
// at the first directory that still holds something.  A level that no longer
// exists is skipped, never read: under --force over an uncommitted sync the
// index still tracks a file whose directory is already gone (` D`), and a
// readdir there was an ENOENT in the middle of the application.
function pruneEmptyDirs(absolute, target) {
  let dir = path.dirname(absolute);
  while (dir !== target && dir.startsWith(target + path.sep)) {
    const kind = kindAt(dir);
    if (kind === "directory") {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } else if (kind !== "missing") {
      return;
    }
    dir = path.dirname(dir);
  }
}

// A directory tree that holds nothing but directories: removed bottom-up,
// never recursively over files — a file found here means the disk changed
// under the tool's feet, and that is an error, not something to delete.
function removeEmptyTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) throw new Error(`${path.join(dir, entry.name)} appeared during the sync — nothing was removed there`);
    removeEmptyTree(path.join(dir, entry.name));
  }
  fs.rmdirSync(dir);
}

// ─────────────────────────── the plan ───────────────────────────

// Everything is decided here, before a byte moves.  The deletions come first
// in the reasoning too: they are what frees a path whose kind changes.
function plan({ source, sha, target, exclude }) {
  // An excluded path is treated as one the source does not track: not
  // written, not counted, and a target that holds it loses it by the ordinary
  // deletion rule (it falls into `leaving`, like any file the target tracks
  // and the source does not).  The prefix is taken as written.
  const all = treeEntries(source, sha);
  const entries = all.filter(({ relative }) => !exclude.some(({ prefix }) => relative.startsWith(prefix)));
  const sourcePaths = new Set(entries.map((e) => e.relative));
  const tracked = git(target, ["ls-files", "-z"]).split("\0").filter(Boolean);

  // What each prefix reaches: in the source (what it keeps out) and in what the
  // target tracks (what the deletions will take).  A prefix that reaches
  // neither is most likely a typo, and the plan says so.
  const excluded = exclude.map(({ prefix, origin }) => ({
    prefix,
    origin,
    matched: all.filter(({ relative }) => relative.startsWith(prefix)).length,
    targetTracked: tracked.filter((relative) => relative.startsWith(prefix)).length
  }));

  const leaving = new Set();
  const kept = [];
  for (const relative of tracked) {
    if (sourcePaths.has(relative)) continue;
    if (isKept(relative)) kept.push(relative);
    else leaving.add(relative);
  }

  // The disk, one lstat per path, remembered: ancestors are asked many times.
  const kinds = new Map();
  const kindOf = (relative) => {
    if (!kinds.has(relative)) kinds.set(relative, kindAt(path.join(target, relative)));
    return kinds.get(relative);
  };
  // The first ancestor that is not a directory (a file, a link, …), or null
  // when the way down is directories or nothing at all.  Stopping at the first
  // non-directory is what keeps a link from ever being looked through.
  const blockingAncestor = (relative) => {
    const segments = relative.split("/");
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
      const kind = kindOf(prefix);
      if (kind === "missing") return null;
      if (kind !== "directory") return { relative: prefix, kind };
    }
    return null;
  };

  const refusals = [];
  const deletes = [];
  for (const relative of [...leaving].sort()) {
    const absolute = assertSafe(relative, target);
    const ancestor = blockingAncestor(relative);
    if (ancestor) {
      refusals.push(`${relative}: tracked by the target, but ${ancestor.relative} is a ${ancestor.kind} on disk — the working tree does not match the index`);
      continue;
    }
    const kind = kindOf(relative);
    if (kind === "directory" || kind === "other") {
      refusals.push(`${relative}: tracked by the target as a file, but a ${kind} on disk — the working tree does not match the index`);
      continue;
    }
    deletes.push({ relative, absolute, present: kind !== "missing" });
  }

  const writes = [];
  let unchanged = 0;
  for (const entry of entries) {
    if (entry.type !== "blob") refuse(`${entry.relative} is a ${entry.type} at ${sha} — submodules and trees are not mirrored`);
    if (!["100644", "100755", "120000"].includes(entry.mode)) refuse(`${entry.relative}: unsupported mode ${entry.mode}`);
    const absolute = assertSafe(entry.relative, target);
    const wantSymlink = entry.mode === "120000";
    const wantExecutable = entry.mode === "100755";

    // A file or a link on the way down: it must be leaving, or nothing lands.
    const ancestor = blockingAncestor(entry.relative);
    if (ancestor) {
      if (leaving.has(ancestor.relative)) writes.push({ ...entry, absolute, action: "create", disk: "missing" });
      else refusals.push(`${entry.relative}: ${ancestor.relative} is a ${ancestor.kind} on disk where the source has a directory, and the target does not track it — remove it and run again`);
      continue;
    }

    const disk = onDisk(absolute);
    if (disk.kind === "directory") {
      // A directory where the source has a file: it lands only if the
      // deletions empty the directory (empty subdirectories do not count).
      const blockers = filesUnder(target, entry.relative).filter((p) => !leaving.has(p));
      if (blockers.length === 0) writes.push({ ...entry, absolute, action: "create", disk: "directory" });
      else refusals.push(`${entry.relative}: a directory sits where the source has a file, holding what the target does not track — remove it and run again: ${blockers.slice(0, 5).join(", ")}${blockers.length > 5 ? `, … (${blockers.length})` : ""}`);
      continue;
    }
    if (disk.kind === "other") { refusals.push(`${entry.relative}: something that is neither a file, a link nor a directory sits there`); continue; }
    if (wantSymlink && disk.kind === "symlink" && disk.hash === entry.hash) { unchanged += 1; continue; }
    if (!wantSymlink && disk.kind === "file" && disk.hash === entry.hash) {
      if (disk.executable === wantExecutable) { unchanged += 1; continue; }
      writes.push({ ...entry, absolute, action: "chmod" });
      continue;
    }
    writes.push({ ...entry, absolute, action: disk.kind === "missing" ? "create" : "replace", disk: disk.kind });
  }

  return { entries, writes, deletes, kept, unchanged, refusals, excluded };
}

// ─────────────────────────── apply ───────────────────────────

// Nothing is decided here: the plan said what to do, this does it in order.
function apply({ source, target }, { writes, deletes }) {
  // Deletions first: they free the paths whose kind changes.
  for (const { absolute, present } of deletes) {
    if (present) fs.unlinkSync(absolute);
    pruneEmptyDirs(absolute, target);
  }
  const blobs = readBlobs(source, [...new Set(writes.filter((w) => w.action !== "chmod").map((w) => w.hash))]);
  for (const write of writes) {
    if (write.action === "chmod") {
      fs.chmodSync(write.absolute, write.mode === "100755" ? 0o755 : 0o644);
      continue;
    }
    // Whatever stood there leaves first: a file or a link is unlinked (never
    // written through), an emptied directory tree is taken down.
    if (write.disk === "symlink" || write.disk === "file") fs.unlinkSync(write.absolute);
    else if (write.disk === "directory" && kindAt(write.absolute) === "directory") removeEmptyTree(write.absolute);
    fs.mkdirSync(path.dirname(write.absolute), { recursive: true });
    const content = blobs.get(write.hash);
    if (write.mode === "120000") {
      fs.symlinkSync(content.toString("utf8"), write.absolute);
    } else {
      fs.writeFileSync(write.absolute, content);
      fs.chmodSync(write.absolute, write.mode === "100755" ? 0o755 : 0o644);
    }
  }
}

// ─────────────────────────── entry ───────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.help) writeAllThenExit(1, USAGE, 0);

const source = topLevel(args.source);
if (!source) refuse(`--source ${args.source} is not a git repository`);
const commit = spawnSync("git", ["-C", source, "rev-parse", "--verify", "--quiet", `${args.sha}^{commit}`], { encoding: "utf8" });
if (commit.status !== 0) refuse(`--sha ${args.sha} is not a commit of ${source}`);
const sha = commit.stdout.trim();

if (!fs.existsSync(args.target) || !fs.statSync(args.target).isDirectory()) refuse(`--target ${args.target} is not a directory`);
const target = fs.realpathSync(args.target);
const targetTop = topLevel(target);
if (!targetTop) refuse(`--target ${target} is not a git repository — the export needs a repository to keep the history of what it replaces`);
if (targetTop !== target) refuse(`--target ${target} is not the top level of its repository (${targetTop}) — the deletions would reach the rest of it`);
if (target === source) refuse("the target is the source repository itself — the export is a separate repository");
const dirty = git(target, ["status", "--porcelain", "--untracked-files=normal"]).trim();
if (dirty && !args.force) {
  refuse(`--target ${target} is not clean (uncommitted changes or untracked files):\n${dirty}\nCommit or stash them, or pass --force to proceed over them.`);
}

const sourceName = args.name || repositoryName(source);
// Read before anything is planned: an unreadable list refuses here, with nothing touched.
const listed = args.defaultExclude ? defaultExclusions(source, sha) : [];
const summary = plan({ source, sha, target, exclude: exclusionsInForce(listed, args.exclude) });
if (summary.refusals.length) {
  refuse(`the plan cannot be applied — nothing was written or deleted:\n  ${summary.refusals.join("\n  ")}`);
}
if (!args.dryRun) apply({ source, target }, summary);

const mode = args.dryRun ? "dry-run" : "sync";
const verb = args.dryRun ? "would " : "";
console.log(`${args.dryRun ? "[DRY RUN] " : ""}export-public: ${sourceName} @ ${sha} → ${target}`);
if (dirty && args.force) console.log(`  --force: proceeding over uncommitted changes in the target`);
console.log(`  written   ${summary.writes.length}${verb ? "  (would write)" : ""}`);
for (const w of summary.writes) console.log(`    + ${w.relative}${w.action === "chmod" ? "  (mode only)" : ""}${w.disk === "directory" ? "  (replaces an emptied directory)" : ""}`);
console.log(`  deleted   ${summary.deletes.length}${verb ? "  (would delete)" : ""}`);
for (const d of summary.deletes) console.log(`    - ${d.relative}${d.present ? "" : "  (already gone from disk — a deletion left to commit)"}`);
console.log(`  unchanged ${summary.unchanged}`);
console.log(`  kept      ${summary.kept.length}  (target-only, protected by the keep list)`);
for (const k of summary.kept) console.log(`    = ${k}`);
if (!args.defaultExclude) console.log(`  --no-default-exclude: the prefixes listed in ${EXCLUDE_FILE} are not applied`);
for (const { prefix, matched, origin } of summary.excluded) {
  console.log(`  excluded${origin === "default" ? " (default)" : ""}: ${prefix}  (${matched} tracked path${matched === 1 ? "" : "s"})`);
}
// A warning, never a refusal: once a folder has left the source, its prefix
// legitimately matches nothing there (and nothing in the target either).
for (const { prefix, matched, targetTracked, origin } of summary.excluded) {
  if (matched === 0 && targetTracked === 0) {
    const who = origin === "default" ? `${EXCLUDE_FILE} lists ${prefix}, which` : `--exclude ${prefix}`;
    process.stderr.write(`export-public: warning: ${who} matches no tracked path, in the source or in the target — a prefix is a repository-relative path taken as written (no ./, end a directory with /)\n`);
  }
}
if (args.dryRun) console.log("\n[DRY RUN] nothing was written or deleted.");

// The commit line: `main` only when the commit really is on the source's main.
const onMain = spawnSync("git", ["-C", source, "merge-base", "--is-ancestor", sha, "main"]).status === 0;
const short = sha.slice(0, 7);
console.log(`\nCommit with: sync: mirror ${sourceName} ${onMain ? "main " : ""}@ ${short}${onMain ? "" : `  (${short} is not on ${sourceName}'s main)`}`);

console.log(JSON.stringify({
  ok: true, mode, source, name: sourceName, sha, target,
  written: summary.writes.length, deleted: summary.deletes.length, unchanged: summary.unchanged,
  kept: summary.kept, keep: KEEP,
  defaultExclude: args.defaultExclude,
  exclude: summary.excluded.map(({ prefix, matched, origin }) => (origin === "default" ? { prefix, matched, default: true } : { prefix, matched })),
  files: { written: summary.writes.map((w) => w.relative), deleted: summary.deletes.map((d) => d.relative) }
}));
