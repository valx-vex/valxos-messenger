// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// Les vrais noms : lignée, instance, et le modèle qui cesse de mentir.
// Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) :
// le bureau de poste vivant (~/.cc2cc-v2/broker.db) n'est JAMAIS ouvert ici.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRacine = path.resolve(new URL("..", import.meta.url).pathname);

import {
  ackMessage,
  getCarriedUnacked,
  listPeers,
  getPendingForCarrier,
  getPendingForContext,
  initSchema,
  insertMessage,
  markCarried,
  markDelivered,
  openDatabase,
  registerPeer
} from "../src/lib/database.js";
import { DEFAULT_REDELIVER_AFTER_MS } from "../src/lib/config.js";
import { procStartOf } from "../src/lib/postbox.js";
import { adressesDuRepli, resolveSelfId, touchSelf } from "../src/lib/identity.js";
import { SCHEMA_VERSION, migrate, schemaVersion } from "../src/lib/migrations.js";
import {
  SEPARATEUR_INSTANCE,
  beat,
  broadcastRecipients,
  designatePrimary,
  ficheLisible,
  instanceId,
  listInstances,
  reapDeadPeers,
  registerInstance,
  resolveRecipient,
  verdictDeChaise
} from "../src/lib/registry.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-t3-"));
  poserLeBureau(root);
  return root;
}

// Une base « d'avant » : le schéma que les trois implémentations posent aujourd'hui,
// sans aucune des colonnes de E.1.
function freshLegacyDb(t) {
  const root = tempHome();
  const db = new Database(path.join(root, "broker.db"));
  initSchema(db);
  db.prepare(`
    INSERT INTO peers (id, status, registered_at, last_seen)
    VALUES ('poste-heritage', 'active', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO messages (msg_id, sender, recipient, body, created_at)
    VALUES ('herite-1', 'poste-heritage', 'alice', 'une lettre de juin', '2026-06-25T00:00:00.000Z')
  `).run();
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return db;
}

// Une base d'aujourd'hui : schéma posé, migration jouée. Jetable, toujours.
function migratedDb(t) {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return db;
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

test("la migration ajoute les colonnes sans toucher aux lignes existantes", (t) => {
  const db = freshLegacyDb(t);
  const messagesAvant = db.prepare("SELECT * FROM messages").all();
  const pairsAvant = db.prepare("SELECT * FROM peers").all();

  const res = migrate(db);

  const colsPeers = columnsOf(db, "peers");
  for (const c of ["lineage", "house", "instance_session_id", "is_primary", "heartbeat_at", "proc_start"]) {
    assert.ok(colsPeers.includes(c), `colonne manquante sur peers: ${c}`);
  }
  const colsMessages = columnsOf(db, "messages");
  for (const c of ["sender_model", "carried_at"]) {
    assert.ok(colsMessages.includes(c), `colonne manquante sur messages: ${c}`);
  }

  assert.equal(res.to, SCHEMA_VERSION);
  // Camp B : aucune ligne n'est modifiée, aucune n'est supprimée.
  assert.equal(db.prepare("SELECT count(*) n FROM messages").get().n, messagesAvant.length);
  assert.equal(db.prepare("SELECT count(*) n FROM peers").get().n, pairsAvant.length);
  for (const [i, row] of db.prepare("SELECT * FROM messages ORDER BY seq").all().entries()) {
    for (const key of Object.keys(messagesAvant[i])) {
      assert.deepEqual(row[key], messagesAvant[i][key], `champ modifié: ${key}`);
    }
  }
});

test("la migration n'invente aucune remise : carried_at est NULL sur les lettres d'avant", (t) => {
  const db = freshLegacyDb(t);
  migrate(db);
  const row = db.prepare("SELECT carried_at, acked_at, delivered_at FROM messages WHERE msg_id='herite-1'").get();
  assert.equal(row.carried_at, null);
  assert.equal(row.acked_at, null);
  assert.equal(row.delivered_at, null);
});

test("migrer deux fois ne casse rien et ne duplique aucune colonne", (t) => {
  const db = freshLegacyDb(t);
  migrate(db);
  const premier = columnsOf(db, "peers").length;
  const premierMessages = columnsOf(db, "messages").length;
  const res = migrate(db);
  assert.equal(columnsOf(db, "peers").length, premier);
  assert.equal(columnsOf(db, "messages").length, premierMessages);
  assert.equal(res.from, SCHEMA_VERSION, "la seconde migration part de la version déjà posée");
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
});

test("migrer une base sans tables n'annonce AUCUN schéma", (t) => {
  const root = tempHome();
  const db = new Database(path.join(root, "broker.db"));
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });

  const res = migrate(db);
  assert.equal(res.to, 0, "une version de schéma est une promesse : pas de tables, pas de promesse");
  assert.equal(schemaVersion(db), 0);
  assert.ok(res.manquantes.includes("peers.lineage"));
  assert.ok(res.manquantes.includes("messages.carried_at"));
});

test("un index qui ne peut pas naître se dit, il ne se tait pas", (t) => {
  const db = freshLegacyDb(t);
  // Un objet porte déjà le nom de l'index : sa création échouera.
  db.exec("CREATE TABLE idx_peers_lineage (x TEXT)");

  const res = migrate(db);
  assert.equal(res.to, SCHEMA_VERSION, "un index manquant ne justifie pas de refuser le courrier");
  assert.equal(res.indexesManques.length, 1);
  assert.match(res.indexesManques[0].statement, /idx_peers_lineage/);
  assert.ok(res.indexesManques[0].raison, "un échec muet est un état qu'on ne saura jamais lire");
});

// --- Les instances : une session = une chaise --------------------------------

test("deux sessions de la même maison sont deux instances, pas une fiche écrasée", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h/work", pid: 1, model: "opus" });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/h/work", pid: 2, model: "haiku" });
  const rows = db.prepare("SELECT * FROM peers WHERE lineage = 'alice' ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.instance_session_id).sort(), ["s-1", "s-2"]);
  assert.deepEqual(rows.map((r) => r.id).sort(), [instanceId("alice", "s-1"), instanceId("alice", "s-2")].sort());
});

test("ré-enregistrer la MÊME session met à jour, ne duplique pas", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  const deuxieme = registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 4242, procStart: "X" });
  assert.equal(db.prepare("SELECT count(*) n FROM peers WHERE instance_session_id='s-1'").get().n, 1);
  assert.equal(deuxieme.pid, 4242);
  assert.equal(deuxieme.proc_start, "X");
});

test("une instance ne peut pas naître sans lignée ni sans session", (t) => {
  const db = migratedDb(t);
  assert.throws(() => registerInstance(db, { sessionId: "s-1", house: "/h" }), /lineage/i);
  assert.throws(() => registerInstance(db, { lineage: "alice", house: "/h" }), /session/i);
});

// A12 — le nom d'une chaise ne se raccourcit JAMAIS. Deux sessions vivantes qui
// partagent leurs 8 premiers caractères sont deux personnes différentes, et le
// jour où elles partagent une chaise, le guichet ne dit pas « ambigu » : il rend
// une certitude fausse. Un tirage aux dés silencieux est pire qu'un aveu.
test("deux sessions aux 8 premiers caractères identiques sont DEUX chaises, jamais une", (t) => {
  const db = migratedDb(t);
  const s1 = "35e98d0b-3f2c-4d66-9fa6-08608bb889cf";
  const s2 = "35e98d0b-7a11-4e02-b3cd-991122334455";

  registerInstance(db, { lineage: "alice", sessionId: s1, house: "/h/work", pid: 111 });
  registerInstance(db, { lineage: "alice", sessionId: s2, house: "/h/b", pid: 222 });

  assert.notEqual(instanceId("alice", s1), instanceId("alice", s2),
    "tronquer la session donne le même nom de chaise à deux sessions différentes");

  const rows = db.prepare("SELECT * FROM peers WHERE lineage='alice' ORDER BY instance_session_id").all();
  assert.equal(rows.length, 2, "la seconde session ne doit pas écraser la fiche de la première");
  assert.deepEqual(rows.map((r) => r.instance_session_id), [s1, s2]);
  assert.deepEqual(rows.map((r) => r.house), ["/h/work", "/h/b"],
    "une chaise écrasée réécrit aussi la maison : le courrier partirait vers la mauvaise porte");
  assert.deepEqual(rows.map((r) => r.pid), [111, 222]);
});

test("deux chaises qui se ressemblent rendent la lignée AMBIGUË, jamais une fausse certitude", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "35e98d0b-3f2c-4d66-9fa6-08608bb889cf", house: "/h/work", pid: 111 });
  registerInstance(db, { lineage: "alice", sessionId: "35e98d0b-7a11-4e02-b3cd-991122334455", house: "/h/b", pid: 222 });

  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "ambigu", "deux chaises vivantes : la lettre attend, elle ne se joue pas aux dés");
  assert.equal(res.targets.length, 2);
});

test("le nom d'une chaise porte la session ENTIÈRE, et se relit", (t) => {
  const db = migratedDb(t);
  const session = "35e98d0b-3f2c-4d66-9fa6-08608bb889cf";
  const row = registerInstance(db, { lineage: "alice", sessionId: session, house: "/h/work", pid: 1 });
  assert.equal(row.id, `alice${SEPARATEUR_INSTANCE}${session}`);
  assert.equal(resolveRecipient(db, row.id).kind, "instance");
  assert.equal(resolveRecipient(db, row.id).targets[0].instance_session_id, session);
});

// --- La résolution : jamais « la plus récente gagne » ------------------------

test("une lignée à deux instances vivantes sans désignation est AMBIGUË (jamais la plus récente)", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/h", pid: 2 });
  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "ambigu");
  assert.equal(res.targets.length, 2);
});

