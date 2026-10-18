// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'ACCUSÉ AUTHENTIFIÉ — on ne signe pas le courrier d'un autre.
//
// Sous A9 (« accusé nul ⇒ la lettre finit toujours par revenir »), `acked_at`
// est la SEULE marque terminale du bureau de poste : toutes les autres finissent
// par se laisser rattraper par le repli, celle-ci jamais. Un accusé posé par la
// mauvaise main ne « dérange » donc pas le destinataire — il fait DISPARAÎTRE sa
// lettre. C'est le geste qui doit être le mieux gardé du dépôt.
//
// Et l'inverse est un défaut du même rang : un geste terminal INATTEIGNABLE fait
// revenir la lettre toutes les dix minutes, pour toujours. Une porte qui ferme
// d'un côté et s'ouvre de l'autre n'est pas une porte — ce fichier prouve les
// DEUX sens, et chaque garde y a son rouge.
//
// Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) :
// le bureau de poste vivant (~/.cc2cc-v2/broker.db) n'est JAMAIS ouvert ici.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  ackMessage,
  getPendingForContext,
  insertMessage,
  markDelivered,
  openDatabase,
  registerPeer,
  unregisterPeer
} from "../src/lib/database.js";
import { migrate } from "../src/lib/migrations.js";
import { adressesDuRepli } from "../src/lib/identity.js";
import {
  deposerAncienNom,
  designatePrimary,
  instanceId,
  registerInstance
} from "../src/lib/registry.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const depot = path.resolve(new URL("..", import.meta.url).pathname);

function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-t7-"));
  poserLeBureau(root);
  return root;
}

function migratedDb(t) {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return db;
}

function accuseDe(db, msgId) {
  return db.prepare("SELECT acked_at FROM messages WHERE msg_id = ?").get(msgId)?.acked_at ?? null;
}

function evenements(db, msgId, type) {
  return db
    .prepare("SELECT * FROM delivery_events WHERE msg_id = ? AND event_type = ? ORDER BY id ASC")
    .all(msgId, type);
}

function refusJournalises(db, msgId) {
  return evenements(db, msgId, "accuse_refuse");
}

// Un refus se prouve sur QUATRE points, jamais sur le seul retour de la fonction :
// il est typé, il n'a rien écrit sur la lettre, il a laissé un reçu, et ce reçu
// NOMME LA GARDE qui a mordu.
//
// Cette dernière assertion n'est pas du zèle : sans elle, deux gardes voisines
// se couvrent l'une l'autre. Retirer « chaise inconnue du registre » laissait
// tout vert — la chaise absente retombait sur « chaise retirée du service »,
// c'est-à-dire un refus juste sous un motif faux. Une garde qu'aucune mutation
// ne fait rougir n'est pas une garde, c'est un commentaire exécutable.
function refuse(db, msgId, signataire, raisonAttendue, pourquoi) {
  const avant = accuseDe(db, msgId);
  const reçusAvant = refusJournalises(db, msgId).length;

  let erreur = null;
  try {
    ackMessage(db, msgId, signataire);
  } catch (e) {
    erreur = e;
  }

  assert.ok(
    erreur,
    `« ${signataire} » a pu accuser ${msgId} : ${pourquoi} — le bureau de poste laisse signer le courrier d'un autre`
  );
  assert.equal(erreur.code, "accuse_refuse", "un refus d'accusé doit être TYPÉ, jamais un échec générique");
  assert.equal(
    erreur.raison,
    raisonAttendue,
    `le refus de « ${signataire} » doit NOMMER sa garde : un motif faux, c'est une garde qu'on croit posée`
  );
  assert.equal(accuseDe(db, msgId), avant, "un accusé refusé ne modifie RIEN : la lettre garde son droit au retour");
  assert.equal(accuseDe(db, msgId), null, "aucun `acked_at` ne doit être posé par un refus (vérifié en base)");

  const reçus = refusJournalises(db, msgId);
  assert.equal(
    reçus.length,
    reçusAvant + 1,
    "un refus se journalise : un refus muet est un état que personne ne saura jamais lire"
  );
  const detailJournal = JSON.parse(reçus[reçus.length - 1].detail_json);
  assert.equal(
    detailJournal.raison,
    raisonAttendue,
    "le journal doit porter la MÊME raison que l'erreur — sinon le reçu raconte autre chose que le refus"
  );
  // Le discriminateur (remède de la revue adverse, dernier item) : deux gardes
  // journalisent sous le MÊME event_type ("accuse_refuse") avec des formes
  // de detail différentes (celle-ci : {destinataire, raison} — la garde PAR
  // LETTRE) — sans lui, un lecteur d'audit ne pouvait pas distinguer un
  // refus d'IDENTITÉ (inbox/history/ack en amont) d'un refus PAR LETTRE
  // (ackMessage lui-même) autrement qu'en devinant à la forme.
  assert.equal(
    detailJournal.refus,
    "accuse-refuse-lettre",
    "la garde PAR LETTRE doit se nommer dans le journal, pas seulement dans l'erreur qu'on jette"
  );
  return erreur;
}

// Le bureau de poste du scénario : la lignée « B » tient une chaise vivante et
// une chaise retirée du service. « A » écrit, « C » regarde.
function bureau(t) {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "A", sessionId: "sess-a" });
  registerInstance(db, { lineage: "B", sessionId: "sess-b-vivante" });
  registerInstance(db, { lineage: "B", sessionId: "sess-b-perimee", status: "offline" });
  registerInstance(db, { lineage: "C", sessionId: "sess-c" });
  return db;
}

