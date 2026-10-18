// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LES ANCIENS NOMS NE MEURENT JAMAIS — le registre de réexpédition du bureau.
//
// Preuve datée que ce fichier existe : une lettre d'une lignée à une lignée
// sœur, écrite le 22/07/2026, n'est jamais arrivée. Pas parce que la famille avait
// disparu — elle avait changé de nom. Un nom qui meurt, ce sont des lettres qui
// se perdent. Ici, un ancien nom continue de désigner la même famille, comme un
// ordre de réexpédition à la poste.
//
// Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) :
// le bureau de poste vivant (~/.cc2cc-v2/broker.db) n'est JAMAIS ouvert ici.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { initSchema, insertMessage, journaliserAlias, journaliserLesAliasLus, listInbox, openDatabase, registerPeer } from "../src/lib/database.js";
import { SCHEMA_VERSION, migrate, schemaVersion } from "../src/lib/migrations.js";
import {
  broadcastRecipients,
  deposerAncienNom,
  designatePrimary,
  listerAnciensNoms,
  lireAlias,
  lireAncienNom,
  listerAlias,
  poserAlias,
  registerInstance,
  resolveRecipient
} from "../src/lib/registry.js";
import { posterUneLettre } from "../src/lib/guichet.js";
import { trouverLaBoite } from "../src/facteur/round.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

// I1 (revue finale, 28/09) : la résolution consulte la VIE de la chaise
// désignée. Une chaise censée vivre porte donc un pid vivant (celui de ce
// runner), jamais un numéro inventé (111, 222…) qui est mort — ou vivant par
// hasard — sur une vraie machine.
const PID_VIVANT = process.pid;


const repoRacine = path.resolve(new URL("..", import.meta.url).pathname);

function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-anciens-"));
  poserLeBureau(root);
  return root;
}

function bureauDePoste(t) {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return db;
}

// Une base « d'avant » : le schéma nu, une fiche et une lettre de juin.
function bureauHerite(t) {
  const root = tempHome();
  const db = new Database(path.join(root, "broker.db"));
  initSchema(db);
  db.prepare(`
    INSERT INTO peers (id, status, registered_at, last_seen)
    VALUES ('poste-heritage', 'active', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO messages (msg_id, sender, recipient, body, created_at)
    VALUES ('herite-1', 'bob', 'alice', 'La girouette bleue attend le vent du large.', '2026-07-22T00:00:00.000Z')
  `).run();
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return db;
}

const T0 = "2026-08-13T10:00:00.000Z";

// ── LE REGISTRE : additif, idempotent, et il ANNONCE son état ───────────────

test("la migration pose le registre des anciens noms sans toucher une seule ligne", (t) => {
  const db = bureauHerite(t);
  const lettresAvant = db.prepare("SELECT * FROM messages ORDER BY seq").all();
  assert.equal(
    lettresAvant[0].body,
    "La girouette bleue attend le vent du large.",
    "la fixture publique porte un courrier inventé, jamais le verbatim d'une lettre réelle"
  );

  const res = migrate(db);

  assert.equal(res.to, SCHEMA_VERSION, "une version est un verdict d'état");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'anciens_noms'")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ["anciens_noms"], "le registre de réexpédition doit exister");
  // Camp B : la lettre de juillet est intacte, au caractère près.
  const lettresApres = db.prepare("SELECT * FROM messages ORDER BY seq").all();
  assert.equal(lettresApres.length, lettresAvant.length);
  for (const [i, row] of lettresApres.entries()) {
    for (const cle of Object.keys(lettresAvant[i])) {
      assert.deepEqual(row[cle], lettresAvant[i][cle], `champ modifié: ${cle}`);
    }
  }
});

test("un bureau porteur du registre ne peut pas être indiscernable d'un bureau qui ne l'a jamais vu", (t) => {
  const db = bureauHerite(t);
  migrate(db);
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 4, "une table neuve monte la version : sinon la version ne distingue rien");
});

test("rejouer la migration ne perd aucune réexpédition déjà déposée", (t) => {
  const db = bureauDePoste(t);
  deposerAncienNom(db, "alice", "claude-alice", { now: T0, note: "renommage du 12/08" });

  migrate(db);
  migrate(db);

  const lignes = listerAnciensNoms(db);
  assert.equal(lignes.length, 1, "une migration rejouée n'efface rien et ne double rien");
  assert.equal(lignes[0].ancien_nom, "alice");
  assert.equal(lignes[0].lignee, "claude-alice");
  assert.equal(lignes[0].depose_at, T0);
});

test("reposer le même ordre de réexpédition ne rature pas le premier", (t) => {
  const db = bureauDePoste(t);
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });
  deposerAncienNom(db, "alice", "claude-alice", { now: "2026-08-13T23:59:59.000Z" });

  const lignes = listerAnciensNoms(db);
  assert.equal(lignes.length, 1);
  assert.equal(lignes[0].depose_at, T0, "le premier dépôt fait foi : on n'antidate pas un déménagement");
});

