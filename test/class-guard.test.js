// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// CLASS GUARD — this test freezes the identity guard. It scans everything git
// would publish — the tracked files, in their INDEX copy and their DISK copy,
// plus the untracked files git does not ignore — for machine-specific
// identifiers that must never appear in a published tree.
//
// THE GUARD CARRIES NO IDENTITY. It used to hold the very names it forbids,
// cut into concatenated fragments — and any reader of the public repository
// put them back together (rev-t8, 2026-08-29). What is forbidden now comes
// from two sources, neither of them written here:
//   - the identities of the machine running the suite, DISCOVERED at run time
//     by test/aide-identites.js — account, host labels, home, the configured
//     operator, the private network as `tailscale status` describes it (this
//     machine, its DNS name, its addresses, its peers), and whatever the
//     operator adds to test/.identites-locales.json, a local, untracked,
//     gitignored file;
//   - generic FORMS that name nobody: a macOS home path, a private-network
//     hostname (*.ts.net), an address in the 100.x.x.x range, and the
//     `<account>-NN` session names, where <account> is the runtime's.
// The hard-coded list of house session names no longer exists. It is NOT
// derived from the local registry either, on purpose: measured on 2026-08-29,
// the registry's names are also this product's documented example vocabulary
// and its author attribution (one of them sits in 30 files), so a
// registry-derived list would flag the README on its first run. Run with
// VALXOS_GARDE_REGISTRE=1 to see what such a list would flag; a name you want
// refused goes into test/.identites-locales.json instead.
//
// What IS allowed: generic test fixture names, example domains, generic
// operator names, the product name, and author attribution.
//
// This file scans itself like any other file: it has nothing to hide.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORMES_PRIVEES, identitesDeCetteMachine, modeCI, nomsDuRegistreLocal } from "./aide-identites.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.basename(fileURLToPath(import.meta.url));

const echapper = (valeur) => String(valeur).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The forbidden patterns, as [regexp, what it is]. Identities come from the
// runtime — or from the caller, for the toys; forms are generic.
// CI mode (Run 6, ruling 10, see aide-identites.js): the GitHub `runner`
// account is not an account of the house, so it names no session pattern.
function motifsInterdits({ identites = identitesDeCetteMachine(), compte = modeCI() ? null : os.userInfo().username, env = process.env } = {}) {
  const motifs = [
    ...FORMES_PRIVEES,
    [/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, "an address in the 100.x.x.x range (a private network)"],
    ...(compte ? [[new RegExp(`(?<![\\w-])${echapper(compte)}-\\d{1,3}(?![\\w-])`, "i"), "a house session name <account>-NN"]] : []),
    ...identites.map(({ motif, quoi }) => [motif, quoi])
  ];
  if (env.VALXOS_GARDE_REGISTRE === "1") {
    for (const nom of nomsDuRegistreLocal()) {
      motifs.push([new RegExp(`(?<![\\w-])${echapper(nom)}(?![\\w-])`, "i"), "a name of the local registry (opt-in)"]);
    }
  }
  return motifs;
}

