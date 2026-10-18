// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE BUREAU INSTALLABLE — nouveau défaut, continuité annoncée, copie explicite.
//
// Aucun test de ce fichier n'approche un bureau réel : chaque HOME et chaque
// source de migration naissent sous mkdtemp. Les « broker.db » ci-dessous sont
// des bases canaris (une table `canari`, aucune lettre), jamais le bureau vivant.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { envPropre } from "./aide-env.js";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const configUrl = new URL("../src/lib/config.js", import.meta.url).href;

function fauxHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function environnement(home, ajouts = {}) {
  const env = { ...envPropre(), HOME: home };
  for (const clef of ["VALXOS_MESSENGER_HOME", "CC2CC_V2_HOME"]) delete env[clef];
  return { ...env, ...ajouts };
}

function sonderBase(home, ajouts = {}) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { baseDir } from ${JSON.stringify(configUrl)}; console.log(baseDir()); console.log(baseDir());`
    ],
    { encoding: "utf8", env: environnement(home, ajouts) }
  );
}

test("③ une installation neuve choisit ~/.valxos-messenger", (t) => {
  const home = fauxHome(t);
  const sonde = sonderBase(home);
  assert.equal(sonde.status, 0, sonde.stderr);
  assert.deepEqual(sonde.stdout.trim().split("\n"), [
    path.join(home, ".valxos-messenger"),
    path.join(home, ".valxos-messenger")
  ]);
  assert.equal(sonde.stderr, "", "une installation neuve n'a aucun repli à annoncer");
});

test("③ l'ancien bureau seul reste utilisé et le repli se dit une seule fois par processus", (t) => {
  const home = fauxHome(t);
  const ancien = path.join(home, ".cc2cc-v2");
  fs.mkdirSync(ancien);
  const sonde = sonderBase(home);
  assert.equal(sonde.status, 0, sonde.stderr);
  assert.deepEqual(sonde.stdout.trim().split("\n"), [ancien, ancien]);
  const annonces = sonde.stderr.trim().split("\n").filter(Boolean);
  assert.equal(annonces.length, 1, `le repli doit parler une fois, reçu : ${sonde.stderr}`);
  assert.match(annonces[0], /^VALXOS Messenger: compatibility - using historical runtime /);
  assert.match(annonces[0], /\.cc2cc-v2/);
  assert.match(annonces[0], /\.valxos-messenger/);
});

test("③ VALXOS_MESSENGER_HOME prend priorité sur CC2CC_V2_HOME", (t) => {
  const home = fauxHome(t);
  const historique = path.join(home, "historique-explicite");
  const nouveau = path.join(home, "nouveau-explicite");
  const sonde = sonderBase(home, { CC2CC_V2_HOME: historique, VALXOS_MESSENGER_HOME: nouveau });
  assert.equal(sonde.status, 0, sonde.stderr);
  assert.deepEqual(new Set(sonde.stdout.trim().split("\n")), new Set([nouveau]));
});

function bureauCanari(source) {
  fs.mkdirSync(path.join(source, "status"), { recursive: true });
  const db = new Database(path.join(source, "broker.db"));
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE canari (n INTEGER)");
  db.prepare("INSERT INTO canari VALUES (42)").run();
  db.close();
  fs.writeFileSync(path.join(source, "web.env"), "VALXOS_WEB_OPERATEUR=alice\n");
  fs.writeFileSync(path.join(source, "status", "alice.json"), "{\"ok\":true}\n");
}

function canaris(fichier) {
  const db = new Database(fichier, { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT n FROM canari ORDER BY n").all().map((r) => r.n); } finally { db.close(); }
}

function empreinte(fichier) {
  return crypto.createHash("sha256").update(fs.readFileSync(fichier)).digest("hex");
}

// Liste complète du dossier (récursive) avec l'empreinte de chaque fichier.
function photo(racine, sauf = []) {
  const vue = {};
  (function marcher(dossier, relatif) {
    for (const e of fs.readdirSync(dossier, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = path.join(relatif, e.name);
      if (e.isDirectory()) { vue[`${r}/`] = "dir"; marcher(path.join(dossier, e.name), r); }
      else vue[r] = sauf.includes(r) ? "présent" : empreinte(path.join(dossier, e.name));
    }
  })(racine, "");
  return vue;
}

function migrer(home, source, cible, args, ajouts = {}) {
  return spawnSync(
    process.execPath,
    [path.join(repo, "scripts", "migrate-home.js"), "--source", source, "--target", cible, ...args],
    { encoding: "utf8", env: environnement(home, ajouts) }
  );
}

test("③ la migration explicite simule puis COPIE par sauvegarde SQLite, pose le marqueur, sans toucher la source", (t) => {
  const home = fauxHome(t);
  const source = path.join(home, ".cc2cc-v2");
  const cible = path.join(home, ".valxos-messenger");
  bureauCanari(source);
  assert.ok(!fs.existsSync(path.join(source, "broker.db-wal")) && !fs.existsSync(path.join(source, "broker.db-shm")),
    "le bureau au repos du fixture n'a aucun sidecar");
  const avant = empreinte(path.join(source, "broker.db"));
  const photoAvant = photo(source);

  const simulation = migrer(home, source, cible, ["--dry-run"]);
  assert.equal(simulation.status, 0, simulation.stderr);
  const plan = JSON.parse(simulation.stdout);
  assert.equal(plan.mode, "dry-run");
  assert.deepEqual(plan.writers, []);
  assert.equal(plan.copy_mode, "file");
  assert.ok(!fs.existsSync(cible), "un dry-run ne crée pas même le répertoire cible");

  const copie = migrer(home, source, cible, ["--apply"]);
  assert.equal(copie.status, 0, copie.stderr);
  const rapport = JSON.parse(copie.stdout);
  assert.equal(rapport.mode, "apply");
  assert.equal(rapport.copied, true);
  assert.deepEqual(rapport.writers, []);
  assert.equal(rapport.copy_mode, "file", "sans -wal ni -shm, la source n'est jamais ouverte");
  assert.equal(rapport.db_copied_by, "file-copy");
  assert.deepEqual(rapport.source_sidecars_created, []);
  assert.equal(rapport.integrity, "ok");
  assert.deepEqual(photo(source), photoAvant, "la source entière, liste et octets, est identique après la copie");
  assert.equal(rapport.marker, path.join(cible, ".valxos-messenger-home"));

  assert.deepEqual(canaris(path.join(cible, "broker.db")), [42]);
  for (const relatif of ["web.env", path.join("status", "alice.json")]) {
    assert.equal(fs.readFileSync(path.join(cible, relatif), "utf8"), fs.readFileSync(path.join(source, relatif), "utf8"));
  }
  const marqueur = path.join(cible, ".valxos-messenger-home");
  assert.ok(fs.existsSync(marqueur));
  assert.ok(fs.statSync(marqueur).isFile(), "le marqueur est un FICHIER");
  const contenu = fs.readFileSync(marqueur, "utf8");
  assert.equal(contenu.split("\n").filter(Boolean).length, 1, "une seule ligne");
  assert.ok(contenu.includes(source), "le marqueur nomme la source");
  assert.match(contenu, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "le marqueur porte une date ISO");

  assert.ok(fs.existsSync(source), "la source entière reste en place");
  assert.equal(empreinte(path.join(source, "broker.db")), avant, "broker.db de la source intact à l'octet");
  assert.deepEqual(canaris(path.join(source, "broker.db")), [42]);
  assert.ok(!fs.existsSync(path.join(source, ".valxos-messenger-home")), "la source ne reçoit jamais le marqueur");

  const rejeu = migrer(home, source, cible, ["--apply"]);
  assert.equal(rejeu.status, 2, "une cible non vide refuse : aucune fusion implicite de deux bureaux");
  assert.ok(fs.existsSync(source), "même le refus ne touche pas la source");
});

test("③ migrate-home : des sidecars présents → sauvegarde SQLite, trames WAL comprises, source intacte", async (t) => {
  const home = fauxHome(t);
  const source = path.join(home, ".cc2cc-v2");
  const cible = path.join(home, ".valxos-messenger");
  bureauCanari(source);
  // Un écrivain tué net après une écriture : ses trames restent dans -wal, non checkpointées.
  const tue = spawnSync(process.execPath, ["-e",
    `const D=require(${JSON.stringify(path.join(repo, "node_modules/better-sqlite3"))});` +
    `const d=new D(process.argv[1]);d.pragma("wal_autocheckpoint = 0");d.prepare("INSERT INTO canari VALUES (7)").run();` +
    `process.kill(process.pid,"SIGKILL");`, path.join(source, "broker.db")], { encoding: "utf8" });
  assert.equal(tue.signal, "SIGKILL", tue.stderr);
  assert.ok(fs.statSync(path.join(source, "broker.db-wal")).size > 0, "le -wal porte la trame non checkpointée");
  const photoAvant = photo(source, ["broker.db-shm"]);

  const r = migrer(home, source, cible, ["--apply"]);
  assert.equal(r.status, 0, r.stderr);
  const rapport = JSON.parse(r.stdout);
  assert.equal(rapport.copy_mode, "backup-api");
  assert.equal(rapport.db_copied_by, "sqlite-backup");
  assert.equal(rapport.integrity, "ok");
  assert.deepEqual(rapport.source_sidecars_created, []);
  assert.deepEqual(canaris(path.join(cible, "broker.db")), [7, 42], "la copie comprend la trame du -wal");
  // broker.db et -wal à l'octet ; -shm (l'index que tout lecteur reconstruit) seulement présent.
  assert.deepEqual(photo(source, ["broker.db-shm"]), photoAvant);
  assert.ok(fs.statSync(path.join(cible, ".valxos-messenger-home")).isFile());
});

test("③ migrate-home refuse tant qu'un écrivain tient la base, et ne crée pas la cible", async (t) => {
  const home = fauxHome(t);
  const source = path.join(home, ".cc2cc-v2");
  const cible = path.join(home, ".valxos-messenger");
  bureauCanari(source);
  const ecrivain = spawn(process.execPath, ["-e",
    `const D=require(${JSON.stringify(path.join(repo, "node_modules/better-sqlite3"))});` +
    `const d=new D(process.argv[1]);d.pragma("journal_mode = WAL");d.prepare("INSERT INTO canari VALUES (1)").run();` +
    `console.log("pret");setInterval(()=>{},1000);`, path.join(source, "broker.db")], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => ecrivain.kill());
  await new Promise((ok) => ecrivain.stdout.once("data", ok));
  for (const mode of ["--apply", "--dry-run"]) {
    const r = migrer(home, source, cible, [mode]);
    assert.equal(r.status, 2, `${mode}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /writers hold the database/);
    assert.match(r.stderr, new RegExp(`\\b${ecrivain.pid}\\b`));
    assert.ok(!fs.existsSync(cible), `${mode} ne crée pas la cible`);
  }
});

