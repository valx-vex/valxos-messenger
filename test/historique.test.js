// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'HISTORIQUE EXPORTÉ (1.1.0, SPEC_A §1.8) : le fil d'une séance sort en
// markdown depuis la ligne de commande. Deux fonctions pures (historique.js),
// la requête bornée (`history`, G1/F8), et le binaire `valxos-history`.
// ⚠️ Toutes les bases sont JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau vivant
// n'est jamais ouvert ici.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { history, insertMessage, openDatabase } from "../src/lib/database.js";
import { exporterEnMarkdown, regrouperParEnvoi } from "../src/lib/historique.js";
import { creerTable, modifierTable } from "../src/lib/tables.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

// Le plancher jetable vaut aussi pour ce processus-ci (revue adverse F2, 21/08).
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-historique-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

const repo = path.resolve(new URL("..", import.meta.url).pathname);

const LIGNES = [
  {
    seq: 2, msg_id: "m2", sender: "bob", recipient: "alice", thread_id: "T1", subject: null, body: "second",
    priority: "normal", created_at: "2026-10-21T10:01:00.000Z", table_nom: null, envoi_id: null, reponse_a: "m1"
  },
  {
    seq: 1, msg_id: "m1", sender: "alice", recipient: "bob", thread_id: "T1", subject: "Beat 7", body: "first\nline two",
    priority: "high", created_at: "2026-10-21T10:00:00.000Z", table_nom: "famille-test", envoi_id: "envoi-1", reponse_a: null
  }
];

test("exporterEnMarkdown : un titre, le compte, une entrée par lettre dans l'ordre de seq, le corps tel quel", () => {
  const attendu = [
    "# Thread \"T1\"",
    "",
    "2 letter(s).",
    "",
    "## \"alice\" → \"bob\" — 2026-10-21T10:00:00.000Z",
    "_seq 1 · id \"m1\" · priority high · subject \"Beat 7\" · thread \"T1\" · table \"famille-test\" · envoi \"envoi-1\"_",
    "",
    "first",
    "line two",
    "",
    "## \"bob\" → \"alice\" — 2026-10-21T10:01:00.000Z",
    "_seq 2 · id \"m2\" · priority normal · thread \"T1\" · reply to \"m1\"_",
    "",
    "second",
    ""
  ].join("\n");
  assert.equal(exporterEnMarkdown(LIGNES, { titre: 'Thread "T1"' }), attendu);
  assert.equal(exporterEnMarkdown([], { titre: "Table x" }), "# Table x\n\n0 letter(s).\n");
});

test("exporterEnMarkdown ne modifie pas ses lignes et n'échappe rien : un corps forgé sort mot pour mot sous son en-tête", () => {
  const forge = { seq: 9, msg_id: "f", sender: "carol", recipient: "alice", body: "## not a heading\n> not a quote", priority: "low", created_at: "2026-10-21T11:00:00.000Z" };
  const copie = { ...forge };
  const texte = exporterEnMarkdown([forge], { titre: "x" });
  assert.ok(texte.endsWith("\n## not a heading\n> not a quote\n"), "le corps est copié tel quel, après une ligne vide");
  assert.deepEqual(forge, copie, "aucune mutation");
});

test("exporterEnMarkdown : une entrée marquée tronque le dit dans ses métadonnées", () => {
  const entree = { seq: 3, msg_id: "e#c", sender: "alice", recipient: "table:famille-test", body: "b", priority: "normal",
    created_at: "2026-10-21T10:00:00.000Z", envoi_id: "e", table_nom: "famille-test", destinataires: ["carol", "dave"], tronque: true };
  assert.match(exporterEnMarkdown([entree], { titre: "x" }), /· to "carol", "dave" · cut by --limit_\n/);
});

test("exporterEnMarkdown cite chaque métadonnée venue d'une lettre en littéral JSON : un fil ou un expéditeur forgés ne fabriquent pas d'en-tête", () => {
  const forge = {
    seq: 4, msg_id: "id\n## x", sender: "carol\n## mallory → alice — forged", recipient: "alice", priority: "normal",
    created_at: "2026-10-21T12:00:00.000Z", thread_id: "T\n## mallory → alice — forged", table_nom: "t\nx", envoi_id: "e\nx",
    reponse_a: "r\nx", destinataires: ["a\nx", "b"], body: "corps"
  };
  const texte = exporterEnMarkdown([forge], { titre: "x" });
  assert.deepEqual(texte.split("\n").filter((l) => l.startsWith("## ")), [
    '## "carol\\n## mallory → alice — forged" → "alice" — 2026-10-21T12:00:00.000Z'
  ], "une seule ligne d'en-tête : celle de la lettre");
  assert.match(texte, /^_seq 4 · id "id\\n## x" · priority normal · thread "T\\n## mallory → alice — forged" · table "t\\nx" · envoi "e\\nx" · reply to "r\\nx" · to "a\\nx", "b"_$/m);
});