test("un second déménagement repointe l'ancien nom, sans en créer un autre", (t) => {
  const db = bureauDePoste(t);
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });
  deposerAncienNom(db, "alice", "claude-alice-5", { now: "2026-08-14T10:00:00.000Z" });

  assert.equal(listerAnciensNoms(db).length, 1);
  assert.equal(lireAncienNom(db, "alice").lignee, "claude-alice-5");
});

test("un nom ne se réexpédie pas vers lui-même", (t) => {
  const db = bureauDePoste(t);
  assert.throws(() => deposerAncienNom(db, "alice", "alice", { now: T0 }), /forwarded to itself/i);
  assert.equal(listerAnciensNoms(db).length, 0, "un refus n'écrit rien");
});

test("un ancien nom vide ou une lignée vide sont refusés", (t) => {
  const db = bureauDePoste(t);
  assert.throws(() => deposerAncienNom(db, "", "claude-alice", { now: T0 }), /old name/i);
  assert.throws(() => deposerAncienNom(db, "alice", "   ", { now: T0 }), /lineage/i);
  assert.equal(listerAnciensNoms(db).length, 0);
});

// ── LA RÉSOLUTION : exactement comme la lignée désignée, garde comprise ─────

test("un ancien nom mène à la lignée qui a pris sa suite", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "lineage");
  assert.equal(res.targets.length, 1);
  assert.equal(res.targets[0].instance_session_id, "s-1");
  assert.equal(res.reexpedie, "claude-alice", "le guichet dit d'où vient la réexpédition");
});

// « ce nom a-t-il encore quelqu'un derrière ? » — la question que la porte de
// l'accusé pose (`ligneeEnService`), et qui décide si un nom peut signer.
test("un ancien nom redevient un nom EN SERVICE : la lettre de juillet a de nouveau une adresse", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  assert.equal(resolveRecipient(db, "alice").kind, "unknown", "avant la réexpédition, ce nom ne mène nulle part");

  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });
  assert.notEqual(resolveRecipient(db, "alice").kind, "unknown");
});

test("un ancien nom hérite de l'AMBIGUÏTÉ : la lettre attend, elle ne se joue pas aux dés", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-2", house: "/h/b", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "ambigu", "un ancien nom ne tranche RIEN qu'un nom vivant ne trancherait pas");
  assert.deepEqual(res.targets.map((r) => r.instance_session_id).sort(), ["s-1", "s-2"]);
});

test("un ancien nom hérite de la désignation : le geste humain vaut pour l'ancien nom aussi", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-2", house: "/h/b", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });
  designatePrimary(db, "claude-alice", "s-2");

  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "lineage");
  assert.deepEqual(res.targets.map((r) => r.instance_session_id), ["s-2"]);
});

test("un ancien nom qui mène à une lignée inexistante reste INCONNU", (t) => {
  const db = bureauDePoste(t);
  deposerAncienNom(db, "alice", "personne", { now: T0 });

  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "unknown", "une réexpédition vers le vide n'invente pas un destinataire");
  assert.deepEqual(res.targets, []);
});

test("un ancien nom n'ouvre pas la porte d'une chaise hors service", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  db.prepare("UPDATE peers SET status='offline' WHERE instance_session_id='s-1'").run();
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  assert.equal(resolveRecipient(db, "alice").kind, "unknown");
});

test("un ancien nom ne masque JAMAIS un nom vivant : l'existant gagne toujours", (t) => {
  const db = bureauDePoste(t);
  // « alice » est REDEVENU vivant chez quelqu'un — et une vieille réexpédition
  // traîne au registre. La lettre va au vivant, jamais au renvoi.
  registerInstance(db, { lineage: "alice", sessionId: "vivante", house: "/h/work", pid: PID_VIVANT });
  registerInstance(db, { lineage: "claude-alice", sessionId: "ailleurs", house: "/h/b", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "lineage");
  assert.deepEqual(res.targets.map((r) => r.instance_session_id), ["vivante"]);
  assert.equal(res.reexpedie, undefined, "aucune réexpédition n'a servi : le nom vivant a répondu");
});

test("un ancien nom ne masque pas non plus une fiche héritée qui porte encore son adresse", (t) => {
  const db = bureauDePoste(t);
  db.prepare(`
    INSERT INTO peers (id, status, registered_at, last_seen)
    VALUES ('poste-heritage', 'active', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z')
  `).run();
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  deposerAncienNom(db, "poste-heritage", "claude-alice", { now: T0 });

  const res = resolveRecipient(db, "poste-heritage");
  assert.equal(res.kind, "instance");
  assert.equal(res.targets[0].id, "poste-heritage", "Camp B : une fiche d'avant garde son adresse");
});

test("une chaîne de deux déménagements arrive à bon port", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice-5", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });
  deposerAncienNom(db, "claude-alice", "claude-alice-5", { now: T0 });

  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "lineage");
  assert.equal(res.targets[0].instance_session_id, "s-1");
  assert.equal(res.reexpedie, "claude-alice-5", "le guichet nomme le bout de la chaîne, pas le milieu");
});