test("③ migrate-home nomme l'écrivain même quand lsof ne trouve qu'une partie des fichiers ouverts", async (t) => {
  const home = fauxHome(t);
  const source = path.join(home, ".cc2cc-v2");
  const cible = path.join(home, ".valxos-messenger");
  bureauCanari(source);
  // Un tenant en journal DELETE : broker.db ouvert en lecture-écriture, sans -wal ni -shm
  // ouverts par lui ; un -wal orphelin posé à côté force lsof à sortir en 1.
  const db = new Database(path.join(source, "broker.db"));
  db.pragma("journal_mode = DELETE");
  db.close();
  fs.writeFileSync(path.join(source, "broker.db-wal"), "");
  const ecrivain = spawn(process.execPath, ["-e",
    `const fs=require("fs");const fd=fs.openSync(process.argv[1],"r+");console.log("pret");setInterval(()=>{},1000);`,
    path.join(source, "broker.db")], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => ecrivain.kill());
  await new Promise((ok) => ecrivain.stdout.once("data", ok));
  const r = migrer(home, source, cible, ["--apply"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /writers hold the database/);
  assert.match(r.stderr, new RegExp(`\\b${ecrivain.pid}\\b`));
  assert.ok(!fs.existsSync(cible));
});

test("③ migrate-home : une sonde lsof impossible n'est jamais un feu vert", (t) => {
  const home = fauxHome(t);
  const source = path.join(home, ".cc2cc-v2");
  const cible = path.join(home, ".valxos-messenger");
  bureauCanari(source);
  const casse = path.join(home, "lsof-casse");
  fs.writeFileSync(casse, "#!/bin/sh\necho 'lsof: kernel says no' >&2\nexit 3\n", { mode: 0o755 });
  for (const lsof of [path.join(home, "absent-lsof"), casse]) {
    const r = migrer(home, source, cible, ["--apply"], { VALXOS_MESSENGER_LSOF: lsof });
    assert.equal(r.status, 2, `${lsof}: ${r.stderr}`);
    // Une seule formulation pour les deux branches (absent, en échec) : la
    // raison entre parenthèses, puis le même constat.
    assert.match(r.stderr, /probe impossible \([^)]+\): cannot prove that the office is at rest/);
    assert.ok(!fs.existsSync(cible));
  }
});

