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

function lancerLeMedecin(racine, bureau, drapeaux = []) {
  const sortie = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-doctor.js"), ...drapeaux], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: bureau, HOME: path.join(racine, "home") }
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