// ── THE PUBLISHED TREE, AS GIT SEES IT ───────────────────────────────────────
//
// The guard certifies what git would publish, not what the disk holds: the
// tracked files (`git ls-files`) plus the untracked files that are not ignored
// (`--others --exclude-standard`) — exactly what a `git add .` would take.
// Every listed file is scanned, whatever its name or extension.
//
// No directory is skipped by NAME any more. The old walk blinded itself on
// `.pytest_cache/`, `tmp/`, `.claude/` wherever they sat: a leak dropped in a
// `.pytest_cache/` that carries no nested .gitignore was committable,
// publishable, and reported clean (adversarial re-verdict on rc2, 2026-08-29). The
// lesson of the 308 false positives (2026-08-26) is kept by construction:
// `.claude/` is gitignored in this repository, so git never lists it — the
// exemption belongs to git, not to a name.
//
// Outside a git repository (a tree unpacked from an npm tarball), or on a
// root that is not the top of its repository, the guard cannot know what
// would be published. It says so, by name: `applicable: false` is a third
// outcome, never a pass.
function fichiersPublies(root, { env = process.env } = {}) {
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { env, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  let sommet;
  try {
    sommet = git("rev-parse", "--show-toplevel").trim();
  } catch (e) {
    if (e.code === "ENOENT") { // the binary itself, not the repository
      return {
        applicable: false,
        raison: "git not found on the PATH: the class guard cannot enumerate what would be published — not applicable (this is not a pass)"
      };
    }
    return {
      applicable: false,
      raison: `${root} is not inside a git repository: the class guard cannot tell what would be published — not applicable (this is not a pass)`
    };
  }
  const meme = (a, b) => {
    try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
  };
  if (!meme(sommet, root)) {
    return {
      applicable: false,
      raison: `${root} is not the top of its repository (${sommet}): the class guard certifies a whole published tree — not applicable (this is not a pass)`
    };
  }
  // Tracked paths come with their index MODE and BLOB: `git commit` publishes
  // the index, `npm pack` publishes the disk, and the guard certifies both.
  const suivis = new Map();
  for (const ligne of git("ls-files", "-z", "-s").split("\0").filter(Boolean)) {
    const coupe = ligne.indexOf("\t");
    const [mode, sha, stage] = ligne.slice(0, coupe).split(" ");
    const rel = ligne.slice(coupe + 1);
    if (stage === "0" || !suivis.has(rel)) suivis.set(rel, { mode, sha });
  }
  const libres = git("ls-files", "-z", "--others", "--exclude-standard").split("\0").filter(Boolean);
  const fichiers = new Set([...suivis.keys(), ...libres]);
  return { applicable: true, fichiers: [...fichiers].sort(), suivis };
}

// The index copies of the tracked files, in one `git cat-file --batch`.
function blobsDeLIndex(root, suivis, { env = process.env } = {}) {
  const shas = [...new Set([...suivis.values()].filter((s) => s.mode !== "160000").map((s) => s.sha))];
  const blobs = new Map();
  if (shas.length === 0) return blobs;
  const sortie = execFileSync("git", ["-C", root, "cat-file", "--batch"], {
    env, input: shas.join("\n") + "\n", stdio: ["pipe", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024
  });
  let pos = 0;
  while (pos < sortie.length) {
    const fin = sortie.indexOf(0x0a, pos);
    const [sha, genre, taille] = sortie.toString("utf8", pos, fin).split(" ");
    pos = fin + 1;
    if (genre === "missing") continue;
    blobs.set(sha, sortie.subarray(pos, pos + Number(taille)));
    pos += Number(taille) + 1; // the trailing newline
  }
  return blobs;
}

function scanText(content, rel, motifs) {
  const hits = [];
  for (const [pattern, desc] of motifs) {
    const re = new RegExp(pattern.source, pattern.flags.replace("g", "") + "g");
    let m;
    while ((m = re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split("\n").length;
      hits.push({ file: rel, line, match: m[0], desc });
    }
  }
  return hits;
}

// Git publishes a symbolic link as its TARGET TEXT, so that text is scanned
// like content. A target that is a file of the tree is then scanned through;
// anything else (outside the tree, dangling, a directory) is a finding.
function scanLink(root, rel, full, cible, motifs) {
  const hits = scanText(cible, rel, motifs);
  const resolue = path.resolve(path.dirname(full), cible);
  const dedans = (racine) => {
    const relative = path.relative(racine, resolue);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  let racineReelle = root;
  try { racineReelle = fs.realpathSync(root); } catch { /* the root is where it is */ }
  if (!dedans(root) && !dedans(racineReelle)) {
    hits.push({ file: rel, line: 1, match: cible, desc: "symbolic link pointing outside the published tree" });
    return hits;
  }
  try {
    hits.push(...scanText(fs.readFileSync(full, "utf8"), rel, motifs));
  } catch (e) {
    hits.push({ file: rel, line: 1, match: cible, desc: `symbolic link whose target is not a readable file (${e.code})` });
  }
  return hits;
}

// The disk side of a path: its hits, and the bytes git would store for it
// (a link's target text, a file's content) so the index copy can be compared.
function scanDisk(root, rel, motifs) {
  const full = path.join(root, rel);
  let etat;
  try { etat = fs.lstatSync(full); } catch { return { hits: [], contenu: null, manquant: true }; }
  if (etat.isSymbolicLink()) {
    const cible = fs.readlinkSync(full);
    return { hits: scanLink(root, rel, full, cible, motifs), contenu: Buffer.from(cible), manquant: false };
  }
  if (!etat.isFile()) return { hits: [], contenu: null, manquant: false }; // a submodule gitlink is not a file of this tree
  let contenu;
  try {
    contenu = fs.readFileSync(full);
  } catch (e) { // a file the guard cannot read is a finding, never a crash of the guard
    return {
      hits: [{ file: rel, line: 1, match: "(unreadable)", desc: `unreadable file (${e.code}) — the guard cannot certify what it cannot read` }],
      contenu: null,
      manquant: false
    };
  }
  return { hits: scanText(contenu.toString("utf8"), rel, motifs), contenu, manquant: false };
}

// The index side: the blob as git holds it — a link's target text, a file's
// content. Scanning THROUGH an index link is the disk side's job.
function scanIndex(rel, blob, motifs) {
  return scanText(blob.toString("utf8"), rel, motifs);
}

function fuites(root, options = {}) {
  const publies = fichiersPublies(root, options);
  if (!publies.applicable) return publies;
  const blobs = blobsDeLIndex(root, publies.suivis, options);
  const motifs = motifsInterdits(options);
  const marquer = (liste, ou) => liste.map((h) => ({ ...h, desc: `${h.desc} [${ou}]` }));
  const hits = [];
  for (const rel of publies.fichiers) {
    const suivi = publies.suivis.get(rel);
    if (!suivi) { // untracked: only the disk exists
      hits.push(...scanDisk(root, rel, motifs).hits);
      continue;
    }
    if (suivi.mode === "160000") continue; // a submodule gitlink is not a file of this tree
    const index = blobs.get(suivi.sha) ?? null;
    const disque = scanDisk(root, rel, motifs);
    if (disque.manquant) {
      hits.push({
        file: rel, line: 1, match: "(no file on disk)",
        desc: "tracked file missing from the working tree — git would publish its index copy, npm pack nothing; the guard cannot certify it"
      });
    }
    if (index && disque.contenu && index.equals(disque.contenu)) { // one content, one report
      hits.push(...disque.hits);
      continue;
    }
    if (index) hits.push(...marquer(scanIndex(rel, index, motifs), "index"));
    hits.push(...marquer(disque.hits, "disk"));
  }
  return { applicable: true, fichiers: publies.fichiers, hits };
}

// A guard that cannot see is RED, by name — never a skip: a skip lets
// `node --test` exit 0 on a tree the guard never looked at (rev-t7, MEDIUM 4).
test("no machine identity leaks in the published tree", (t) => {
  // B4: how wide the field was is part of the verdict — without tailscale the
  // guard sees less, and that must be visible in the report, not silent.
  const identites = identitesDeCetteMachine();
  const tailscale = identites.some((i) => i.source === "tailscale") ? "yes" : "no";
  t.diagnostic(`${identites.length} identities discovered (tailscale: ${tailscale})`);
  const verdict = fuites(repoRoot, { identites });
  if (!verdict.applicable) assert.fail(`SONDE IMPOSSIBLE : ${verdict.raison}`);

  if (verdict.hits.length > 0) {
    const report = verdict.hits.map((h) => `  ${h.file}:${h.line} — ${h.desc}: "${h.match}"`).join("\n");
    assert.fail(
      `Class guard failed — ${verdict.hits.length} identity leak(s) found:\n${report}\n\n` +
      "These must be removed before the tree is published — from the index ([index]: git add the fix) " +
      "and from the disk ([disk]); a finding without a tag sits in both."
    );
  }
});

test("the class guard scans a representative sample of the tree", () => {
  const publies = fichiersPublies(repoRoot);
  if (!publies.applicable) assert.fail(`SONDE IMPOSSIBLE : ${publies.raison}`);
  const files = publies.fichiers;
  assert.ok(files.some((f) => f.startsWith("src/lib/")), "guard must scan src/lib/");
  assert.ok(files.some((f) => f.startsWith("test/")), "guard must scan test/");
  assert.ok(files.includes("README.md"), "guard must scan README.md");
  // Listed by git, never seen by the old extension-filtered walk.
  assert.ok(files.includes("LICENSE"), "guard must scan LICENSE (no extension)");
  assert.ok(files.includes(".gitignore"), "guard must scan .gitignore");
  assert.ok(files.some((f) => f.endsWith(".woff2")), "guard must scan the bundled fonts too — nothing git lists is exempt");
  assert.ok(files.includes(path.join("test", SELF)), "the guard scans itself — it carries no identity literal any more");
});

// ── TOY REPOSITORIES — the guard is proven on trees whose truth is known ─────
//
// Each toy is its own git repository in a throwaway directory. Git runs with
// the operator's global and system configuration switched off: the verdicts
// below must not depend on whatever `~/.config/git/ignore` says on the
// machine that happens to run the suite.
const GIT_ENV = (() => {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "class-guard-xdg-"))
  };
  for (const clef of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[clef];
  return env;
})();

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
}

// Generic FORMS, built at run time: the toys name nobody, a leak hits exactly
// one pattern, and this file — scanned like any other — never holds a form
// match in its own source.
const ADRESSE_PRIVEE = [100, 64, 0, 7].join(".");
const HOTE_PRIVE = ["poste", "exemple", "ts", "net"].join(".");
const LEAK = `const relais = "${ADRESSE_PRIVEE}";\n`;
const CLEAN = "export const ok = true;\n";

// `suivis` are added to the index (what `git ls-files` lists), `libres` are
// only written to disk (untracked: listed by `--others` unless ignored).
function depotJouet({ gitignore, suivis = {}, libres = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "class-guard-jouet-"));
  git(dir, "init", "-q");
  const poser = (rel, contenu) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contenu);
  };
  if (gitignore !== undefined) {
    poser(".gitignore", gitignore);
    git(dir, "add", "--", ".gitignore");
  }
  for (const [rel, contenu] of Object.entries(suivis)) {
    poser(rel, contenu);
    git(dir, "add", "--", rel);
  }
  for (const [rel, contenu] of Object.entries(libres)) poser(rel, contenu);
  return dir;
}