test("③ migrate-home : cible non vide refusée sans --force ; --force la met de côté datée, jamais effacée", (t) => {
  const home = fauxHome(t);
  const source = path.join(home, ".cc2cc-v2");
  const cible = path.join(home, ".valxos-messenger");
  bureauCanari(source);
  fs.mkdirSync(cible);
  fs.writeFileSync(path.join(cible, "ancien.txt"), "je reste quelque part\n");

  const refus = migrer(home, source, cible, ["--apply"]);
  assert.equal(refus.status, 2, refus.stderr);
  assert.match(refus.stderr, /--force/);
  assert.deepEqual(fs.readdirSync(cible), ["ancien.txt"]);

  const simulation = migrer(home, source, cible, ["--dry-run", "--force"]);
  assert.equal(simulation.status, 0, simulation.stderr);
  assert.ok(JSON.parse(simulation.stdout).aside, "le plan annonce la mise de côté");
  assert.deepEqual(fs.readdirSync(cible), ["ancien.txt"], "un dry-run ne déplace rien");
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.includes("aside")), []);

  const force = migrer(home, source, cible, ["--apply", "--force"]);
  assert.equal(force.status, 0, force.stderr);
  const rapport = JSON.parse(force.stdout);
  assert.ok(rapport.aside.startsWith(`${cible}.aside-`), rapport.aside);
  assert.equal(fs.readFileSync(path.join(rapport.aside, "ancien.txt"), "utf8"), "je reste quelque part\n");
  assert.deepEqual(canaris(path.join(cible, "broker.db")), [42]);
  assert.ok(fs.statSync(path.join(cible, ".valxos-messenger-home")).isFile());
});

