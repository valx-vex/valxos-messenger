// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE MÉDECIN NE CRÉE PAS LE BUREAU QU'IL DIAGNOSTIQUE (Q3 de la revue qualité, 18/10).
//
// `valxos-doctor` appelait `ensureRuntimeDirs()` puis `getDatabase()` avant tout
// constat : sur une machine sans bureau, il créait le dossier, `broker.db`,
// `run/`, `status/`, `logs/`, `exports/` — puis rapportait `dbExists: true`. Le
// constat ne pouvait jamais être faux, et le CHANGELOG promettait « reports and
// never writes by default ».
//
// Trois issues, dites comme telles :
//   · pas de bureau → `dbExists: false`, `ok: false`, RIEN n'est créé (avec ou
//     sans `--reap` : il n'y a rien à moissonner) ;
//   · un bureau, sans `--reap` → ouvert en LECTURE SEULE : aucune ligne ne bouge,
//     aucune migration ne s'écrit, aucun dossier ne naît ;
//   · un bureau d'une version plus ancienne, lu en lecture seule → le médecin
//     dit qu'il n'a pas pu compter (`schemaBehind`, ok: false), il ne plante pas
//     et ne migre pas : une sonde qui n'a pas tourné n'est jamais un pass.
//
// Tout se joue dans des bureaux et des HOME jetables.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

import { initSchema, insertMessage, openDatabase } from "../src/lib/database.js";
import { SCHEMA_VERSION, schemaVersion } from "../src/lib/migrations.js";
import { registerInstance } from "../src/lib/registry.js";
import { ecrireFicheCodex } from "../src/lib/chaise-codex.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

// ⚠️ LE JETABLE VAUT AUSSI POUR CE PROCESSUS-CI (revue adverse F2, 21/08) : les
// ouvertures EN PROCESSUS de ce fichier (`openDatabase`) lisent `baseDir()`, donc
// l'ENV du runner, jamais le fichier qu'on leur impose. Sans ce plancher, elles
// poseraient leurs dossiers dans le bureau du lanceur.
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-doctor-seul-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

const repo = path.resolve(new URL("..", import.meta.url).pathname);

function scratch(t) {
  const racine = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-doctor-seul-")));
  fs.mkdirSync(path.join(racine, "home"));
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  return racine;
}

function lancerLeMedecin(racine, bureau, drapeaux = [], envEnPlus = {}) {
  const sortie = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-doctor.js"), ...drapeaux], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: bureau, HOME: path.join(racine, "home"), ...envEnPlus }
  });
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  return JSON.parse(sortie.stdout);
}

// La liste de tout ce qui existe sous un dossier, chemins relatifs, triée.
function arbre(dossier) {
  const vus = [];
  (function marcher(courant, relatif) {
    for (const entree of fs.readdirSync(courant, { withFileTypes: true })) {
      const r = path.join(relatif, entree.name);
      vus.push(entree.isDirectory() ? `${r}/` : r);
      if (entree.isDirectory()) marcher(path.join(courant, entree.name), r);
    }
  })(dossier, "");
  return vus.sort();
}

const empreinte = (fichier) => crypto.createHash("sha256").update(fs.readFileSync(fichier)).digest("hex");

// Un lecteur SQLite en WAL pose `-wal` et `-shm` à côté de la base, même en
// lecture seule : ce n'est pas une écriture de données, et rien ne s'en lit.
const SIDECARS = ["broker.db-wal", "broker.db-shm"];