test("une lignée à une seule instance résout sans désignation", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "lineage");
  assert.equal(res.targets[0].instance_session_id, "s-1");
});

test("après désignation, la lignée résout vers l'instance DÉSIGNÉE", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/h", pid: 2 });
  designatePrimary(db, "alice", "s-1");
  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "lineage");
  assert.equal(res.targets.length, 1);
  assert.equal(res.targets[0].instance_session_id, "s-1");
});

test("désigner une instance retire la désignation des autres (une seule chaise)", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/h", pid: 2 });
  designatePrimary(db, "alice", "s-1");
  designatePrimary(db, "alice", "s-2");
  const rows = db.prepare("SELECT instance_session_id, is_primary FROM peers WHERE lineage='alice' ORDER BY instance_session_id").all();
  assert.deepEqual(rows, [
    { instance_session_id: "s-1", is_primary: 0 },
    { instance_session_id: "s-2", is_primary: 1 }
  ]);
});

// La désignation est le SEUL geste humain du design. `touchSelf` tourne à chaque
// appel d'outil : si une ré-annonce rendait la chaise, un seul hook de la session
// désignée effacerait le choix de l'opérateur, et la lignée redeviendrait ambiguë
// entre deux tournées. Ce que le code affirme ici, la suite le mord.
test("la chaise désignée SURVIT aux ré-annonces de la session désignée", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/h", pid: 2 });
  designatePrimary(db, "alice", "s-1");

  for (let i = 0; i < 3; i += 1) {
    registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  }

  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "lineage", "une ré-annonce ne rend pas la chaise");
  assert.equal(res.targets.length, 1);
  assert.equal(res.targets[0].instance_session_id, "s-1");
  assert.equal(res.targets[0].is_primary, 1);
});

test("la chaise désignée survit aussi aux ré-annonces des AUTRES chaises", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/h", pid: 2 });
  designatePrimary(db, "alice", "s-1");

  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/h", pid: 2 });
  registerInstance(db, { lineage: "alice", sessionId: "s-3", house: "/h", pid: 3 });

  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "lineage");
  assert.equal(res.targets[0].instance_session_id, "s-1", "s'annoncer ne prend pas la chaise d'un autre");
  const chaises = db.prepare("SELECT instance_session_id, is_primary FROM peers WHERE lineage='alice' ORDER BY instance_session_id").all();
  assert.deepEqual(chaises, [
    { instance_session_id: "s-1", is_primary: 1 },
    { instance_session_id: "s-2", is_primary: 0 },
    { instance_session_id: "s-3", is_primary: 0 }
  ]);
});

test("un hook de la session désignée ne défait pas la désignation (touchSelf)", (t) => {
  const db = migratedDb(t);
  const hook = { session_id: "aaaa1111-2222", cwd: "/home/exemple" };
  touchSelf(db, "claude-alice", hook);
  touchSelf(db, "claude-alice", { session_id: "bbbb3333-4444", cwd: "/home/exemple" });
  designatePrimary(db, "claude-alice", "aaaa1111-2222");

  // Ce que fait la vraie vie : un appel d'outil, donc un hook, donc touchSelf.
  touchSelf(db, "claude-alice", hook);

  const res = resolveRecipient(db, "claude-alice");
  assert.equal(res.kind, "lineage", "un seul appel d'outil ne doit pas rendre la lignée ambiguë");
  assert.equal(res.targets[0].instance_session_id, "aaaa1111-2222");
});

test("désigner une instance inconnue est une erreur nommée, jamais un silence", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  assert.throws(() => designatePrimary(db, "alice", "s-fantome"), /no instance/i);
});

test("un nom d'instance exact résout directement, sans ambiguïté possible", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1abcdef", house: "/h", pid: 1 });
  registerInstance(db, { lineage: "alice", sessionId: "s-2abcdef", house: "/h", pid: 2 });
  const res = resolveRecipient(db, "alice#s-1abcdef");
  assert.equal(res.kind, "instance");
  assert.equal(res.targets.length, 1);
  assert.equal(res.targets[0].instance_session_id, "s-1abcdef");
});

test("un nom hérité (ancienne fiche sans lignée) reste résolvable — Camp B", (t) => {
  const db = migratedDb(t);
  db.prepare(`
    INSERT INTO peers (id, status, registered_at, last_seen)
    VALUES ('poste-heritage', 'active', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z')
  `).run();
  const res = resolveRecipient(db, "poste-heritage");
  assert.equal(res.kind, "instance");
  assert.equal(res.targets[0].id, "poste-heritage");
});

test("une fiche héritée ne vole pas le courrier de la lignée du même nom", (t) => {
  const db = migratedDb(t);
  db.prepare(`
    INSERT INTO peers (id, status, registered_at, last_seen)
    VALUES ('claude-alice', 'active', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z')
  `).run();
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-9", house: "/h/work", pid: 9 });
  const res = resolveRecipient(db, "claude-alice");
  assert.equal(res.kind, "lineage");
  assert.equal(res.targets.length, 1);
  assert.equal(res.targets[0].instance_session_id, "s-9");
});

test("un destinataire que personne ne porte est INCONNU, jamais deviné", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  const res = resolveRecipient(db, "personne");
  assert.equal(res.kind, "unknown");
  assert.deepEqual(res.targets, []);
});

test("une instance retirée du service ne reçoit plus, et sa lignée redevient claire", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/h", pid: 2 });
  db.prepare("UPDATE peers SET status='offline' WHERE instance_session_id='s-2'").run();
  const res = resolveRecipient(db, "alice");
  assert.equal(res.kind, "lineage");
  assert.equal(res.targets[0].instance_session_id, "s-1");
  assert.equal(listInstances(db, "alice").length, 1);
});

test("le battement met à jour l'instance, et elle seule", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/h", pid: 1 });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/h", pid: 2 });
  beat(db, "s-1", "2026-08-13T12:00:00.000Z");
  const un = db.prepare("SELECT heartbeat_at, last_seen FROM peers WHERE instance_session_id='s-1'").get();
  const deux = db.prepare("SELECT heartbeat_at FROM peers WHERE instance_session_id='s-2'").get();
  assert.equal(un.heartbeat_at, "2026-08-13T12:00:00.000Z");
  assert.equal(un.last_seen, "2026-08-13T12:00:00.000Z");
  assert.notEqual(deux.heartbeat_at, "2026-08-13T12:00:00.000Z");
});

// --- Le bureau de poste : le modèle sur la lettre, la remise au guichet -------

test("ouvrir le bureau de poste joue la migration (aucun appel manuel)", (t) => {
  const root = tempHome();
  const brut = new Database(path.join(root, "broker.db"));
  initSchema(brut);
  brut.close();

  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  assert.ok(columnsOf(db, "peers").includes("lineage"));
  assert.ok(columnsOf(db, "messages").includes("carried_at"));
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
});

test("insertMessage enregistre le modèle de l'expéditeur sur LA LETTRE", (t) => {
  const db = migratedDb(t);
  const row = insertMessage(db, {
    sender: "alice", recipient: "bob", body: "x", sender_model: "claude-opus-5[1m]"
  });
  assert.equal(row.sender_model, "claude-opus-5[1m]");
  const sans = insertMessage(db, { sender: "alice", recipient: "bob", body: "y" });
  assert.equal(sans.sender_model, null, "un modèle inconnu se dit NULL, jamais il ne s'invente");
});

test("insertMessage accepte un identifiant fourni (idempotence côté appelant)", (t) => {
  const db = migratedDb(t);
  const a = insertMessage(db, { msg_id: "fixe-1", sender: "a", recipient: "b", body: "x" });
  const bis = insertMessage(db, { msg_id: "fixe-1", sender: "a", recipient: "b", body: "x" });
  assert.equal(a.msg_id, "fixe-1");
  assert.equal(a.seq, bis.seq);
  assert.equal(db.prepare("SELECT count(*) n FROM messages").get().n, 1);
});

test("markCarried pose carried_at et JAMAIS delivered_at ni acked_at", (t) => {
  const db = migratedDb(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "b", body: "x" });
  const n = markCarried(db, [lettre], "facteur");
  assert.equal(n, 1);
  const row = db.prepare("SELECT * FROM messages WHERE msg_id='L1'").get();
  assert.ok(row.carried_at, "la lettre doit porter la marque du guichet");
  assert.equal(row.delivered_at, null, "remis au guichet n'est PAS livré");
  assert.equal(row.acked_at, null, "remis au guichet n'est surtout pas accusé");
  const ev = db.prepare("SELECT * FROM delivery_events WHERE msg_id='L1' ORDER BY id DESC").get();
  assert.equal(ev.event_type, "facteur_remis");
});

test("la marque du guichet ne se réécrit pas à la tournée suivante", (t) => {
  const db = migratedDb(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "b", body: "x" });
  markCarried(db, [lettre], "facteur", { at: "2026-08-13T10:00:00.000Z" });
  markCarried(db, [lettre], "facteur", { at: "2026-08-13T11:00:00.000Z" });
  assert.equal(db.prepare("SELECT carried_at FROM messages WHERE msg_id='L1'").get().carried_at,
    "2026-08-13T10:00:00.000Z");
});

test("markCarried compte les lettres MARQUÉES, pas celles qu'on lui a tendues", (t) => {
  const db = migratedDb(t);
  const vraie = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  const fantome = { seq: 999_999, msg_id: "L-fantome" };

  assert.equal(markCarried(db, [vraie, fantome], "facteur"), 1,
    "une ligne périmée n'a pas été remise au guichet : la compter serait un compte qui ment");
  assert.equal(db.prepare("SELECT count(*) n FROM delivery_events WHERE msg_id='L-fantome'").get().n, 0,
    "on ne journalise pas la remise d'une lettre qui n'existe pas");
  assert.equal(markCarried(db, [fantome], "facteur"), 0);
});