test("③ migrate-home : une cible vide est acceptée, une cible qui est la source (lien) refusée même avec --force", (t) => {
  const home = fauxHome(t);
  const source = path.join(home, ".cc2cc-v2");
  bureauCanari(source);
  const vide = path.join(home, "vide");
  fs.mkdirSync(vide);
  const ok = migrer(home, source, vide, ["--apply"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(canaris(path.join(vide, "broker.db")), [42]);

  const lien = path.join(home, ".valxos-messenger");
  fs.symlinkSync(source, lien);
  const refus = migrer(home, source, lien, ["--apply", "--force"]);
  assert.notEqual(refus.status, 0, refus.stderr);
  assert.ok(fs.lstatSync(lien).isSymbolicLink(), "le lien de la Phase A reste en place");
});

test("③ la famille VALXOS_* a priorité dans le code Node et dans le moniteur Python", (t) => {
  const home = fauxHome(t);
  const js = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { valeurDeLEnvironnement } from ${JSON.stringify(configUrl)}; ` +
        `console.log(valeurDeLEnvironnement({CC2CC_SELF:"ancien",VALXOS_SELF:"nouveau"},"CC2CC_SELF"));`
    ],
    { encoding: "utf8", env: environnement(home) }
  );
  assert.equal(js.status, 0, js.stderr);
  assert.equal(js.stdout.trim(), "nouveau");

  const python = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      "import importlib.util,sys; " +
        `s=importlib.util.spec_from_file_location('moniteur',${JSON.stringify(path.join(repo, "src/monitor/valxos_monitor.py"))}); ` +
        "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);" +
        "print(m.base_dir());print(m.self_id())"
    ],
    {
      encoding: "utf8",
      env: environnement(home, {
        CC2CC_V2_HOME: path.join(home, "ancien"),
        VALXOS_MESSENGER_HOME: path.join(home, "nouveau"),
        CC2CC_SELF: "ancien",
        VALXOS_SELF: "nouveau"
      })
    }
  );
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(python.stdout.trim().split("\n"), [path.join(home, "nouveau"), "nouveau"]);
});

// ───────── LE PIÈGE N°1 (Run 6, tâche 2) — le nouveau bureau se PROUVE ─────────
//
// Un ~/.valxos-messenger qui existe ne prouve rien : un mkdir d'un processus neuf
// suffisait à couper le bureau vivant en deux. Seuls un lien vers l'historique ou
// le marqueur posé par migrate-home font basculer — en Node ET en Python, avec
// le même verdict sur les mêmes plans de maison.
function sonderPython(home, ajouts = {}) {
  return spawnSync("python3", ["-B", "-c",
    "import importlib.util,sys; " +
    `s=importlib.util.spec_from_file_location('m',${JSON.stringify(path.join(repo, "src/monitor/valxos_monitor.py"))}); ` +
    "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);print(m.base_dir());print(m.base_dir())"],
    { encoding: "utf8", env: environnement(home, ajouts) });
}

// [nom, plan de la maison, bureau attendu, bureau non prouvé à nommer sur stderr | null]
const CAS = [
  ["① nouveau = lien vers l'historique → nouveau", (h) => { fs.mkdirSync(path.join(h, ".cc2cc-v2")); fs.symlinkSync(path.join(h, ".cc2cc-v2"), path.join(h, ".valxos-messenger")); }, ".valxos-messenger", null],
  ["② nouveau porte le marqueur → nouveau, même si l'historique existe", (h) => { fs.mkdirSync(path.join(h, ".cc2cc-v2")); fs.mkdirSync(path.join(h, ".valxos-messenger")); fs.writeFileSync(path.join(h, ".valxos-messenger", ".valxos-messenger-home"), "{}\n"); }, ".valxos-messenger", null],
  ["③ nouveau = dossier nu sans marqueur + historique → historique (le piège n°1)", (h) => { fs.mkdirSync(path.join(h, ".cc2cc-v2")); fs.mkdirSync(path.join(h, ".valxos-messenger")); }, ".cc2cc-v2", ".valxos-messenger"],
  ["④ nouveau absent + historique → historique", (h) => { fs.mkdirSync(path.join(h, ".cc2cc-v2")); }, ".cc2cc-v2", null],
  ["⑤ lien nouveau → ailleurs, historique présent → historique", (h) => { fs.mkdirSync(path.join(h, ".cc2cc-v2")); fs.mkdirSync(path.join(h, "autre")); fs.symlinkSync(path.join(h, "autre"), path.join(h, ".valxos-messenger")); }, ".cc2cc-v2", ".valxos-messenger"],
  ["⑥ rien du tout → nouveau (installation neuve)", () => {}, ".valxos-messenger", null],
  ["⑦ nouveau = dossier nu, aucun historique → nouveau (seul bureau possible)", (h) => { fs.mkdirSync(path.join(h, ".valxos-messenger")); }, ".valxos-messenger", null],
  ["⑧ lien nouveau → historique absent (lien cassé), rien d'autre → nouveau", (h) => { fs.symlinkSync(path.join(h, ".cc2cc-v2"), path.join(h, ".valxos-messenger")); }, ".valxos-messenger", null],
  ["⑨ nouveau porte un DOSSIER nommé comme le marqueur + historique → historique (pas une preuve)", (h) => { fs.mkdirSync(path.join(h, ".cc2cc-v2")); fs.mkdirSync(path.join(h, ".valxos-messenger", ".valxos-messenger-home"), { recursive: true }); }, ".cc2cc-v2", ".valxos-messenger"]
];

function lignes(sortie) {
  return sortie.split("\n").filter(Boolean);
}

for (const [nom, poser, attendu, nonProuve] of CAS) {
  test(`bureau (Node et Python) ${nom}`, (t) => {
    const home = fauxHome(t);
    poser(home);
    const cible = path.join(home, attendu);
    const sondes = [["node", sonderBase(home)], ["python", sonderPython(home)]];
    // PARITÉ À L'OCTET (T4b-b) : le Node reprend mot pour mot les lignes
    // anglaises du moniteur. Les deux langages disent la même chose, ou rien.
    assert.deepEqual(lignes(sondes[0][1].stderr), lignes(sondes[1][1].stderr), "Node et Python écrivent les mêmes lignes stderr");
    for (const [langage, sonde] of sondes) {
      assert.equal(sonde.status, 0, `${langage}: ${sonde.stderr}`);
      assert.deepEqual(lignes(sonde.stdout), [cible, cible], `${langage} choisit ${attendu}`);
      const avertissements = lignes(sonde.stderr).filter((l) => /non prouv|unproven/i.test(l));
      if (nonProuve) {
        assert.equal(avertissements.length, 1, `${langage} doit nommer le bureau non prouvé une fois, reçu : ${sonde.stderr}`);
        assert.ok(avertissements[0].includes(path.join(home, nonProuve)), `${langage} nomme ${nonProuve} : ${avertissements[0]}`);
        assert.equal(lignes(sonde.stderr).length, 1, `${langage} : une seule ligne, reçu : ${sonde.stderr}`);
      } else {
        assert.equal(avertissements.length, 0, `${langage} : aucun avertissement attendu, reçu : ${sonde.stderr}`);
      }
    }
  });
}

test("bureau : les overrides explicites gardent la priorité sur un nouveau bureau prouvé (Node et Python)", (t) => {
  const home = fauxHome(t);
  fs.mkdirSync(path.join(home, ".valxos-messenger"));
  fs.writeFileSync(path.join(home, ".valxos-messenger", ".valxos-messenger-home"), "{}\n");
  const explicite = path.join(home, "explicite");
  for (const ajouts of [{ VALXOS_MESSENGER_HOME: explicite, CC2CC_V2_HOME: path.join(home, "perdant") }, { CC2CC_V2_HOME: explicite }]) {
    for (const sonde of [sonderBase(home, ajouts), sonderPython(home, ajouts)]) {
      assert.equal(sonde.status, 0, sonde.stderr);
      assert.deepEqual(lignes(sonde.stdout), [explicite, explicite]);
    }
  }
});

test("bureau : le nom du marqueur est UNE constante, identique en Node et en Python", (t) => {
  const home = fauxHome(t);
  const js = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { MARQUEUR_BUREAU } from ${JSON.stringify(configUrl)}; console.log(MARQUEUR_BUREAU);`],
    { encoding: "utf8", env: environnement(home) });
  assert.equal(js.status, 0, js.stderr);
  const py = spawnSync("python3", ["-B", "-c",
    "import importlib.util,sys; " +
    `s=importlib.util.spec_from_file_location('m',${JSON.stringify(path.join(repo, "src/monitor/valxos_monitor.py"))}); ` +
    "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);print(m.MARKER)"],
    { encoding: "utf8", env: environnement(home) });
  assert.equal(py.status, 0, py.stderr);
  assert.equal(js.stdout.trim(), ".valxos-messenger-home");
  assert.equal(py.stdout.trim(), js.stdout.trim());
});