// --- LE CŒUR : trois refus, une seule signature valable ---

test("A écrit à B : A échoue, C échoue, une instance périmée échoue — seul B réussit", (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L1", sender: "A", recipient: "B", body: "pour B, et pour B seul" });

  refuse(db, "L1", "A", "neither the recipient nor an instance of the recipient lineage",
    "l'expéditeur n'est pas le destinataire");
  refuse(db, "L1", "C", "neither the recipient nor an instance of the recipient lineage",
    "une session étrangère n'a aucun droit sur ce courrier");
  refuse(db, "L1", instanceId("B", "sess-b-perimee"), "chair retired from service",
    "une instance retirée du service ne lit plus rien");

  // F3 (passe adverse, 28/09) : la lignée « B » mène à SA seule chaise
  // vivante — c'est elle, sous son nom de chaise, qui signe. Le nom de lignée
  // NU n'en tient qu'une copie, désignée ou non.
  refuse(db, "L1", "B", "cc copy: this address leads to a live chair of the lineage. A signer without a chair (a bare name) holds only a copy: only that chair signs, from its own session",
    "le nom de lignée nu ne signe pas la lettre que le guichet mène à une chaise");
  const accusee = ackMessage(db, "L1", instanceId("B", "sess-b-vivante"));
  assert.ok(accusee.acked_at, "le destinataire, lui, signe");
  assert.ok(accuseDe(db, "L1"), "et la signature se lit EN BASE, pas seulement au retour de la fonction");
});

test("une instance EN SERVICE de la lignée destinataire a le droit de signer", (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L2", sender: "A", recipient: "B", body: "adressée à la lignée" });

  const accusee = ackMessage(db, "L2", instanceId("B", "sess-b-vivante"));
  assert.ok(accusee.acked_at, "la chaise vivante lit le courrier de sa lignée — c'est ce que fait le repli");
});

test("une chaise que le registre ne connaît pas ne signe rien, même sous le bon nom de lignée", (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L3", sender: "A", recipient: "B", body: "x" });

  refuse(db, "L3", instanceId("B", "sess-inventee"), "chair unknown to the registry",
    "un nom de chaise s'invente en une ligne : il ne prouve rien");
});

test("un accusé anonyme est refusé : sans nom, personne ne peut être le destinataire", (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L4", sender: "A", recipient: "B", body: "x" });

  refuse(db, "L4", null, "anonymous ack: without a name, nobody is the recipient",
    "un accusé sans signataire retombait sur le destinataire — c'était la porte ouverte");
  refuse(db, "L4", "   ", "anonymous ack: without a name, nobody is the recipient",
    "un nom d'espaces n'est pas un nom");
});

// --- LA PORTE DOIT FERMER DES DEUX CÔTÉS ---
//
// « Une instance retirée du service ne lit plus rien » était vrai pour les
// chaises et faux pour les lignées : l'égalité exacte des noms court-circuitait
// tout contrôle de registre. Une fiche `unregisterPeer`-ée signait encore, tandis
// que sa sœur `lignée#session` était refusée. Le retrait du service se prouve
// donc maintenant sur les DEUX formes de nom.

test("une fiche RETIRÉE DU SERVICE ne signe plus, même sous le nom exact du destinataire", (t) => {
  const db = migratedDb(t);
  registerPeer(db, { id: "bob", description: "maison" });
  insertMessage(db, { msg_id: "L10", sender: "A", recipient: "bob", body: "x" });
  unregisterPeer(db, "bob");

  refuse(db, "L10", "bob", "recipient retired from service",
    "le nom exact court-circuitait le registre : une fiche retirée signait encore");
});

test("une CHAISE retirée du service ne signe pas non plus son propre courrier nominatif", (t) => {
  const db = bureau(t);
  const perimee = instanceId("B", "sess-b-perimee");
  insertMessage(db, { msg_id: "L11", sender: "A", recipient: perimee, body: "nominative" });

  refuse(db, "L11", perimee, "recipient retired from service",
    "son propre nom exact ne rend pas le service à une chaise qui l'a quitté");
});

test("le retrait du service n'enterre aucune lettre : se ré-annoncer rend le droit de signer", (t) => {
  const db = migratedDb(t);
  registerPeer(db, { id: "bob", description: "maison" });
  insertMessage(db, { msg_id: "L12", sender: "A", recipient: "bob", body: "x" });
  unregisterPeer(db, "bob");
  refuse(db, "L12", "bob", "recipient retired from service", "hors service");

  registerPeer(db, { id: "bob", description: "maison" });
  assert.ok(
    ackMessage(db, "L12", "bob").acked_at,
    "A9 : le refus doit être réversible, sinon on a échangé une lettre volée contre une lettre immortelle"
  );
});

// ⚠️ LIMITE DÉCLARÉE, tenue par un test pour qu'on la voie plutôt que de la
// découvrir : une fiche ABSENTE n'est pas une fiche retirée. Le registre ne sait
// rien de ce nom — le courrier d'avant le registre (Camp B) reste accusable sous
// son nom exact. Ce n'est donc PAS une preuve d'existence.
test("LIMITE : un nom qu'aucune fiche ne porte signe encore son propre courrier (Camp B)", (t) => {
  const db = migratedDb(t);
  insertMessage(db, { msg_id: "L13", sender: "A", recipient: "nom-d-avant-le-registre", body: "x" });

  assert.ok(
    ackMessage(db, "L13", "nom-d-avant-le-registre").acked_at,
    "refuser ici perdrait le courrier adressé aux noms hérités : le verrou ne prouve pas l'existence, il refuse le RETRAIT"
  );
});