test("les lettres remises au guichet mais NON ACCUSÉES se comptent", (t) => {
  const db = migratedDb(t);
  const portee = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "1" });
  const accusee = insertMessage(db, { msg_id: "L2", sender: "a", recipient: "bob", body: "2" });
  insertMessage(db, { msg_id: "L3", sender: "a", recipient: "bob", body: "3" });
  markCarried(db, [portee, accusee], "facteur");
  ackMessage(db, "L2", "bob");

  assert.deepEqual(getCarriedUnacked(db).map((r) => r.msg_id), ["L1"]);
  assert.deepEqual(getCarriedUnacked(db, { recipient: "personne" }), []);
});

test("le repli ne re-sert pas une lettre remise au guichet pendant la fenêtre de grâce", (t) => {
  const db = migratedDb(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  markCarried(db, [lettre], "facteur", { at: "2026-08-13T12:00:00.000Z" });

  const pendantLaGrace = getPendingForContext(db, "bob", {
    carriedGraceMs: 90_000, now: "2026-08-13T12:00:30.000Z"
  });
  assert.deepEqual(pendantLaGrace.map((r) => r.msg_id), [],
    "une lettre déposée il y a 30 s n'est pas encore perdue");

  const apres = getPendingForContext(db, "bob", {
    carriedGraceMs: 90_000, now: "2026-08-13T12:05:00.000Z"
  });
  assert.deepEqual(apres.map((r) => r.msg_id), ["L1"],
    "sans accusé, la lettre redevient rattrapable par le repli — jamais de perte");
});

test("une lettre accusée n'est plus jamais re-servie, même hors grâce", (t) => {
  const db = migratedDb(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  markCarried(db, [lettre], "facteur", { at: "2026-08-13T12:00:00.000Z" });
  ackMessage(db, "L1", "bob");
  assert.deepEqual(
    getPendingForContext(db, "bob", { carriedGraceMs: 90_000, now: "2026-08-13T23:00:00.000Z" }),
    []
  );
});

// A9 — L'INVARIANT QUI PRIME SUR TOUT : « acked_at nul ⇒ la lettre finit
// toujours par revenir ». Le seul bug capable de perdre du courrier POUR DE BON
// est celui-ci : le hook pose `delivered_at`, meurt avant d'écrire le contexte,
// et le repli l'exclut pour toujours à cause de la marque qu'il vient de poser.
// La lettre est là, en base, et définitivement invisible.
test("A9 — une lettre livrée il y a 11 minutes et jamais accusée REVIENT", (t) => {
  const db = migratedDb(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });

  // Le hook a posé sa marque… puis il est mort avant que le texte n'atteigne
  // la conversation. Personne n'a rien vu, et personne n'a accusé.
  markDelivered(db, [lettre], "bob", "post_tool_use_delivered");
  const onzeMinutes = new Date(Date.now() + 11 * 60_000).toISOString();

  const revenue = getPendingForContext(db, "bob", { now: onzeMinutes });
  assert.deepEqual(revenue.map((r) => r.msg_id), ["L1"],
    "acked_at nul ⇒ la lettre finit toujours par revenir");
});

test("le repli ne bégaie pas : une lettre livrée à l'instant attend son tour", (t) => {
  const db = migratedDb(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  markDelivered(db, [lettre], "bob", "post_tool_use_delivered");

  const deuxMinutes = new Date(Date.now() + 2 * 60_000).toISOString();
  assert.deepEqual(getPendingForContext(db, "bob", { now: deuxMinutes }), [],
    "re-servir à chaque hook noierait la conversation : on attend la fenêtre de re-service");
});

test("A9 — remise au guichet ET livrée : sans accusé, la lettre revient quand même", (t) => {
  const db = migratedDb(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  markCarried(db, [lettre], "facteur");
  markDelivered(db, [lettre], "bob", "post_tool_use_delivered");

  const onzeMinutes = new Date(Date.now() + 11 * 60_000).toISOString();
  assert.deepEqual(getPendingForContext(db, "bob", { now: onzeMinutes }).map((r) => r.msg_id), ["L1"],
    "aucune combinaison de marques ne doit rendre une lettre durablement invisible");
});

test("une lettre accusée ne revient JAMAIS, même des heures après sa livraison", (t) => {
  const db = migratedDb(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  markDelivered(db, [lettre], "bob", "post_tool_use_delivered");
  ackMessage(db, "L1", "bob");

  const demain = new Date(Date.now() + 24 * 3600_000).toISOString();
  assert.deepEqual(getPendingForContext(db, "bob", { now: demain }), [],
    "la terminalité appartient à l'accusé du destinataire, et à lui seul");
});

// A8 dit « on préfère un doublon à une lettre perdue » : un DOUBLON, pas une
// avalanche. Si la marque de livraison ne bougeait pas au re-service, la lettre
// re-servie garderait sa date d'origine, resterait éternellement au-delà de la
// fenêtre, et repartirait à CHAQUE appel d'outil — pour toujours. Le destinataire
// ne pourrait plus travailler et le filet A9 deviendrait la nuisance.
test("une lettre non accusée revient AU PLUS UNE FOIS par fenêtre, pas à chaque tournée", (t) => {
  const db = migratedDb(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });

  const depart = Date.parse("2026-08-13T12:00:00.000Z");
  const instant = (minutes) => new Date(depart + minutes * 60_000).toISOString();

  // Le hook a posé sa marque, puis il est mort avant d'écrire le contexte.
  markDelivered(db, [lettre], "bob", "post_tool_use_delivered", { at: instant(0) });

  // Six relevés d'affilée APRÈS la fenêtre de re-service (10 min), un par minute :
  // exactement ce que fait une session qui appelle des outils.
  const retours = [];
  for (const minute of [11, 12, 13, 14, 15, 16]) {
    const rows = getPendingForContext(db, "bob", { now: instant(minute) });
    if (rows.length > 0) {
      retours.push(minute);
      markDelivered(db, rows, "bob", "post_tool_use_delivered", { at: instant(minute) });
    }
  }
  assert.deepEqual(retours, [11],
    "re-servie une fois, puis elle se tait : un doublon (A8), jamais une avalanche");

  // …et elle revient bien à la fenêtre SUIVANTE : on borne le retour, on ne l'éteint pas.
  assert.deepEqual(
    getPendingForContext(db, "bob", { now: instant(22) }).map((r) => r.msg_id), ["L1"],
    "acked_at nul ⇒ la lettre finit toujours par revenir — à la fenêtre d'après (A9)");
});

test("la marque de livraison n'avance que sur les lettres SERVIES", (t) => {
  const db = migratedDb(t);
  const servie = insertMessage(db, { msg_id: "SERVIE", sender: "a", recipient: "bob", body: "x" });
  const voisine = insertMessage(db, { msg_id: "VOISINE", sender: "a", recipient: "bob", body: "y" });
  const marques = () =>
    db.prepare("SELECT msg_id, delivered_at FROM messages ORDER BY seq").all();

  markDelivered(db, [servie, voisine], "bob", "post_tool_use_delivered", {
    at: "2026-08-13T12:00:00.000Z"
  });

  // Une tournée qui ne sert RIEN ne touche à aucune marque.
  const avant = marques();
  assert.equal(markDelivered(db, [], "bob", "post_tool_use_delivered"), 0);
  assert.deepEqual(marques(), avant, "une tournée qui n'a rien remis ne repousse le tour de personne");

  // La tournée suivante ne remet que la première : la seconde n'a pas été mise
  // sous les yeux du destinataire, son tour ne doit pas être repoussé.
  markDelivered(db, [servie], "bob", "post_tool_use_delivered", { at: "2026-08-13T12:11:00.000Z" });
  assert.deepEqual(marques(), [
    { msg_id: "SERVIE", delivered_at: "2026-08-13T12:11:00.000Z" },
    { msg_id: "VOISINE", delivered_at: "2026-08-13T12:00:00.000Z" }
  ], "une marque qui avance sans que la lettre ait été servie ment, et enterre la lettre");
});

test("les deux fenêtres du repli sont des réglages, jamais des nombres en dur", (t) => {
  const db = migratedDb(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  markDelivered(db, [lettre], "bob", "post_tool_use_delivered");

  const dansUneMinute = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(getPendingForContext(db, "bob", {
    redeliverAfterMs: 30_000, now: dansUneMinute
  }).map((r) => r.msg_id), ["L1"], "une fenêtre de re-service raccourcie doit se voir");
  assert.deepEqual(getPendingForContext(db, "bob", {
    redeliverAfterMs: 3600_000, now: dansUneMinute
  }), [], "une fenêtre de re-service allongée aussi");

  assert.equal(typeof DEFAULT_REDELIVER_AFTER_MS, "number");
  assert.ok(DEFAULT_REDELIVER_AFTER_MS > 0);
});

test("le Facteur ne ramasse que ce qui n'a été ni remis, ni livré, ni accusé", (t) => {
  const db = migratedDb(t);
  const a = insertMessage(db, { msg_id: "A", sender: "s", recipient: "bob", body: "1" });
  const b = insertMessage(db, { msg_id: "B", sender: "s", recipient: "bob", body: "2" });
  const c = insertMessage(db, { msg_id: "C", sender: "s", recipient: "bob", body: "3" });
  insertMessage(db, { msg_id: "D", sender: "s", recipient: "bob", body: "4" });
  markCarried(db, [a], "facteur");
  markDelivered(db, [b], "bob");
  ackMessage(db, c.msg_id, "bob");
  assert.deepEqual(getPendingForCarrier(db).map((r) => r.msg_id), ["D"]);
});

// --- L'identité : touchSelf enregistre une instance, pas une fiche de maison ---

test("touchSelf enregistre une INSTANCE de la lignée, pas une fiche partagée", (t) => {
  const db = migratedDb(t);
  touchSelf(db, "claude-alice", { session_id: "aaaa1111-2222", cwd: "/home/exemple", model: "claude-opus-5[1m]" });
  touchSelf(db, "claude-alice", { session_id: "bbbb3333-4444", cwd: "/home/exemple", model: "claude-haiku" });

  const instances = listInstances(db, "claude-alice");
  assert.equal(instances.length, 2, "deux sessions d'une même maison = deux chaises");
  assert.deepEqual(instances.map((r) => r.instance_session_id).sort(), ["aaaa1111-2222", "bbbb3333-4444"]);
  assert.equal(resolveRecipient(db, "claude-alice").kind, "ambigu");
});

test("touchSelf n'estampille plus le modèle sur la fiche (le champ mentait)", (t) => {
  const db = migratedDb(t);
  touchSelf(db, "claude-alice", { session_id: "aaaa1111-2222", cwd: "/home/exemple", model: "claude-opus-5[1m]" });
  const rows = db.prepare("SELECT model FROM peers").all();
  assert.deepEqual(rows, [{ model: null }],
    "le modèle d'un sous-agent ne doit plus pouvoir se coller sur la fiche de la session");
});

test("sans session identifiée, touchSelf garde le geste d'avant (le repli ne se casse jamais)", (t) => {
  const db = migratedDb(t);
  touchSelf(db, "claude-alice", { cwd: "/home/exemple" });
  const row = db.prepare("SELECT id, lineage, instance_session_id FROM peers").get();
  assert.equal(row.id, "claude-alice");
  assert.equal(row.instance_session_id, null);
});

// --- Le repli va chercher le courrier sous TOUS les noms de la session --------
//
// Une lettre adressée à une CHAISE (`lignée#session`) n'était rattrapable par
// aucun hook : ils cherchent sous le nom de la LIGNÉE. Sans ça, A9 est violé par
// construction pour tout courrier nominatif — la lettre reste en base, visible
// de personne. Le Facteur (T4) routera par chaise : le trou serait béant.

test("le repli d'une session ramasse aussi le courrier adressé à SA chaise", (t) => {
  const db = migratedDb(t);
  touchSelf(db, "alice", { session_id: "s-1", cwd: "/h" });
  insertMessage(db, { msg_id: "L1", sender: "bob", recipient: "alice", body: "à la lignée" });
  insertMessage(db, { msg_id: "L2", sender: "bob", recipient: "alice#s-1", body: "à la chaise" });

  const adresses = adressesDuRepli(db, "alice", { session_id: "s-1" });
  assert.deepEqual(adresses, ["alice", "alice#s-1"]);
  assert.deepEqual(getPendingForContext(db, adresses).map((r) => r.msg_id), ["L1", "L2"],
    "aucune lettre ne doit rester adressée à un nom que personne ne va lire");
});

test("le repli d'une session ne ramasse PAS le courrier de la chaise d'à côté", (t) => {
  const db = migratedDb(t);
  touchSelf(db, "alice", { session_id: "s-1", cwd: "/h" });
  touchSelf(db, "alice", { session_id: "s-2", cwd: "/h" });
  insertMessage(db, { msg_id: "L2", sender: "bob", recipient: "alice#s-2", body: "pour l'autre" });

  const adresses = adressesDuRepli(db, "alice", { session_id: "s-1" });
  assert.deepEqual(getPendingForContext(db, adresses), [],
    "une lettre nominative se lit sur SA chaise, jamais sur celle du voisin");
  assert.deepEqual(
    getPendingForContext(db, adressesDuRepli(db, "alice", { session_id: "s-2" })).map((r) => r.msg_id),
    ["L2"]
  );
});

test("sans session identifiée, le repli garde exactement le geste d'avant", (t) => {
  const db = migratedDb(t);
  assert.deepEqual(adressesDuRepli(db, "alice", {}), ["alice"]);
  assert.deepEqual(adressesDuRepli(db, "", { session_id: "s-1" }), []);
  assert.deepEqual(getPendingForContext(db, []), [], "aucune adresse ne rend aucune lettre, jamais toutes");
});

test("une chaise enregistrée sous un autre nom reste une adresse de la session", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "ancien-nom", sessionId: "s-1", house: "/h", pid: 1 });
  const adresses = adressesDuRepli(db, "alice", { session_id: "s-1" });
  assert.deepEqual(adresses, ["alice", "alice#s-1", "ancien-nom#s-1"]);
});

test("de bout en bout : un hook rattrape une lettre adressée à sa chaise", (t) => {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, {
    msg_id: "L1", sender: "bob", recipient: "hook-agent#sess-42", body: "lettre nominative"
  });
  db.close();

  const res = spawnSync("node", [path.join(repoRacine, "src/hooks/piggyback_fetch.js")], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "sess-42", cwd: "/h" }),
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "hook-agent" }
  });
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  assert.match(json.hookSpecificOutput?.additionalContext || "", /lettre nominative/,
    "le repli ne se casse jamais : ce que le Facteur n'a pas porté, les hooks le rattrapent");
});