test("sans bureau, le médecin ne crée RIEN : ni dossier, ni base — et dit dbExists:false, ok:false", (t) => {
  const racine = scratch(t);
  const bureau = path.join(racine, "office");
  const avant = arbre(racine);

  const rapport = lancerLeMedecin(racine, bureau);

  assert.equal(rapport.checks.dbExists, false, "le constat peut enfin être faux");
  assert.equal(rapport.ok, false, "pas de bureau, pas de vert");
  assert.equal(fs.existsSync(bureau), false, "le dossier du bureau n'existe toujours pas");
  assert.deepEqual(arbre(racine), avant, "rien n'a été créé nulle part sous le scratch (HOME compris)");
  // Les clefs du rapport gardent leur forme : zéro lettre dans chaque état, pas une clef qui manque.
  assert.deepEqual(rapport.checks.lettres, { "accusée": 0, "reçue": 0, "au guichet": 0, "en attente": 0 });
  assert.equal(rapport.checks.peers, 0);
  assert.equal(rapport.checks.souffrance.total, 0);
});

test("sans bureau, --reap ne crée rien non plus : il n'y a rien à moissonner", (t) => {
  const racine = scratch(t);
  const bureau = path.join(racine, "office");
  const avant = arbre(racine);

  const rapport = lancerLeMedecin(racine, bureau, ["--reap"]);

  assert.equal(rapport.checks.dbExists, false);
  assert.equal(rapport.ok, false);
  assert.equal(rapport.checks.moisson.mode, "moisson", "le geste demandé reste dit");
  assert.equal(rapport.checks.moisson.reaped, 0);
  assert.deepEqual(arbre(racine), avant);
});

test("un bureau qui n'a que sa base : le médecin la lit sans créer run/, status/, logs/ ni exports/", (t) => {
  const racine = scratch(t);
  const bureau = path.join(racine, "office");
  fs.mkdirSync(bureau);
  const db = openDatabase({ file: path.join(bureau, "broker.db") });
  insertMessage(db, { msg_id: "L-1", sender: "a", recipient: "b", body: "x" });
  db.close();
  // `openDatabase` pose ses dossiers sous le plancher du processus, pas sous `bureau` :
  // ce bureau-ci ne contient que sa base, comme un bureau dont on a rangé les dossiers vides.
  assert.deepEqual(arbre(bureau).filter((chemin) => !SIDECARS.includes(chemin)), ["broker.db"], "SONDE : le décor n'a que la base");
  const avant = arbre(bureau);
  const octets = empreinte(path.join(bureau, "broker.db"));

  const rapport = lancerLeMedecin(racine, bureau);

  assert.equal(rapport.checks.dbExists, true);
  assert.equal(rapport.checks.lettres["en attente"], 1, "la base est bien lue");
  const apres = arbre(bureau).filter((chemin) => !SIDECARS.includes(chemin));
  assert.deepEqual(apres, avant, "aucun dossier, aucun fichier ne naît (hors les deux compagnons WAL d'un lecteur)");
  assert.equal(empreinte(path.join(bureau, "broker.db")), octets, "la base est identique à l'octet");
});

test("sans --reap, rien ne bouge dans la base : la chaise morte est comptée, pas marquée", (t) => {
  const racine = scratch(t);
  const bureau = path.join(racine, "office");
  fs.mkdirSync(bureau);
  const db = openDatabase({ file: path.join(bureau, "broker.db") });
  const fini = spawnSync(process.execPath, ["-e", ""]);
  registerInstance(db, { lineage: "alice", sessionId: "s-morte", pid: Number(fini.pid) });
  const avant = {
    pairs: db.prepare("SELECT id, status, dead_at FROM peers ORDER BY id").all(),
    evenements: db.prepare("SELECT COUNT(*) AS n FROM delivery_events").get().n
  };
  db.close();

  const rapport = lancerLeMedecin(racine, bureau);

  assert.equal(rapport.checks.moisson.mode, "rapport");
  assert.equal(rapport.checks.moisson.reaped, 1, "la candidate se compte");
  const relu = new Database(path.join(bureau, "broker.db"), { readonly: true });
  t.after(() => relu.close());
  assert.deepEqual(relu.prepare("SELECT id, status, dead_at FROM peers ORDER BY id").all(), avant.pairs);
  assert.equal(relu.prepare("SELECT COUNT(*) AS n FROM delivery_events").get().n, avant.evenements);
});