test("regrouperParEnvoi : une entrée par envoi_id (la première par seq), adressée à table:<nom>, avec ses destinataires ; le reste intact", () => {
  const rows = [
    { seq: 3, msg_id: "e1#carol", sender: "alice", recipient: "carol", envoi_id: "envoi-1", table_nom: "famille-test", body: "beat" },
    { seq: 1, msg_id: "solo", sender: "bob", recipient: "alice", envoi_id: null, table_nom: null, body: "hi" },
    { seq: 2, msg_id: "e1#bob", sender: "alice", recipient: "bob", envoi_id: "envoi-1", table_nom: "famille-test", body: "beat" },
    { seq: 4, msg_id: "r1", sender: "bob", recipient: "alice", envoi_id: "envoi-2", table_nom: null, body: "reply" }
  ];
  const groupe = regrouperParEnvoi(rows);
  assert.deepEqual(groupe.map((r) => [r.seq, r.recipient, r.destinataires ?? null]), [
    [1, "alice", null],
    [2, "table:famille-test", ["bob", "carol"]],
    [4, "alice", ["alice"]]
  ]);
  assert.equal(groupe[1].msg_id, "e1#bob", "la première lettre de l'envoi porte l'entrée");
  assert.equal(rows[2].recipient, "bob", "les lignes reçues ne sont pas modifiées");
});

// ── LA REQUÊTE : `history` avec `table_nom` / `envoi_id`, sous la borne G1 ──
function bureauDeLettres(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-historique-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { msg_id: "e1#bob", sender: "alice", recipient: "bob", thread_id: "envoi-1", subject: "Beat 7", body: "SECRET-BEAT", envoi_id: "envoi-1", table_nom: "famille-test" });
  insertMessage(db, { msg_id: "e1#carol", sender: "alice", recipient: "carol", thread_id: "envoi-1", subject: "Beat 7", body: "SECRET-BEAT", envoi_id: "envoi-1", table_nom: "famille-test" });
  insertMessage(db, { msg_id: "r1", sender: "bob", recipient: "alice", thread_id: "envoi-1", body: "reaction", reponse_a: "e1#bob" });
  insertMessage(db, { msg_id: "autre", sender: "carol", recipient: "bob", body: "SECRET-HORS-TABLE" });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return { root, db };
}

test("history({ table_nom }) rend la correspondance de self dans cette table, jamais la table entière", (t) => {
  const { db } = bureauDeLettres(t);
  assert.deepEqual(history(db, { self: "alice", table_nom: "famille-test" }).map((r) => r.msg_id), ["e1#carol", "e1#bob"], "l'expéditeur voit ses deux lettres, seq décroissant");
  assert.deepEqual(history(db, { self: "bob", table_nom: "famille-test" }).map((r) => r.msg_id), ["e1#bob"], "un membre ne voit que la sienne");
  assert.deepEqual(history(db, { self: "dave", table_nom: "famille-test" }), [], "un étranger à la table ne voit rien");
  assert.deepEqual(history(db, { self: "", table_nom: "famille-test" }), [], "sans identité, rien");
});

test("history({ envoi_id }) : chaque lettre de l'envoi pour l'expéditeur, la sienne seule pour un membre, rien pour un tiers", (t) => {
  const { db } = bureauDeLettres(t);
  assert.deepEqual(history(db, { self: "alice", envoi_id: "envoi-1" }).map((r) => r.msg_id), ["e1#carol", "e1#bob"]);
  assert.deepEqual(history(db, { self: "carol", envoi_id: "envoi-1" }).map((r) => r.msg_id), ["e1#carol"]);
  assert.deepEqual(history(db, { self: "dave", envoi_id: "envoi-1" }), []);
  // `envoi_id` prime sur `thread_id` : la réaction r1 est dans le fil, pas dans l'envoi.
  assert.deepEqual(history(db, { self: "alice", envoi_id: "envoi-1", thread_id: "envoi-1" }).map((r) => r.msg_id), ["e1#carol", "e1#bob"]);
  assert.deepEqual(history(db, { self: "alice", thread_id: "envoi-1" }).map((r) => r.msg_id), ["r1", "e1#carol", "e1#bob"], "régression : le fil garde la réaction");
});