// La sonde de la re-revue, transformée en test : avec le VRAI hook, six tournées
// d'affilée après la fenêtre ne ramènent pas six fois la même lettre.
test("de bout en bout : six tournées après la fenêtre ne re-servent la lettre qu'une fois", () => {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  const lettre = insertMessage(db, {
    msg_id: "L1", sender: "bob", recipient: "hook-agent", body: "lettre en souffrance"
  });
  // Un hook l'a posée il y a 11 minutes ; personne n'a accusé.
  markDelivered(db, [lettre], "hook-agent", "post_tool_use_delivered", {
    at: new Date(Date.now() - 11 * 60_000).toISOString()
  });
  db.close();

  const tournee = () => {
    const res = spawnSync("node", [path.join(repoRacine, "src/hooks/piggyback_fetch.js")], {
      input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "sess-1", cwd: "/h" }),
      encoding: "utf8",
      env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "hook-agent" }
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout).hookSpecificOutput?.additionalContext || "";
  };

  assert.match(tournee(), /lettre en souffrance/,
    "passé la fenêtre et sans accusé, la lettre revient (A9)");
  for (const tour of [2, 3, 4, 5, 6]) {
    assert.equal(tournee(), "",
      `tournée ${tour} : re-servir à chaque appel d'outil noierait la session, et le verrou d'arrêt ne se libérerait jamais`);
  }
});

// --- Le guichet MCP : plus de roster mort, un identifiant qu'on peut fixer ----

function ouvrirGuichet(t, { root, self }) {
  const client = new Client({ name: "cc2cc-v2-t3", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repoRacine, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: self }
  });
  t.after(async () => { try { await client.close(); } catch { /* guichet déjà fermé */ } });
  return client.connect(transport).then(() => client);
}

function lireJson(res) {
  return JSON.parse(res.content[0].text);
}

test("un broadcast sans pair enregistré n'écrit AUCUNE lettre morte", async (t) => {
  const root = tempHome();
  const client = await ouvrirGuichet(t, { root, self: "solo" });

  const pairs = lireJson(await client.callTool({ name: "list_peers", arguments: {} }));
  assert.deepEqual(pairs.roster, [], "le guichet ne sert plus de sièges vides");

  const diffusion = lireJson(await client.callTool({
    name: "broadcast", arguments: { body: "y a quelqu'un ?" }
  }));
  assert.equal(diffusion.count, 0);

  const db = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  assert.equal(db.prepare("SELECT count(*) n FROM messages").get().n, 0,
    "aucune lettre ne doit partir vers un nom que personne ne porte");
});

test("le guichet MCP : une lettre par lignée, et un identifiant qu'on peut fixer", async (t) => {
  const root = tempHome();
  const amorce = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(amorce, { lineage: "bob", sessionId: "s-1", house: "/h/bob", pid: 1 });
  registerInstance(amorce, { lineage: "bob", sessionId: "s-2", house: "/h/bob", pid: 2 });
  amorce.close();

  const client = await ouvrirGuichet(t, { root, self: "alice" });

  const premier = lireJson(await client.callTool({
    name: "send",
    arguments: { to: "bob", body: "bonjour", msg_id: "fixe-1", sender_model: "claude-opus-5[1m]" }
  }));
  const second = lireJson(await client.callTool({
    name: "send",
    arguments: { to: "bob", body: "bonjour", msg_id: "fixe-1", sender_model: "claude-opus-5[1m]" }
  }));
  assert.equal(premier.msg_id, "fixe-1");
  assert.equal(premier.seq, second.seq, "le même identifiant ne crée pas une seconde lettre");

  const diffusion = lireJson(await client.callTool({
    name: "broadcast", arguments: { body: "appel général" }
  }));
  assert.equal(diffusion.count, 1, "deux chaises d'une même lignée = UNE lettre, pas deux");
  assert.deepEqual(diffusion.results.map((r) => r.to), ["bob"]);

  const db = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  const lettres = db.prepare("SELECT msg_id, recipient, sender, sender_model FROM messages ORDER BY seq").all();
  assert.equal(lettres.length, 2);
  assert.equal(lettres[0].sender_model, "claude-opus-5[1m]", "le modèle voyage avec la lettre");
  assert.deepEqual(lettres.map((l) => l.recipient), ["bob", "bob"]);
});

