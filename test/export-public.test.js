// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// THE PUBLIC EXPORT — tools/export-public.js mirrors one commit of this
// repository into the public export repository, and can be replayed.
//
// Born red on 2026-08-29: the public export had been copied by hand once
// (2026-08-23) and had drifted to ~rc0 while main was at rc.2 — no installer
// entry point, missing tests, missing fixes.  A mirror that is done by hand
// is done once; this tool is the gesture, and this file is its contract:
//
//   - every file tracked at the source commit lands in the target, byte for
//     byte, with its executable bit (git's own blob hash is the witness);
//   - a target file the source no longer tracks is deleted — the target's git
//     history keeps it.  Nothing else survives: the export is a pure mirror,
//     the keep list names the repository itself (.git/**) and nothing more
//     (until 2026-08-29 it protected the export's front door — CONTRIBUTING.md,
//     SECURITY.md, .editorconfig, .github/** — which the source tracks now);
//   - nothing is written outside the target: not in HOME, not in TMPDIR,
//     not in the source;
//   - replaying on the same (commit, target) changes nothing;
//   - a dirty target is refused (--force overrides, and says so);
//   - --exclude <prefix> (repeatable) keeps tracked paths out of the mirror,
//     deletes them from the target, and names each prefix in the plan with
//     the number of paths it matched — a prefix that matches nothing draws a
//     warning on stderr, never a refusal;
//   - the prefixes listed in the source commit's `.export-exclude` (one per
//     line, `#` for comments) are excluded too, without any flag — read from
//     the commit's object store, never from the working tree — unless
//     --no-default-exclude says otherwise (FIX-C, C7: the exclusion of the
//     internal folders and of the private-name guard no longer depends on
//     whoever types the command remembering three flags);
//   - --dry-run prints the plan and touches nothing;
//   - the help, a usage error and a refusal arrive WHOLE through a pipe (FIX-D, D1):
//     the tool writes the text synchronously before it exits.
//
// The toy target is a git repository born under mkdtemp; the source is this
// repository at its own HEAD — a real commit, never a fixture.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { enTubeReel, quote } from "./aide-tube.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(repo, "tools", "export-public.js");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

const KEEP_LIST = [".git/**"];

// The toy target: a git repository with three target-only files under the
// former keep prefixes, two stale files, and two files the source also
// tracks (with other content).
const FORMERLY_KEPT = {
  "CONTRIBUTING.old.md": "target-only: the source does not track this\n",
  ".github/ISSUE_TEMPLATE/stale.yml": "target-only: a template the source does not carry\n",
  ".editorconfig.local": "target-only: under a formerly kept name\n"
};
const STALE = {
  "old/stale.txt": "stale: the source no longer tracks this\n",
  "src/lib/gone.js": "stale: a file under a source directory\n"
};
const OVERWRITTEN = {
  "README.md": "old readme — the source's wins\n",
  ".github/workflows/tests.yml": "old workflow — a source file wins even under a kept prefix\n"
};

function git(cwd, args) {
  return execFileSync("git", ["-c", "user.name=toy", "-c", "user.email=toy@example.com", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
}

function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

// A sandbox holds the toy target, a fake HOME and a fake TMPDIR: after a run,
// the last two must still be empty and the sandbox must hold nothing else.
function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-export-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  for (const dir of [target, home, tmp]) fs.mkdirSync(dir);
  git(target, ["init", "-q", "-b", "main"]);
  writeTree(target, { ...FORMERLY_KEPT, ...STALE, ...OVERWRITTEN });
  git(target, ["add", "--", ...Object.keys(FORMERLY_KEPT), ...Object.keys(STALE), ...Object.keys(OVERWRITTEN)]);
  git(target, ["commit", "-q", "-m", "toy export before the sync"]);
  return { root, target, home, tmp };
}

// The tests that mirror the WHOLE source tree pass --no-default-exclude: this repository's own
// `.export-exclude` would otherwise keep three prefixes out of the mirror they compare with
// `git ls-tree`. `defaults: true` is the real gesture, used by the tests of that list.
// The flag goes BEFORE the caller's arguments: `--exclude` as a last argument must stay a usage error.
function run(box, extra = [], { target = box.target, source = repo, commit = sha, defaults = false } = {}) {
  return spawnSync(process.execPath, [tool, "--source", source, "--sha", commit, "--target", target, ...(defaults ? [] : ["--no-default-exclude"]), ...extra], {
    encoding: "utf8",
    cwd: box.root,
    env: { PATH: process.env.PATH, HOME: box.home, TMPDIR: box.tmp, LC_ALL: "C" }
  });
}

// The machine report is the last line of stdout.
function report(out) {
  const lines = out.stdout.trim().split("\n");
  const last = lines[lines.length - 1];
  assert.ok(last.startsWith("{"), `no JSON report at the end of:\n${out.stdout}\n${out.stderr}`);
  return JSON.parse(last);
}

function sourceEntries() {
  return execFileSync("git", ["ls-tree", "-r", "-z", sha], { cwd: repo, encoding: "utf8" })
    .split("\0").filter(Boolean)
    .map((line) => {
      const [meta, relative] = line.split("\t");
      const [mode, type, hash] = meta.split(" ");
      return { mode, type, hash, relative };
    });
}

// git's own witness: the blob hash of what is on disk.
function blobHash(buffer) {
  return crypto.createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

function walk(dir, prefix = "", out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), relative, out);
    else out.push(relative);
  }
  return out.sort();
}

function status(cwd) {
  return git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
}

// ── the sync ────────────────────────────────────────────────────────────────