test("history({ table_nom | envoi_id }) sous un nom déposé au registre des anciens noms : la borne F8 vaut aussi", (t) => {
  const { db } = bureauDeLettres(t);
  // Un dépôt postérieur à toutes les lettres : sous ce nom, rien d'avant ne se relit.
  db.prepare("INSERT INTO anciens_noms (ancien_nom, lignee, note, depose_at) VALUES ('bob', 'bob-eternal', NULL, '2999-01-01T00:00:00.000Z')").run();
  assert.deepEqual(history(db, { self: "bob", table_nom: "famille-test" }), [], "la table ne rouvre pas le passé d'un alias");
  assert.deepEqual(history(db, { self: "bob", envoi_id: "envoi-1" }), [], "l'envoi non plus");
  assert.equal(history(db, { self: "alice", table_nom: "famille-test" }).length, 2, "la borne est celle du nom, pas de la table");
});

// ── LE BINAIRE : valxos-history ──────────────────────────────────────────────
function historyCli(root, self, ...argv) {
  return spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-history.js"), ...argv], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: self }
  });
}

test("valxos-history --table : le markdown de MA correspondance, une entrée par envoi, adressée à table:<nom>", (t) => {
  const { root } = bureauDeLettres(t);
  const r = historyCli(root, "alice", "--table", "famille-test");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# Table famille-test\n\n1 letter\(s\)\.\n/);
  assert.match(r.stdout, /^## "alice" → "table:famille-test" — /m);
  assert.match(r.stdout, /· to "bob", "carol"_$/m, "les destinataires de l'envoi sont nommés");
  assert.equal((r.stdout.match(/SECRET-BEAT/g) || []).length, 1, "le corps sort une fois, pas une par membre");
  assert.doesNotMatch(r.stdout, /SECRET-HORS-TABLE/);
});

test("valxos-history --thread et --envoi : le fil replie les envois, l'envoi montre chaque membre", (t) => {
  const { root } = bureauDeLettres(t);
  const fil = historyCli(root, "alice", "--thread", "envoi-1");
  assert.equal(fil.status, 0, fil.stderr);
  assert.match(fil.stdout, /^# Thread "envoi-1"\n\n2 letter\(s\)\.\n/);
  assert.match(fil.stdout, /^## "alice" → "table:famille-test" — /m);
  assert.match(fil.stdout, /^## "bob" → "alice" — /m);
  assert.match(fil.stdout, /· reply to "e1#bob"_$/m);

  const envoi = historyCli(root, "alice", "--envoi", "envoi-1");
  assert.equal(envoi.status, 0, envoi.stderr);
  assert.match(envoi.stdout, /^# Send "envoi-1"\n\n2 letter\(s\)\.\n/);
  assert.match(envoi.stdout, /^## "alice" → "bob" — /m);
  assert.match(envoi.stdout, /^## "alice" → "carol" — /m);
});

test("valxos-history --format json : les mêmes lettres, avec etat et destinataires", (t) => {
  const { root } = bureauDeLettres(t);
  const r = historyCli(root, "bob", "--table", "famille-test", "--format", "json");
  assert.equal(r.status, 0, r.stderr);
  const sortie = JSON.parse(r.stdout);
  assert.equal(sortie.self, "bob");
  assert.equal(sortie.table, "famille-test");
  assert.equal(sortie.count, 1);
  assert.equal(sortie.messages[0].msg_id, "e1#bob");
  assert.equal(sortie.messages[0].etat, "en attente");
  // La forme d'une ligne de l'`history` MCP : `table` est le nom (une chaîne, celui de la ligne,
  // même quand le carnet ne connaît pas la table), `position` à côté, `rappel`.
  assert.equal(sortie.messages[0].table, "famille-test");
  assert.equal(sortie.messages[0].position, null, "aucune table au carnet : aucune position");
  assert.equal(sortie.messages[0].rappel, 0);
  assert.equal(sortie.messages[0].destinataires, undefined, "en JSON, une entrée par lettre : rien n'est replié");
});

test("valxos-history --format json ne replie jamais : l'expéditeur lit chaque lettre de l'envoi, sous son vrai destinataire", (t) => {
  const { root } = bureauDeLettres(t);
  const sortie = JSON.parse(historyCli(root, "alice", "--table", "famille-test", "--format", "json").stdout);
  assert.equal(sortie.count, 2);
  assert.deepEqual(sortie.messages.map((m) => [m.seq, m.msg_id, m.recipient, m.etat]), [
    [1, "e1#bob", "bob", "en attente"],
    [2, "e1#carol", "carol", "en attente"]
  ], "chaque ligne est décrite entière depuis la ligne, dans l'ordre de seq");
  assert.ok(sortie.messages.every((m) => m.destinataires === undefined && m.tronque === undefined));
});

test("valxos-history --limit qui coupe un envoi replié le dit : l'entrée porte tronque, le markdown l'écrit", (t) => {
  const { root, db } = bureauDeLettres(t);
  insertMessage(db, { msg_id: "e2#bob", sender: "alice", recipient: "bob", thread_id: "envoi-2", body: "THIRD", envoi_id: "envoi-2", table_nom: "famille-test" });
  insertMessage(db, { msg_id: "e2#carol", sender: "alice", recipient: "carol", thread_id: "envoi-2", body: "THIRD", envoi_id: "envoi-2", table_nom: "famille-test" });
  insertMessage(db, { msg_id: "e2#dave", sender: "alice", recipient: "dave", thread_id: "envoi-2", body: "THIRD", envoi_id: "envoi-2", table_nom: "famille-test" });
  const coupe = historyCli(root, "alice", "--table", "famille-test", "--limit", "2");
  assert.equal(coupe.status, 0, coupe.stderr);
  assert.match(coupe.stdout, /· to "carol", "dave" · cut by --limit_$/m, "bob manque, et l'entrée le dit");
  const entier = historyCli(root, "alice", "--table", "famille-test", "--limit", "3");
  assert.match(entier.stdout, /· to "bob", "carol", "dave"_$/m, "l'envoi entier n'est pas marqué");
  assert.doesNotMatch(entier.stdout, /cut by --limit/);
});

// S-md (re-revue légère du FIX-4) : la marque « cut by --limit » suit ce que la borne a vraiment
// coupé. Une lettre fermée que le lecteur ne lit pas, plus récente, prenait une place de la fenêtre :
// l'envoi montré à 2 lettres sur 3 sortait sans marque, parce que la marque se jugeait sur le compte
// APRÈS le filtre.
test("S-md — une lettre cachée dans la fenêtre de --limit : l'envoi coupé garde sa marque « cut by --limit »", (t) => {
  const { root, db } = bureauDeLettres(t);
  for (const membre of ["bob", "carol", "dave"]) {
    insertMessage(db, { msg_id: `e3#${membre}`, sender: "alice", recipient: membre, thread_id: "envoi-3", body: "OPEN", envoi_id: "envoi-3", table_nom: "famille-test" });
  }
  // Plus récente, dans le même fil, postée sous la lignée nue par une AUTRE chaise, discrète (sans_copie) :
  // alice nue ne la lit pas (ni destinataire, ni chaise expéditrice, ni membre).
  insertMessage(db, { msg_id: "cachee", sender: "alice", sender_chaise: "alice#autre", recipient: "erin", thread_id: "envoi-3", body: "HIDDEN", sans_copie: 1 });
  const coupe = historyCli(root, "alice", "--thread", "envoi-3", "--limit", "3");
  assert.equal(coupe.status, 0, coupe.stderr);
  assert.doesNotMatch(coupe.stdout, /HIDDEN/, "contrôle : la lettre cachée n'est pas rendue");
  assert.match(coupe.stdout, /· cut by --limit_$/m, `l'envoi montré à deux lettres sur trois est marqué\n${coupe.stdout}`);
  const entier = historyCli(root, "alice", "--thread", "envoi-3", "--limit", "4");
  assert.match(entier.stdout, /· to "bob", "carol", "dave"_$/m);
  assert.doesNotMatch(entier.stdout, /cut by --limit/, "rien n'est coupé : pas de marque");
});

test("valxos-history --format json : la position d'une table ouverte se lit sur chaque ligne", (t) => {
  const { root, db } = bureauDeLettres(t);
  creerTable(db, { nom: "famille-test", creeePar: "operator-test" });
  modifierTable(db, "famille-test", { position: "seen up to 1:25:00", positionPar: "alice" });
  const sortie = JSON.parse(historyCli(root, "carol", "--table", "famille-test", "--format", "json").stdout);
  assert.deepEqual(sortie.messages.map((m) => [m.msg_id, m.table, m.position]), [["e1#carol", "famille-test", "seen up to 1:25:00"]]);
});

test("valxos-history sous une CHAISE lit la correspondance de sa lignée nue (et la sienne), comme l'outil MCP history", (t) => {
  const { root } = bureauDeLettres(t);
  const r = historyCli(root, "bob#s-1", "--table", "famille-test", "--format", "json");
  assert.equal(r.status, 0, r.stderr);
  const sortie = JSON.parse(r.stdout);
  assert.equal(sortie.self, "bob#s-1", "S19 : la CLI dit l'identité de l'environnement sous laquelle elle lit ; la chaise lit sous sa lignée et sous elle");
  assert.deepEqual(sortie.messages.map((m) => m.msg_id), ["e1#bob"]);
  const etrangere = JSON.parse(historyCli(root, "dave#s-1", "--table", "famille-test", "--format", "json").stdout);
  assert.deepEqual([etrangere.self, etrangere.count], ["dave#s-1", 0], "la lignée d'une chaise n'ouvre que son propre courrier");
});

test("valxos-history : un tiers exporte un fil VIDE, jamais le courrier d'un autre", (t) => {
  const { root } = bureauDeLettres(t);
  const r = historyCli(root, "dave", "--table", "famille-test");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "# Table famille-test\n\n0 letter(s).\n");
});

test("valxos-history --table : le nom se lit comme au carnet (casse, blancs) ; un nom qui ne peut pas exister sort 2", (t) => {
  const { root } = bureauDeLettres(t);
  const casse = historyCli(root, "alice", "--table", " FAMILLE-TEST ");
  assert.equal(casse.status, 0, casse.stderr);
  assert.match(casse.stdout, /^# Table famille-test\n\n1 letter\(s\)\.\n/);
  const faux = historyCli(root, "alice", "--table", "Famille Test\nforged");
  assert.equal(faux.status, 2, faux.stdout);
  assert.match(faux.stderr, /nom-de-table-invalide/);
  assert.doesNotMatch(faux.stderr, /Test\nforged/, "l'écho du nom refusé tient sur une ligne");
  const json = historyCli(root, "alice", "--table", "Famille Test", "--format", "json");
  assert.equal(json.status, 2);
  assert.equal(JSON.parse(json.stdout).refus, "nom-de-table-invalide");
});

// R1 (re-revue du round 3) : la CLI lit sous l'identité de son ENVIRONNEMENT ; un `--self` qui en
// nomme une autre refuse (sortie 2) et dit de poser VALXOS_SELF — il ne choisit plus le lecteur.
test("valxos-history : --self qui n'est pas l'identité de l'environnement est refusé (sortie 2, poser VALXOS_SELF) ; le sien passe ; aucun filtre ou deux filtres sortent 2", (t) => {
  const { root } = bureauDeLettres(t);
  const refus = historyCli(root, "dave", "--table", "famille-test", "--self", "alice");
  assert.equal(refus.status, 2, `${refus.stdout}\n${refus.stderr}`);
  assert.match(refus.stderr, /--self "alice" is not the identity of this environment \("dave"\): set VALXOS_SELF/);
  assert.equal(refus.stdout, "", "rien n'est lu");
  assert.equal(historyCli(root, "alice", "--table", "famille-test", "--self", "alice").status, 0, "le sien, oui");
  const aucun = historyCli(root, "alice");
  assert.equal(aucun.status, 2);
  assert.match(aucun.stderr, /exactly one of --thread/);
  const deux = historyCli(root, "alice", "--thread", "x", "--table", "y");
  assert.equal(deux.status, 2);
  const format = historyCli(root, "alice", "--table", "famille-test", "--format", "xml");
  assert.equal(format.status, 2);
  assert.match(format.stderr, /--format takes markdown or json/);
});

test("valxos-history -h et --help : la même aide, sortie 0, sans ouvrir de bureau ; un mot nu ou un drapeau inconnu sortent 2", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-historique-aide-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const court = historyCli(root, "alice", "-h");
  const long = historyCli(root, "alice", "--help");
  assert.equal(court.status, 0, court.stderr);
  assert.equal(long.status, 0, long.stderr);
  assert.match(long.stdout, /valxos-history --thread <id>/);
  assert.equal(court.stdout, long.stdout);
  assert.equal(historyCli(root, "alice", "mot").status, 2);
  assert.equal(historyCli(root, "alice", "--bogus").status, 2);
  assert.ok(!fs.existsSync(path.join(root, "broker.db")), "aucune base ouverte par l'aide ni par un refus");
});