test("le nom ne s'empile pas d'un hook à l'autre : resolveSelfId rend une LIGNÉE", (t) => {
  const db = migratedDb(t);
  const memoire = { self: process.env.CC2CC_SELF, nom: process.env.CC2CC_SESSION_NAME };
  delete process.env.CC2CC_SELF;
  delete process.env.CC2CC_SESSION_NAME;
  t.after(() => {
    if (memoire.self !== undefined) process.env.CC2CC_SELF = memoire.self;
    if (memoire.nom !== undefined) process.env.CC2CC_SESSION_NAME = memoire.nom;
  });

  const hook = { session_id: "86d692e2-aaaa", cwd: "/home/exemple" };
  const noms = [];
  for (let i = 0; i < 3; i += 1) {
    const self = resolveSelfId(db, hook);
    noms.push(self);
    touchSelf(db, self, hook);
  }
  assert.equal(noms[1], noms[0], "le second hook doit retrouver la MÊME lignée");
  assert.equal(noms[2], noms[0], "le troisième aussi");
  assert.equal(db.prepare("SELECT count(*) n FROM peers").get().n, 1,
    "trois hooks d'une même session = une seule chaise");
  assert.ok(!noms[2].includes("#"),
    "une lignée ne porte pas de numéro de chaise : sinon le repli va chercher le courrier sous un nom que personne n'écrit");
});

// --- LA MOISSON : le registre inscrit enfin les départs ----------------------
//
// Le défaut de production du 18/08 : 43 chaises toutes « active », 3 processus
// vivants, et 29 homonymes dans une seule lignée, qui la rendaient « ambigu ».

// Un numéro de processus dont on est SÛR qu'il ne désigne plus personne : on
// lance un processus, on attend sa fin, on reprend son numéro. Si le noyau l'a
// recyclé entre-temps (improbable, mais une sonde se vérifie), on se rabat sur
// un numéro hors de portée — jamais sur une supposition.
function pidMort() {
  const fini = spawnSync(process.execPath, ["-e", ""]);
  const pid = Number(fini.pid);
  try {
    process.kill(pid, 0);
  } catch {
    return pid;
  }
  return 4194304;
}

// Une base d'aujourd'hui dont on garde AUSSI la racine : les outils en ligne de
// commande s'ouvrent la leur, par `CC2CC_V2_HOME`.
function baseAvecRacine(t) {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return { db, root };
}

test("la moisson marque la chaise dont le processus est parti, et GARDE la ligne", (t) => {
  const db = migratedDb(t);
  const mort = pidMort();
  registerInstance(db, { lineage: "alice", sessionId: "s-partie", pid: mort });

  const res = reapDeadPeers(db);

  assert.equal(res.reaped, 1);
  assert.equal(res.moissonnees[0].raison, "processus-parti");
  const chaise = db.prepare("SELECT * FROM peers WHERE instance_session_id = 's-partie'").get();
  // Camp B : marquée, datée, JAMAIS effacée.
  assert.equal(chaise.status, "dead");
  assert.ok(chaise.dead_at, "une mort se date, sinon on ne saura jamais quand elle a été constatée");
  assert.equal(db.prepare("SELECT count(*) n FROM peers").get().n, 1,
    "aucune ligne ne disparaît : la moisson marque, elle ne supprime pas");
});

test("la moisson laisse en service la chaise dont le processus tourne encore", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-vivante", pid: process.pid });

  const res = reapDeadPeers(db);

  assert.equal(res.reaped, 0, "le processus de ce test est vivant : le moissonner serait une faute");
  assert.equal(
    db.prepare("SELECT status FROM peers WHERE instance_session_id = 's-vivante'").get().status,
    "active"
  );
});

test("un pid vivant dont l'heure de naissance ne concorde plus est un pid RECYCLÉ", (t) => {
  const db = migratedDb(t);
  // Le numéro est bien vivant (c'est le nôtre) mais la fiche dit qu'il est né
  // à une autre heure : ce n'est donc plus le même processus.
  registerInstance(db, {
    lineage: "alice",
    sessionId: "s-recyclee",
    pid: process.pid,
    procStart: "Thu Jan  1 00:00:00 1970"
  });

  const res = reapDeadPeers(db);

  assert.equal(res.reaped, 1);
  assert.equal(res.moissonnees[0].raison, "pid-recycle",
    "sans ce croisement, un numéro repris par un autre programme ferait passer un mort pour un vivant");
});

test("une chaise SANS numéro de processus ne se moissonne pas : on s'abstient", (t) => {
  const db = migratedDb(t);
  // Une fiche héritée de v1 : elle n'a jamais porté de PID. On ne sait rien
  // d'elle — et ne rien savoir n'est pas une raison de la retirer du service.
  registerInstance(db, { lineage: "ancienne", sessionId: "s-sans-pid", pid: null });

  const res = reapDeadPeers(db);

  assert.equal(res.reaped, 0);
  assert.equal(res.abstained, 1);
  assert.equal(res.abstenues[0].raison, "sans-pid");
  assert.equal(
    db.prepare("SELECT status FROM peers WHERE instance_session_id = 's-sans-pid'").get().status,
    "active",
    "s'abstenir doit LAISSER la chaise en service, sinon l'abstention est une condamnation déguisée"
  );
});

test("une sonde qui n'a pas pu tourner ne condamne personne", (t) => {
  const db = migratedDb(t);
  registerInstance(db, {
    lineage: "alice",
    sessionId: "s-sonde-muette",
    pid: process.pid,
    procStart: "Thu Jan  1 00:00:00 1970"
  });

  // `ps` ne répond pas. Le verdict précédent aurait dit « recyclé » ; ici on ne
  // sait simplement pas — et une sonde impossible n'est jamais un succès, ni
  // dans un sens ni dans l'autre.
  const res = reapDeadPeers(db, { procStartOf: () => null });

  assert.equal(res.reaped, 0);
  assert.equal(res.abstained, 1);
  assert.equal(res.abstenues[0].raison, "sonde-impossible");
});

test("verdictDeChaise rend TROIS issues, jamais deux", () => {
  assert.equal(verdictDeChaise({ pid: null }).etat, "indecidable");
  assert.equal(verdictDeChaise({ pid: process.pid }).etat, "vivante");
  assert.equal(verdictDeChaise({ pid: pidMort() }).etat, "morte");
});

test("la moisson laisse une trace relisible : un peer_reaped par chaise", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-tracee", pid: pidMort() });

  reapDeadPeers(db);

  const trace = db
    .prepare("SELECT * FROM delivery_events WHERE event_type = 'peer_reaped'")
    .all();
  assert.equal(trace.length, 1);
  assert.equal(trace[0].msg_id, null, "une chaise n'est pas une lettre");
  assert.equal(JSON.parse(trace[0].detail_json).raison, "processus-parti");
});

test("se ré-annoncer RESSUSCITE une chaise moissonnée à tort", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-revenue", pid: pidMort() });
  reapDeadPeers(db);
  assert.equal(
    db.prepare("SELECT status FROM peers WHERE instance_session_id = 's-revenue'").get().status,
    "dead"
  );

  // La session parle de nouveau : c'est la preuve la plus forte qu'elle est là.
  registerInstance(db, { lineage: "alice", sessionId: "s-revenue", pid: process.pid });

  const chaise = db.prepare("SELECT * FROM peers WHERE instance_session_id = 's-revenue'").get();
  assert.equal(chaise.status, "active", "la moisson doit être réversible sans geste humain");
  assert.equal(chaise.dead_at, null, "garder la date de mort ferait mentir la colonne sur une chaise qui parle");
});

// I-6 (vérification des chaises parallèles, 18/10) : une fiche NUE (sans session,
// `registerPeer` — le CLI, un client MCP solo) moissonnée puis ré-enregistrée
// redevenait `active` en gardant sa date de mort. Même règle que la chaise :
// se ré-annoncer efface le constat qu'il datait.
test("une fiche nue moissonnée qui se ré-enregistre perd sa date de mort, comme une chaise", (t) => {
  const db = migratedDb(t);
  registerPeer(db, { id: "operateur", pid: pidMort() });
  reapDeadPeers(db);
  const morte = db.prepare("SELECT status, dead_at FROM peers WHERE id = 'operateur'").get();
  assert.equal(morte.status, "dead", "SONDE IMPOSSIBLE : la moisson n'a pas marqué la fiche nue");
  assert.ok(morte.dead_at, "SONDE IMPOSSIBLE : la moisson n'a pas daté la fiche nue");

  registerPeer(db, { id: "operateur", pid: process.pid });

  const revenue = db.prepare("SELECT status, dead_at FROM peers WHERE id = 'operateur'").get();
  assert.equal(revenue.status, "active");
  assert.equal(revenue.dead_at, null, "une fiche nue qui parle de nouveau ne garde pas la date de sa mort");
});

test("LE DÉFAUT DU 18/08 : une lignée noyée sous ses homonymes morts redevient adressable", (t) => {
  const db = migratedDb(t);
  const mort = pidMort();
  // Vingt-neuf chaises mortes et une vivante, toutes « claude-alice ».
  for (let i = 0; i < 29; i += 1) {
    registerInstance(db, { lineage: "claude-alice", sessionId: `s-morte-${i}`, pid: mort });
  }
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-vivante", pid: process.pid });

  assert.equal(resolveRecipient(db, "claude-alice").kind, "ambigu",
    "avant la moisson : trente chaises répondent, le guichet refuse de trancher et la lettre attend");

  const res = reapDeadPeers(db);
  assert.equal(res.reaped, 29);

  // ⚠️ C'est ICI que la moisson paie. Marquer « dead » sans que la résolution
  // le lise n'aurait rien changé du tout.
  const apres = resolveRecipient(db, "claude-alice");
  assert.equal(apres.kind, "lineage");
  assert.equal(apres.targets.length, 1);
  assert.equal(apres.targets[0].instance_session_id, "s-vivante");
  assert.equal(db.prepare("SELECT count(*) n FROM peers").get().n, 30,
    "Camp B : les trente lignes sont toujours là, seule leur lecture a changé");
});