test("bureau : choisirLeBureau rend la raison de son choix", async (t) => {
  const home = fauxHome(t);
  const { choisirLeBureau } = await import(configUrl);
  assert.deepEqual(choisirLeBureau({ home }), { racine: path.join(home, ".valxos-messenger"), raison: "neuf" });
  fs.mkdirSync(path.join(home, ".cc2cc-v2"));
  assert.deepEqual(choisirLeBureau({ home }), { racine: path.join(home, ".cc2cc-v2"), raison: "historique" });
  fs.mkdirSync(path.join(home, ".valxos-messenger"));
  assert.deepEqual(choisirLeBureau({ home }), {
    racine: path.join(home, ".cc2cc-v2"), raison: "historique", nonProuve: path.join(home, ".valxos-messenger")
  });
  fs.writeFileSync(path.join(home, ".valxos-messenger", ".valxos-messenger-home"), "{}\n");
  assert.deepEqual(choisirLeBureau({ home }), { racine: path.join(home, ".valxos-messenger"), raison: "marqueur" });
  fs.rmSync(path.join(home, ".valxos-messenger"), { recursive: true });
  fs.symlinkSync(path.join(home, ".cc2cc-v2"), path.join(home, ".valxos-messenger"));
  assert.deepEqual(choisirLeBureau({ home }), { racine: path.join(home, ".valxos-messenger"), raison: "lien-vers-historique" });
});