function fichiersFuyants(dir, options = {}) {
  const verdict = fuites(dir, { env: GIT_ENV, ...options });
  assert.equal(verdict.applicable, true, verdict.raison);
  return [...new Set(verdict.hits.map((h) => h.file))].sort();
}

// The three toys of the adversarial re-verdict on rc2 (2026-08-29): the old guard
// walked the disk and skipped directories by NAME, so a leak dropped under
// `.pytest_cache/` (not gitignored here) was committable, publishable, and
// reported clean.
test("toy: a leak in a tracked file under src/ is caught", () => {
  const dir = depotJouet({ suivis: { "src/a.js": LEAK, "src/b.js": CLEAN } });
  assert.deepEqual(fichiersFuyants(dir), ["src/a.js"]);
});

test("toy: a leak under .pytest_cache/ with no nested .gitignore is committable — and caught", () => {
  const dir = depotJouet({ libres: { ".pytest_cache/README.md": LEAK } });
  assert.deepEqual(fichiersFuyants(dir), [".pytest_cache/README.md"]);
});

test("toy: a .pytest_cache/ carrying pytest's own nested .gitignore is not committable — and not scanned", () => {
  const dir = depotJouet({ libres: { ".pytest_cache/.gitignore": "*\n", ".pytest_cache/README.md": LEAK } });
  assert.deepEqual(fichiersFuyants(dir), []);
});