// --- Une lettre adressée à une CHAISE, signée d'un nom de LIGNÉE ---
//
// Le repli sert à chaque session le courrier de SA chaise (`adressesDuRepli`),
// mais le guichet MCP ne sait dériver qu'un nom de LIGNÉE. Exiger que le registre
// tranche la lignée vers cette chaise-là fermait la porte exactement là où
// l'adressage nominatif sert à quelque chose. Cette porte est donc large — et
// bornée : la lignée du destinataire, et elle seule, à condition qu'elle vive.

test("A9 — la session qui LIT sa lettre nominative peut l'ÉTEINDRE, une sœur vivante dans le décor", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "sess-1" });
  registerInstance(db, { lineage: "alice", sessionId: "sess-2" });
  const chaise = instanceId("alice", "sess-1");
  insertMessage(db, { msg_id: "N1", sender: "A", recipient: chaise, body: "pour la chaise 1" });

  // 1. Le repli de sess-1 va chercher son courrier sous TOUS ses noms.
  const adresses = adressesDuRepli(db, "alice", { session_id: "sess-1" });
  // Run 6, Task 7 (27/09) : sa sœur vit et personne n'est désigné — la lignée
  // est ambiguë, donc tenue : sess-1 n'en voit qu'une copie cc. Sa CHAISE, elle,
  // reste son adresse.
  assert.deepEqual(adresses, [chaise], "le repli cherche sous la chaise ; la lignée ambiguë est tenue");
  const servies = adresses.flatMap((a) => getPendingForContext(db, a).map((r) => r.msg_id));
  assert.deepEqual(servies, ["N1"], "la lettre EST servie à sess-1 : elle la lit");

  // 2. Elle accuse sous sa CHAISE — ce que son guichet MCP dérive de sa fiche
  //    depuis la Task 7. Fix round 2 de la boucle Task 12 : le nom de lignée
  //    NU ne signe plus vers une chaise vivante (porte 3 fermée pour lui).
  refuse(db, "N1", "alice", "cc copy: this address leads to a live chair of the lineage. A signer without a chair (a bare name) holds only a copy: only that chair signs, from its own session", "un nom nu ne signe pas la lettre d'une chaise vivante");
  assert.ok(
    ackMessage(db, "N1", chaise).acked_at,
    "le VRAI destinataire doit pouvoir éteindre sa propre lettre — sinon elle revient toutes les 10 minutes, pour toujours"
  );

  // 3. Onze minutes plus tard, la lettre ne revient plus. C'est le geste terminal.
  const onzeMinutes = new Date(Date.now() + 11 * 60_000).toISOString();
  const retour = adresses.flatMap((a) => getPendingForContext(db, a, { now: onzeMinutes }).map((r) => r.msg_id));
  assert.deepEqual(retour, [], "une lettre accusée ne revient JAMAIS : le geste terminal a bien mordu");
});

// Fix round 2 de la boucle Task 12 : la porte large (une lignée NUE signe pour
// une chaise vivante de sa lignée) est fermée ; son refus se lit au journal.
test("l'accusé d'une lignée NUE pour une chaise vivante est refusé, et le refus se lit au journal", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "alice", sessionId: "sess-1" });
  registerInstance(db, { lineage: "alice", sessionId: "sess-2" });
  insertMessage(db, { msg_id: "N2", sender: "A", recipient: instanceId("alice", "sess-1"), body: "x" });

  refuse(db, "N2", "alice", "cc copy: this address leads to a live chair of the lineage. A signer without a chair (a bare name) holds only a copy: only that chair signs, from its own session", "porte 3 fermée pour un nom nu");
  assert.equal(evenements(db, "N2", "acked").length, 0);
});

test("la lignée signe pour sa chaise quand elle est seule aussi (la porte ne dépend pas du décor)", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "B", sessionId: "sess-unique" });
  insertMessage(db, { msg_id: "L5", sender: "A", recipient: instanceId("B", "sess-unique"), body: "nominative" });

  // Fix round 2 : « B » nu n'est plus cette chaise ; la chaise signe elle-même.
  refuse(db, "L5", "B", "cc copy: this address leads to a live chair of the lineage. A signer without a chair (a bare name) holds only a copy: only that chair signs, from its own session", "un nom nu ne signe pas pour une chaise de session");
  assert.ok(ackMessage(db, "L5", instanceId("B", "sess-unique")).acked_at, "la chaise signe sa lettre nominative");
});

test("une chaise DÉSIGNÉE ne rétrécit pas la porte de sa lignée", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "B", sessionId: "sess-1" });
  registerInstance(db, { lineage: "B", sessionId: "sess-2" });
  designatePrimary(db, "B", "sess-2");
  insertMessage(db, { msg_id: "L6", sender: "A", recipient: instanceId("B", "sess-1"), body: "pour la chaise 1" });

  // Fix round 2 : sess-1 signe sous sa chaise ; « B » nu est refusé.
  refuse(db, "L6", "B", "cc copy: this address leads to a live chair of the lineage. A signer without a chair (a bare name) holds only a copy: only that chair signs, from its own session", "un nom nu ne signe pas pour une chaise de session");
  assert.ok(
    ackMessage(db, "L6", instanceId("B", "sess-1")).acked_at,
    "la désignation route le courrier de la LIGNÉE ; elle ne retire pas à sess-1 le droit d'éteindre le sien"
  );
});