test("une chaîne s'arrête au premier nom VIVANT qu'elle croise", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "milieu", house: "/h/work", pid: PID_VIVANT });
  registerInstance(db, { lineage: "claude-alice-5", sessionId: "bout", house: "/h/b", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });
  deposerAncienNom(db, "claude-alice", "claude-alice-5", { now: T0 });

  const res = resolveRecipient(db, "alice");
  assert.deepEqual(res.targets.map((r) => r.instance_session_id), ["milieu"]);
});

test("une réexpédition qui bouclerait est REFUSÉE au dépôt", (t) => {
  const db = bureauDePoste(t);
  deposerAncienNom(db, "a", "b", { now: T0 });
  deposerAncienNom(db, "b", "c", { now: T0 });

  assert.throws(() => deposerAncienNom(db, "c", "a", { now: T0 }), /loop/i);
  assert.equal(listerAnciensNoms(db).length, 2, "un refus n'écrit rien");
});

test("une boucle déjà en base ne fait pas tourner le guichet en rond", (t) => {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  // Écrite à la main, sous le dépôt : un registre se salit (édition humaine,
  // base recopiée). Le guichet doit survivre à ce qu'on n'a pas écrit.
  const brut = db.prepare("INSERT INTO anciens_noms (ancien_nom, lignee, note, depose_at) VALUES (?, ?, NULL, ?)");
  brut.run("a", "b", T0);
  brut.run("b", "c", T0);
  brut.run("c", "a", T0);
  db.close();

  // ⚠️ CE VERDICT SE PREND DEHORS, ET C'EST LA SEULE FAÇON HONNÊTE DE LE PRENDRE.
  // Le défaut qu'on cherche n'est pas un mauvais résultat : c'est un guichet qui
  // NE REND JAMAIS LA MAIN. Un test dans ce processus-ci ne le verrait pas
  // échouer — il se figerait avec lui, et toute la suite avec.
  const sonde = path.join(root, "sonde-de-boucle.mjs");
  fs.writeFileSync(sonde, [
    `import { openDatabase } from ${JSON.stringify(pathToFileURL(path.join(repoRacine, "src/lib/database.js")).href)};`,
    `import { resolveRecipient } from ${JSON.stringify(pathToFileURL(path.join(repoRacine, "src/lib/registry.js")).href)};`,
    "const db = openDatabase({ file: process.argv[2] });",
    'process.stdout.write(resolveRecipient(db, "a").kind);'
  ].join("\n"));

  const res = spawnSync("node", [sonde, path.join(root, "broker.db")], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...envPropre(), CC2CC_V2_HOME: root }
  });
  assert.equal(res.signal, null, "le guichet doit RENDRE LA MAIN : une boucle sans fin se fait tuer au bout de 15 s");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "unknown", "une boucle ne désigne personne");
});

test("un bureau SANS registre de réexpédition porte le courrier exactement comme avant", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  // La table n'a pas pu naître (migration partielle, base d'une autre version) :
  // aucun renvoi ne vaut une porte fermée à toute la machine.
  db.exec("DROP TABLE anciens_noms");

  assert.equal(resolveRecipient(db, "claude-alice").kind, "lineage");
  assert.equal(resolveRecipient(db, "alice").kind, "unknown");
  assert.deepEqual(listerAnciensNoms(db), []);
  assert.equal(lireAncienNom(db, "alice"), null);
});

test("la tournée générale n'écrit pas deux fois à la même famille sous deux noms", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  assert.deepEqual(broadcastRecipients(db, "bob"), ["claude-alice"]);
});

test("de bout en bout : la lettre du 22/07, adressée à un ancien nom (ici « alice »), retrouve sa famille", (t) => {
  const db = bureauDePoste(t);
  const lettre = insertMessage(db, {
    msg_id: "bob-22-07", sender: "bob", recipient: "alice",
    body: "La girouette bleue attend le vent du large, ne ferme pas les volets"
  });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0, note: "sept semaines d'attente" });

  const res = resolveRecipient(db, lettre.recipient);
  assert.equal(res.kind, "lineage");
  assert.equal(res.targets[0].instance_session_id, "s-1");
  // La lettre n'a pas bougé : on change l'adressage, jamais le courrier.
  const enBase = db.prepare("SELECT * FROM messages WHERE msg_id='bob-22-07'").get();
  assert.equal(enBase.recipient, "alice");
  assert.equal(enBase.acked_at, null, "A9 : sans accusé, la lettre finit toujours par revenir");
});