test("toy: a leak under tmp/ is caught when tmp/ is not ignored", () => {
  const dir = depotJouet({ libres: { "tmp/leak.js": LEAK } });
  assert.deepEqual(fichiersFuyants(dir), ["tmp/leak.js"]);
});

test("toy: a leak under tmp/ is not scanned when tmp/ is gitignored, as in this repository", () => {
  const dir = depotJouet({ gitignore: "tmp/\n", libres: { "tmp/leak.js": LEAK } });
  assert.deepEqual(fichiersFuyants(dir), []);
});

test("toy: a leak in an untracked, non-ignored file is caught — it is what `git add .` would take", () => {
  const dir = depotJouet({ suivis: { "src/ok.js": CLEAN }, libres: { "src/nouveau.js": LEAK } });
  assert.deepEqual(fichiersFuyants(dir), ["src/nouveau.js"]);
});

test("toy: an ignored file is never scanned — it cannot be published", () => {
  const dir = depotJouet({ gitignore: "build/\n", libres: { "build/leak.js": LEAK } });
  assert.deepEqual(fichiersFuyants(dir), []);
});

test("toy: a file without extension is scanned like any other", () => {
  const dir = depotJouet({ suivis: { NOTICE: LEAK } });
  assert.deepEqual(fichiersFuyants(dir), ["NOTICE"]);
});