test("the sync: every tracked source file lands byte for byte, every target-only file goes, nothing leaks outside the target", (t) => {
  const box = sandbox(t);
  const sourceBefore = status(repo);
  const out = run(box);
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);

  const entries = sourceEntries();
  assert.ok(entries.length > 100, `the source commit tracks a real tree (${entries.length} entries)`);
  for (const { mode, relative, hash } of entries) {
    const absolute = path.join(box.target, relative);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    assert.ok(stat && stat.isFile(), `${relative} is a regular file in the target`);
    assert.equal(blobHash(fs.readFileSync(absolute)), hash, `${relative} is byte for byte the source's blob`);
    assert.equal(Boolean(stat.mode & 0o100), mode === "100755", `${relative} carries its executable bit (${mode})`);
  }

  for (const relative of [...Object.keys(STALE), ...Object.keys(FORMERLY_KEPT)]) {
    assert.equal(fs.existsSync(path.join(box.target, relative)), false, `${relative} is gone — a pure mirror keeps nothing target-only`);
  }
  assert.equal(fs.existsSync(path.join(box.target, "old")), false, "an emptied directory is removed");
  assert.ok(fs.existsSync(path.join(box.target, "src", "lib")), "a directory the source still fills stays");
  for (const relative of Object.keys(OVERWRITTEN)) {
    const expected = execFileSync("git", ["show", `${sha}:${relative}`], { cwd: repo });
    assert.ok(expected.equals(fs.readFileSync(path.join(box.target, relative))), `${relative} is the source's version`);
  }

  // Exactly the source tree — nothing else.
  const expectedTree = entries.map((e) => e.relative).sort();
  assert.deepEqual(walk(box.target), expectedTree, "the target holds the source tree, and nothing else");

  // Nothing written outside the target.
  assert.deepEqual(fs.readdirSync(box.home), [], "the fake HOME stayed empty");
  assert.deepEqual(fs.readdirSync(box.tmp), [], "the fake TMPDIR stayed empty");
  assert.deepEqual(fs.readdirSync(box.root).sort(), ["home", "target", "tmp"], "the sandbox holds nothing new");
  assert.equal(status(repo), sourceBefore, "the source repository is untouched");

  // The report says what it did, and how to commit it.
  const summary = report(out);
  assert.equal(summary.ok, true);
  assert.equal(summary.mode, "sync");
  assert.equal(summary.sha, sha, "the full source commit is in the report");
  assert.equal(summary.deleted, Object.keys(STALE).length + Object.keys(FORMERLY_KEPT).length);
  assert.equal(summary.written + summary.unchanged, entries.length, "every source entry was either written or found unchanged");
  assert.ok(summary.written >= entries.length - Object.keys(OVERWRITTEN).length, "the toy target had almost nothing of the source");
  assert.deepEqual(summary.kept, [], "nothing target-only was kept");
  assert.deepEqual(summary.keep, KEEP_LIST, "the keep list names the repository itself and nothing more");
  assert.deepEqual(summary.exclude, [], "nothing is excluded unless asked");
  // The source's name is the main repository's directory — this test may run
  // from a worktree, whose own directory name is not the repository's.
  const repositoryName = path.basename(path.dirname(
    execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim()
  ));
  assert.match(out.stdout, new RegExp(`sync: mirror ${repositoryName} .*${sha.slice(0, 7)}`), "the commit reminder names the repository and the short sha");
  assert.match(out.stdout, /written\s+\d+/);
  assert.match(out.stdout, /deleted\s+\d+/);
  assert.match(out.stdout, /unchanged\s+\d+/);
});

test("replayed on the same commit and target, the export changes nothing", (t) => {
  const box = sandbox(t);
  const first = run(box);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  // A toy repository: -A is the natural gesture here, the house rule protects real trees.
  git(box.target, ["add", "-A"]);
  git(box.target, ["commit", "-q", "-m", "sync"]);
  assert.equal(status(box.target), "", "the toy target is clean after the commit");

  const second = run(box);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const summary = report(second);
  assert.equal(summary.written, 0, "nothing to write on a replay");
  assert.equal(summary.deleted, 0, "nothing to delete on a replay");
  assert.equal(summary.unchanged, sourceEntries().length);
  assert.equal(status(box.target), "", "the replay leaves the target clean");
});

test("a target with uncommitted changes is refused — and --force is the documented override", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(path.join(box.target, "wip.txt"), "uncommitted work\n");
  const before = walk(box.target).map((relative) => [relative, fs.readFileSync(path.join(box.target, relative), "utf8")]);

  const refused = run(box);
  assert.notEqual(refused.status, 0, "a dirty target is refused");
  assert.match(refused.stderr, /not clean|uncommitted/i, "the refusal names the reason");
  assert.match(refused.stderr, /--force/, "and the override");
  const after = walk(box.target).map((relative) => [relative, fs.readFileSync(path.join(box.target, relative), "utf8")]);
  assert.deepEqual(after, before, "a refusal touches nothing");

  const forced = run(box, ["--force"]);
  assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
  assert.equal(fs.existsSync(path.join(box.target, "old", "stale.txt")), false, "with --force the sync proceeds");
  assert.equal(fs.readFileSync(path.join(box.target, "wip.txt"), "utf8"), "uncommitted work\n", "an untracked file is not the tool's to delete");
});

test("--dry-run prints the plan and writes nothing", (t) => {
  const box = sandbox(t);
  const before = walk(box.target).map((relative) => [relative, fs.readFileSync(path.join(box.target, relative), "utf8")]);
  const out = run(box, ["--dry-run"]);
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  const after = walk(box.target).map((relative) => [relative, fs.readFileSync(path.join(box.target, relative), "utf8")]);
  assert.deepEqual(after, before, "the target is untouched");
  assert.equal(status(box.target), "", "git sees no change either");
  assert.deepEqual(fs.readdirSync(box.home), []);
  assert.deepEqual(fs.readdirSync(box.tmp), []);

  const summary = report(out);
  assert.equal(summary.mode, "dry-run");
  assert.equal(summary.deleted, Object.keys(STALE).length + Object.keys(FORMERLY_KEPT).length, "the plan counts the deletions");
  assert.ok(summary.written > 0, "the plan counts the writes");
  assert.match(out.stdout, /DRY RUN/);
  assert.match(out.stdout, /old\/stale\.txt/, "the plan names what would go");
});

test("refusals: a plain directory, a subdirectory of a repository, the source itself, an unknown commit, missing arguments", (t) => {
  const box = sandbox(t);

  const plain = path.join(box.root, "plain");
  fs.mkdirSync(plain);
  const notARepo = run(box, [], { target: plain });
  assert.notEqual(notARepo.status, 0);
  assert.match(notARepo.stderr, /git repository/i);
  assert.deepEqual(fs.readdirSync(plain), [], "nothing written into a directory that is not a repository");

  const sub = path.join(box.target, "src");
  const subdirectory = run(box, [], { target: sub });
  assert.notEqual(subdirectory.status, 0, "a subdirectory is not a target: the deletions would reach the rest of its repository");
  assert.match(subdirectory.stderr, /top level|toplevel/i);
  assert.ok(fs.existsSync(path.join(box.target, "old", "stale.txt")), "and nothing was deleted");

  const self = run(box, [], { target: repo });
  assert.notEqual(self.status, 0, "the source is never its own target");
  assert.match(self.stderr, /source/i);

  const unknown = run(box, [], { commit: "0000000000000000000000000000000000000000" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /commit/i);
  assert.ok(fs.existsSync(path.join(box.target, "old", "stale.txt")), "an unknown commit changes nothing");

  const usage = spawnSync(process.execPath, [tool, "--target", box.target], { encoding: "utf8" });
  assert.equal(usage.status, 2, "missing arguments are a usage error");
  assert.match(usage.stderr, /--source/);
  assert.match(usage.stderr, /--sha/);
});

test("the exporter lives outside the npm package: tools/ is not in the files whitelist", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, "files is an explicit whitelist");
  assert.ok(!pkg.files.some((entry) => entry === "tools" || entry.startsWith("tools/")), "tools/ never ships");
  assert.ok(fs.existsSync(tool), "the exporter exists in the tree");
});

// ── file ↔ directory transitions (rev-t8, 2026-08-29) ───────────────────────
// A path can change kind between two commits: a tracked file becomes a
// directory (`docs` → `docs/FACTEUR.md`), a tracked directory becomes a file.
// Before the fix the first crashed plan() with an unmasked ENOTDIR — even on
// --dry-run — and the second was refused by apply() AFTER the deletions had
// run: a half-synchronised, dirty target. The rule now: plan() decides every
// transition, and a refusal comes before any mutation.