// ── L'ALIAS PRIORITAIRE (Run 6, Task 5 — 27/09) ────────────────────────────
//
// Une lignée écrivait au vieux nom court d'une autre, et une fiche héritée
// du même nom gardait le courrier : un renvoi ordinaire se lit EN DERNIER, donc n'importe quel
// porteur du vieux nom le masquait. L'alias est une DONNÉE posée au registre
// (jamais un nom de famille écrit dans le produit) et il se lit EN PREMIER.

test("ALIAS : « alice » mène à la chaise désignée d'alice-eternal, même masqué par une fiche héritée", (t) => {
  const db = bureauDePoste(t);
  registerPeer(db, { id: "alice", project_path: "/x", description: "fiche héritée", status: "active" });
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  registerInstance(db, { lineage: "alice-eternal", sessionId: "inst-2", pid: process.pid });
  designatePrimary(db, "alice-eternal", "sess-1");
  assert.equal(resolveRecipient(db, "alice").targets[0].id, "alice", "sans alias, la fiche héritée masque");
  poserAlias(db, "alice", "alice-eternal");
  const r = resolveRecipient(db, "alice");
  assert.equal(r.kind, "lineage"); assert.equal(r.alias, "alice-eternal");
  assert.deepEqual(r.targets.map((c) => c.instance_session_id), ["sess-1"]);
  assert.equal(resolveRecipient(db, "alice#sess-1").targets[0].id, "alice-eternal#sess-1");
});

test("ALIAS : la migration 6 ajoute la colonne sur une base neuve", (t) => {
  const db = bureauDePoste(t);
  assert.ok(db.prepare("PRAGMA table_info(anciens_noms)").all().some((c) => c.name === "prioritaire"));
  assert.equal(schemaVersion(db), SCHEMA_VERSION); assert.ok(SCHEMA_VERSION >= 6);
});

test("ALIAS : il bat une CHAISE VIVANTE et une LIGNÉE vivante enregistrées sous l'ancien nom", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "alice", sessionId: "vieux-1", pid: process.pid });
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  assert.equal(resolveRecipient(db, "alice").targets[0].instance_session_id, "vieux-1", "avant : la lignée vivante gagne");
  poserAlias(db, "alice", "alice-eternal");
  const r = resolveRecipient(db, "alice");
  assert.equal(r.alias, "alice-eternal");
  assert.deepEqual(r.targets.map((c) => c.instance_session_id), ["sess-1"], "l'alias ne peut pas être masqué");
  // Même l'identifiant exact d'une chaise de l'ancienne lignée suit l'alias :
  // la racine du nom EST l'alias, le suffixe voyage avec.
  const exacte = resolveRecipient(db, "alice#vieux-1");
  assert.equal(exacte.alias, "alice-eternal#vieux-1");
  assert.equal(exacte.kind, "unknown", "alice-eternal n'a pas de chaise vieux-1 : on ne retombe pas sur l'ancien nom");
});

test("ALIAS : il bat une ADRESSE HUMAINE portée par l'ancien nom — le « @nom » suit la famille d'arrivée", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "alice", sessionId: "vieux-1", pid: process.pid, sessionName: "atelier" });
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid, sessionName: "atelier" });
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-2", pid: process.pid, sessionName: "veille" });
  poserAlias(db, "alice", "alice-eternal");
  const r = resolveRecipient(db, "alice@atelier");
  assert.equal(r.alias, "alice-eternal@atelier");
  assert.deepEqual(r.targets.map((c) => c.instance_session_id), ["sess-1"]);
});

test("ALIAS : vers une famille sans chaise, la lettre est TENUE pour elle (inconnu, alias nommé), puis arrive", (t) => {
  const db = bureauDePoste(t);
  poserAlias(db, "alice", "alice-eternal");
  const avant = resolveRecipient(db, "alice");
  assert.equal(avant.kind, "unknown");
  assert.equal(avant.alias, "alice-eternal", "la résolution dit OÙ la lettre attend");
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  assert.equal(resolveRecipient(db, "alice").targets[0].instance_session_id, "sess-1");
});

test("ALIAS : un renvoi ORDINAIRE reste masquable — seule la marque prioritaire change l'ordre", (t) => {
  const db = bureauDePoste(t);
  registerPeer(db, { id: "alice", project_path: "/x", description: "fiche héritée", status: "active" });
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  deposerAncienNom(db, "alice", "alice-eternal");
  assert.equal(lireAlias(db, "alice"), null);
  assert.equal(resolveRecipient(db, "alice").targets[0].id, "alice", "Camp B : le renvoi ordinaire garde sa doctrine");
  assert.equal(poserAlias(db, "alice", "alice-eternal").prioritaire, 1);
  assert.equal(resolveRecipient(db, "alice").alias, "alice-eternal");
});