test("une LIGNÉE ÉTRANGÈRE ne signe pas le courrier nominatif d'une autre lignée", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "B", sessionId: "sess-1" });
  registerInstance(db, { lineage: "C", sessionId: "sess-c" });
  insertMessage(db, { msg_id: "L14", sender: "A", recipient: instanceId("B", "sess-1"), body: "x" });

  refuse(db, "L14", "C", "lineage foreign to the recipient chair",
    "la porte large s'arrête au nom de la lignée : elle ne franchit jamais les maisons");
});

test("une lignée dont plus aucune chaise ne répond ne signe rien", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "B", sessionId: "sess-morte", status: "offline" });
  insertMessage(db, { msg_id: "L15", sender: "A", recipient: instanceId("B", "sess-morte"), body: "x" });

  refuse(db, "L15", "B", "lineage without a chair in service",
    "un nom de lignée que plus personne ne porte s'invente aussi facilement qu'un nom de chaise");
});

test("la chaise voisine ne signe pas le courrier nominatif de sa sœur", (t) => {
  const db = migratedDb(t);
  registerInstance(db, { lineage: "B", sessionId: "sess-1" });
  registerInstance(db, { lineage: "B", sessionId: "sess-2" });
  insertMessage(db, { msg_id: "L7", sender: "A", recipient: instanceId("B", "sess-1"), body: "pour la chaise 1" });

  refuse(db, "L7", instanceId("B", "sess-2"), "neither the recipient nor an instance of the recipient lineage",
    "se nommer précisément RÉDUIT son pouvoir : une chaise ne signe que son nom et celui de sa lignée");
});

// --- Le nom qui décide est le nom qui est écrit ---

test("le nom qui TRANCHE est le nom qui est JOURNALISÉ (jamais le brut non trimé)", (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L16", sender: "A", recipient: "B", body: "x" });

  // F3 : la lettre de « B » se signe sous sa chaise (la lignée mène à elle).
  assert.ok(ackMessage(db, "L16", `  ${instanceId("B", "sess-b-vivante")}  `).acked_at, "un nom entouré d'espaces reste le nom du signataire");
  const [acked] = evenements(db, "L16", "acked");
  assert.equal(
    acked.agent_id,
    instanceId("B", "sess-b-vivante"),
    "trancher sur « B » et écrire « ␣␣B␣␣ » au journal, c'est un journal qui ne dit pas ce qui s'est passé"
  );
});

test("un refus journalise le nom trimé aussi, et l'anonyme reste anonyme", (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L17", sender: "A", recipient: "B", body: "x" });

  refuse(db, "L17", "  A  ", "neither the recipient nor an instance of the recipient lineage", "expéditeur");
  refuse(db, "L17", "   ", "anonymous ack: without a name, nobody is the recipient", "anonyme");

  const [ecart, anonyme] = refusJournalises(db, "L17");
  assert.equal(ecart.agent_id, "A");
  assert.equal(anonyme.agent_id, null, "un accusé sans nom n'invente pas de nom au journal");
});

// --- A8/A9 : le refus ne perd rien, l'accusé légitime reste stable ---

// ⏱️ L'HORLOGE EST INJECTÉE, ET C'EST LA SEULE FAÇON DE PROUVER QUOI QUE CE SOIT ICI.
//
// Ce test a longtemps comparé les dates de deux accusés consécutifs. Il était vert,
// et il était vert PAR CHANCE : deux appels qui se suivent tombent dans la même
// milliseconde, donc `acked_at = ?` (la réécriture) rendait exactement la chaîne de
// `COALESCE(acked_at, ?)` (la garde). La mutation ne faisait rougir personne — la
// garde du geste TERMINAL du bureau de poste n'était gardée par rien.
//
// On ne demande donc plus rien à l'horloge murale : une heure sépare les deux
// passages, comme pour la marque du guichet (`markCarried`, test/registry.test.js).
// Un test vert par chance est pire qu'un test absent : on cesse de regarder.
test("un accusé légitime est idempotent : la date du premier passage ne se réécrit JAMAIS", (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L8", sender: "A", recipient: "B", body: "x" });

  const signataire = instanceId("B", "sess-b-vivante"); // F3 : la chaise signe la lettre de sa lignée
  const premier = ackMessage(db, "L8", signataire, { at: "2026-08-13T10:00:00.000Z" });
  const second = ackMessage(db, "L8", signataire, { at: "2026-08-13T11:00:00.000Z" });

  assert.equal(premier.acked_at, "2026-08-13T10:00:00.000Z", "le premier accusé pose SA date");
  assert.equal(
    second.acked_at,
    "2026-08-13T10:00:00.000Z",
    "une heure plus tard, l'accusé porte toujours la date du premier passage — la signature ne se rejoue pas"
  );
  assert.equal(
    accuseDe(db, "L8"),
    "2026-08-13T10:00:00.000Z",
    "et c'est ce que la BASE porte, pas seulement ce que la fonction rend"
  );
});