// The lesson of the 308 false positives (2026-08-26) is kept by construction:
// `.claude/` is gitignored in this repository, so git never lists it. The
// exemption belongs to git, not to a directory name.
test("toy: a gitignored .claude/ worktree is not scanned — no false positives, by construction", () => {
  const dir = depotJouet({ gitignore: ".claude/\n", libres: { ".claude/wt/x/leak.js": LEAK, "src/ok.js": CLEAN } });
  assert.deepEqual(fichiersFuyants(dir), []);
});

test("toy: a .claude/ that is NOT gitignored is scanned like anything else", () => {
  const dir = depotJouet({ libres: { ".claude/wt/x/leak.js": LEAK } });
  assert.deepEqual(fichiersFuyants(dir), [".claude/wt/x/leak.js"]);
});

// A15 (export public, 18/10) — PYTHON BYTECODE IS NEVER PUBLISHABLE. The monitor is a
// Python script launched from the tree: any import of it (a test, a probe) writes
// `src/monitor/__pycache__/*.pyc`, which carries the machine's account name and NUL
// bytes. In the public export that file was not ignored, got indexed, and turned both
// this guard and the NUL-byte test red. The repository's OWN .gitignore is the oracle
// here — the toy borrows its text, so the day someone drops the lines this goes red.
test("toy: the repository's own .gitignore keeps Python bytecode out of the published tree", () => {
  const pyc = "src/monitor/__pycache__/valxos_monitor.cpython-312.pyc";
  const autre = "scripts/__pycache__/migrate.cpython-312.pyc";
  const octets = `\0\0\u000d${LEAK}\0`;
  const sans = depotJouet({ libres: { [pyc]: octets } });
  assert.deepEqual(fichiersFuyants(sans), [pyc], "control: without the ignore, bytecode is committable — and it leaks");

  const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  const dir = depotJouet({ gitignore, libres: { [pyc]: octets, [autre]: octets, "src/monitor/valxos_monitor.py": CLEAN } });
  assert.deepEqual(fichiersFuyants(dir), [], "with the real .gitignore, __pycache__/ and *.pyc are never listed, so never scanned or published");
  assert.equal(git(dir, "check-ignore", pyc).trim(), pyc, "git itself says the bytecode is ignored");
  assert.equal(git(dir, "check-ignore", "x/y/z.pyc").trim(), "x/y/z.pyc", "a stray .pyc outside any __pycache__/ is ignored too");
});