test("ALIAS : poserAlias refuse une boucle (a→b puis b→a) sans rien écrire", (t) => {
  const db = bureauDePoste(t);
  poserAlias(db, "a", "b");
  assert.throws(() => poserAlias(db, "b", "a"), /loop/);
  assert.equal(lireAncienNom(db, "b"), null);
  assert.equal(lireAlias(db, "a").lignee, "b");
});

test("ALIAS : la lettre postée à « alice » va à la chaise désignée, et l'alias est journalisé UNE fois", async (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  registerInstance(db, { lineage: "alice-eternal", sessionId: "inst-2", pid: process.pid });
  designatePrimary(db, "alice-eternal", "sess-1");
  poserAlias(db, "alice", "alice-eternal");
  const deps = { reveiller: async () => null, maisons: { houses: [], parSession: new Map() } };
  const entree = { msg_id: "alias-1", sender: "bob-eternal", recipient: "alice", body: "par l'alias" };
  const { row, resolution } = await posterUneLettre(db, entree, deps);
  assert.equal(row.recipient, "alice", "l'enveloppe ne se réécrit jamais");
  assert.equal(resolution.alias, "alice-eternal");
  assert.deepEqual(resolution.targets.map((c) => c.instance_session_id), ["sess-1"]);
  // Le rejeu du même msg_id et le passage du Facteur ne rejournalisent pas.
  await posterUneLettre(db, entree, deps);
  journaliserAlias(db, row, resolveRecipient(db, row.recipient), "facteur-test");
  const evts = db.prepare("SELECT * FROM delivery_events WHERE msg_id = ? AND event_type = 'alias_applique'").all("alias-1");
  assert.equal(evts.length, 1, "une fois par lettre");
  const detail = JSON.parse(evts[0].detail_json);
  assert.equal(detail.demande, "alice");
  assert.equal(detail.alias, "alice-eternal");
});

test("ALIAS : une lettre TENUE (famille sans chaise) est aussi journalisée, et le Facteur voit l'alias", async (t) => {
  const db = bureauDePoste(t);
  poserAlias(db, "alice", "alice-eternal");
  const { row } = await posterUneLettre(
    db,
    { msg_id: "alias-tenue", sender: "bob-eternal", recipient: "alice", body: "tenue" },
    { reveiller: async () => null, maisons: { houses: [], parSession: new Map() } }
  );
  const n = db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE msg_id = ? AND event_type = 'alias_applique'").get(row.msg_id).n;
  assert.equal(n, 1);
  const acheminement = trouverLaBoite(db, row, { parSession: new Map(), houses: [], resoudre: resolveRecipient });
  assert.equal(acheminement.motif, "destinataire-inconnu");
  assert.equal(acheminement.alias, "alice-eternal");
});

test("ALIAS : une lettre SANS alias ne laisse aucune trace alias_applique", async (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  const { row } = await posterUneLettre(
    db,
    { msg_id: "direct-1", sender: "bob-eternal", recipient: "alice-eternal", body: "direct" },
    { reveiller: async () => null, maisons: { houses: [], parSession: new Map() } }
  );
  const n = db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE msg_id = ? AND event_type = 'alias_applique'").get(row.msg_id).n;
  assert.equal(n, 0);
});

test("ALIAS : listerAlias rend les alias comme des alias, jamais comme des pairs", (t) => {
  const db = bureauDePoste(t);
  deposerAncienNom(db, "ordinaire", "alice-eternal");
  poserAlias(db, "alice", "alice-eternal");
  assert.deepEqual(listerAlias(db).map((a) => ({ id: a.id, alias_de: a.alias_de, kind: a.kind })), [
    { id: "alice", alias_de: "alice-eternal", kind: "alias" }
  ]);
});

// ── La migration 5 → 6 sur un bureau jetable : chaque ligne survit ─────────