// F2 (passe adverse du Run 6, 28/09) — UN BUREAU EXPLICITE N'EST JAMAIS
// RELATIF AU DOSSIER COURANT. `VALXOS_MESSENGER_HOME = "~/.valxos-messenger"`
// dans un bloc env de client (TOML, JSON : aucun shell n'y développe `~`)
// créait un bureau par dossier de projet en Node, et le moniteur Python en
// résolvait un troisième. Une seule règle des deux côtés : `~` et `~/…` se
// développent contre HOME ; un chemin relatif est refusé (une ligne sur stderr
// qui nomme la variable, sortie 2) ; un chemin absolu passe tel quel.
function sondesDuBureau(home, cwd, ajouts) {
  const env = environnement(home, ajouts);
  const node = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { baseDir } from ${JSON.stringify(configUrl)}; console.log(baseDir());`], { encoding: "utf8", env, cwd });
  const python = spawnSync("python3", ["-B", "-c",
    "import importlib.util,sys; " +
    `s=importlib.util.spec_from_file_location('m',${JSON.stringify(path.join(repo, "src/monitor/valxos_monitor.py"))}); ` +
    "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);print(m.base_dir())"],
  { encoding: "utf8", env, cwd });
  return { node, python };
}

for (const clef of ["VALXOS_MESSENGER_HOME", "CC2CC_V2_HOME"]) {
  for (const [valeur, attendu] of [
    ["~/.valxos-messenger", (h) => path.join(h, ".valxos-messenger")],
    ["~", (h) => h],
    ["/absolu/bureau", () => "/absolu/bureau"]
  ]) {
    test(`F2 — ${clef}=${valeur} se résout pareil en Node et en Python, jamais contre le dossier courant`, (t) => {
      const home = fauxHome(t);
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-cwd-"));
      t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const { node, python } = sondesDuBureau(home, cwd, { [clef]: valeur });
      assert.equal(node.status, 0, node.stderr);
      assert.equal(python.status, 0, python.stderr);
      assert.equal(node.stdout.trim(), attendu(home));
      assert.equal(python.stdout.trim(), attendu(home), "parité Node/Python");
    });
  }
  test(`F2 — ${clef} relatif est refusé des deux côtés : une ligne qui nomme la variable, sortie 2, rien créé`, (t) => {
    const home = fauxHome(t);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-cwd-"));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    for (const valeur of ["bureau-relatif", "./bureau", "~autre/bureau"]) {
      const { node, python } = sondesDuBureau(home, cwd, { [clef]: valeur });
      for (const [cote, r] of [["Node", node], ["Python", python]]) {
        assert.equal(r.status, 2, `${cote} ${valeur} : ${r.stdout}${r.stderr}`);
        const lignesErr = r.stderr.trim().split("\n").filter(Boolean);
        assert.equal(lignesErr.length, 1, `${cote} : une seule ligne, reçu ${r.stderr}`);
        assert.ok(lignesErr[0].includes(clef), `${cote} : la ligne nomme ${clef}`);
        assert.match(lignesErr[0], /absolute/);
        assert.equal(r.stdout, "", `${cote} : aucun bureau rendu`);
      }
      assert.equal(node.stderr, python.stderr, "la même ligne des deux côtés");
    }
    assert.deepEqual(fs.readdirSync(cwd), [], "rien n'a été créé dans le dossier courant");
  });
}

// M-7 (revue du 28/09) : sortie 1, pas 0 — Claude Code ne montre le stderr
// d'un hook sorti 0 qu'en mode verbeux ; 1 est l'erreur NON bloquante dont il
// montre le stderr. 2, lui, bloquerait un Stop : jamais.
test("F2 — un hook sous bureau relatif dit la ligne et sort 1 (non bloquant, visible) : il ne bloque jamais un Stop, et ne crée rien", (t) => {
  const home = fauxHome(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-cwd-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const hook of ["safety_net_poll.js", "piggyback_fetch.js", "startup_sync.js"]) {
    const r = spawnSync(process.execPath, [path.join(repo, "src/hooks", hook)], {
      encoding: "utf8", cwd, input: JSON.stringify({ session_id: "S1" }),
      env: environnement(home, { VALXOS_MESSENGER_HOME: "bureau-relatif", VALXOS_SELF: "lignee-t" })
    });
    assert.equal(r.status, 1, `${hook} : ${r.stderr}`);
    assert.match(r.stderr, /VALXOS_MESSENGER_HOME/);
  }
  assert.deepEqual(fs.readdirSync(cwd), [], "rien n'a été créé dans le dossier courant");
});

// F5 (passe adverse du Run 6, 28/09) — UN LIEN RELATIF RESTE RELATIF.
// `cpSync` sans `verbatimSymlinks` réécrivait `logs/current.log -> facteur.log`
// en lien ABSOLU vers la source : écrire par le nouveau bureau modifiait
// l'ancien. Les liens qui sortent du bureau (absolus, ou relatifs qui en
// sortent) se nomment dans le plan, dry-run comme apply.
test("F5 — migrate-home garde un lien relatif relatif, n'écrit jamais dans la source par la copie, et nomme les liens qui sortent", (t) => {
  const home = fs.realpathSync(fauxHome(t));
  const source = path.join(home, ".cc2cc-v2");
  const cible = path.join(home, ".valxos-messenger");
  bureauCanari(source);
  fs.mkdirSync(path.join(source, "logs"));
  fs.writeFileSync(path.join(source, "logs", "facteur.log"), "log\n");
  fs.symlinkSync("facteur.log", path.join(source, "logs", "current.log"));
  fs.writeFileSync(path.join(home, "dehors.txt"), "hors du bureau\n");
  fs.mkdirSync(path.join(source, "exports", "sub"), { recursive: true });
  fs.symlinkSync(path.join(home, "dehors.txt"), path.join(source, "exports", "sub", "lien-absolu"));
  fs.symlinkSync("../../../dehors.txt", path.join(source, "exports", "sub", "lien-relatif-sortant"));
  const attendus = [
    { path: path.join("exports", "sub", "lien-absolu"), target: path.join(home, "dehors.txt") },
    { path: path.join("exports", "sub", "lien-relatif-sortant"), target: "../../../dehors.txt" }
  ];

  const plan = migrer(home, source, cible, ["--dry-run"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout).links_leaving_office, attendus, "le plan nomme les liens qui sortent");

  const copie = migrer(home, source, cible, ["--apply"]);
  assert.equal(copie.status, 0, copie.stderr);
  assert.deepEqual(JSON.parse(copie.stdout).links_leaving_office, attendus);
  assert.equal(fs.readlinkSync(path.join(cible, "logs", "current.log")), "facteur.log", "le lien relatif reste relatif");
  assert.equal(fs.readlinkSync(path.join(cible, "exports", "sub", "lien-relatif-sortant")), "../../../dehors.txt");
  fs.appendFileSync(path.join(cible, "logs", "current.log"), "écrit par le nouveau bureau\n");
  assert.equal(fs.readFileSync(path.join(source, "logs", "facteur.log"), "utf8"), "log\n", "la source n'est pas touchée par la copie");
});

// F9 (passe adverse du Run 6, 28/09) — `VALXOS_MESSENGER_HOME=` (vide) jetait
// un `CC2CC_V2_HOME` explicite et renvoyait le processus au bureau vivant par
// défaut. Vide compte pour absente ; quand elle aurait masqué la clef
// historique, une ligne le dit. Parité Node/Python.
test("F9 — VALXOS_MESSENGER_HOME vide laisse gagner CC2CC_V2_HOME, et le dit en une ligne (Node et Python)", (t) => {
  const home = fauxHome(t);
  const explicite = path.join(home, "explicite");
  const { node, python } = sondesDuBureau(home, home, { VALXOS_MESSENGER_HOME: "", CC2CC_V2_HOME: explicite });
  for (const [cote, r] of [["Node", node], ["Python", python]]) {
    assert.equal(r.status, 0, `${cote} : ${r.stderr}`);
    assert.equal(r.stdout.trim(), explicite, `${cote} : la clef historique explicite gagne`);
    const lignesErr = r.stderr.trim().split("\n").filter(Boolean);
    assert.equal(lignesErr.length, 1, `${cote} : une ligne, reçu ${r.stderr}`);
    assert.match(lignesErr[0], /VALXOS_MESSENGER_HOME/);
    assert.match(lignesErr[0], /CC2CC_V2_HOME/);
  }
  assert.equal(node.stderr, python.stderr, "la même ligne des deux côtés");
});

test("F9 — VALXOS_MESSENGER_HOME vide et rien d'autre : le défaut, sans rien dire", (t) => {
  const home = fauxHome(t);
  const { node, python } = sondesDuBureau(home, home, { VALXOS_MESSENGER_HOME: "" });
  for (const r of [node, python]) {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), path.join(home, ".valxos-messenger"));
    assert.equal(r.stderr, "");
  }
});

// N5 (seconde passe adverse du Run 6, 28/09) — UN HOME VIDE OU RELATIF NE FAIT
// PAS UN BUREAU RELATIF. Avec `HOME=` (env -i, bacs à sable, certains
// runners), le bureau par défaut et `~/…` se résolvaient contre le dossier
// courant. Désormais : le domicile du compte (passwd) prend le relais, sinon
// refus en une ligne (sortie 2). La parité se prouve sur une valeur `~/…`
// explicite, qui ne regarde jamais le bureau réel du compte.
test("N5 — HOME= : `~/…` se résout contre le domicile du compte, pareil en Node et en Python, jamais contre cwd", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-cwd-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = { ...envPropre(), HOME: "", VALXOS_MESSENGER_HOME: "~/.bureau-n5" };
  delete env.CC2CC_V2_HOME;
  const node = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { baseDir } from ${JSON.stringify(configUrl)}; console.log(baseDir());`], { encoding: "utf8", env, cwd });
  const python = spawnSync("python3", ["-B", "-c",
    "import importlib.util,sys; " +
    `s=importlib.util.spec_from_file_location('m',${JSON.stringify(path.join(repo, "src/monitor/valxos_monitor.py"))}); ` +
    "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);print(m.base_dir())"], { encoding: "utf8", env, cwd });
  const attendu = path.join(os.userInfo().homedir, ".bureau-n5");
  assert.equal(node.status, 0, node.stderr);
  assert.equal(python.status, 0, python.stderr);
  assert.equal(node.stdout.trim(), attendu);
  assert.equal(python.stdout.trim(), attendu, "parité Node/Python");
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test("N5 — le domicile : HOME absolu gagne ; vide ou relatif → domicile du compte ; aucun des deux → refus en une ligne", async () => {
  const { domicile } = await import(configUrl);
  assert.equal(domicile({ env: { HOME: "/maison/absolue" } }), "/maison/absolue");
  assert.equal(domicile({ env: { HOME: "" }, compte: () => "/depuis/passwd" }), "/depuis/passwd");
  assert.equal(domicile({ env: { HOME: "relatif" }, compte: () => "/depuis/passwd" }), "/depuis/passwd");
  let refus = null;
  domicile({ env: { HOME: "" }, compte: () => "", refuser: (ligne) => { refus = ligne; return null; } });
  assert.match(refus, /HOME/);
  assert.match(refus, /absolute/);
});