test("une chaise morte ne reçoit plus de tournée générale", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "partie", sessionId: "s-partie", pid: pidMort() });
  registerInstance(db, { lineage: "presente", sessionId: "s-presente", pid: process.pid });

  reapDeadPeers(db);

  assert.deepEqual(broadcastRecipients(db, "moi"), ["presente"],
    "écrire à une chaise morte, c'est écrire une lettre morte");
});

test("listPeers cache les mortes par défaut et les montre avec includeDead", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-morte", pid: pidMort() });
  registerInstance(db, { lineage: "alice", sessionId: "s-vive", pid: process.pid });
  reapDeadPeers(db);

  assert.equal(listPeers(db).length, 1, "par défaut on liste ce qui REÇOIT");
  assert.equal(listPeers(db, { includeDead: true }).length, 2, "rien n'a disparu");
});

test("cc2cc-peers cache les chaises mortes, --all les montre", (t) => {
  const { db, root } = baseAvecRacine(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-morte", pid: pidMort() });
  registerInstance(db, { lineage: "alice", sessionId: "s-vive", pid: process.pid });
  reapDeadPeers(db);

  const lancer = (args) => JSON.parse(spawnSync(
    process.execPath,
    [path.join(repoRacine, "src/bin/valxos-peers.js"), ...args],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root } }
  ).stdout);

  const parDefaut = lancer([]);
  assert.equal(parDefaut.peers.length, 1);
  assert.equal(parDefaut.include_dead, false, "l'outil dit CE QU'IL MONTRE");

  const tout = lancer(["--all"]);
  assert.equal(tout.peers.length, 2);
  assert.equal(tout.include_dead, true);
});

// Ruling 11 (27/09) : le médecin LIT. Deux passages sans drapeau comptent la
// même candidate, ne marquent rien et ne tracent rien ; seul `--reap` écrit.
function lancerDoctor(root, drapeaux = []) {
  const sortie = spawnSync(
    process.execPath,
    [path.join(repoRacine, "src/bin/valxos-doctor.js"), ...drapeaux],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root } }
  );
  return JSON.parse(sortie.stdout);
}

// `checks.moisson` est la source ; les champs plats d'avant lui en sont des
// alias de compatibilité qui la MIROITENT (hygiène H4) — jamais un second compte.
function aliasMiroitentLaMoisson(checks) {
  assert.equal(checks.peersChecked, checks.moisson.checked, "peersChecked miroite moisson.checked");
  assert.equal(checks.peersReaped, checks.moisson.reaped, "peersReaped miroite moisson.reaped");
  assert.equal(checks.peersAbstained, checks.moisson.abstained, "peersAbstained miroite moisson.abstained");
}

test("valxos-doctor sans drapeau constate les chaises mortes et n'écrit rien (27/09)", (t) => {
  const { db, root } = baseAvecRacine(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-morte", pid: pidMort() });
  registerInstance(db, { lineage: "alice", sessionId: "s-vive", pid: process.pid });
  const tracesAvant = db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE event_type = 'peer_reaped'").get().n;

  for (const passage of [1, 2]) {
    const rapport = lancerDoctor(root);
    assert.equal(rapport.checks.moisson.mode, "rapport", `passage ${passage}`);
    assert.equal(rapport.checks.moisson.reaped, 1, `passage ${passage} : la candidate se compte`);
    aliasMiroitentLaMoisson(rapport.checks);
    assert.equal(rapport.checks.peers, 2, "rien n'est marqué : les deux chaises sont encore en service");
    assert.equal(rapport.checks.remede, "valxos-chaise moissonner");
    assert.equal(rapport.checks.reapError, null);
  }
  assert.equal(db.prepare("SELECT status FROM peers WHERE id = ?").get(instanceId("alice", "s-morte")).status, "active");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE event_type = 'peer_reaped'").get().n,
    tracesAvant,
    "un rapport ne trace aucune moisson"
  );
});

test("valxos-doctor --reap marque la chaise morte, et la base la garde (27/09)", (t) => {
  const { db, root } = baseAvecRacine(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-morte", pid: pidMort() });
  registerInstance(db, { lineage: "alice", sessionId: "s-vive", pid: process.pid });

  const rapport = lancerDoctor(root, ["--reap"]);
  assert.equal(rapport.checks.moisson.mode, "moisson");
  assert.equal(rapport.checks.moisson.reaped, 1);
  aliasMiroitentLaMoisson(rapport.checks);
  assert.equal(rapport.checks.peers, 1, "après la moisson, une seule chaise reçoit");
  assert.equal(rapport.checks.peersTotal, 2, "et la base garde les deux");
  assert.equal(rapport.checks.reapError, null);
  assert.equal(db.prepare("SELECT status FROM peers WHERE id = ?").get(instanceId("alice", "s-morte")).status, "dead");
});

test("valxos-chaise moissonner --json est le second geste explicite (27/09)", (t) => {
  const { db, root } = baseAvecRacine(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-morte", pid: pidMort() });
  registerInstance(db, { lineage: "alice", sessionId: "s-vive", pid: process.pid });

  const sortie = spawnSync(
    process.execPath,
    [path.join(repoRacine, "src/bin/valxos-chaise.js"), "moissonner", "--json"],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root } }
  );
  assert.equal(sortie.status, 0, sortie.stderr);
  const r = JSON.parse(sortie.stdout);
  assert.equal(r.moissonnees, 1);
  assert.equal(r.abstenues, 0);
  assert.deepEqual(r.chaises.map((c) => c.id), [instanceId("alice", "s-morte")]);
  assert.equal(db.prepare("SELECT status FROM peers WHERE id = ?").get(instanceId("alice", "s-morte")).status, "dead");
  assert.equal(db.prepare("SELECT status FROM peers WHERE id = ?").get(instanceId("alice", "s-vive")).status, "active");
});

test("reapDeadPeers({ dryRun: true }) compte les candidates sans rien écrire (27/09)", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-partie", pid: pidMort() });
  const rapport = reapDeadPeers(db, { dryRun: true });
  assert.equal(rapport.mode, "rapport");
  assert.equal(rapport.reaped, 1);
  assert.equal(db.prepare("SELECT status, dead_at FROM peers").get().status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE event_type = 'peer_reaped'").get().n, 0);
  const moisson = reapDeadPeers(db);
  assert.equal(moisson.mode, "moisson");
  assert.equal(db.prepare("SELECT status FROM peers").get().status, "dead");
});

// Le doctor suit la MAISON CLAUDE du lanceur (CLAUDE_CONFIG_DIR, sinon
// ~/.claude — même règle que l'installeur, config.js). Un « home jetable, rien
// d'installé » doit donc perdre la maison du shell qui lance la suite : sur
// une machine où le lanceur exporte CLAUDE_CONFIG_DIR, le doctor regarderait
// la VRAIE maison, y trouverait le vrai plugin, et le cas malade passerait sain.
// TOUS les liens que l'installeur pose, et que le médecin vérifie : les clefs de
// `bin` du manifeste (22 : valxos-*, valxos-messenger, cc2cc-*, facteur) — plus
// une liste écrite à la main ici, qui retomberait à onze le jour où le médecin
// en vérifie davantage (Q19, revue qualité, 18/10).
const COMMANDES_DU_PRODUIT = Object.keys(JSON.parse(fs.readFileSync(path.join(repoRacine, "package.json"), "utf8")).bin);