function bureauEnV5(t) {
  const root = tempHome();
  const fichier = path.join(root, "broker.db");
  const db = new Database(fichier);
  initSchema(db);
  // Le bureau tel que la version 5 le laissait : toutes les colonnes d'avant,
  // le registre SANS `prioritaire`, et le tampon 5.
  for (const [table, col, type] of [
    ["peers", "lineage", "TEXT"], ["peers", "house", "TEXT"], ["peers", "instance_session_id", "TEXT"],
    ["peers", "is_primary", "INTEGER NOT NULL DEFAULT 0"], ["peers", "heartbeat_at", "TEXT"],
    ["peers", "proc_start", "TEXT"], ["peers", "dead_at", "TEXT"], ["peers", "session_name", "TEXT"],
    ["messages", "sender_model", "TEXT"], ["messages", "carried_at", "TEXT"],
    ["messages", "facteur_not_before_ms", "INTEGER NOT NULL DEFAULT 0"]
  ]) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  db.exec(`CREATE TABLE anciens_noms (
     ancien_nom TEXT PRIMARY KEY CHECK (length(trim(ancien_nom)) > 0),
     lignee TEXT NOT NULL CHECK (length(trim(lignee)) > 0),
     note TEXT, depose_at TEXT NOT NULL, CHECK (ancien_nom <> lignee))`);
  db.pragma("user_version = 5");
  db.prepare(`INSERT INTO peers (id, status, registered_at, last_seen, lineage, instance_session_id, is_primary)
    VALUES ('alice-eternal#sess-1', 'active', ?, ?, 'alice-eternal', 'sess-1', 1)`).run(T0, T0);
  db.prepare(`INSERT INTO peers (id, status, registered_at, last_seen) VALUES ('alice', 'active', ?, ?)`).run(T0, T0);
  db.prepare(`INSERT INTO messages (msg_id, sender, recipient, body, created_at)
    VALUES ('v5-1', 'bob-eternal', 'alice', 'lettre de la version 5', ?)`).run(T0);
  db.prepare("INSERT INTO anciens_noms (ancien_nom, lignee, note, depose_at) VALUES ('claude-alice', 'alice-eternal', 'v5', ?)").run(T0);
  db.prepare("INSERT INTO delivery_events (msg_id, agent_id, event_type, detail_json) VALUES ('v5-1', 'bob-eternal', 'sent', '{}')").run();
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return db;
}

test("MIGRATION 5 → 6 : chaque ligne survit, la colonne arrive à 0, le tampon passe à 6", (t) => {
  const db = bureauEnV5(t);
  const photo = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const avant = Object.fromEntries(["peers", "messages", "anciens_noms", "delivery_events"].map((tb) => [tb, photo(tb)]));
  assert.equal(schemaVersion(db), 5);

  const bilan = migrate(db);
  assert.equal(bilan.from, 5);
  assert.equal(bilan.to, 6);
  assert.deepEqual(bilan.manquantes, []);
  assert.equal(schemaVersion(db), 6);
  for (const table of ["peers", "messages", "delivery_events"]) {
    assert.deepEqual(photo(table), avant[table], `${table} : pas une ligne ne bouge`);
  }
  const anciens = photo("anciens_noms");
  assert.deepEqual(anciens.map(({ prioritaire, ...reste }) => reste), avant.anciens_noms);
  assert.deepEqual(anciens.map((r) => r.prioritaire), [0], "un renvoi d'avant n'est jamais promu en silence");
  // La contrainte vit aussi sur la colonne ajoutée : une marque hors {0,1} ne s'écrit pas.
  assert.throws(() => db.prepare("UPDATE anciens_noms SET prioritaire = 2").run(), /CHECK/);
  // Rejouer ne change rien.
  assert.deepEqual(migrate(db).to, 6);
  assert.deepEqual(photo("anciens_noms"), anciens);
});

// ── La porte humaine : valxos-chaise alias ─────────────────────────────────

function chaiseCli(root, args) {
  return spawnSync("node", [path.join(repoRacine, "src/bin/valxos-chaise.js"), ...args], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...envPropre(), CC2CC_V2_HOME: root }
  });
}

function bureauCli() {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  return { root, db };
}