test("un bureau d'une version plus ancienne : le médecin le DIT, ne plante pas et ne le migre pas", (t) => {
  const racine = scratch(t);
  const bureau = path.join(racine, "office");
  fs.mkdirSync(bureau);
  // Le schéma d'origine, sans aucune des colonnes ajoutées depuis : celui que pose un
  // moniteur qui démarre avant tout processus Node, ou un bureau copié d'une version ancienne.
  const ancien = new Database(path.join(bureau, "broker.db"));
  initSchema(ancien);
  ancien.prepare("INSERT INTO messages (msg_id, sender, recipient, body) VALUES ('vieux-1', 'a', 'b', 'x')").run();
  assert.equal(schemaVersion(ancien), 0, "SONDE : le décor est bien un bureau d'avant les migrations");
  ancien.close();
  const octets = empreinte(path.join(bureau, "broker.db"));

  const rapport = lancerLeMedecin(racine, bureau);

  assert.equal(rapport.checks.dbExists, true);
  assert.deepEqual(rapport.checks.schemaBehind.version, 0);
  assert.equal(rapport.checks.schemaBehind.expected, SCHEMA_VERSION);
  assert.match(rapport.checks.schemaBehind.remede, /migrat/i, "le remède est dit");
  assert.equal(rapport.ok, false, "une sonde qui n'a pas pu compter n'est jamais un pass");
  const relu = new Database(path.join(bureau, "broker.db"), { readonly: true });
  t.after(() => relu.close());
  assert.equal(schemaVersion(relu), 0, "le médecin n'a rien migré");
  assert.equal(empreinte(path.join(bureau, "broker.db")), octets, "la base est identique à l'octet");
});

test("--reap ouvre en écriture : un bureau ancien est migré et la moisson se joue", (t) => {
  const racine = scratch(t);
  const bureau = path.join(racine, "office");
  fs.mkdirSync(bureau);
  const ancien = new Database(path.join(bureau, "broker.db"));
  initSchema(ancien);
  ancien.close();

  const rapport = lancerLeMedecin(racine, bureau, ["--reap"]);

  assert.equal(rapport.checks.moisson.mode, "moisson");
  assert.equal(rapport.checks.schemaBehind, undefined, "un geste d'écriture explicite migre : plus de retard");
  const relu = new Database(path.join(bureau, "broker.db"), { readonly: true });
  t.after(() => relu.close());
  assert.equal(schemaVersion(relu), SCHEMA_VERSION);
});