// L'horloge injectée ne doit pas devenir le seul chemin prouvé : sans `at`, le
// geste réel doit continuer de poser une date, et de ne pas la réécrire.
test("sans horloge fournie, l'accusé pose l'heure du bureau — et ne la reprend pas au destinataire", (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L8b", sender: "A", recipient: "B", body: "x" });

  const signataire = instanceId("B", "sess-b-vivante"); // F3 : la chaise signe la lettre de sa lignée
  const premier = ackMessage(db, "L8b", signataire);
  assert.ok(premier.acked_at, "le chemin nominal horodate bien la signature");

  // Une date d'un an en arrière : un écart qu'aucune horloge ne peut effacer.
  // Si le second passage réécrit, il écrit forcément « aujourd'hui ».
  db.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = 'L8b'").run("2025-08-13T10:00:00.000Z");
  const second = ackMessage(db, "L8b", signataire);

  assert.equal(second.acked_at, "2025-08-13T10:00:00.000Z", "un accusé déjà posé reste celui d'avant, même vieux d'un an");
  assert.equal(accuseDe(db, "L8b"), "2025-08-13T10:00:00.000Z");
});

test("une lettre qui n'existe pas n'est ni accusée ni refusée : elle est absente", (t) => {
  const db = bureau(t);
  assert.equal(ackMessage(db, "L-fantome", "B"), null, "le geste d'avant se garde : absente se dit null");
});

test("après trois refus, la lettre est toujours là — un refus ne perd jamais de courrier (A9)", (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L9", sender: "A", recipient: "B", body: "x" });

  refuse(db, "L9", "A", "neither the recipient nor an instance of the recipient lineage", "expéditeur");
  refuse(db, "L9", "C", "neither the recipient nor an instance of the recipient lineage", "étrangère");
  refuse(db, "L9", instanceId("B", "sess-b-perimee"), "chair retired from service", "périmée");

  const restante = db.prepare("SELECT acked_at FROM messages WHERE msg_id = 'L9'").get();
  assert.equal(restante.acked_at, null, "« accusé nul ⇒ la lettre finit toujours par revenir »");
  assert.equal(refusJournalises(db, "L9").length, 3, "trois refus, trois reçus");
});

// --- LE GUICHET LUI-MÊME ---
//
// Les gardes ci-dessus se prouvent sur la bibliothèque. Le défaut qu'elles
// referment, lui, se produisait au GUICHET : c'est là que l'identité est dérivée,
// et une identité dérivée autrement rend toutes les preuves du dessus muettes.
// On sort donc le serveur pour de vrai — stdio, maison `mkdtemp`, et RIEN que
// l'outil `ack` : jamais `send`, donc aucun socket n'est sollicité.
//
// FORME OBLIGATOIRE : on RÉCOLTE, on FERME, on ASSÈRE APRÈS. Une assertion qui
// lève entre `connect` et `close` laisse l'enfant stdio vivant et fait pendre la
// suite ENTIÈRE — c'est le piège de `test/mcp.test.js`, on ne le reproduit pas.
async function auGuichet(env, travail) {
  const client = new Client({ name: "cc2cc-v2-accuse", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(depot, "src/mcp-server/server.js")],
    env: { ...env, CC2CC_V2_HOME: env.CC2CC_V2_HOME }
  });
  try {
    await client.connect(transport);
    return await travail(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// Fix round 2 de la boucle Task 12 : un guichet SANS fiche ne signe plus vers
// une chaise vivante. Le vrai guichet d'une session a sa fiche
// (`sessions/<ppid>.json` de sa maison) et dérive sa CHAISE (Task 7) : on la
// lui pose. Rend la maison, à passer en CLAUDE_CONFIG_DIR.
function ficheDeSession(root, sessionId) {
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, messagingSocketPath: path.join(maison, "r.sock"), name: "session" }));
  return maison;
}

const appel = async (client, name, args) =>
  JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

test("AU GUICHET — la session éteint sa lettre nominative par le nom qu'elle dérive vraiment", async () => {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  registerInstance(db, { lineage: "alice", sessionId: "sess-1" });
  registerInstance(db, { lineage: "alice", sessionId: "sess-2" });
  insertMessage(db, { msg_id: "G1", sender: "A", recipient: instanceId("alice", "sess-1"), body: "x" });
  db.close();

  // PATH est requis pour retrouver `node` ; CC2CC_SELF vaut la LIGNÉE, et la
  // fiche de session fait dériver la CHAISE sess-1 (Task 7, fix round 2).
  const recolte = await auGuichet(
    { PATH: process.env.PATH, CC2CC_V2_HOME: root, CC2CC_SELF: "alice", CLAUDE_CONFIG_DIR: ficheDeSession(root, "sess-1") },
    (client) => appel(client, "ack", { msg_id: "G1" })
  );

  assert.equal(
    recolte.acked,
    true,
    `le guichet a refusé au VRAI destinataire d'éteindre sa lettre : ${recolte.raison ?? ""}`
  );

  const relu = openDatabase({ file: path.join(root, "broker.db") });
  assert.ok(relu.prepare("SELECT acked_at FROM messages WHERE msg_id='G1'").get().acked_at);
  relu.close();
});