test("CLI alias : pose l'alias, le dit, et le rend en JSON", (t) => {
  const { root, db } = bureauCli();
  t.after(() => { try { db.close(); } catch { /* jetable */ } });
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  const res = chaiseCli(root, ["alias", "alice", "alice-eternal", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const sortie = JSON.parse(res.stdout);
  assert.equal(sortie.alias, true);
  assert.equal(sortie.nom, "alice");
  assert.equal(sortie.lignee, "alice-eternal");
  assert.equal(sortie.resolution, "lineage");
  assert.equal(lireAlias(db, "alice").lignee, "alice-eternal");

  const humain = chaiseCli(root, ["alias", "alice", "alice-eternal"]);
  assert.equal(humain.status, 0, humain.stderr);
  assert.match(humain.stdout, /"alice" is now an alias of "alice-eternal": no card masks it\./);
});

test("CLI alias : refuse une boucle, rien n'est posé", (t) => {
  const { root, db } = bureauCli();
  t.after(() => { try { db.close(); } catch { /* jetable */ } });
  assert.equal(chaiseCli(root, ["alias", "a", "b"]).status, 0);
  const res = chaiseCli(root, ["alias", "b", "a"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Nothing was posted.*loop/s);
  assert.equal(lireAncienNom(db, "b"), null);
});

test("CLI alias : refuse d'aliaser une lignée VIVANTE qui a des chaises, sauf --force", (t) => {
  const { root, db } = bureauCli();
  t.after(() => { try { db.close(); } catch { /* jetable */ } });
  registerInstance(db, { lineage: "alice", sessionId: "vieux-1", pid: process.pid });
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  const refus = chaiseCli(root, ["alias", "alice", "alice-eternal"]);
  assert.equal(refus.status, 1);
  assert.match(refus.stderr, /Nothing was posted.*chair.*--force/s);
  assert.equal(lireAncienNom(db, "alice"), null);

  const force = chaiseCli(root, ["alias", "alice", "alice-eternal", "--force", "--json"]);
  assert.equal(force.status, 0, force.stderr);
  assert.equal(JSON.parse(force.stdout).force, true);
  assert.equal(resolveRecipient(db, "alice").targets[0].instance_session_id, "sess-1");
});

test("CLI alias : sans ses deux noms, il refuse (exit 2)", () => {
  const { root, db } = bureauCli();
  db.close();
  const res = chaiseCli(root, ["alias", "alice"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /valxos-chaise alias <name> <lineage>/);
});

test("CLI anciens-noms : un alias masqué par une fiche héritée SERT quand même, et se dit alias", (t) => {
  const { root, db } = bureauCli();
  t.after(() => { try { db.close(); } catch { /* jetable */ } });
  registerPeer(db, { id: "alice", project_path: "/x", description: "fiche héritée", status: "active" });
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  poserAlias(db, "alice", "alice-eternal");
  const res = chaiseCli(root, ["anciens-noms", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const [ligne] = JSON.parse(res.stdout).anciens_noms;
  assert.equal(ligne.alias, true);
  assert.equal(ligne.sert, true);
  assert.equal(ligne.mene_a, "alice-eternal");
  assert.equal(ligne.masque_par, null);
  const humain = chaiseCli(root, ["anciens-noms"]);
  assert.match(humain.stdout, /alice → alice-eternal   \[lineage\]   ALIAS   leads to alice-eternal/);
});

// ── ALIAS EN CHAÎNE (Run 6, Task 6 — repli de la review de la Task 5) ───────
// a→b puis b→c : une lettre à « a » arrive chez c. S'arrêter à « b » rendait
// la lettre à une fiche héritée qui porte encore « b », ou la tenait pour une
// famille qui n'existe plus.
test("ALIAS EN CHAÎNE : a→b puis b→c résout a vers c, suffixe compris", (t) => {
  const db = bureauDePoste(t);
  registerPeer(db, { id: "b", project_path: "/x", description: "fiche héritée sous b", status: "active" });
  registerInstance(db, { lineage: "c", sessionId: "sess-1", pid: process.pid, sessionName: "atelier" });
  poserAlias(db, "a", "b");
  poserAlias(db, "b", "c");
  const r = resolveRecipient(db, "a");
  assert.equal(r.kind, "lineage");
  assert.equal(r.alias, "c", "l'alias dit l'adresse d'ARRIVÉE de la chaîne");
  assert.deepEqual(r.targets.map((c) => c.id), ["c#sess-1"], "la fiche héritée « b » ne masque pas la chaîne");
  assert.equal(resolveRecipient(db, "a#sess-1").targets[0].id, "c#sess-1");
  assert.equal(resolveRecipient(db, "a@atelier").targets[0].id, "c#sess-1");
  assert.equal(resolveRecipient(db, "b").alias, "c");
});
test("ALIAS EN CHAÎNE : une chaîne dont la famille d'arrivée n'a pas de chaise TIENT la lettre pour elle", (t) => {
  const db = bureauDePoste(t);
  poserAlias(db, "a", "b");
  poserAlias(db, "b", "c");
  const r = resolveRecipient(db, "a");
  assert.equal(r.kind, "unknown");
  assert.equal(r.alias, "c");
});
test("ALIAS EN CHAÎNE : une boucle d'alias écrite à la main rend la main, sans jamais retomber sur le nom de départ", (t) => {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "a", sessionId: "vieux-1", pid: process.pid });
  const brut = db.prepare("INSERT INTO anciens_noms (ancien_nom, lignee, note, depose_at, prioritaire) VALUES (?, ?, NULL, ?, 1)");
  brut.run("a", "b", T0);
  brut.run("b", "a", T0);
  db.close();
  // Même doctrine que la boucle des renvois : le verdict se prend DEHORS.
  const sonde = path.join(root, "sonde-boucle-alias.mjs");
  fs.writeFileSync(sonde, [
    `import { openDatabase } from ${JSON.stringify(pathToFileURL(path.join(repoRacine, "src/lib/database.js")).href)};`,
    `import { resolveRecipient } from ${JSON.stringify(pathToFileURL(path.join(repoRacine, "src/lib/registry.js")).href)};`,
    "const db = openDatabase({ file: process.argv[2] });",
    'const r = resolveRecipient(db, "a");',
    "process.stdout.write(JSON.stringify({ kind: r.kind, alias: r.alias, cibles: r.targets.map((c) => c.id) }));"
  ].join("\n"));
  const res = spawnSync("node", [sonde, path.join(root, "broker.db")], {
    encoding: "utf8", timeout: 15000, env: { ...envPropre(), CC2CC_V2_HOME: root }
  });
  assert.equal(res.signal, null, "une boucle d'alias doit rendre la main");
  assert.equal(res.status, 0, res.stderr);
  const verdict = JSON.parse(res.stdout);
  assert.equal(verdict.alias, "b", "la chaîne s'arrête au dernier nom jamais vu");
  assert.ok(!verdict.cibles.includes("a#vieux-1"), "jamais la chaise de l'ancien nom");
});

// ── L'ALIAS À LA RELÈVE : `listInbox` (MCP `inbox`, CLI) — Task 6, fix 1 ────
test("ALIAS À LA RELÈVE : une lettre à « alice » déposée AVANT l'alias se lit à l'inbox d'alice-eternal, journalisée une fois", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "alice", body: "avant l'alias" });
  assert.equal(listInbox(db, "alice-eternal").length, 0, "sans alias, elle n'est pas à lui");
  poserAlias(db, "alice", "alice-eternal");
  const relevees = listInbox(db, "alice-eternal");
  assert.deepEqual(relevees.map((r) => r.msg_id), [lettre.msg_id]);
  listInbox(db, "alice-eternal");
  const lignes = db.prepare("SELECT * FROM delivery_events WHERE msg_id = ? AND event_type = 'alias_applique'").all(lettre.msg_id);
  assert.equal(lignes.length, 1, "une ligne par lettre, pas une par relève");
  assert.equal(JSON.parse(lignes[0].detail_json).alias, "alice-eternal");
});
// UN RÉSOLVEUR QUI LÈVE NE FERME JAMAIS LA BOÎTE (hygiène H6). Le journal de
// l'alias « ne lève jamais » — mais la résolution qu'on lui passait était
// calculée AVANT son try, par l'appelant : un `resolveRecipient` qui levait
// cassait la relève entière. On l'arme pour de vrai : toute requête sur les
// fiches (`peers`, que le résolveur lit et la relève non) lève.
function resolveurEnPanne(db) {
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/\bFROM\s+peers\b/i.test(sql)) throw new Error("résolveur en panne (test)");
    return prepare(sql);
  };
}