function snapshot(dir) {
  return walk(dir).map((relative) => {
    const absolute = path.join(dir, relative);
    const stat = fs.lstatSync(absolute);
    return [relative, stat.isSymbolicLink() ? `-> ${fs.readlinkSync(absolute)}` : fs.readFileSync(absolute, "utf8")];
  });
}

test("a tracked FILE where the source has a directory: the file goes, the directory lands (top-level and nested)", (t) => {
  const box = sandbox(t);
  // `docs` and `src/web/public` are directories at the source commit.
  writeTree(box.target, { docs: "a file named like a source directory\n", "src/web/public": "another one, nested\n" });
  git(box.target, ["add", "--", "docs", "src/web/public"]);
  git(box.target, ["commit", "-q", "-m", "files where directories will come"]);

  const dry = run(box, ["--dry-run"]);
  assert.equal(dry.status, 0, `a dry-run plans the transition without crashing\n${dry.stdout}\n${dry.stderr}`);
  assert.ok(fs.statSync(path.join(box.target, "docs")).isFile(), "the dry-run touched nothing");

  const out = run(box);
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.ok(fs.statSync(path.join(box.target, "docs")).isDirectory(), "docs is a directory now");
  assert.ok(fs.existsSync(path.join(box.target, "docs", "FACTEUR.md")), "with the source's files in it");
  assert.ok(fs.existsSync(path.join(box.target, "src", "web", "public", "index.html")), "the nested one too");
  const summary = report(out);
  assert.ok(summary.files.deleted.includes("docs") && summary.files.deleted.includes("src/web/public"), "both files are reported deleted");
  assert.deepEqual(walk(box.target), sourceEntries().map((e) => e.relative).sort(), "the target is the source tree");
});

test("a tracked DIRECTORY where the source has a file: its files go, the file lands — empty subdirectories included", (t) => {
  const box = sandbox(t);
  // `README.md` and `LICENSE` are files at the source commit; the toy already
  // tracks README.md as a file, so it leaves before the directory is born.
  git(box.target, ["rm", "-q", "--", "README.md"]);
  writeTree(box.target, {
    "README.md/old.txt": "a directory named like a source file\n",
    "README.md/deeper/x.txt": "nested inside it\n",
    "LICENSE/a.txt": "another one\n"
  });
  // An empty directory is invisible to git: the target stays clean with it.
  fs.mkdirSync(path.join(box.target, "README.md", "empty"));
  git(box.target, ["add", "--", "README.md/old.txt", "README.md/deeper/x.txt", "LICENSE/a.txt"]);
  git(box.target, ["commit", "-q", "-m", "directories where files will come"]);
  assert.equal(status(box.target), "", "the toy target is clean, empty directory included");

  const dry = run(box, ["--dry-run"]);
  assert.equal(dry.status, 0, `a dry-run plans the transition without crashing\n${dry.stdout}\n${dry.stderr}`);
  assert.ok(fs.statSync(path.join(box.target, "README.md")).isDirectory(), "the dry-run touched nothing");

  const out = run(box);
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  const readme = execFileSync("git", ["show", `${sha}:README.md`], { cwd: repo });
  assert.ok(fs.statSync(path.join(box.target, "README.md")).isFile(), "README.md is a file now");
  assert.ok(readme.equals(fs.readFileSync(path.join(box.target, "README.md"))), "with the source's bytes");
  assert.ok(fs.statSync(path.join(box.target, "LICENSE")).isFile(), "LICENSE too");
  const summary = report(out);
  for (const gone of ["README.md/old.txt", "README.md/deeper/x.txt", "LICENSE/a.txt"]) {
    assert.ok(summary.files.deleted.includes(gone), `${gone} is reported deleted`);
  }
  assert.deepEqual(walk(box.target), sourceEntries().map((e) => e.relative).sort(), "the target is the source tree");
});

test("a transition blocked by something the target does not track is refused BEFORE any mutation, even under --force", (t) => {
  const box = sandbox(t);
  git(box.target, ["rm", "-q", "--", "README.md"]);
  writeTree(box.target, { "README.md/old.txt": "tracked, would go\n" });
  git(box.target, ["add", "--", "README.md/old.txt"]);
  git(box.target, ["commit", "-q", "-m", "a directory where a file will come"]);
  // Untracked work inside the directory: the tool has no right to delete it,
  // so the file cannot land — and nothing else may happen either.
  writeTree(box.target, { "README.md/wip.txt": "untracked work\n" });
  const before = snapshot(box.target);

  const refused = run(box, ["--force"]);
  assert.notEqual(refused.status, 0, "refused");
  assert.match(refused.stderr, /README\.md\/wip\.txt/, "the refusal names what blocks");
  assert.deepEqual(snapshot(box.target), before, "and nothing was deleted or written — not even the stale files");

  // The other direction: an untracked FILE where the source wants a directory.
  const box2 = sandbox(t);
  writeTree(box2.target, { docs: "untracked file where the source has a directory\n" });
  const before2 = snapshot(box2.target);
  const refused2 = run(box2, ["--force"]);
  assert.notEqual(refused2.status, 0, "refused");
  assert.match(refused2.stderr, /\bdocs\b/, "the refusal names what blocks");
  assert.deepEqual(snapshot(box2.target), before2, "nothing was deleted or written");
});

// ── the commit line names the repository, not the checkout (rev-t8, 2026-08-29) ──
// The reminder read `path.basename(source)`: run from a worktree it said
// `cc2cc-v2-export`. The name is the main repository's directory — the parent
// of `git rev-parse --git-common-dir` — and --name overrides it.

function toySource(box, files = { "hello.txt": "hello\n" }) {
  const mainRepo = path.join(box.root, "main-repo");
  fs.mkdirSync(mainRepo);
  git(mainRepo, ["init", "-q", "-b", "main"]);
  writeTree(mainRepo, files);
  git(mainRepo, ["add", "--", ...Object.keys(files)]);
  git(mainRepo, ["commit", "-q", "-m", "hello"]);
  const worktree = path.join(box.root, "wt");
  git(mainRepo, ["worktree", "add", "-q", "--detach", worktree]);
  return { worktree, commit: git(worktree, ["rev-parse", "HEAD"]).trim() };
}

test("the commit reminder names the main repository even from a worktree, and --name overrides it", (t) => {
  const box = sandbox(t);
  const { worktree, commit } = toySource(box);

  const out = run(box, [], { source: worktree, commit });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.match(out.stdout, /Commit with: sync: mirror main-repo main @ [0-9a-f]{7}\b/, "the repository's name, and the commit is on its main");
  assert.doesNotMatch(out.stdout, /mirror wt\b/, "never the worktree's directory name");
  assert.equal(fs.readFileSync(path.join(box.target, "hello.txt"), "utf8"), "hello\n", "the toy source was mirrored");

  const box2 = sandbox(t);
  const named = run(box2, ["--name", "custom-name"], { source: worktree, commit });
  assert.equal(named.status, 0, `${named.stdout}\n${named.stderr}`);
  assert.match(named.stdout, /Commit with: sync: mirror custom-name main @ [0-9a-f]{7}\b/, "--name wins");
  assert.equal(report(named).name, "custom-name", "and the report carries it");
});