test("AU GUICHET — un refus dit D'OÙ VIENT le nom qu'on lui a opposé", async () => {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  registerInstance(db, { lineage: "alice", sessionId: "sess-1" });
  insertMessage(db, { msg_id: "G2", sender: "A", recipient: "alice", body: "x" });
  db.close();

  // Une maison qui n'exporte NI CC2CC_SELF NI CC2CC_SESSION_NAME — ce que pose
  // `mcp.json` aujourd'hui. Le nom dérivé devient le nom d'hôte, et l'accusé est
  // refusé : le refus doit rendre ce défaut d'installation LISIBLE.
  const recolte = await auGuichet(
    { PATH: process.env.PATH, CC2CC_V2_HOME: root },
    (client) => appel(client, "ack", { msg_id: "G2" })
  );

  assert.equal(recolte.refuse, true, "sans nom dérivé juste, l'accusé ne peut pas passer");
  // fix round 2 (MINOR) : `refuse` (booléen) et `refus` (discriminateur texte,
  // DISTINCT de "accuse-refuse" — la garde d'identité) doivent tenir ENSEMBLE
  // sur cette forme-là, celle du refus PAR LETTRE d'`ackMessage`.
  assert.equal(
    recolte.refus,
    "accuse-refuse-lettre",
    "le refus par lettre porte son propre discriminateur, distinct de celui de la garde d'identité"
  );
  assert.match(
    recolte.origine,
    /^hostname fallback: this house exports none of CC2CC_SELF, CC2CC_SESSION_NAME/,
    "un refus muet sur l'origine du nom envoie l'opérateur chercher le défaut dans la mauvaise maison"
  );
});

test("AU GUICHET — le reçu d'identité déclarée ne s'écrit pas sur une lettre qui n'existe pas", async () => {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  db.close();

  await auGuichet(
    { PATH: process.env.PATH, CC2CC_V2_HOME: root, CC2CC_SELF: "alice" },
    (client) => client.callTool({ name: "ack", arguments: { msg_id: "PAS-DE-LETTRE", self: "intrus" } })
  );

  const relu = openDatabase({ file: path.join(root, "broker.db") });
  const n = relu
    .prepare("SELECT count(*) n FROM delivery_events WHERE msg_id = 'PAS-DE-LETTRE'")
    .get().n;
  relu.close();
  assert.equal(n, 0, "on ne journalise pas la remise d'une lettre qui n'existe pas — ni son accusé");
});

// ════════════════════════════════════════════════════════════════════════════
// LA PORTE DE LA RÉSOLUTION — on signe ce que le guichet nous a fait porter
// ════════════════════════════════════════════════════════════════════════════
//
// Les trois portes du dessus ne connaissent que deux formes d'adresse : le nom
// EXACT, et `lignée#session`. Une lettre adressée à un ANCIEN nom (« alice ») ou
// à une adresse humaine (« claude-alice@atelier ») est livrable — le repli va
// la chercher — et n'entre par aucune des trois. Les deux seules identités
// qu'une session sait dériver toute seule (sa LIGNÉE au guichet MCP, sa CHAISE
// dans les hooks) étaient donc REFUSÉES, et la lettre revenait toutes les dix
// minutes, pour toujours. Une lettre perdue transformée en lettre harcelante.
//
// Le principe : si le guichet a jugé qu'une lettre m'appartient au point de me la
// faire porter, alors j'ai le droit de la signer. Le droit d'accuser se DÉRIVE de
// la même résolution qui a servi à livrer — jamais d'une liste de formes d'adresse
// écrite à côté, qui se désynchronise à la première adresse neuve.

const T0 = "2026-08-13T10:00:00.000Z";
const plusTard = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

// Le bureau de ce soir : la lettre du 22/07 adressée à un nom qui n'existe plus,
// la famille sous son nom d'aujourd'hui, et l'ordre de réexpédition.
function bureauDeCeSoir(t, { sessionName = null } = {}) {
  const db = migratedDb(t);
  insertMessage(db, {
    msg_id: "bob-22-07",
    sender: "bob",
    recipient: "alice",
    body: "La girouette bleue attend le vent du large"
  });
  registerInstance(db, {
    lineage: "claude-alice", sessionId: "sess-ce-soir", house: "/h/work", pid: 111, sessionName
  });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });
  return db;
}

test("CE SOIR — la lettre venue d'un ancien nom s'éteint par la main qui la reçoit, et ne revient plus", (t) => {
  const db = bureauDeCeSoir(t);

  // 1. Le repli la porte : elle est servie sous l'ancien nom, comme prévu.
  const adresses = adressesDuRepli(db, "claude-alice", { session_id: "sess-ce-soir" });
  assert.ok(adresses.includes("alice"), "le repli doit aller chercher le courrier de l'ancien nom");
  const servies = getPendingForContext(db, adresses, { now: T0 }).map((r) => r.msg_id);
  assert.deepEqual(servies, ["bob-22-07"], "la lettre de juillet est bien remise ce soir");
  markDelivered(db, getPendingForContext(db, adresses, { now: T0 }), "claude-alice", "delivered", { at: T0 });

  // 2. LE TÉMOIN : sans accusé, elle reviendrait. Sans cette ligne, les trois
  //    vérifications d'après seraient vertes même si le repli était mort.
  assert.deepEqual(
    getPendingForContext(db, adresses, { now: plusTard(11) }).map((r) => r.msg_id),
    ["bob-22-07"],
    "A9 : tant qu'elle n'est pas accusée, la lettre revient — c'est ce qui rend la suite lisible"
  );

  // 3. Elle s'accuse avec l'identité que la session dérive : sa CHAISE (son
  //    guichet MCP la dérive de sa fiche depuis la Task 7). Fix round 2 : le nom
  //    de lignée NU ne signe plus vers la chaise vivante que l'ancien nom atteint.
  refuse(db, "bob-22-07", "claude-alice", "cc copy: this address leads to a live chair of the lineage. A signer without a chair (a bare name) holds only a copy: only that chair signs, from its own session", "nom nu vers une chaise vivante");
  assert.ok(
    ackMessage(db, "bob-22-07", instanceId("claude-alice", "sess-ce-soir"), { at: T0 }).acked_at,
    "livrée par un ancien nom et inaccusable, la lettre perdue devient une lettre harcelante"
  );

  // 4. Et elle ne revient plus. Jamais.
  for (const minutes of [11, 22, 33]) {
    assert.deepEqual(
      getPendingForContext(db, adresses, { now: plusTard(minutes) }).map((r) => r.msg_id),
      [],
      `+${minutes} min : une lettre accusée ne revient JAMAIS`
    );
  }
});