function envDuDoctor(root, home) {
  const env = { ...envPropre(), CC2CC_V2_HOME: root, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

test("cc2cc-doctor dérive son verdict des faits — pas un ok littéral", (t) => {
  const { root } = baseAvecRacine(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-doctor-home-"));

  const lancer = () => JSON.parse(spawnSync(
    process.execPath,
    [path.join(repoRacine, "src/bin/valxos-doctor.js")],
    { encoding: "utf8", env: envDuDoctor(root, home) }
  ).stdout);

  // Home jetable, rien d'installé : ni cible plugin, ni commandes CLI liées.
  const malade = lancer();
  assert.equal(malade.checks.pluginTargetExists, false);
  assert.equal(malade.ok, false, "un doctor qui dit ok:true sans cible plugin ni CLI ment");

  // Le même home, désormais « installé » : cible plugin + les commandes produit liées.
  fs.mkdirSync(path.join(home, ".claude", "skills", "valxos-messenger"), { recursive: true });
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of COMMANDES_DU_PRODUIT) {
    // S1 (remède de la revue adverse) : le doctor vérifie maintenant X_OK, pas juste
    // existsSync — une fiche « installée » DOIT être exécutable pour rester
    // le cas sain, sinon ce fixture mentirait exactement comme facteur.js
    // avant le fix.
    fs.writeFileSync(path.join(binDir, name), "");
    fs.chmodSync(path.join(binDir, name), 0o755);
  }

  const sain = lancer();
  assert.equal(sain.checks.pluginTargetExists, true);
  assert.ok(Object.values(sain.checks.cliCommands).every(Boolean), "les commandes produit sont liées");
  assert.equal(sain.checks.pluginManifestExists, true, "ce repo réel porte bien son manifeste");
  assert.equal(sain.checks.reapError, null);
  assert.equal(sain.ok, true, "toutes les cibles présentes, aucune erreur de moisson : le cas sain reste vert");
});

// S1 (remède de la revue adverse, IMPORTANT 4) — LE FAIT QUI COMPTE : le doctor élargi à 9
// commandes vérifiait encore avec existsSync, qui ne voit PAS le bit
// d'exécution. facteur.js était exactement dans cet état (présent, mode
// 644) et ce même doctor rendait ok:true — élargir la LISTE n'avait pas
// fermé l'INVARIANT que la revue adverse a nommé à la main : l'exécutabilité réelle de
// chaque binaire. Ce test rejoue précisément ce scénario : les fiches
// PRÉSENTES, UNE seule non-exécutable (mode 644, comme facteur.js avant le
// fix) — le doctor doit désormais le voir et le dire.
test("cc2cc-doctor voit un binaire PRÉSENT mais NON-EXÉCUTABLE — le scénario exact de S1 (facteur.js, mode 644)", (t) => {
  const { root } = baseAvecRacine(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-doctor-nonexec-"));

  fs.mkdirSync(path.join(home, ".claude", "skills", "valxos-messenger"), { recursive: true });
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of COMMANDES_DU_PRODUIT) {
    fs.writeFileSync(path.join(binDir, name), "");
    // Huit exécutables, UN seul laissé en 644 — le mode par défaut d'un
    // fichier fraîchement écrit, exactement ce que git a laissé passer pour
    // facteur.js.
    fs.chmodSync(path.join(binDir, name), name === "facteur" ? 0o644 : 0o755);
  }

  const rapport = JSON.parse(spawnSync(
    process.execPath,
    [path.join(repoRacine, "src/bin/valxos-doctor.js")],
    { encoding: "utf8", env: envDuDoctor(root, home) }
  ).stdout);

  assert.equal(rapport.checks.cliCommands.facteur, false, "présent mais non-exécutable doit se voir comme false");
  assert.equal(
    Object.entries(rapport.checks.cliCommands).filter(([, ok]) => ok === false).length,
    1,
    "les autres, réellement exécutables, restent true — un seul binaire est en cause"
  );
  assert.equal(rapport.ok, false, "un facteur non-exécutable ne doit JAMAIS se cacher derrière ok:true (c'était exactement S1)");
});

// Q19 (revue qualité, 18/10) — LE MÉDECIN VÉRIFIE LES LIENS QUE L'INSTALLEUR POSE, TOUS.
// L'installeur lie chaque clef de `bin` (22 : onze valxos-*, dix alias cc2cc-*, facteur) ;
// le médecin en vérifiait onze, écrits à la main, sans `valxos-messenger` ni les alias :
// un alias absent ou la commande d'entrée absente ne rougissaient rien.
test("cc2cc-doctor vérifie TOUS les liens de `bin` — l'alias oublié et la commande d'entrée se voient", (t) => {
  const { root } = baseAvecRacine(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-doctor-liens-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude", "skills", "valxos-messenger"), { recursive: true });
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of COMMANDES_DU_PRODUIT) {
    fs.writeFileSync(path.join(binDir, name), "");
    fs.chmodSync(path.join(binDir, name), 0o755);
  }
  const lancer = () => JSON.parse(spawnSync(
    process.execPath,
    [path.join(repoRacine, "src/bin/valxos-doctor.js")],
    { encoding: "utf8", env: envDuDoctor(root, home) }
  ).stdout);

  const sain = lancer();
  assert.equal(COMMANDES_DU_PRODUIT.length, 22, "SONDE : le manifeste publie bien 22 commandes");
  assert.deepEqual(
    Object.keys(sain.checks.cliCommands).sort(),
    [...COMMANDES_DU_PRODUIT].sort(),
    "le médecin nomme exactement les liens que l'installeur pose, ni plus ni moins"
  );
  assert.equal(sain.ok, true, "les 22 liens exécutables : le cas sain reste vert");

  for (const manquant of ["cc2cc-send", "valxos-messenger"]) {
    fs.rmSync(path.join(binDir, manquant));
    const malade = lancer();
    assert.equal(malade.checks.cliCommands[manquant], false, `${manquant} absent se voit`);
    assert.equal(malade.ok, false, `un lien ${manquant} absent ne se cache pas derrière ok:true`);
    fs.writeFileSync(path.join(binDir, manquant), "");
    fs.chmodSync(path.join(binDir, manquant), 0o755);
  }
});

// pluginManifestExists se lit depuis repoRoot(), calculé depuis import.meta.url
// de config.js — aucune variable d'env ne peut le tromper. La seule façon
// honnête de prouver que son absence fait mentir ok, c'est de faire tourner
// le doctor depuis une COPIE du code qui n'a jamais eu de
// .claude-plugin/plugin.json. La copie doit vivre DANS l'arbre du worktree
// (pas /tmp) pour que la résolution de module trouve node_modules en
// remontant les répertoires parents.
test("cc2cc-doctor : un manifeste plugin absent fait aussi mentir ok — pas seulement la cible", (t) => {
  const fixture = fs.mkdtempSync(path.join(repoRacine, ".doctor-fixture-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.cpSync(path.join(repoRacine, "src"), path.join(fixture, "src"), { recursive: true });
  // Le médecin lit les liens à vérifier dans le `package.json` de SON paquet : la copie le porte,
  // comme tout vrai paquet. Seul le manifeste du PLUGIN manque à cette copie.
  fs.copyFileSync(path.join(repoRacine, "package.json"), path.join(fixture, "package.json"));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-doctor-manifest-home-"));
  // Un bureau qui EXISTE : le médecin ne crée plus la base qu'il diagnostique (Q3), et sans
  // elle `ok` serait faux pour une autre raison que le manifeste.
  const { root: runtimeRoot } = baseAvecRacine(t);

  // Tout le reste est SAIN — cible plugin et commandes produit liées — pour
  // que seul le manifeste absent explique un ok:false.
  fs.mkdirSync(path.join(home, ".claude", "skills", "valxos-messenger"), { recursive: true });
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of COMMANDES_DU_PRODUIT) {
    // S1 (remède de la revue adverse) : le doctor vérifie maintenant X_OK, pas juste
    // existsSync — une fiche « installée » DOIT être exécutable pour rester
    // le cas sain, sinon ce fixture mentirait exactement comme facteur.js
    // avant le fix.
    fs.writeFileSync(path.join(binDir, name), "");
    fs.chmodSync(path.join(binDir, name), 0o755);
  }

  const sortie = spawnSync(
    process.execPath,
    [path.join(fixture, "src", "bin", "valxos-doctor.js")],
    { encoding: "utf8", env: envDuDoctor(runtimeRoot, home) }
  );
  assert.equal(sortie.status, 0, `le doctor n'a pas tourné : ${sortie.stderr}`);
  const rapport = JSON.parse(sortie.stdout);

  assert.equal(rapport.checks.pluginManifestExists, false, "cette copie n'a jamais eu de .claude-plugin/plugin.json");
  assert.equal(rapport.checks.pluginTargetExists, true, "tout le reste est sain — seul le manifeste manque");
  assert.ok(Object.values(rapport.checks.cliCommands).every(Boolean));
  assert.equal(rapport.ok, false, "un manifeste absent ne doit pas se cacher derrière un ok:true");
});

test("le guichet MCP cache les chaises mortes, include_dead les montre", async (t) => {
  const { db, root } = baseAvecRacine(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-morte", pid: pidMort() });
  registerInstance(db, { lineage: "alice", sessionId: "s-vive", pid: process.pid });
  reapDeadPeers(db);
  db.close();

  const client = await ouvrirGuichet(t, { root, self: "temoin" });

  const parDefaut = lireJson(await client.callTool({ name: "list_peers", arguments: {} }));
  assert.equal(parDefaut.peers.length, 1);
  assert.equal(parDefaut.include_dead, false);

  const tout = lireJson(await client.callTool({
    name: "list_peers", arguments: { include_dead: true }
  }));
  assert.equal(tout.peers.length, 2);
  assert.equal(tout.include_dead, true);
});

// --- Le moniteur ne moissonne JAMAIS (Run 6, Task 8, fix round 2) ---------
//
// Le moniteur est un processus automatique lancé par le plugin : la règle de
// Task 6 (la moisson est un geste d'opérateur) le lie. Les deux seuls gestes
// qui marquent des chaises mortes sont `valxos-doctor --reap` et
// `valxos-chaise moissonner`. `--reap-only` ne moissonne plus : il redirige,
// bruyamment, au lieu d'être une troisième porte silencieuse.
//
// La PARITÉ reste gardée : le moniteur juge encore la vie de la chaise
// inscrite pour sa session (`peer_liveness`, dans `chaise()`, pour la garde du
// jumeau). Le jour où sa sonde diverge de `verdictDeChaise`, un jumeau vivant
// passerait pour mort et deux moniteurs relèveraient le même courrier. On
// interroge donc directement la sonde Python, sans moisson.

function verdictPython(root, pid, procStart = null) {
  const sortie = spawnSync(
    "python3",
    [
      "-c",
      "import json, sys; sys.path.insert(0, sys.argv[1]); import valxos_monitor as m; "
        + "pid = None if sys.argv[2] == '' else sys.argv[2]; ps = None if sys.argv[3] == '' else sys.argv[3]; "
        + "print(json.dumps(m.peer_liveness(pid, ps)))",
      path.join(repoRacine, "src/monitor"),
      pid == null ? "" : String(pid),
      procStart == null ? "" : String(procStart)
    ],
    // Pas de __pycache__ dans l'arbre du dépôt : la sonde importe le module.
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root, PYTHONDONTWRITEBYTECODE: "1" } }
  );
  assert.equal(sortie.status, 0, `sonde Python impossible : ${sortie.stderr}`);
  const [etat, raison] = JSON.parse(sortie.stdout.trim());
  return { etat, raison };
}

test("valxos-monitor --reap-only ne moissonne plus : il redirige vers valxos-chaise moissonner, exit 2", (t) => {
  const { db, root } = baseAvecRacine(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-morte", pid: pidMort() });

  const sortie = spawnSync(
    "python3",
    [path.join(repoRacine, "src/monitor/valxos_monitor.py"), "--reap-only"],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "temoin" } }
  );
  assert.equal(sortie.status, 2);
  assert.equal(sortie.stdout, "");
  assert.equal(sortie.stderr.trim().split("\n").length, 1, "une seule ligne");
  assert.equal(
    sortie.stderr,
    "valxos-monitor no longer harvests: run  valxos-chaise moissonner  (or valxos-doctor --reap)\n",
    "la ligne du refus, mot pour mot"
  );
  assert.equal(db.prepare("SELECT status FROM peers WHERE instance_session_id='s-morte'").get().status, "active");
  assert.equal(db.prepare("SELECT count(*) n FROM delivery_events WHERE event_type='peer_reaped'").get().n, 0);
});

test("le moniteur n'a plus de moisson dans son code (27/09)", () => {
  const source = fs.readFileSync(path.join(repoRacine, "src/monitor/valxos_monitor.py"), "utf8");
  assert.doesNotMatch(source, /def reap_dead_peers|UPDATE peers SET status = 'dead'|'peer_reaped'/);
});

test("PARITÉ : le moniteur juge une chaise partie comme le registre", (t) => {
  const { db, root } = baseAvecRacine(t);
  const mort = pidMort();
  registerInstance(db, { lineage: "alice", sessionId: "s-morte", pid: mort });
  registerInstance(db, { lineage: "alice", sessionId: "s-vive", pid: process.pid });
  for (const session of ["s-morte", "s-vive"]) {
    const ligne = db.prepare("SELECT * FROM peers WHERE instance_session_id = ?").get(session);
    assert.equal(verdictPython(root, ligne.pid, ligne.proc_start).etat, verdictDeChaise(ligne).etat, session);
  }
  assert.equal(verdictPython(root, mort).etat, "morte");
  assert.equal(verdictPython(root, process.pid).etat, "vivante");
});

test("PARITÉ : le moniteur s'abstient exactement là où le registre s'abstient", (t) => {
  const { db, root } = baseAvecRacine(t);
  registerInstance(db, { lineage: "ancienne", sessionId: "s-sans-pid", pid: null });
  const ligne = db.prepare("SELECT * FROM peers WHERE instance_session_id='s-sans-pid'").get();
  assert.equal(verdictDeChaise(ligne).etat, "indecidable");
  assert.equal(verdictPython(root, ligne.pid, ligne.proc_start).etat, "indecidable",
    "une chaise sans PID n'est pas une chaise morte — les deux implémentations doivent le dire pareil");
});

test("PARITÉ : l'heure de naissance écrite par Node se relit à l'identique en Python", (t) => {
  const { root } = baseAvecRacine(t);
  // L'heure de naissance telle que le côté Node l'inscrit — `LC_ALL=C TZ=UTC`.
  const naissance = procStartOf(process.pid);
  assert.ok(naissance, "sonde impossible : sans heure de naissance lisible, ce test ne prouve RIEN");
  // Le moniteur relit cette chaîne avec SA propre sonde. S'il lit `ps` dans la
  // langue et le fuseau du shell, il obtient une autre chaîne pour la même
  // seconde, conclut « pid recyclé », et prend une chaise VIVANTE pour morte.
  assert.equal(verdictPython(root, process.pid, naissance).etat, "vivante",
    "les deux sondes doivent rendre la même chaîne");
});

test("designatePrimary refuse une chaise hors service (morte ou offline)", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-registry-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  registerInstance(db, { lineage: "alice", sessionId: "s-vive", house: "/h/a", pid: process.pid });
  registerInstance(db, { lineage: "alice", sessionId: "s-morte", house: "/h/b", pid: 222 });
  registerInstance(db, { lineage: "alice", sessionId: "s-partie", house: "/h/c", pid: 333 });
  db.prepare("UPDATE peers SET status = 'dead', dead_at = ? WHERE instance_session_id = 's-morte'").run("2026-08-18T12:00:00.000Z");
  db.prepare("UPDATE peers SET status = 'offline' WHERE instance_session_id = 's-partie'").run();

  assert.throws(() => designatePrimary(db, "alice", "s-morte"), /out of service/);
  assert.throws(() => designatePrimary(db, "alice", "s-partie"), /out of service/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM peers WHERE is_primary = 1").get().n, 0);

  const vive = designatePrimary(db, "alice", "s-vive");
  assert.equal(Number(vive.is_primary), 1, "la vivante, elle, se désigne");
});

// ── Trouvés par la passe adverse du 18/08 (NO-GO), corrigés ici ──────────────

// F1 : un process ANCIEN qui rouvre une base plus récente ne doit pas la
// rétrograder. Une version est un verdict d'état ; le tamponner vers le bas,
// c'est mentir sur ce que la base contient.
test("migrate ne rétrograde JAMAIS une base plus récente que le code", (t) => {
  const db = migratedDb(t);
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  db.pragma(`user_version = ${SCHEMA_VERSION + 7}`);
  const res = migrate(db);
  assert.equal(schemaVersion(db), SCHEMA_VERSION + 7, "la version reste celle de la base, pas celle du code");
  assert.equal(res.to, SCHEMA_VERSION + 7);
  assert.equal(res.plusRecente, true, "et le rapport le DIT");
});

// F4a : deux moissons en même temps — la seconde ne trace pas une mort déjà
// constatée par la première (sinon la trace compte des morts en double).
test("la moisson ne trace pas une chaise qu'une autre moisson vient de marquer", (t) => {
  const db = migratedDb(t);
  const mort = pidMort();
  registerInstance(db, { lineage: "alice", sessionId: "s-partie", pid: mort });
  // Le concurrent frappe PENDANT notre verdict : entre notre SELECT et notre UPDATE.
  const concurrent = db.prepare("UPDATE peers SET status = 'dead', dead_at = ? WHERE instance_session_id = 's-partie'");
  const res = reapDeadPeers(db, {
    isProcessAlive: (pid) => { concurrent.run("2026-08-18T13:00:00.000Z"); return false; }
  });
  assert.equal(res.reaped, 0, "on ne compte pas une mort qu'on n'a pas constatée soi-même");
  const events = db.prepare("SELECT count(*) n FROM delivery_events WHERE event_type = 'peer_reaped'").get().n;
  assert.equal(events, 0, "et on ne la trace pas deux fois");
  assert.equal(db.prepare("SELECT status FROM peers WHERE instance_session_id = 's-partie'").get().status, "dead");
});

// F4b : une chaise qui SE RÉ-ANNONCE pendant la moisson est vivante — notre
// lecture est périmée, pas elle. On ne l'écrase pas.
test("la moisson n'écrase pas une chaise qui s'est ré-annoncée pendant le verdict", (t) => {
  const db = migratedDb(t);
  const mort = pidMort();
  registerInstance(db, { lineage: "alice", sessionId: "s-revenue", pid: mort });
  const res = reapDeadPeers(db, {
    isProcessAlive: (pid) => {
      // Elle revient, avec un PID vivant, entre notre SELECT et notre UPDATE.
      registerInstance(db, { lineage: "alice", sessionId: "s-revenue", pid: process.pid });
      return false; // notre verdict, sur la lecture PÉRIMÉE, dit « morte »
    }
  });
  assert.equal(res.reaped, 0);
  const chaise = db.prepare("SELECT status, dead_at FROM peers WHERE instance_session_id = 's-revenue'").get();
  assert.equal(chaise.status, "active", "la revenante reste en service");
  assert.equal(chaise.dead_at, null);
});

// ── FICHES LISIBLES ET MOISSON EXPLICITE (Run 6, Task 8) ─────────────────────
test("le Facteur ne moissonne jamais (27/09)", () => {
  for (const f of ["src/facteur/daemon.js", "src/facteur/round.js", "src/bin/facteur.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(repoRacine, f), "utf8"), /reapDeadPeers|peer_reaped/, f);
  }
});

test("ficheLisible : chaque chaise vivante se reconnaît (lignée#session, nom, désignée)", () => {
  const f = ficheLisible({ id: "alice-eternal#414d241d-acca", lineage: "alice-eternal", instance_session_id: "414d241d-acca", session_name: "atelier", is_primary: 1 });
  assert.deepEqual([f.chaise, f.nom, f.adresse_humaine, f.designee], ["alice-eternal#414d241d", "atelier", "alice-eternal@atelier", true]);
});

test("ficheLisible : une fiche héritée garde son id pour chaise, et rien n'est retiré", () => {
  const brute = { id: "bob-eternal", status: "active", is_primary: 0, chaise_designee: false };
  const f = ficheLisible(brute);
  assert.deepEqual([f.chaise, f.nom, f.adresse_humaine, f.designee], ["bob-eternal", null, null, false]);
  for (const [k, v] of Object.entries(brute)) assert.deepEqual(f[k], v, k);
});

test("la doctrine ne dit plus que le médecin écrit (27/09)", () => {
  const doctrine = fs.readFileSync(path.join(repoRacine, "docs/DOCTRINE_FACTEUR.md"), "utf8");
  assert.doesNotMatch(doctrine, /Sa seule écriture/);
  assert.match(doctrine, /valxos-doctor --reap/);
  assert.match(doctrine, /valxos-chaise moissonner/);
});

test("le skill chaise dit la même chose que la doctrine : le doctor rapporte (27/09)", () => {
  const skill = fs.readFileSync(path.join(repoRacine, "skills/chaise/SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /runs at monitor startup, on `valxos-doctor`/);
  assert.doesNotMatch(skill, /monitor also still harvests|runs at monitor startup/);
  assert.match(skill, /`valxos-doctor --reap`/);
  assert.match(skill, /`valxos-chaise moissonner`/);
});