// ── --force over what an uncommitted sync leaves (rev-t8 re-verdict, M1) ─────
// A sync deletes files from disk and never touches the index: until the
// commit, the target shows them as ` D` — tracked, gone from disk, their
// directory with them. plan() accepted such a path (present: false), then
// apply() pruned its directory with readdirSync on a directory that no longer
// exists: ENOENT in the middle of the application, a half-applied tree — the
// exact thing the header promises never happens.

test("--force on a target whose index still tracks a file already gone from disk (` D`): the sync completes", (t) => {
  const box = sandbox(t);
  // Exactly what an uncommitted sync leaves: the file and its directory gone, the index unchanged.
  fs.rmSync(path.join(box.target, "old"), { recursive: true });
  assert.match(status(box.target), /^ D old\/stale\.txt$/m, "the index still tracks it: ` D`");

  const out = run(box, ["--force"]);
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.deepEqual(walk(box.target), sourceEntries().map((e) => e.relative).sort(), "the target is the source tree — nothing half-applied");
  const summary = report(out);
  assert.ok(summary.files.deleted.includes("old/stale.txt"), "the index entry is reported: a deletion left to commit");
  assert.match(out.stdout, /old\/stale\.txt.*already gone/, "and the report says it was already gone from disk");
});

test("a second --force sync over an uncommitted sync changes nothing and reports what is left to commit", (t) => {
  const box = sandbox(t);
  const first = run(box);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const afterFirst = snapshot(box.target);
  assert.match(status(box.target), /^ D /m, "the first sync left deletions in the index");

  const second = run(box, ["--force"]);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.deepEqual(snapshot(box.target), afterFirst, "the disk is exactly what the first sync left");
  const summary = report(second);
  assert.equal(summary.written, 0, "nothing to write");
  assert.deepEqual(
    summary.files.deleted.sort(),
    [...Object.keys(STALE), ...Object.keys(FORMERLY_KEPT)].sort(),
    "the deletions the first sync made are still the ones to commit"
  );
});

// ── --exclude: tracked, yet kept out of the public mirror (2026-10-18) ──────
// The public repository mirrors the release tree minus two internal doc
// folders. --exclude <prefix> (repeatable) treats every tracked path that
// starts with the prefix as if the source did not track it: it is not
// written, it is deleted from the target when the target holds it, and the
// plan says so. The prefix is taken as written — end a directory with `/`.

const WITH_INTERNAL_DOCS = {
  "docs/FACTEUR.md": "public\n",
  "docs/runbooks.md": "public: a sibling file, not under docs/runbooks/\n",
  "docs/runbooks/x.md": "private\n",
  "docs/runbooks/deep/y.md": "private, nested\n",
  "docs/superpowers/plan.md": "private too\n"
};