// ── LES CHAISES CODEX (1.1.0, Tâche 11) ─────────────────────────────────────
// La section `codex` du médecin : `codex --version` et RIEN d'autre, chaque
// fiche `<bureau>/codex/<lignée>.json` avec son pid, sa carte, la socket du
// démon partagé — et toujours sans écrire. Un faux `codex` sur un PATH
// jetable journalise ses arguments ; le vrai n'est jamais lancé ici.
function fauxCodex(racine, { code = 0 } = {}) {
  const bin = path.join(racine, `bin-codex-${code}`);
  fs.mkdirSync(bin, { recursive: true });
  const journal = path.join(racine, "codex.journal");
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!/bin/sh\nprintf '%s|%s\\n' "$*" "$CODEX_HOME" >> ${JSON.stringify(journal)}\necho "codex-cli 0.163.0"\nexit ${code}\n`,
    { mode: 0o755 }
  );
  return { bin, journal };
}

const HEURE = 60 * 60 * 1000;
const ilYA = (ms) => new Date(Date.now() - ms).toISOString();

// Le bureau du test DEVIENT celui du processus le temps du test :
// `ecrireFicheCodex` écrit ses fiches sous `runtimePaths().root`, jamais sous un
// `file` qu'on lui passerait. Le plancher revient à la fin.
function bureauAvecFiches(t, racine) {
  const bureau = path.join(racine, "office");
  fs.mkdirSync(bureau);
  const plancher = process.env.CC2CC_V2_HOME;
  poserLeBureau(bureau);
  t.after(() => poserLeBureau(plancher));
  return { bureau, db: openDatabase({ file: path.join(bureau, "broker.db") }) };
}

test("section codex : `codex --version` seul, chaque fiche avec son pid, sa carte, son lien et la socket du démon — et le médecin n'écrit rien", (t) => {
  const racine = scratch(t);
  const { bureau, db } = bureauAvecFiches(t, racine);
  const codexHome = path.join(racine, "codex-home");
  fs.mkdirSync(path.join(codexHome, "app-server-control"), { recursive: true });
  // Seule la présence se lit (lstat) : un fichier vide tient lieu du lien que pose le démon.
  fs.writeFileSync(path.join(codexHome, "app-server-control", "app-server-control.sock"), "");
  const mort = Number(spawnSync(process.execPath, ["-e", ""]).pid);
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, porte: "app" });
  ecrireFicheCodex(db, { lineage: "bob", thread_id: "thread-2", codex_home: path.join(racine, "autre-codex"), pid: mort });
  db.close();
  const { bin, journal } = fauxCodex(racine);
  const avant = arbre(bureau).filter((chemin) => !SIDECARS.includes(chemin));
  const octets = empreinte(path.join(bureau, "broker.db"));
  const fiche = empreinte(path.join(bureau, "codex", "hal-test.json"));

  const rapport = lancerLeMedecin(racine, bureau, [], { PATH: bin });

  const { codex } = rapport.checks;
  assert.equal(codex.version, "codex-cli 0.163.0");
  assert.equal(
    fs.readFileSync(journal, "utf8"),
    "--version|/dev/null/valxos-doctor\n",
    "le médecin ne lance codex qu'avec --version, une fois, et dans une maison qui ne peut pas exister (codex --version écrit dans la sienne)"
  );
  assert.equal(codex.count, 2);
  assert.deepEqual(
    codex.fiches.map((f) => [f.lineage, f.thread_id, f.porte, f.pid_vivant, f.dead_at, f.statut_carte, f.lien]),
    [
      ["bob", "thread-2", "cli", false, null, "active", "codex://threads/thread-2"],
      ["hal-test", "thread-1", "app", true, null, "active", "codex://threads/thread-1"]
    ]
  );
  assert.deepEqual(codex.fiches.map((f) => f.demon_socket.present), [false, true]);
  assert.ok(codex.fiches.every((f) => typeof f.last_seen === "string"));
  assert.equal(codex.moisson.mode, "rapport");
  assert.deepEqual(codex.moisson.reaped, [], "bob vient d'être vu : il attend ses 24 h");
  assert.equal(codex.remede, undefined);
  assert.deepEqual(arbre(bureau).filter((chemin) => !SIDECARS.includes(chemin)), avant, "aucun fichier ne naît");
  assert.equal(empreinte(path.join(bureau, "broker.db")), octets, "la base est identique à l'octet");
  assert.equal(empreinte(path.join(bureau, "codex", "hal-test.json")), fiche, "la fiche aussi");
});

test("section codex sans `codex` sur le PATH : « absent » ; un `codex` qui échoue : « unavailable » — sans bureau, rien n'est créé", (t) => {
  const racine = scratch(t);
  const bureau = path.join(racine, "office");
  const vide = path.join(racine, "bin-vide");
  fs.mkdirSync(vide);
  const absent = lancerLeMedecin(racine, bureau, [], { PATH: vide });
  assert.equal(absent.checks.codex.version, "absent");
  assert.equal(absent.checks.codex.count, 0);
  assert.deepEqual(absent.checks.codex.fiches, []);
  assert.equal(fs.existsSync(bureau), false, "le médecin ne crée toujours pas le bureau");
  const { bin } = fauxCodex(racine, { code: 1 });
  assert.equal(lancerLeMedecin(racine, bureau, [], { PATH: bin }).checks.codex.version, "unavailable");
});

test("section codex sur un bureau d'une version plus ancienne : les fiches se lisent, la carte se tait, la moisson ne se joue pas — jamais une pile", (t) => {
  const racine = scratch(t);
  const bureau = path.join(racine, "office");
  fs.mkdirSync(path.join(bureau, "codex"), { recursive: true, mode: 0o700 });
  const ancien = new Database(path.join(bureau, "broker.db"));
  initSchema(ancien);
  ancien.close();
  // La fiche d'une chaise Codex, posée à la main : un bureau ancien n'a pas la colonne `lineage`,
  // et ecrireFicheCodex n'y écrirait pas sa carte.
  fs.writeFileSync(path.join(bureau, "codex", "hal-test.json"), `${JSON.stringify({
    lineage: "hal-test", thread_id: "thread-1", codex_home: path.join(racine, "codex-home"), pid: 2_000_000_000,
    proc_start: null, porte: "app", cwd: null, started_at: ilYA(48 * HEURE), last_seen: ilYA(48 * HEURE), dead_at: null
  })}\n`, { mode: 0o600 });
  const octets = empreinte(path.join(bureau, "broker.db"));
  const { bin } = fauxCodex(racine);

  const rapport = lancerLeMedecin(racine, bureau, [], { PATH: bin });

  assert.ok(rapport.checks.schemaBehind, "SONDE : le décor est bien un bureau ancien");
  const { codex } = rapport.checks;
  assert.deepEqual(codex.fiches.map((f) => [f.lineage, f.statut_carte, f.pid_vivant]), [["hal-test", null, false]]);
  assert.deepEqual([codex.moisson.mode, codex.moisson.checked, codex.moisson.reaped], ["rapport", 0, []], "aucune moisson sur un bureau qu'on n'a pas pu lire");
  assert.equal(codex.erreur, undefined);
  assert.equal(empreinte(path.join(bureau, "broker.db")), octets, "la base est identique à l'octet");
  assert.equal(JSON.parse(fs.readFileSync(path.join(bureau, "codex", "hal-test.json"), "utf8")).dead_at, null);
});

test("--reap : une fiche Codex au processus parti et muette depuis plus de 24 h est marquée dead_at, fichier ET carte, et le fichier reste ; la moisson des chaises ne la devance pas", (t) => {
  const racine = scratch(t);
  const { bureau, db } = bureauAvecFiches(t, racine);
  const codexHome = path.join(racine, "codex-home");
  const mort = Number(spawnSync(process.execPath, ["-e", ""]).pid);
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: mort, now: ilYA(25 * HEURE) });
  ecrireFicheCodex(db, { lineage: "bob", thread_id: "thread-2", codex_home: codexHome, pid: mort, now: ilYA(HEURE) });
  ecrireFicheCodex(db, { lineage: "carol", thread_id: "thread-3", codex_home: codexHome, pid: process.pid, now: ilYA(25 * HEURE) });
  registerInstance(db, { lineage: "alice", sessionId: "s-morte", pid: mort });
  db.close();
  const { bin } = fauxCodex(racine);
  const fichier = (nom) => path.join(bureau, "codex", `${nom}.json`);
  const lireFiche = (nom) => JSON.parse(fs.readFileSync(fichier(nom), "utf8"));

  // Sans --reap : la candidate se compte, le remède se nomme, rien ne bouge.
  const octets = empreinte(path.join(bureau, "broker.db"));
  const seul = lancerLeMedecin(racine, bureau, [], { PATH: bin });
  assert.equal(seul.checks.codex.moisson.mode, "rapport");
  assert.deepEqual(seul.checks.codex.moisson.reaped.map((r) => r.lineage), ["hal-test"], "seule la muette de plus de 24 h au pid parti");
  assert.equal(seul.checks.codex.remede, "valxos-doctor --reap");
  assert.deepEqual(seul.checks.moisson.reaped, 1, "la moisson des chaises ne compte que la chaise Claude morte");
  assert.equal(lireFiche("hal-test").dead_at, null);
  assert.equal(empreinte(path.join(bureau, "broker.db")), octets);

  // Avec --reap : marquée, jamais effacée.
  const moisson = lancerLeMedecin(racine, bureau, ["--reap"], { PATH: bin });
  assert.equal(moisson.checks.codex.moisson.mode, "moisson");
  assert.deepEqual(moisson.checks.codex.moisson.reaped.map((r) => r.lineage), ["hal-test"]);
  const hal = lireFiche("hal-test");
  assert.match(String(hal.dead_at), /^\d{4}-\d{2}-\d{2}T/, "la fiche porte son constat de mort");
  assert.equal(hal.thread_id, "thread-1", "le reste de la fiche est intact");
  assert.equal(lireFiche("bob").dead_at, null, "vue il y a une heure : elle attend ses 24 h");
  assert.equal(lireFiche("carol").dead_at, null, "son processus vit : elle reste");
  const vue = moisson.checks.codex.fiches.find((f) => f.lineage === "hal-test");
  assert.deepEqual([vue.dead_at, vue.statut_carte], [hal.dead_at, "dead"]);
  assert.equal(moisson.checks.codex.remede, undefined, "après la moisson, plus de remède à nommer");
  const relu = new Database(path.join(bureau, "broker.db"), { readonly: true });
  t.after(() => relu.close());
  const carte = (id) => relu.prepare("SELECT status, dead_at FROM peers WHERE id = ?").get(id);
  assert.deepEqual(carte("hal-test"), { status: "dead", dead_at: hal.dead_at });
  assert.deepEqual(carte("bob"), { status: "active", dead_at: null }, "la moisson des chaises ne devance pas les 24 h d'une chaise Codex");
  assert.equal(carte("alice#s-morte").status, "dead", "la moisson des chaises a bien tourné");
  const traces = relu.prepare("SELECT detail_json FROM delivery_events WHERE event_type = 'peer_reaped' AND agent_id = 'hal-test'").all();
  assert.equal(traces.length, 1);
  assert.equal(JSON.parse(traces[0].detail_json).raison, "codex-parti-24h");
  assert.deepEqual(fs.readdirSync(path.join(bureau, "codex")).sort(), ["bob.json", "carol.json", "hal-test.json"], "aucun fichier effacé (Camp B), aucun temporaire laissé");

  // Rejouée, la moisson ne marque rien deux fois.
  const encore = lancerLeMedecin(racine, bureau, ["--reap"], { PATH: bin });
  assert.deepEqual(encore.checks.codex.moisson.reaped, []);
  assert.equal(relu.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE event_type = 'peer_reaped' AND agent_id = 'hal-test'").get().n, 1);
});

test("round 1 — un pid vivant mais RECYCLÉ (une autre naissance que celle de la fiche) : le médecin dit pid_vivant:false, et la fiche muette depuis 24 h est candidate", (t) => {
  const racine = scratch(t);
  const { bureau, db } = bureauAvecFiches(t, racine);
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: path.join(racine, "codex-home"), pid: process.pid, now: ilYA(25 * HEURE) });
  db.close();
  const fichier = path.join(bureau, "codex", "hal-test.json");
  // Le pid de ce test vit ; la fiche, elle, dit une naissance qui n'est pas la sienne.
  fs.writeFileSync(fichier, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(fichier, "utf8")), proc_start: "Thu Jan  1 00:00:00 1970" })}\n`, { mode: 0o600 });
  const { bin } = fauxCodex(racine);

  const rapport = lancerLeMedecin(racine, bureau, [], { PATH: bin });

  const vue = rapport.checks.codex.fiches.find((f) => f.lineage === "hal-test");
  assert.equal(vue.pid_vivant, false, "le numéro vit, mais ce n'est plus la chaise");
  assert.deepEqual(rapport.checks.codex.moisson.reaped.map((r) => [r.lineage, r.processus]), [["hal-test", "pid-recycle"]]);
});