// M-4 (revue du 28/09) — LA MÊME CHAÎNE DES DEUX CÔTÉS. Node gardait un chemin
// absolu brut et résolvait `~/…` ; Python gardait les `..` et retirait la barre
// finale ; `~//x` donnait `/x` des deux côtés (un shell donne `$HOME/x`).
for (const [valeur, attendu] of [
  ["~/a/../b", (h) => path.join(h, "b")],
  ["/tmp/x/", () => "/tmp/x"],
  ["/tmp/a/../x", () => "/tmp/x"],
  ["~//x", (h) => path.join(h, "x")],
  // M-3 de la revue finale : `//x` — Node `/x`, Python `//x` (POSIX garde deux
  // barres de tête). Les deux replient sur `/x`.
  ["//x", () => "/x"],
  ["///tmp//y", () => "/tmp/y"]
]) {
  test(`M-4 — ${valeur} se normalise pareil en Node et en Python`, (t) => {
    const home = fauxHome(t);
    const { node, python } = sondesDuBureau(home, home, { VALXOS_MESSENGER_HOME: valeur });
    assert.equal(node.status, 0, node.stderr);
    assert.equal(python.status, 0, python.stderr);
    assert.equal(node.stdout.trim(), attendu(home));
    assert.equal(python.stdout.trim(), attendu(home), "parité Node/Python");
  });
}

// M-6 (revue du 28/09) — `baseDir` passe son `annoncer` à la ligne F9.
test("M-6 — la ligne F9 passe par l'annonceur injecté dans baseDir", async () => {
  const { baseDir } = await import(`${configUrl}?m6=${Date.now()}`);
  const dites = [];
  const racine = baseDir({ env: { VALXOS_MESSENGER_HOME: "", CC2CC_V2_HOME: "/tmp/m6-explicite", HOME: "/tmp" }, annoncer: (m) => dites.push(m) });
  assert.equal(racine, "/tmp/m6-explicite");
  assert.equal(dites.length, 1);
  assert.match(dites[0], /VALXOS_MESSENGER_HOME is set but empty/);
});