// `git commit` publishes the INDEX; `npm pack` publishes the DISK. The guard
// certifies both for a tracked path (rev-t7, MEDIUM 3): a leak added to the
// index and then wiped from the disk was reported clean, and a tracked file
// deleted from the disk was silently skipped.
test("toy: a leak that sits in the index but no longer on disk is caught — git commit publishes the index", () => {
  const dir = depotJouet({ suivis: { "src/a.js": LEAK } });
  fs.writeFileSync(path.join(dir, "src", "a.js"), CLEAN); // the disk is clean, the index is not
  const verdict = fuites(dir, { env: GIT_ENV });
  assert.deepEqual(verdict.hits.map((h) => h.file), ["src/a.js"]);
  assert.match(verdict.hits[0].desc, /index/, "the finding says where the leak lives");
});

test("toy: a leak on disk in a tracked file whose index copy is clean is caught — npm pack publishes the disk", () => {
  const dir = depotJouet({ suivis: { "src/a.js": CLEAN } });
  fs.writeFileSync(path.join(dir, "src", "a.js"), LEAK);
  const verdict = fuites(dir, { env: GIT_ENV });
  assert.deepEqual(verdict.hits.map((h) => h.file), ["src/a.js"]);
  assert.match(verdict.hits[0].desc, /disk|working tree/, "the finding says where the leak lives");
});

test("toy: the same leak in the index and on disk is reported once", () => {
  const dir = depotJouet({ suivis: { "src/a.js": LEAK } });
  assert.deepEqual(fichiersFuyants(dir), ["src/a.js"]);
});

test("toy: a tracked file missing from the disk is a named finding, never a silent skip", () => {
  const dir = depotJouet({ suivis: { "src/a.js": CLEAN } });
  fs.unlinkSync(path.join(dir, "src", "a.js"));
  const verdict = fuites(dir, { env: GIT_ENV });
  assert.deepEqual(verdict.hits.map((h) => h.file), ["src/a.js"]);
  assert.match(verdict.hits[0].desc, /missing/, "the guard cannot certify a file it cannot see on disk");
});

// Symbolic links: git publishes the link's TARGET TEXT. A target that is a
// file of the tree is scanned through; anything else is reported — a link
// leaving the published tree is a finding whatever it points at.
test("toy: a tracked symlink whose target is a file of the tree is scanned through", () => {
  const dir = depotJouet({ gitignore: "prive/\n", libres: { "prive/secret.md": LEAK } });
  fs.mkdirSync(path.join(dir, "docs"));
  fs.symlinkSync(path.join("..", "prive", "secret.md"), path.join(dir, "docs", "lien.md"));
  git(dir, "add", "--", "docs/lien.md");
  assert.deepEqual(fichiersFuyants(dir), ["docs/lien.md"]);
});

test("toy: a symlink pointing outside the tree is reported, even when its target is clean", () => {
  const dehors = fs.mkdtempSync(path.join(os.tmpdir(), "class-guard-dehors-"));
  fs.writeFileSync(path.join(dehors, "propre.txt"), CLEAN);
  const dir = depotJouet();
  fs.symlinkSync(path.join(dehors, "propre.txt"), path.join(dir, "dehors.txt"));
  git(dir, "add", "--", "dehors.txt");
  const verdict = fuites(dir, { env: GIT_ENV });
  assert.equal(verdict.applicable, true);
  assert.deepEqual(verdict.hits.map((h) => h.file), ["dehors.txt"]);
  assert.match(verdict.hits[0].desc, /outside/);
});