test("--exclude <prefix> keeps a tracked path out of the mirror, deletes it from the target, and says so in the plan", (t) => {
  const box = sandbox(t);
  const { worktree, commit } = toySource(box, WITH_INTERNAL_DOCS);
  // An earlier mirror already published two of the private files.
  writeTree(box.target, { "docs/runbooks/x.md": "stale copy\n", "docs/superpowers/plan.md": "stale copy\n" });
  git(box.target, ["add", "--", "docs/runbooks/x.md", "docs/superpowers/plan.md"]);
  git(box.target, ["commit", "-q", "-m", "an earlier mirror published them"]);
  // Repeatable, and both spellings of a value: `--exclude x` and `--exclude=x`.
  const flags = ["--exclude", "docs/runbooks/", "--exclude=docs/superpowers/"];

  const before = snapshot(box.target);
  const dry = run(box, [...flags, "--dry-run"], { source: worktree, commit });
  assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
  assert.deepEqual(snapshot(box.target), before, "the dry-run touched nothing");
  assert.match(dry.stdout, /^ {2}excluded: docs\/runbooks\/ {2}\(2 tracked paths\)$/m, "the dry-run prints the first prefix, with what it matched");
  assert.match(dry.stdout, /^ {2}excluded: docs\/superpowers\/ {2}\(1 tracked path\)$/m, "and the second, in the singular");
  assert.equal(dry.stderr, "", "prefixes that match something draw no warning");
  assert.match(dry.stdout, /^ {4}- docs\/runbooks\/x\.md$/m, "the plan names the excluded file it would delete");
  assert.doesNotMatch(dry.stdout, /\+ docs\/(runbooks|superpowers)\//, "and writes none of them");

  const out = run(box, flags, { source: worktree, commit });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.match(out.stdout, /^ {2}excluded: docs\/runbooks\/ {2}\(2 tracked paths\)$/m);
  assert.match(out.stdout, /^ {2}excluded: docs\/superpowers\/ {2}\(1 tracked path\)$/m);
  assert.equal(fs.existsSync(path.join(box.target, "docs/runbooks/x.md")), false, "an excluded path is removed from the target");
  assert.equal(fs.existsSync(path.join(box.target, "docs/superpowers/plan.md")), false, "whichever prefix it falls under");
  assert.equal(fs.existsSync(path.join(box.target, "docs/runbooks")), false, "and so are the directories it leaves empty");
  assert.equal(fs.readFileSync(path.join(box.target, "docs/FACTEUR.md"), "utf8"), "public\n");
  assert.equal(fs.readFileSync(path.join(box.target, "docs/runbooks.md"), "utf8"), WITH_INTERNAL_DOCS["docs/runbooks.md"], "a prefix ending in / does not reach a sibling file");
  assert.deepEqual(walk(box.target), ["docs/FACTEUR.md", "docs/runbooks.md"], "the target is the source tree minus the excluded prefixes");
  const summary = report(out);
  assert.deepEqual(summary.files.written.sort(), ["docs/FACTEUR.md", "docs/runbooks.md"], "no excluded path is written");
  assert.deepEqual(summary.exclude, [{ prefix: "docs/runbooks/", matched: 2 }, { prefix: "docs/superpowers/", matched: 1 }], "the report carries each prefix and what it matched");
  assert.ok(summary.files.deleted.includes("docs/runbooks/x.md") && summary.files.deleted.includes("docs/superpowers/plan.md"),
    "the stale copies are reported deleted, by the ordinary deletion path");

  // A prefix is taken as written: no trailing slash, no boundary.
  const box2 = sandbox(t);
  const bare = run(box2, ["--exclude", "docs/run"], { source: worktree, commit });
  assert.equal(bare.status, 0, `${bare.stdout}\n${bare.stderr}`);
  assert.deepEqual(walk(box2.target), ["docs/FACTEUR.md", "docs/superpowers/plan.md"], "`docs/run` excludes docs/runbooks.md and docs/runbooks/ alike");
});

test("--exclude without a value is a usage error — and a missing value never swallows the next flag", (t) => {
  const box = sandbox(t);
  const before = snapshot(box.target);
  // `--exclude --dry-run` once took `--dry-run` as the prefix and ran for real;
  // the guard is shared, so --name is covered too.
  for (const [extra, flag] of [
    [["--exclude"], "--exclude"], [["--exclude="], "--exclude"], [["--exclude", ""], "--exclude"],
    [["--exclude", "--dry-run"], "--exclude"], [["--name", "--force"], "--name"]
  ]) {
    const bad = run(box, extra);
    assert.equal(bad.status, 2, `${JSON.stringify(extra)} is a usage error`);
    assert.match(bad.stderr, new RegExp(`${flag} needs a value`));
  }
  assert.deepEqual(snapshot(box.target), before, "a usage error touches nothing — no sync ran");

  // The explicit `=` spelling stays the way to pass a value that really starts with `--`.
  const explicit = run(box, ["--exclude=--odd/", "--dry-run"]);
  assert.equal(explicit.status, 0, `${explicit.stdout}\n${explicit.stderr}`);
  assert.match(explicit.stdout, /^ {2}excluded: --odd\/ {2}\(0 tracked paths\)$/m);
});

test("--exclude with a prefix that matches nothing warns on stderr, exits 0 and plans exactly what it would without it", (t) => {
  const box = sandbox(t);
  const { worktree, commit } = toySource(box, WITH_INTERNAL_DOCS);
  // A folder that already left the source but that the target still tracks:
  // its prefix matches nothing in the source, and still has a job to do.
  writeTree(box.target, { "docs/left/old.md": "tracked by the target only\n" });
  git(box.target, ["add", "--", "docs/left/old.md"]);
  git(box.target, ["commit", "-q", "-m", "a folder that left the source"]);

  const plain = run(box, ["--dry-run"], { source: worktree, commit });
  assert.equal(plain.status, 0, `${plain.stdout}\n${plain.stderr}`);

  // The two slips of a typing hand: a letter missing, a leading ./
  const mistyped = run(box, ["--exclude", "docs/runbook/", "--exclude", "./docs/superpowers/", "--dry-run"], { source: worktree, commit });
  assert.equal(mistyped.status, 0, `a warning, not a refusal\n${mistyped.stdout}\n${mistyped.stderr}`);
  assert.match(mistyped.stderr, /warning: --exclude docs\/runbook\/ matches no tracked path/);
  assert.match(mistyped.stderr, /warning: --exclude \.\/docs\/superpowers\/ matches no tracked path/);
  assert.match(mistyped.stdout, /^ {2}excluded: docs\/runbook\/ {2}\(0 tracked paths\)$/m, "the plan shows that nothing matched");
  const summary = report(mistyped);
  assert.deepEqual(summary.exclude, [{ prefix: "docs/runbook/", matched: 0 }, { prefix: "./docs/superpowers/", matched: 0 }]);
  assert.ok(summary.files.written.includes("docs/runbooks/x.md"), "the private file is still planned for writing — the warning is the only signal");
  assert.deepEqual(summary.files, report(plain).files, "the plan is the one without --exclude");

  // No warning where the prefix has a job in the target.
  const left = run(box, ["--exclude", "docs/left/", "--dry-run"], { source: worktree, commit });
  assert.equal(left.status, 0, `${left.stdout}\n${left.stderr}`);
  assert.equal(left.stderr, "", "a folder that left the source is not a mistake while the target still tracks it");
  const leftReport = report(left);
  assert.deepEqual(leftReport.exclude, [{ prefix: "docs/left/", matched: 0 }]);
  assert.ok(leftReport.files.deleted.includes("docs/left/old.md"), "and the ordinary deletion takes it");
});

test("replayed with the same --exclude flags, the export changes nothing", (t) => {
  const box = sandbox(t);
  const { worktree, commit } = toySource(box, WITH_INTERNAL_DOCS);
  const flags = ["--exclude", "docs/runbooks/", "--exclude", "docs/superpowers/"];
  const first = run(box, flags, { source: worktree, commit });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  // A toy repository: -A is the natural gesture here, the house rule protects real trees.
  git(box.target, ["add", "-A"]);
  git(box.target, ["commit", "-q", "-m", "sync"]);
  assert.equal(status(box.target), "", "the toy target is clean after the commit");

  const second = run(box, flags, { source: worktree, commit });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(second.stderr, "", "a replay has nothing to warn about");
  const summary = report(second);
  assert.equal(summary.written, 0, "nothing to write on a replay");
  assert.equal(summary.deleted, 0, "nothing to delete on a replay");
  assert.equal(summary.unchanged, 2, "the two public files are found unchanged");
  assert.deepEqual(summary.exclude, [{ prefix: "docs/runbooks/", matched: 2 }, { prefix: "docs/superpowers/", matched: 1 }]);
  assert.equal(status(box.target), "", "the replay leaves the target clean");
});

test("--exclude deletes only what the target tracks: an untracked copy under the prefix survives --force", (t) => {
  const box = sandbox(t);
  const { worktree, commit } = toySource(box, WITH_INTERNAL_DOCS);
  writeTree(box.target, { "docs/runbooks/wip.md": "untracked work\n" });
  const out = run(box, ["--force", "--exclude", "docs/runbooks/"], { source: worktree, commit });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.equal(fs.readFileSync(path.join(box.target, "docs/runbooks/wip.md"), "utf8"), "untracked work\n", "an untracked file is not the tool's to delete");
  assert.equal(fs.existsSync(path.join(box.target, "docs/runbooks/x.md")), false, "and nothing of the excluded source landed beside it");
});

// ── .export-exclude: the exclusions that do not depend on anyone's memory (FIX-C, C7, 2026-10-18) ──
// The public repository is the release tree minus the internal folders and the private-name guard.
// Three flags typed by hand at every export is a list that one forgetful gesture shortens: a
// private runbook published is not taken back. The source commit now carries the list itself, in a
// tracked `.export-exclude` at its root — one prefix per line, `#` for a comment — and the tool
// applies it by default, in addition to --exclude. It is read from the COMMIT (git's object
// store, like every other source file), never from the working tree: a replay of an old sha gets
// the list that sha had, and an uncommitted edit changes nothing. `--no-default-exclude` turns the
// list off (the tests that mirror a whole tree). The file itself stays in the mirror: it holds
// repository paths, no private name.

const LIST = [
  "# the internal folders and the private-name guard never leave the private repository",
  "docs/runbooks/",
  "",
  "docs/superpowers/",
  "  test/noms-prives.test.js  ",
  ""
].join("\n");

const WITH_A_LIST = {
  ...WITH_INTERNAL_DOCS,
  ".export-exclude": LIST,
  "test/noms-prives.test.js": "private guard\n",
  "test/other.test.js": "public test\n"
};
const PUBLIC_PART = [".export-exclude", "docs/FACTEUR.md", "docs/runbooks.md", "test/other.test.js"];

test("without any flag, the prefixes of .export-exclude stay out of the mirror, leave the target, and are named 'excluded (default)' — the list itself stays", (t) => {
  const box = sandbox(t);
  const { worktree, commit } = toySource(box, WITH_A_LIST);
  // An earlier mirror already published one private file.
  writeTree(box.target, { "docs/runbooks/x.md": "stale copy\n" });
  git(box.target, ["add", "--", "docs/runbooks/x.md"]);
  git(box.target, ["commit", "-q", "-m", "an earlier mirror published it"]);

  const before = snapshot(box.target);
  const dry = run(box, ["--dry-run"], { source: worktree, commit, defaults: true });
  assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
  assert.deepEqual(snapshot(box.target), before, "the dry-run touched nothing");
  // Not 'excluded:' — a default prefix says where it comes from. Surrounding blanks are not part of a prefix.
  assert.match(dry.stdout, /^ {2}excluded \(default\): docs\/runbooks\/ {2}\(2 tracked paths\)$/m);
  assert.match(dry.stdout, /^ {2}excluded \(default\): docs\/superpowers\/ {2}\(1 tracked path\)$/m);
  assert.match(dry.stdout, /^ {2}excluded \(default\): test\/noms-prives\.test\.js {2}\(1 tracked path\)$/m);
  assert.doesNotMatch(dry.stdout, /^ {2}excluded: /m, "none of them is a flag");
  assert.equal(dry.stderr, "", "prefixes that match something draw no warning");
  assert.match(dry.stdout, /^ {4}- docs\/runbooks\/x\.md$/m, "the plan names the stale private file it would delete");
  assert.doesNotMatch(dry.stdout, /\+ (docs\/(runbooks|superpowers)\/|test\/noms-prives)/, "and writes none of them");

  const out = run(box, [], { source: worktree, commit, defaults: true });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.deepEqual(walk(box.target), PUBLIC_PART, "the target is the source tree minus the listed prefixes — and .export-exclude is in it");
  assert.equal(fs.readFileSync(path.join(box.target, ".export-exclude"), "utf8"), LIST, "the list reaches the mirror byte for byte");
  assert.equal(fs.readFileSync(path.join(box.target, "docs/runbooks.md"), "utf8"), WITH_INTERNAL_DOCS["docs/runbooks.md"], "a prefix ending in / does not reach a sibling file");
  const summary = report(out);
  assert.deepEqual(summary.exclude, [
    { prefix: "docs/runbooks/", matched: 2, default: true },
    { prefix: "docs/superpowers/", matched: 1, default: true },
    { prefix: "test/noms-prives.test.js", matched: 1, default: true }
  ], "the report carries each default prefix, flagged, in the order of the file");
  assert.equal(summary.defaultExclude, true);
  assert.ok(summary.files.deleted.includes("docs/runbooks/x.md"), "the stale copy is reported deleted, by the ordinary deletion path");
});

test("--no-default-exclude lets the listed paths go, and the plan says the list was not applied", (t) => {
  const box = sandbox(t);
  const { worktree, commit } = toySource(box, WITH_A_LIST);
  const out = run(box, [], { source: worktree, commit }); // defaults: false = --no-default-exclude
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  for (const relative of ["docs/runbooks/x.md", "docs/runbooks/deep/y.md", "docs/superpowers/plan.md", "test/noms-prives.test.js"]) {
    assert.ok(fs.existsSync(path.join(box.target, relative)), `${relative} lands when the default list is off`);
  }
  assert.match(out.stdout, /^ {2}--no-default-exclude: the prefixes listed in \.export-exclude are not applied$/m, "the dangerous mode is visible in the plan");
  const summary = report(out);
  assert.deepEqual(summary.exclude, [], "nothing is excluded");
  assert.equal(summary.defaultExclude, false);

  // The same switch, with a flag of the same run: the flag still applies.
  const box2 = sandbox(t);
  const flagged = run(box2, ["--exclude", "docs/superpowers/"], { source: worktree, commit });
  assert.equal(flagged.status, 0, `${flagged.stdout}\n${flagged.stderr}`);
  assert.equal(fs.existsSync(path.join(box2.target, "docs/superpowers/plan.md")), false, "--exclude still works without the list");
  assert.ok(fs.existsSync(path.join(box2.target, "docs/runbooks/x.md")), "and only that prefix is excluded");
  assert.deepEqual(report(flagged).exclude, [{ prefix: "docs/superpowers/", matched: 1 }]);
});

test("--exclude adds to the list; a prefix named by both counts once, as a default", (t) => {
  const box = sandbox(t);
  const { worktree, commit } = toySource(box, WITH_A_LIST);
  const out = run(box, ["--exclude", "test/other.test.js", "--exclude", "docs/runbooks/"], { source: worktree, commit, defaults: true });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.deepEqual(walk(box.target), [".export-exclude", "docs/FACTEUR.md", "docs/runbooks.md"], "the flag's prefix is excluded beside the listed ones");
  assert.match(out.stdout, /^ {2}excluded: test\/other\.test\.js {2}\(1 tracked path\)$/m, "the flag keeps its own label");
  assert.equal([...out.stdout.matchAll(/excluded[^:]*: docs\/runbooks\//g)].length, 1, "docs/runbooks/ is named once");
  assert.match(out.stdout, /^ {2}excluded \(default\): docs\/runbooks\/ /m, "and as a default");
  assert.deepEqual(report(out).exclude.map(({ prefix, default: d }) => [prefix, d === true]), [
    ["docs/runbooks/", true], ["docs/superpowers/", true], ["test/noms-prives.test.js", true], ["test/other.test.js", false]
  ]);
});

test("a source commit without .export-exclude behaves exactly as before: nothing excluded, no extra line, no warning", (t) => {
  const box = sandbox(t);
  const { worktree, commit } = toySource(box, WITH_INTERNAL_DOCS);
  const out = run(box, [], { source: worktree, commit, defaults: true });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.stderr, "", "a missing list is not a mistake");
  assert.doesNotMatch(out.stdout, /excluded|no-default-exclude/, "the plan has no exclusion line");
  assert.deepEqual(walk(box.target), Object.keys(WITH_INTERNAL_DOCS).sort(), "the whole source tree lands");
  const summary = report(out);
  assert.deepEqual(summary.exclude, []);
  assert.equal(summary.defaultExclude, true, "the default list was on; the commit simply has none");
});

test("the list is read from the SOURCE COMMIT, not from the working tree: an edit, a deletion or an untracked file there changes nothing", (t) => {
  const box = sandbox(t);
  const { worktree, commit } = toySource(box, WITH_A_LIST);
  // Uncommitted: the file emptied. Then deleted. The commit still says what it said.
  fs.writeFileSync(path.join(worktree, ".export-exclude"), "# nothing is excluded here\n");
  const edited = run(box, ["--dry-run"], { source: worktree, commit, defaults: true });
  assert.equal(edited.status, 0, `${edited.stdout}\n${edited.stderr}`);
  assert.deepEqual(report(edited).exclude.map((e) => e.prefix), ["docs/runbooks/", "docs/superpowers/", "test/noms-prives.test.js"], "an emptied working-tree file does not lift the exclusions");
  fs.rmSync(path.join(worktree, ".export-exclude"));
  const deleted = run(box, ["--dry-run"], { source: worktree, commit, defaults: true });
  assert.equal(deleted.status, 0, `${deleted.stdout}\n${deleted.stderr}`);
  assert.equal(report(deleted).exclude.length, 3, "a deleted working-tree file does not lift them either");

  // The other direction: a commit that tracks no list, and an untracked file that would list everything.
  const bare = sandbox(t);
  const { worktree: other, commit: otherCommit } = toySource(bare, WITH_INTERNAL_DOCS);
  fs.writeFileSync(path.join(other, ".export-exclude"), "docs/\n");
  const untracked = run(bare, [], { source: other, commit: otherCommit, defaults: true });
  assert.equal(untracked.status, 0, `${untracked.stdout}\n${untracked.stderr}`);
  assert.deepEqual(walk(bare.target), Object.keys(WITH_INTERNAL_DOCS).sort(), "an untracked .export-exclude is not the commit's list");

  // And a replay of an OLD sha gets the list that sha had.
  const history = sandbox(t);
  const { worktree: wt, commit: first } = toySource(history, { "docs/runbooks/x.md": "private\n", "docs/a.md": "public\n", ".export-exclude": "docs/runbooks/\n" });
  git(wt, ["checkout", "-q", "--detach", first]);
  fs.rmSync(path.join(wt, ".export-exclude"));
  git(wt, ["commit", "-q", "-a", "-m", "the list is dropped"]);
  const second = git(wt, ["rev-parse", "HEAD"]).trim();
  const old = run(history, [], { source: wt, commit: first, defaults: true });
  assert.equal(old.status, 0, `${old.stdout}\n${old.stderr}`);
  assert.equal(fs.existsSync(path.join(history.target, "docs/runbooks/x.md")), false, "the old sha excludes what its own list says");
  const fresh = run(history, ["--force"], { source: wt, commit: second, defaults: true });
  assert.equal(fresh.status, 0, `${fresh.stdout}\n${fresh.stderr}`);
  assert.equal(fs.existsSync(path.join(history.target, "docs/runbooks/x.md")), true, "the newer sha, whose tree has no list, mirrors everything");
});

test("the guarantees hold with the default list: dry-run writes nothing, a replay changes nothing, a dirty target is refused", (t) => {
  const box = sandbox(t);
  const { worktree, commit } = toySource(box, WITH_A_LIST);

  const before = snapshot(box.target);
  const dry = run(box, ["--dry-run"], { source: worktree, commit, defaults: true });
  assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
  assert.deepEqual(snapshot(box.target), before, "the dry-run writes and deletes nothing");
  assert.equal(status(box.target), "", "git sees no change either");

  fs.writeFileSync(path.join(box.target, "wip.txt"), "uncommitted work\n");
  const refused = run(box, [], { source: worktree, commit, defaults: true });
  assert.notEqual(refused.status, 0, "a dirty target is refused, list or no list");
  assert.match(refused.stderr, /not clean|uncommitted/i);
  assert.match(refused.stderr, /--force/);
  fs.rmSync(path.join(box.target, "wip.txt"));

  const first = run(box, [], { source: worktree, commit, defaults: true });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  // A toy repository: -A is the natural gesture here, the house rule protects real trees.
  git(box.target, ["add", "-A"]);
  git(box.target, ["commit", "-q", "-m", "sync"]);
  const second = run(box, [], { source: worktree, commit, defaults: true });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(second.stderr, "", "a replay has nothing to warn about");
  const summary = report(second);
  assert.equal(summary.written, 0, "nothing to write on a replay");
  assert.equal(summary.deleted, 0, "nothing to delete on a replay");
  assert.equal(summary.unchanged, PUBLIC_PART.length, "the public part is found unchanged");
  assert.equal(status(box.target), "", "the replay leaves the target clean");
});

test("a listed prefix that matches nothing warns on stderr naming the list, exits 0 and plans what it would without it", (t) => {
  const box = sandbox(t);
  const files = { "docs/FACTEUR.md": "public\n", "docs/runbooks/x.md": "private\n", ".export-exclude": "docs/runbooks/\n./docs/typo/\ndocs/gone/\n" };
  const { worktree, commit } = toySource(box, files);
  // A folder that left the source but that the target still tracks keeps a job: no warning for it.
  writeTree(box.target, { "docs/gone/old.md": "tracked by the target only\n" });
  git(box.target, ["add", "--", "docs/gone/old.md"]);
  git(box.target, ["commit", "-q", "-m", "a folder that left the source"]);

  const out = run(box, ["--dry-run"], { source: worktree, commit, defaults: true });
  assert.equal(out.status, 0, `a warning, not a refusal\n${out.stdout}\n${out.stderr}`);
  assert.match(out.stderr, /warning: \.export-exclude lists \.\/docs\/typo\/, which matches no tracked path, in the source or in the target/);
  assert.doesNotMatch(out.stderr, /docs\/gone\/|docs\/runbooks\//, "no warning for a prefix that has a job");
  assert.match(out.stdout, /^ {2}excluded \(default\): \.\/docs\/typo\/ {2}\(0 tracked paths\)$/m, "the plan shows that nothing matched");
  const summary = report(out);
  assert.deepEqual(summary.files.written, [".export-exclude", "docs/FACTEUR.md"]);
  assert.ok(summary.files.deleted.includes("docs/gone/old.md"), "the folder that left the source goes by the ordinary deletion");
});

test("the file format: comments, blank lines, CRLF, surrounding blanks and a missing final newline; a prefix is taken as written", (t) => {
  const box = sandbox(t);
  const text = "# a comment\r\n\r\n   # an indented comment\r\ndocs/runbooks/\r\n  docs/runbooks.md  \r\n\t\r\ntest/noms-prives.test.js";
  const { worktree, commit } = toySource(box, { ...WITH_A_LIST, ".export-exclude": text });
  const out = run(box, ["--dry-run"], { source: worktree, commit, defaults: true });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.deepEqual(report(out).exclude.map((e) => e.prefix), ["docs/runbooks/", "docs/runbooks.md", "test/noms-prives.test.js"], "three prefixes: comments and blanks are not prefixes, CRLF and blanks around one are not part of it");

  // An empty list, and a list of comments only, exclude nothing and say nothing.
  for (const content of ["", "# nothing to exclude yet\n"]) {
    const empty = sandbox(t);
    const { worktree: wt, commit: c } = toySource(empty, { ".export-exclude": content, "docs/a.md": "x\n" });
    const done = run(empty, ["--dry-run"], { source: wt, commit: c, defaults: true });
    assert.equal(done.status, 0, `${done.stdout}\n${done.stderr}`);
    assert.equal(done.stderr, "");
    assert.deepEqual(report(done).exclude, []);
  }
});

test("an .export-exclude that is not a regular file is refused before anything is written — a list that cannot be read must not become 'export everything'", (t) => {
  const box = sandbox(t);
  const mainRepo = path.join(box.root, "main-repo");
  fs.mkdirSync(mainRepo);
  git(mainRepo, ["init", "-q", "-b", "main"]);
  writeTree(mainRepo, { "docs/runbooks/x.md": "private\n", "elsewhere.txt": "docs/runbooks/\n" });
  fs.symlinkSync("elsewhere.txt", path.join(mainRepo, ".export-exclude"));
  git(mainRepo, ["add", "--", "docs/runbooks/x.md", "elsewhere.txt", ".export-exclude"]);
  git(mainRepo, ["commit", "-q", "-m", "the list is a symbolic link"]);
  const commit = git(mainRepo, ["rev-parse", "HEAD"]).trim();
  const before = snapshot(box.target);

  const refused = run(box, [], { source: mainRepo, commit, defaults: true });
  assert.notEqual(refused.status, 0, "refused");
  assert.match(refused.stderr, /\.export-exclude is a symbolic link/);
  assert.deepEqual(snapshot(box.target), before, "and nothing was written or deleted");

  // Switched off, the list is not read at all: the same commit mirrors.
  const off = run(box, ["--dry-run"], { source: mainRepo, commit });
  assert.equal(off.status, 0, `${off.stdout}\n${off.stderr}`);
});

test("this repository's own .export-exclude: tracked, the three prefixes, kept in the mirror, never in the npm package", (t) => {
  const listed = execFileSync("git", ["show", `${sha}:.export-exclude`], { cwd: repo, encoding: "utf8" });
  const prefixes = listed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(prefixes, ["docs/runbooks/", "docs/superpowers/", "test/noms-prives.test.js"], "the internal folders and the private-name guard");
  for (const prefix of prefixes) assert.ok(!prefix.startsWith("./") && !prefix.startsWith("/"), `${prefix}: a repository-relative path, taken as written`);
  assert.ok(!prefixes.some((prefix) => ".export-exclude".startsWith(prefix)), "the list does not exclude itself: it stays in the mirror");
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.ok(!pkg.files.includes(".export-exclude"), "and it never ships in the npm package");

  // The real gesture on the real commit: whatever of the three prefixes this tree holds does not land.
  const present = prefixes.filter((prefix) => sourceEntries().some((e) => e.relative.startsWith(prefix)));
  if (present.length === 0) {
    // Pas un skip (la quarantaine les tient au registre) : ce qui précède a tourné, la suite n'a
    // rien à éprouver ici, et la sortie le dit.
    t.diagnostic("the gesture on this tree was not played: it holds none of the three prefixes (a clone of the public repository?), so the list has nothing to keep out");
    return;
  }
  const box = sandbox(t);
  const out = run(box, [], { defaults: true });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  const landed = walk(box.target);
  for (const prefix of prefixes) {
    assert.deepEqual(landed.filter((relative) => relative.startsWith(prefix)), [], `nothing under ${prefix} lands, with no flag`);
  }
  assert.ok(landed.includes(".export-exclude"), "the list itself lands");
  const expected = sourceEntries().map((e) => e.relative).filter((relative) => !prefixes.some((prefix) => relative.startsWith(prefix))).sort();
  assert.deepEqual(landed, expected, "the target is the source tree minus the three prefixes");
});

// ── the help, a usage error and a refusal are not cut on a pipe (FIX-D, D1, 2026-10-18) ─────────
// The same defect as C2 (test/sortie-unique.test.js): the tool wrote its help, its usage error or a
// refusal and called process.exit right after. On a macOS pipe the write leaves in two parts and the
// exit takes the second: the help arrived cut at 1024 or 512 bytes, a usage error likewise, and the
// dirty-target refusal — which lists every uncommitted file, so it grows with the mess it reports —
// likewise. The text is now written whole, synchronously, before the exit. A real shell pipe
// (`sh -c '… | wc -c'`), eight times each since the cut falls at 512 or at 1024; the expected length is
// the same command redirected to a file.

const toolCommand = (...args) => [process.execPath, tool, ...args].map(quote).join(" ");

test("D1 — --help through a real pipe: the whole help, eight times out of eight, exit 0", () => {
  const { attendu, rcAttendu, tailles, codes } = enTubeReel(toolCommand("--help"));
  assert.ok(attendu > 1024, `probe impossible: the help is ${attendu} bytes, a cut at 512 or 1024 could no longer be seen`);
  assert.equal(rcAttendu, 0);
  assert.deepEqual(tailles, Array(8).fill(attendu), "every read of the pipe gives the whole help");
  assert.deepEqual(codes, Array(8).fill(0), "and the exit stays 0");
});

test("D1 — a usage error on stderr, usage included, through a real pipe: whole, eight times out of eight, exit 2", () => {
  // --source and --sha are missing: the tool says so, then prints its usage.
  const { attendu, rcAttendu, tailles, codes } = enTubeReel(toolCommand("--target", "nowhere"), { flux: "stderr" });
  assert.ok(attendu > 1024, `probe impossible: the usage error is ${attendu} bytes, a cut at 512 or 1024 could no longer be seen`);
  assert.equal(rcAttendu, 2);
  assert.deepEqual(tailles, Array(8).fill(attendu), "every read of the pipe gives the whole usage error");
  assert.deepEqual(codes, Array(8).fill(2), "and the exit stays 2");
});

test("D1 — the dirty-target refusal, which lists every uncommitted file, through a real pipe: whole, eight times out of eight, exit 1, nothing touched", (t) => {
  const box = sandbox(t);
  for (let i = 0; i < 40; i += 1) fs.writeFileSync(path.join(box.target, `untracked-file-with-a-long-name-number-${i}.txt`), "x\n");
  const before = snapshot(box.target);

  // What the refusal says, read without a pipe: it is the dirty-target refusal, and it lists the files.
  const direct = run(box);
  assert.equal(direct.status, 1, `${direct.stdout}\n${direct.stderr}`);
  assert.match(direct.stderr, /is not clean/);
  assert.match(direct.stderr, /untracked-file-with-a-long-name-number-39\.txt/, "the list reaches its last file");

  const command = toolCommand("--source", repo, "--sha", sha, "--target", box.target, "--no-default-exclude");
  const { attendu, rcAttendu, tailles, codes } = enTubeReel(command, { flux: "stderr", env: { HOME: box.home, TMPDIR: box.tmp, LC_ALL: "C" }, cwd: box.root });
  assert.ok(attendu > 2048, `probe impossible: the refusal is ${attendu} bytes, a cut at 512 or 1024 could no longer be seen`);
  assert.equal(attendu, Buffer.byteLength(direct.stderr), "the file the pipe is compared with holds the very refusal read above");
  assert.equal(rcAttendu, 1);
  assert.deepEqual(tailles, Array(8).fill(attendu), "every read of the pipe gives the whole refusal");
  assert.deepEqual(codes, Array(8).fill(1), "and the exit stays 1");
  assert.deepEqual(snapshot(box.target), before, "a refusal touches nothing");
  assert.deepEqual(fs.readdirSync(box.home), [], "the fake HOME stayed empty");
});