test("l'autre identité dérivable — la CHAISE — éteint aussi la lettre venue d'un ancien nom", (t) => {
  const db = bureauDeCeSoir(t);

  // Les hooks, eux, dérivent la chaise (`adressesDuRepli`). Les deux identités
  // qu'une session sait produire doivent ouvrir la même porte.
  assert.ok(
    ackMessage(db, "bob-22-07", instanceId("claude-alice", "sess-ce-soir"), { at: T0 }).acked_at,
    "la chaise qui LIT la lettre doit pouvoir l'éteindre : c'est elle qui la reçoit"
  );
});

test("l'accusé venu par la résolution NOMME sa porte au journal", (t) => {
  const db = bureauDeCeSoir(t);
  // Fix round 2 : la chaise signe (le nom nu est refusé vers elle).
  ackMessage(db, "bob-22-07", instanceId("claude-alice", "sess-ce-soir"), { at: T0 });

  const [acked] = evenements(db, "bob-22-07", "acked");
  assert.equal(acked.agent_id, instanceId("claude-alice", "sess-ce-soir"));
  assert.equal(
    JSON.parse(acked.detail_json).titre,
    "the chair the office routes this address to",
    "une porte qu'on ne retrouve pas au journal est une porte qu'on ne surveille plus"
  );
});

test("l'adresse humaine s'accuse par la chaise ; la lignée nue est refusée (fix round 2)", (t) => {
  const db = migratedDb(t);
  registerInstance(db, {
    lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: 111, sessionName: "atelier"
  });
  insertMessage(db, { msg_id: "H1", sender: "bob", recipient: "claude-alice@atelier", body: "x" });
  insertMessage(db, { msg_id: "H2", sender: "bob", recipient: "claude-alice@atelier", body: "x" });

  refuse(db, "H1", "claude-alice", "cc copy: this address leads to a live chair of the lineage. A signer without a chair (a bare name) holds only a copy: only that chair signs, from its own session", "la lignée nue ne signe plus pour sa chaise nommée");
  assert.ok(
    ackMessage(db, "H2", instanceId("claude-alice", "s-1"), { at: T0 }).acked_at,
    "et la chaise nommée signe pour elle-même"
  );
});

// --- ET LA PORTE RESTE FERMÉE POUR LES AUTRES -------------------------------

test("un ANCIEN NOM n'ouvre la porte à personne d'autre : le voisin ne signe toujours pas", (t) => {
  const db = bureauDeCeSoir(t);
  registerInstance(db, { lineage: "bob", sessionId: "s-bob", house: "/h/hermes", pid: 222 });

  refuse(db, "bob-22-07", "bob", "neither the recipient nor an instance of the recipient lineage",
    "une famille voisine n'hérite pas des anciens noms d'une autre");
  refuse(db, "bob-22-07", instanceId("bob", "s-bob"),
    "neither the recipient nor an instance of the recipient lineage",
    "une chaise voisine non plus");
  refuse(db, "bob-22-07", "claude-alice-5", "neither the recipient nor an instance of the recipient lineage",
    "un nom qui ressemble n'est pas un nom qui reçoit");
});

test("une ADRESSE HUMAINE n'ouvre la porte ni à la chaise d'à côté, ni à la famille d'à côté", (t) => {
  const db = migratedDb(t);
  registerInstance(db, {
    lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: 111, sessionName: "atelier"
  });
  registerInstance(db, {
    lineage: "claude-alice", sessionId: "s-2", house: "/h/work", pid: 222, sessionName: "veille"
  });
  registerInstance(db, { lineage: "bob", sessionId: "s-bob", house: "/h/hermes", pid: 333 });
  insertMessage(db, { msg_id: "H3", sender: "bob", recipient: "claude-alice@atelier", body: "x" });

  refuse(db, "H3", instanceId("claude-alice", "s-2"), "neither the recipient nor an instance of the recipient lineage",
    "se nommer précisément RÉDUIT son pouvoir : veille n'est pas atelier");
  refuse(db, "H3", "bob", "neither the recipient nor an instance of the recipient lineage",
    "la porte de la résolution s'arrête à la famille que le guichet a désignée");
});

test("un ancien nom qui ne mène nulle part ne fait signer personne", (t) => {
  const db = migratedDb(t);
  insertMessage(db, { msg_id: "H4", sender: "bob", recipient: "alice", body: "x" });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });
  // Le renvoi est posé, mais « claude-alice » n'a AUCUNE chaise en service.
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-morte", status: "offline" });

  refuse(db, "H4", "claude-alice", "neither the recipient nor an instance of the recipient lineage",
    "un renvoi vers une famille éteinte ne rend le droit de signer à personne");
});