// Outside a git repository (a tree unpacked from an npm tarball) the guard
// cannot know what would be published. It says so, by name — a third
// outcome, never a pass.
test("toy: outside a git repository the guard declares itself not applicable, by name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "class-guard-sans-git-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "leak.js"), LEAK);
  const verdict = fuites(dir, { env: GIT_ENV });
  assert.equal(verdict.applicable, false, "no repository, no verdict");
  assert.match(verdict.raison, /git/i, "the reason names git");
  assert.match(verdict.raison, /not applicable/i);
});

test("toy: a root that is not the top of its repository is not applicable either", () => {
  const dir = depotJouet({ suivis: { "src/a.js": LEAK } });
  const verdict = fuites(path.join(dir, "src"), { env: GIT_ENV });
  assert.equal(verdict.applicable, false, "a subdirectory is not the published tree");
  assert.match(verdict.raison, /not applicable/i);
});

// B5: no `git` on the PATH is not "not a repository" — the reason names what
// is missing.
test("toy: without git on the PATH the guard says 'git not found', not 'not a repository'", () => {
  const dir = depotJouet({ suivis: { "src/a.js": CLEAN } });
  const verdict = fuites(dir, { env: { ...GIT_ENV, PATH: path.join(dir, "nowhere") } });
  assert.equal(verdict.applicable, false);
  assert.match(verdict.raison, /git not found/i, "the reason names the missing tool");
  assert.doesNotMatch(verdict.raison, /not inside a git repository/i);
  assert.match(verdict.raison, /not applicable/i);
});

// B6: a tracked file the guard cannot read is a named finding, never an
// exception that takes the whole guard down.
test("toy: an unreadable tracked file (mode 000) is a named finding, not an exception", () => {
  const dir = depotJouet({ suivis: { "src/a.js": CLEAN } });
  fs.chmodSync(path.join(dir, "src", "a.js"), 0);
  let verdict;
  try {
    verdict = fuites(dir, { env: GIT_ENV });
  } finally {
    fs.chmodSync(path.join(dir, "src", "a.js"), 0o644);
  }
  assert.deepEqual(verdict.hits.map((h) => h.file), ["src/a.js"]);
  assert.match(verdict.hits[0].desc, /unreadable/, "the finding says the file could not be read");
});

// ── THE GUARD CARRIES NO IDENTITY (rev-t8, 2026-08-29, HIGH) ─────────────────
//
// The guard used to hold the names it forbids as concatenated fragments
// (a name split into two string literals joined at run time): a negative
// assertion, logically exempt, and still a leak —
// anyone reads the fragments and puts them together. The identities now come
// from the runtime, and this file is proven clean of them: whole (the motif),
// and in fragments (any split of the value into two adjacent string literals).
test("this guard carries none of this machine's identities — whole, or cut into fragments", () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const identites = identitesDeCetteMachine();
  // In CI mode account, host and home are the runner's and are not searched:
  // the floor drops to zero there, and only there (both conditions of modeCI).
  const plancher = modeCI() ? 0 : 3;
  assert.ok(identites.length >= plancher, `SONDE IMPOSSIBLE : ${identites.length} identity(ies) discovered — account, host and home should always be`);
  for (const { motif, quoi, valeur } of identites) {
    assert.doesNotMatch(source, motif, `the guard names ${quoi}`);
    for (let coupe = 1; coupe < valeur.length; coupe += 1) {
      const morceaux = new RegExp(
        `["'\`]${echapper(valeur.slice(0, coupe))}["'\`]\\s*\\+\\s*["'\`]${echapper(valeur.slice(coupe))}["'\`]`,
        "i"
      );
      assert.doesNotMatch(source, morceaux, `the guard carries ${quoi} cut into fragments at ${coupe}`);
    }
  }
});