test("ALIAS À LA RELÈVE : un résolveur qui lève ne casse pas l'inbox — la lettre se relève, sans ligne de journal", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "alice", body: "avant l'alias" });
  poserAlias(db, "alice", "alice-eternal");
  resolveurEnPanne(db);
  assert.throws(() => resolveRecipient(db, "alice"), /résolveur en panne/, "SONDE IMPOSSIBLE : le résolveur ne lève pas");
  const relevees = listInbox(db, "alice-eternal");
  assert.deepEqual(relevees.map((r) => r.msg_id), [lettre.msg_id], "la boîte reste ouverte");
  const lignes = db.prepare("SELECT 1 FROM delivery_events WHERE msg_id = ? AND event_type = 'alias_applique'").all(lettre.msg_id);
  assert.equal(lignes.length, 0, "pas de résolution, pas de ligne — et pas d'exception");
});

test("ALIAS SUR LE CHEMIN DE LECTURE : un résolveur qui lève ne casse pas journaliserLesAliasLus", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "alice-eternal", sessionId: "sess-1", pid: process.pid });
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "alice", body: "lue par le repli" });
  poserAlias(db, "alice", "alice-eternal");
  resolveurEnPanne(db);
  assert.equal(journaliserLesAliasLus(db, [lettre], "alice-eternal"), 0);
});

test("ALIAS À LA RELÈVE : la chaîne compte, et le suffixe de chaise voyage", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "c", sessionId: "sess-1", pid: process.pid });
  const a = insertMessage(db, { sender: "bob-eternal", recipient: "a", body: "par la chaîne" });
  const nominative = insertMessage(db, { sender: "bob-eternal", recipient: "a#sess-1", body: "nominative" });
  poserAlias(db, "a", "b");
  poserAlias(db, "b", "c");
  assert.deepEqual(listInbox(db, "c").map((r) => r.msg_id), [a.msg_id]);
  assert.deepEqual(listInbox(db, "c#sess-1").map((r) => r.msg_id), [nominative.msg_id]);
  assert.equal(listInbox(db, "b").length, 0, "« b » est lui-même un alias : il ne relève pas pour c");
});