test("AU GUICHET — ce soir, la session éteint la lettre de juillet par le nom qu'elle dérive vraiment", async () => {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  insertMessage(db, {
    msg_id: "bob-22-07", sender: "bob", recipient: "alice", body: "La girouette bleue attend le vent du large"
  });
  registerInstance(db, { lineage: "claude-alice", sessionId: "sess-ce-soir", house: "/h/work", pid: 111 });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });
  db.close();

  // Aucun `self` déclaré : le guichet dérive SEUL son nom — sa chaise, par sa
  // fiche (fix round 2).
  const recolte = await auGuichet(
    { PATH: process.env.PATH, CC2CC_V2_HOME: root, CC2CC_SELF: "claude-alice", CLAUDE_CONFIG_DIR: ficheDeSession(root, "sess-ce-soir") },
    (client) => appel(client, "ack", { msg_id: "bob-22-07" })
  );

  assert.equal(
    recolte.acked,
    true,
    `le guichet a refusé au destinataire d'éteindre la lettre de juillet : ${recolte.raison ?? ""}`
  );

  const relu = openDatabase({ file: path.join(root, "broker.db") });
  const acked = relu.prepare("SELECT acked_at FROM messages WHERE msg_id='bob-22-07'").get().acked_at;
  relu.close();
  assert.ok(acked, "et la signature se lit EN BASE, pas seulement dans la réponse de l'outil");
});

// ── LA RÉPÉTITION GÉNÉRALE ──────────────────────────────────────────────────
//
// Les tests du dessus prouvent les gardes sur la bibliothèque et l'accusé au
// guichet. Celui-ci joue la cérémonie ENTIÈRE avec les vraies pièces, chacune
// dans son propre processus : le hook `PostToolUse` livre, le serveur MCP
// éteint, et la lettre ne revient plus.
//
// ⏱️ L'HORLOGE NE SE DEMANDE PAS AU MONDE. On ne peut pas injecter `now` dans un
// hook qui tourne ailleurs — alors au lieu d'avancer l'horloge de onze minutes,
// on RECULE la marque de la lettre d'autant. La fenêtre de re-service est de dix
// minutes : à −11, −22 et −33, chacun de ces passages ramènerait la lettre si
// l'accusé n'avait pas mordu. C'est ce que le TÉMOIN vérifie avant de signer.
test("RÉPÉTITION GÉNÉRALE — le vrai hook livre, le vrai guichet éteint, et la lettre ne revient plus", async () => {
  const root = tempHome();
  const fichier = path.join(root, "broker.db");
  const db = openDatabase({ file: fichier });
  migrate(db);
  insertMessage(db, {
    msg_id: "bob-22-07", sender: "bob", recipient: "alice",
    body: "La girouette bleue attend le vent du large, ne ferme pas les volets"
  });
  registerInstance(db, { lineage: "claude-alice", sessionId: "sess-ce-soir", house: "/h/work", pid: 111 });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });
  db.close();

  const maison = { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "claude-alice" };

  // Le VRAI hook, dans son propre processus, avec l'entrée qu'il reçoit vraiment.
  const tournee = () => {
    const res = spawnSync("node", [path.join(depot, "src/hooks/piggyback_fetch.js")], {
      input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "sess-ce-soir", cwd: "/w" }),
      encoding: "utf8",
      env: maison
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout).hookSpecificOutput?.additionalContext || "";
  };

  // Reculer la marque de livraison de N minutes : l'équivalent exact d'attendre.
  const reculerDe = (minutes) => {
    const base = openDatabase({ file: fichier });
    base
      .prepare("UPDATE messages SET delivered_at = ? WHERE msg_id = 'bob-22-07'")
      .run(new Date(Date.now() - minutes * 60_000).toISOString());
    base.close();
  };

  // 1. La tournée : la lettre de juillet entre dans le contexte, par l'ancien nom.
  assert.match(tournee(), /girouette bleue/, "le repli doit porter la lettre adressée à « alice »");

  // 2. LE TÉMOIN : onze minutes plus tard, sans accusé, elle revient. C'est A9,
  //    et c'est ce qui rend les trois vérifications de la fin non vides.
  reculerDe(11);
  assert.match(tournee(), /girouette bleue/, "sans accusé, la lettre revient : la fenêtre a bien des dents");

  // 3. Le vrai guichet, SANS `self` : il dérive son nom tout seul — sa chaise,
  //    par sa fiche de session (fix round 2).
  const recolte = await auGuichet(
    { PATH: process.env.PATH, CC2CC_V2_HOME: root, CC2CC_SELF: "claude-alice", CLAUDE_CONFIG_DIR: ficheDeSession(root, "sess-ce-soir") },
    (client) => appel(client, "ack", { msg_id: "bob-22-07" })
  );
  assert.equal(recolte.acked, true, `le guichet a refusé l'accusé : ${recolte.raison ?? ""} (origine ${recolte.origine ?? "?"})`);

  // 4. Et elle ne revient plus, ni à onze, ni à vingt-deux, ni à trente-trois.
  for (const minutes of [11, 22, 33]) {
    reculerDe(minutes);
    assert.equal(tournee(), "", `+${minutes} min : la cérémonie transformerait une lettre perdue en lettre harcelante`);
  }

  const relu = openDatabase({ file: fichier });
  const ligne = relu.prepare("SELECT recipient, acked_at FROM messages WHERE msg_id='bob-22-07'").get();
  relu.close();
  assert.ok(ligne.acked_at, "la signature se lit en base");
  assert.equal(ligne.recipient, "alice", "Camp B : on a changé l'adressage, jamais le courrier");
});