// An identity handed to the guard is caught, whatever the machine: the toys
// inject a synthetic one and never depend on who runs the suite.
test("toy: an injected identity is caught — the guard catches whatever identity it is given", () => {
  const dir = depotJouet({ suivis: { "src/a.js": 'const hote = "zorglub-machine";\n' } });
  const identites = [{ motif: /(?<![\w-])zorglub-machine(?![\w-])/i, quoi: "an injected identity", valeur: "zorglub-machine" }];
  const verdict = fuites(dir, { env: GIT_ENV, identites });
  assert.deepEqual(verdict.hits.map((h) => h.file), ["src/a.js"]);
  assert.equal(verdict.hits[0].desc, "an injected identity");
  assert.deepEqual(fichiersFuyants(dir), [], "without the injection, nothing in this file is an identity");
});

test("toy: an identity declared in the local, untracked file is discovered and caught", () => {
  const fichierLocal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "class-guard-locales-")), ".identites-locales.json");
  fs.writeFileSync(fichierLocal, JSON.stringify(["poste-de-zorglub"]));
  const identites = identitesDeCetteMachine({ fichierLocal });
  assert.ok(identites.some((i) => i.valeur === "poste-de-zorglub"), "the local file is read");
  const dir = depotJouet({ suivis: { "docs/a.md": "served from poste-de-zorglub\n" } });
  assert.deepEqual(fichiersFuyants(dir, { identites }), ["docs/a.md"]);
});

test("toy: a `<account>-NN` session name is caught, with the account taken from the runtime", () => {
  const dir = depotJouet({ suivis: { "src/a.js": `const chaise = "${os.userInfo().username}-42";\n` } });
  // The account is handed over explicitly: the toy proves the pattern in every
  // mode, including CI mode where the default account is null.
  const verdict = fuites(dir, { env: GIT_ENV, identites: [], compte: os.userInfo().username });
  assert.deepEqual([...new Set(verdict.hits.map((h) => h.file))], ["src/a.js"]);
  assert.ok(verdict.hits.some((h) => /session name/.test(h.desc)));
});

test("toy: a private-network hostname (*.ts.net) is caught by its form alone", () => {
  const dir = depotJouet({ suivis: { "docs/a.md": `reach it at ${HOTE_PRIVE}\n` } });
  const verdict = fuites(dir, { env: GIT_ENV, identites: [] });
  assert.deepEqual(verdict.hits.map((h) => h.file), ["docs/a.md"]);
});

// "Not applicable" was a skip, and a skip lets `node --test` exit 0 outside a
// git repository (rev-t7, MEDIUM 4) while the sister guards go red there.
// House convention: a NAMED red — "SONDE IMPOSSIBLE" — never a skip. Proven
// on a copy of this very file run outside any repository.
test("outside a git repository, `node --test` on this guard exits non-zero and names SONDE IMPOSSIBLE", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "class-guard-hors-git-"));
  fs.mkdirSync(path.join(dir, "test"));
  const copie = path.join(dir, "test", SELF);
  fs.copyFileSync(fileURLToPath(import.meta.url), copie);
  fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "aide-identites.js"), path.join(dir, "test", "aide-identites.js"));
  const env = { ...GIT_ENV };
  delete env.NODE_TEST_CONTEXT; // the nested runner must actually run (garde-bureau's lesson)
  const sortie = spawnSync(
    process.execPath,
    ["--test", "--test-name-pattern=no machine identity leaks", copie],
    { encoding: "utf8", env, cwd: dir }
  );
  const tout = `${sortie.stdout}\n${sortie.stderr}`;
  assert.ok(!/skipping running files/.test(tout), "SONDE IMPOSSIBLE : the nested runner ran nothing");
  assert.notEqual(sortie.status, 0, "outside git the guard must be RED, never a skip that exits 0");
  assert.match(tout, /SONDE IMPOSSIBLE/, "and the red is named");
  // B4: the report says how wide the guard's field was — without tailscale the
  // field shrinks, and that must be visible, not silent.
  assert.match(tout, /\d+ identities discovered \(tailscale: (yes|no)\)/, "the report carries the discovery diagnostic");
});
