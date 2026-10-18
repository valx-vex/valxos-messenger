// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { insertMessage, openDatabase } from "../src/lib/database.js";
import { deposerAncienNom, designatePrimary, registerInstance } from "../src/lib/registry.js";
import { procStartOf } from "../src/lib/postbox.js";
import { spawn } from "node:child_process";
import { envPropre, poserLeBureau } from "./aide-env.js";

// ⚠️ LE JETABLE VAUT AUSSI POUR CE PROCESSUS-CI (revue adverse F2, 21/08). Un `file`
// explicite ne protège PAS le bureau vivant : `ensureRuntimeDirs`,
// `writeHeartbeat` et le registre lisent `baseDir()` — donc l'ENV du runner,
// jamais le fichier qu'on vient de leur imposer. Sans ce plancher, les gestes
// EN PROCESSUS de ce fichier écrivaient dans le VRAI ~/.cc2cc-v2 (fiches et
// répertoires constatés le 21/08). Les tests qui posent leur propre racine la
// posent par-dessus ; l'état d'origine se restaure à la fin du fichier.
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-mcp-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});


const repo = path.resolve(new URL("..", import.meta.url).pathname);

// L'ACCUSÉ SE SIGNE — au guichet MCP aussi. Deux transports, un par IDENTITÉ,
// parce qu'un test qui parle sous une seule session et DÉCLARE le nom de
// l'autre ne teste rien : il raconte l'écart qu'on referme, pas la loi. C'était
// exactement le défaut de cette suite avant ce chantier (finding de la revue adverse) — la
// même session (CC2CC_SELF=mcp-a) déclarait `self: "mcp-b"` et signait.
async function connecter(root, self, envEnPlus = {}) {
  const client = new Client({ name: `cc2cc-v2-test-${self}`, version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: {
      ...envPropre(),
      CC2CC_V2_HOME: root,
      CC2CC_SELF: self,
      ...envEnPlus
    }
  });
  await client.connect(transport);
  return client;
}

test("MCP stdio server registers, sends, reads, and acks messages — chaque porte par SA propre session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-mcp-"));
  const a = await connecter(root, "mcp-a");
  const b = await connecter(root, "mcp-b");

  try {
    await a.callTool({ name: "register", arguments: { id: "mcp-a", description: "sender" } });
    await b.callTool({ name: "register", arguments: { id: "mcp-b", description: "receiver" } });

    const sent = await a.callTool({
      name: "send",
      arguments: { from: "mcp-a", to: "mcp-b", subject: "hello", body: "from mcp" }
    });
    const sentJson = JSON.parse(sent.content[0].text);
    assert.equal(sentJson.sent, true);

    // --- L'INTRUS : la session « mcp-a » DÉCLARE être « mcp-b » ---------------
    const inboxIntrus = await a.callTool({ name: "inbox", arguments: { self: "mcp-b" } });
    const inboxIntrusJson = JSON.parse(inboxIntrus.content[0].text);
    assert.equal(inboxIntrusJson.refus, "releve-refusee", "l'intrus ne relève pas le courrier d'autrui");

    const ackIntrus = await a.callTool({
      name: "ack",
      arguments: { self: "mcp-b", msg_id: sentJson.msg_id }
    });
    const ackIntrusJson = JSON.parse(ackIntrus.content[0].text);
    assert.equal(ackIntrusJson.acked, false, "l'intrus ne signe pas");
    assert.equal(ackIntrusJson.refus, "accuse-refuse");
    assert.equal(ackIntrusJson.motif, "only the recipient signs");

    // La même garde couvre `history` : une surface de LECTURE hors famille
    // n'est pas moins une fuite qu'une relève ou un accusé.
    const historyIntrus = await a.callTool({
      name: "history",
      arguments: { self: "mcp-b", peer: "mcp-a" }
    });
    assert.equal(
      JSON.parse(historyIntrus.content[0].text).refus,
      "releve-refusee",
      "l'intrus ne lit pas non plus l'historique d'autrui"
    );

    // La tentative n'a RIEN modifié : la lettre garde son droit au retour (A9).
    const db = openDatabase({ file: path.join(root, "broker.db") });
    try {
      const row = db.prepare("SELECT acked_at FROM messages WHERE msg_id = ?").get(sentJson.msg_id);
      assert.equal(row.acked_at, null, "un refus ne pose jamais d'accusé, même partiel");
    } finally {
      db.close();
    }

    // --- LE DESTINATAIRE, par SA PROPRE porte -------------------------------
    const inbox = await b.callTool({ name: "inbox", arguments: {} });
    const inboxJson = JSON.parse(inbox.content[0].text);
    assert.equal(inboxJson.count, 1);
    assert.equal(inboxJson.messages[0].body, "from mcp");

    const ack = await b.callTool({ name: "ack", arguments: { msg_id: sentJson.msg_id } });
    assert.equal(JSON.parse(ack.content[0].text).acked, true, "le vrai destinataire signe par sa propre session");

    // LE DESTINATAIRE lit SA PROPRE histoire, sans rien déclarer : la garde ne
    // gêne jamais la session dérivée légitime.
    const history = await b.callTool({ name: "history", arguments: { peer: "mcp-a", limit: 5 } });
    const historyJson = JSON.parse(history.content[0].text);
    assert.equal(historyJson.messages.length, 1);
    assert.equal(historyJson.messages[0].etat, "accusée");

    const unregistered = await b.callTool({ name: "unregister", arguments: { id: "mcp-b" } });
    const unregisterJson = JSON.parse(unregistered.content[0].text);
    assert.equal(unregisterJson.unregistered, true);
    assert.equal(unregisterJson.peer.status, "offline");
  } finally {
    await a.close();
    await b.close();
  }
});

// CAMP B EST CONSTITUTIONNEL (décision 20/08) : la voie destructive n'existe
// plus, au schéma ni au handler. `delete_row` est un mot que zod ne connaît
// plus — il l'ignore en silence, comme n'importe quelle clé inconnue — et
// aucun chemin du code ne le lirait de toute façon. La fiche est marquée
// hors service, jamais effacée : le compte des lignes ne descend JAMAIS.
test("unregister avec l'ancien delete_row:true ne supprime plus rien — la fiche survit en offline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-mcp-campb-"));
  const client = await connecter(root, "camp-b");
  try {
    await client.callTool({ name: "register", arguments: { id: "camp-b", description: "chaise à préserver" } });

    const db = openDatabase({ file: path.join(root, "broker.db") });
    const avant = db.prepare("SELECT COUNT(*) AS n FROM peers").get().n;

    const result = await client.callTool({
      name: "unregister",
      arguments: { id: "camp-b", delete_row: true }
    });
    const json = JSON.parse(result.content[0].text);
    assert.equal(json.unregistered, true);
    assert.equal(json.peer.status, "offline", "hors service, pas hors existence");

    const apres = db.prepare("SELECT COUNT(*) AS n FROM peers").get().n;
    assert.equal(apres, avant, "Camp B constitutionnel : le compte des lignes ne descend jamais");

    const row = db.prepare("SELECT * FROM peers WHERE id = ?").get("camp-b");
    assert.ok(row, "la fiche existe toujours — marquée, jamais effacée");
    assert.equal(row.status, "offline");
    db.close();
  } finally {
    await client.close();
  }
});

// --- LA FAMILLE DÉRIVÉE MARCHE TOUJOURS : une lignée relève et accuse pour ---
// --- une chaise DE SA PROPRE lignée (porte 3 de droitDAccuser, réutilisée). --
// FIX ROUND 1 de la boucle Task 12 (revue I-1, 28/09) : la porte large s'est
// refermée pour `inbox` et `ack`. Un serveur SANS fiche (ce « alice » n'en a
// pas) ne déclare plus une chaise : un client sans fiche, refusé en nom nu,
// déclarait la chaise et éteignait la lettre de la vraie session. Fix round 2 :
// `history` aussi (la règle vit en base, dans la vérification du nom déclaré).
test("une lignée SANS fiche ne relève, n'accuse ni ne relit sous une chaise déclarée", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-mcp-famille-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  const chaise = registerInstance(db, { lineage: "alice", sessionId: "sess-chaise-1" }).id;
  db.close();

  const alice = await connecter(root, "alice");
  const etranger = await connecter(root, "etranger");

  try {
    await etranger.callTool({ name: "register", arguments: { id: "etranger", description: "voisin" } });

    const sent = await etranger.callTool({
      name: "send",
      arguments: { from: "etranger", to: chaise, subject: "pour la chaise", body: "nominative" }
    });
    const sentJson = JSON.parse(sent.content[0].text);
    assert.equal(sentJson.sent, true);

    // « alice » (dérivée, CC2CC_SELF=alice, aucune fiche) déclare la chaise
    // de sa lignée : refusé pour la relève comme pour l'accusé.
    const inbox = await alice.callTool({ name: "inbox", arguments: { self: chaise } });
    const inboxJson = JSON.parse(inbox.content[0].text);
    assert.equal(inboxJson.refus, "releve-refusee", "une chaise déclarée sans fiche qui la dérive est refusée");
    assert.equal(inboxJson.messages, undefined);

    const ack = await alice.callTool({ name: "ack", arguments: { self: chaise, msg_id: sentJson.msg_id } });
    const ackJson = JSON.parse(ack.content[0].text);
    assert.equal(ackJson.acked, false, "la lettre de la chaise reste à sa session");
    assert.equal(ackJson.refus, "accuse-refuse");
    const intacte = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
    try {
      assert.equal(intacte.prepare("SELECT acked_at FROM messages WHERE msg_id = ?").get(sentJson.msg_id).acked_at, null);
    } finally {
      intacte.close();
    }

    // `history` aussi (fix round 2) : la règle vit en base, dans la vérification
    // du nom déclaré — un nom nu ne lit pas en propriétaire la chaise vivante.
    const historyFamille = await alice.callTool({
      name: "history",
      arguments: { self: chaise, peer: "etranger", limit: 5 }
    });
    const historyFamilleJson = JSON.parse(historyFamille.content[0].text);
    assert.equal(historyFamilleJson.refus, "releve-refusee", "l'historique d'une chaise vivante n'est pas lu par un nom nu");
    assert.equal(historyFamilleJson.messages, undefined);

    // Et un « voisin » réel (ni la lignée, ni sa chaise) ne le peut pas : la
    // largeur de la porte 3 s'arrête toujours à la lignée destinataire.
    const sent2 = await etranger.callTool({
      name: "send",
      arguments: { from: "etranger", to: chaise, subject: "encore", body: "toujours nominative" }
    });
    const sentJson2 = JSON.parse(sent2.content[0].text);

    const inboxVoisin = await etranger.callTool({ name: "inbox", arguments: { self: chaise } });
    assert.equal(
      JSON.parse(inboxVoisin.content[0].text).refus,
      "releve-refusee",
      "un voisin qui ne porte ni la lignée ni la chaise reste refusé"
    );
    const ackVoisin = await etranger.callTool({ name: "ack", arguments: { self: chaise, msg_id: sentJson2.msg_id } });
    assert.equal(JSON.parse(ackVoisin.content[0].text).acked, false);

    // Le discriminateur dans le JOURNAL, pas seulement dans la réponse
    // (remède de la revue adverse, dernier item) : un refus d'IDENTITÉ (celui-ci,
    // en amont d'`ack`) doit se lire "accuse-refuse" au journal, la MÊME
    // valeur que le `refus` renvoyé à l'appelant.
    const lecture = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
    try {
      const evenement = lecture
        .prepare("SELECT detail_json FROM delivery_events WHERE event_type = 'accuse_refuse' ORDER BY id DESC LIMIT 1")
        .get();
      assert.equal(
        JSON.parse(evenement.detail_json).refus,
        "accuse-refuse",
        "la garde D'IDENTITÉ doit se nommer dans le journal, pas seulement dans la réponse au posteur"
      );
    } finally {
      lecture.close();
    }
  } finally {
    await alice.close();
    await etranger.close();
  }
});

// --- FIX ROUND 1 (IMPORTANT 2) : deux chemins pour LA MÊME identité ne -----
// --- doivent plus rendre deux verdicts opposés. ----------------------------
//
// Avant ce fix : omettre `self` faisait passer par `ensureSelf()`, qui
// RESSUSCITE la fiche (statut posé « active ») avant de lire ; déclarer son
// propre nom EXACT tombait sur la porte 1 de `droitDAccuser` (« destinataire
// retiré du service ») SANS jamais ressusciter personne. Un appelant pouvait
// donc choisir son verdict rien qu'en omettant `self` — la garde d'identité
// elle-même devenait une source d'incohérence.
test("déclarer son propre nom EXACT ne diverge plus du silence — les deux ressuscitent la même fiche", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-mcp-consistance-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { msg_id: "CONS-C", sender: "quelquun", recipient: "explicite", body: "x" });
  insertMessage(db, { msg_id: "CONS-D", sender: "quelquun", recipient: "silencieux", body: "y" });
  db.close();

  const explicite = await connecter(root, "explicite");
  const silencieux = await connecter(root, "silencieux");
  try {
    // Les deux fiches naissent, puis se retirent du service (offline) — le
    // même décor que la porte 1 refusait avant ce fix.
    await explicite.callTool({ name: "register", arguments: { id: "explicite" } });
    await explicite.callTool({ name: "unregister", arguments: { id: "explicite" } });
    await silencieux.callTool({ name: "register", arguments: { id: "silencieux" } });
    await silencieux.callTool({ name: "unregister", arguments: { id: "silencieux" } });

    // [C] déclarer son propre nom EXACT — refusait avant ce fix.
    const viaSelf = await explicite.callTool({ name: "inbox", arguments: { self: "explicite" } });
    const viaSelfJson = JSON.parse(viaSelf.content[0].text);
    assert.equal(
      viaSelfJson.count,
      1,
      "déclarer son propre nom exact ressuscite tout autant que le silence — porte 1 n'achète rien à cette frontière"
    );

    // [D] ne rien déclarer — marchait déjà, sert de témoin inchangé.
    const viaSilence = await silencieux.callTool({ name: "inbox", arguments: {} });
    assert.equal(JSON.parse(viaSilence.content[0].text).count, 1, "le silence ressuscite (témoin, comportement inchangé)");
  } finally {
    await explicite.close();
    await silencieux.close();
  }
});

// ── LA COPIE CC AU GUICHET MCP (Run 6, Task 7) ──────────────────────────────
test("27/09 — MCP : list_peers dit la chaise désignée ; inbox d'une chaise non désignée montre la copie cc ; son ack est refusé", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-mcp-cc-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid });
  registerInstance(db, { lineage: "lignee-t", sessionId: "INST", pid: process.pid });
  designatePrimary(db, "lignee-t", "ALPHA");
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "lignee-t", body: "pour la chaise désignée" });
  db.close();
  const c = await connecter(root, "lignee-t");
  try {
    const peers = JSON.parse((await c.callTool({ name: "list_peers", arguments: {} })).content[0].text);
    const l = peers.lineages.find((x) => x.lineage === "lignee-t");
    assert.equal(l.chaise_designee, "lignee-t#ALPHA");
    assert.equal(l.sans_chaise_designee, false);
    assert.equal(peers.peers.find((p) => p.id === "lignee-t#ALPHA").chaise_designee, true);
    assert.equal(peers.peers.find((p) => p.id === "lignee-t#INST").chaise_designee, false);
    // Task 8 : chaque pair porte sa fiche lisible, sans rien perdre de Task 7.
    for (const p of peers.peers) {
      for (const champ of ["chaise", "nom", "designee"]) assert.ok(champ in p, `${p.id} porte ${champ}`);
    }
    const designee = peers.peers.find((p) => p.id === "lignee-t#ALPHA");
    assert.equal(designee.chaise, "lignee-t#ALPHA");
    assert.equal(designee.designee, true);
    assert.equal(peers.peers.find((p) => p.id === "lignee-t#INST").designee, false);

    // Fix round 1 (revue I-1) : ce client n'a pas de fiche ; il ne relève ni
    // n'accuse sous une chaise déclarée. La copie cc d'une chaise non
    // désignée et son accusé refusé se prouvent avec une vraie fiche (tests
    // « serveur MCP AVEC fiche » plus bas).
    for (const self of ["lignee-t#INST", "lignee-t#ALPHA"]) {
      const inbox = JSON.parse((await c.callTool({ name: "inbox", arguments: { self } })).content[0].text);
      assert.equal(inbox.refus, "releve-refusee", `inbox sous ${self} déclarée`);
      const ack = JSON.parse((await c.callTool({ name: "ack", arguments: { self, msg_id: lettre.msg_id } })).content[0].text);
      assert.equal(ack.acked, false, `ack sous ${self} déclarée`);
      assert.equal(ack.refus, "accuse-refuse");
    }
  } finally {
    await c.close();
  }
});

// ── FIX ROUND 1 : LE GUICHET MCP DÉRIVE SA CHAISE (Run 6, Task 7) ───────────
// Le serveur MCP est lancé par le harnais de la session : son parent est le
// même processus que celui des hooks, et la fiche `sessions/<ppid>.json` de la
// maison dit sa session. Ici le serveur est lancé par CE runner : sa fiche est
// celle de `process.pid` (le même geste que les tests de hooks).
const outil = async (c, name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);
function bureauMcp(prefixe) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  return { root, maison, ouvrir: () => openDatabase({ file: path.join(root, "broker.db") }) };
}
function ficheDuRunner(maison, sessionId) {
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, messagingSocketPath: path.join(maison, "r.sock"), name: "runner" }));
}

test("27/09 fix 1 — sonde 7 : un client MCP SANS fiche (lignée nue) ne signe pas la lettre de la lignée tenue par la chaise désignée", async () => {
  const { root, ouvrir } = bureauMcp("cc2cc-v2-mcp-sonde7-");
  const db = ouvrir();
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid });
  registerInstance(db, { lineage: "lignee-t", sessionId: "INST", pid: process.pid });
  designatePrimary(db, "lignee-t", "ALPHA");
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "lignee-t", body: "pour la chaise désignée" });
  db.close();
  const c = await connecter(root, "lignee-t");
  try {
    const inbox = await outil(c, "inbox");
    assert.equal(inbox.count, 0, "la lettre de la lignée n'est pas au client nu");
    assert.equal(inbox.copies.length, 1);
    assert.equal(inbox.copies[0].cc, true);
    assert.equal(inbox.copies[0].chaise_designee, "lignee-t#ALPHA");
    const ack = await outil(c, "ack", { msg_id: lettre.msg_id });
    assert.equal(ack.acked, false, "la porte 1 ne s'ouvre plus sur la lettre d'une autre chaise");
    assert.match(ack.raison, /cc copy/);
    assert.ok(!ack.raison.includes("lignee-t#ALPHA"), "le refus ne nomme pas la chaise (fix round 1)");
    const ackDeclare = await outil(c, "ack", { msg_id: lettre.msg_id, self: "lignee-t" });
    assert.equal(ackDeclare.acked, false, "déclarer la lignée nue ne rouvre pas la porte");
    const verif = ouvrir();
    assert.equal(verif.prepare("SELECT acked_at, delivered_at FROM messages WHERE msg_id = ?").get(lettre.msg_id).acked_at, null);
    assert.equal(verif.prepare("SELECT delivered_at FROM messages WHERE msg_id = ?").get(lettre.msg_id).delivered_at, null, "une copie n'est pas une livraison");
    verif.close();
  } finally {
    await c.close();
  }
});

test("27/09 fix 1 — serveur MCP AVEC fiche, chaise désignée : whoami rend la chaise, inbox livre, ack signe", async () => {
  const { root, maison, ouvrir } = bureauMcp("cc2cc-v2-mcp-fiche-a-");
  ficheDuRunner(maison, "ALPHA");
  const db = ouvrir();
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid, house: maison });
  registerInstance(db, { lineage: "lignee-t", sessionId: "INST", pid: process.pid });
  designatePrimary(db, "lignee-t", "ALPHA");
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "lignee-t", body: "pour la chaise désignée" });
  const nominative = insertMessage(db, { sender: "bob-eternal", recipient: "lignee-t#ALPHA", body: "à la chaise désignée par son nom" });
  db.close();
  const c = await connecter(root, "lignee-t", { CLAUDE_CONFIG_DIR: maison });
  try {
    assert.equal((await outil(c, "whoami")).id, "lignee-t#ALPHA");
    assert.equal((await outil(c, "list_peers")).self, "lignee-t#ALPHA");
    const inbox = await outil(c, "inbox");
    assert.equal(inbox.self, "lignee-t#ALPHA");
    assert.deepEqual(inbox.messages.map((m) => m.msg_id).sort(), [lettre.msg_id, nominative.msg_id].sort());
    assert.deepEqual(inbox.copies, []);
    assert.equal((await outil(c, "ack", { msg_id: lettre.msg_id })).acked, true);
    assert.equal((await outil(c, "ack", { msg_id: nominative.msg_id, self: "lignee-t" })).acked, true,
      "la lignée nue déclarée se résout à la chaise");
    const envoi = await outil(c, "send", { to: "bob-eternal", body: "réponse" });
    const verif = ouvrir();
    assert.equal(verif.prepare("SELECT sender FROM messages WHERE msg_id = ?").get(envoi.msg_id).sender, "lignee-t#ALPHA");
    verif.close();
  } finally {
    await c.close();
  }
});

test("27/09 fix 1 — serveur MCP AVEC fiche, une AUTRE chaise désignée : inbox montre la copie cc, ack refusé", async () => {
  const { root, maison, ouvrir } = bureauMcp("cc2cc-v2-mcp-fiche-b-");
  ficheDuRunner(maison, "INST");
  const db = ouvrir();
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid });
  registerInstance(db, { lineage: "lignee-t", sessionId: "INST", pid: process.pid, house: maison });
  designatePrimary(db, "lignee-t", "ALPHA");
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "lignee-t", body: "pour la chaise désignée" });
  db.close();
  const c = await connecter(root, "lignee-t", { CLAUDE_CONFIG_DIR: maison });
  try {
    assert.equal((await outil(c, "whoami")).id, "lignee-t#INST");
    const inbox = await outil(c, "inbox", { self: "lignee-t" });
    assert.equal(inbox.self, "lignee-t#INST", "la lignée nue déclarée est résolue à la chaise, jamais crue comme lignée");
    assert.equal(inbox.count, 0);
    assert.equal(inbox.copies.length, 1);
    assert.equal(inbox.copies[0].chaise_designee, "lignee-t#ALPHA");
    for (const args of [{ msg_id: lettre.msg_id }, { msg_id: lettre.msg_id, self: "lignee-t" }]) {
      const ack = await outil(c, "ack", args);
      assert.equal(ack.acked, false);
      assert.match(ack.raison, /cc copy/);
    }
  } finally {
    await c.close();
  }
});

test("27/09 fix 1 — client MCP SOLO sans fiche (aucune autre chaise de sa lignée) : inbox livre, ack signe — inchangé", async () => {
  const { root, ouvrir } = bureauMcp("cc2cc-v2-mcp-solo-");
  const db = ouvrir();
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "client-solo", body: "pour toi" });
  db.close();
  // Une maison déclarée qui n'existe pas : rien ne lève, repli sur la lignée nue.
  const c = await connecter(root, "client-solo", { CLAUDE_CONFIG_DIR: path.join(root, "maison-absente") });
  try {
    assert.equal((await outil(c, "whoami")).id, "client-solo");
    const inbox = await outil(c, "inbox");
    assert.equal(inbox.count, 1);
    assert.equal(inbox.messages[0].msg_id, lettre.msg_id);
    assert.equal(inbox.copies, undefined, "aucune copie : la forme d'avant, à l'octet");
    assert.equal((await outil(c, "ack", { msg_id: lettre.msg_id })).acked, true);
  } finally {
    await c.close();
  }
});

test("27/09 fix 2 (F3 28/09) — fiche présente mais chaise tenue par un AUTRE processus vivant confirmé (jumeau) : aucune identité, refus journalisé UNE fois", async (t) => {
  const { root, maison, ouvrir } = bureauMcp("cc2cc-v2-mcp-jumeau-");
  const autre = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => { try { autre.kill("SIGKILL"); } catch { /* déjà parti */ } });
  const naissance = procStartOf(autre.pid);
  assert.ok(naissance, "sonde impossible : ps n'a pas rendu d'heure de naissance");
  ficheDuRunner(maison, "ALPHA");
  const db = ouvrir();
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: autre.pid, procStart: naissance, house: maison });
  db.close();
  const c = await connecter(root, "lignee-t", { CLAUDE_CONFIG_DIR: maison });
  try {
    // F3 (passe adverse, 28/09) : le jumeau ne parle ni en chaise, ni en
    // lignée nue — la lignée nue lui rendait la boîte de la vraie session.
    const qui = await outil(c, "whoami");
    assert.equal(qui.id, null, "le jumeau n'a pas d'identité au guichet");
    assert.equal(qui.refus, "chaise-refusee");
    assert.equal(qui.raison, "jumeau");
    assert.equal((await outil(c, "whoami")).id, null);
  } finally {
    await c.close();
  }
  const journal = path.join(root, "logs", "lignee-t.log");
  const refus = fs.existsSync(journal)
    ? fs.readFileSync(journal, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.message === "chaise_refusee")
    : [];
  assert.equal(refus.length, 1, "un refus par clef, pas un par appel");
  assert.equal(refus[0].raison, "jumeau");
  assert.equal(refus[0].session_id, "ALPHA");
  assert.equal(refus[0].agent_id, null);
  assert.equal(refus[0].pid, process.pid);
  assert.equal(fs.readdirSync(path.join(root, "run", "chaises-refusees")).length, 1, "une seule marque exclusive");
  const verif = ouvrir();
  assert.equal(verif.prepare("SELECT pid FROM peers WHERE id = 'lignee-t#ALPHA'").get().pid, autre.pid, "le jumeau ne prend pas la chaise");
  verif.close();
});

// ── ALWAYSLOAD (1.0.0) ───────────────────────────────────────────────────────
// Claude Code ≥ 2.1.287 diffère les outils MCP derrière la recherche d'outils.
// Les hooks et les skills demandent au modèle d'appeler `inbox`, `send` et
// `ack` sans détour : seuls ces trois-là portent la marque ; les six autres
// restent différables, et un outil de plus marqué par mégarde se verrait ici.
test("tools/list : inbox, send et ack portent _meta anthropic/alwaysLoad, les six autres non", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-mcp-alwaysload-"));
  const c = await connecter(root, "always-load");
  try {
    const { tools } = await c.listTools();
    const parNom = new Map(tools.map((tool) => [tool.name, tool]));
    const toujoursCharges = ["inbox", "send", "ack"];
    const differables = ["whoami", "register", "list_peers", "unregister", "broadcast", "history"];

    assert.deepEqual(
      [...parNom.keys()].sort(),
      [...toujoursCharges, ...differables].sort(),
      "SONDE IMPOSSIBLE sinon : la liste d'outils n'est plus les neuf attendus"
    );
    for (const nom of toujoursCharges) {
      assert.equal(parNom.get(nom)._meta?.["anthropic/alwaysLoad"], true, `${nom} est toujours chargé`);
    }
    for (const nom of differables) {
      assert.ok(
        !(parNom.get(nom)._meta && "anthropic/alwaysLoad" in parNom.get(nom)._meta),
        `${nom} reste différable : aucune marque alwaysLoad`
      );
    }
  } finally {
    await c.close();
  }
});

// ── J1 (jury, 18/10) : `from` = UNE ADRESSE QUI MÈNE À L'APPELANT ───────────
// `expediteurVerifie` rendait `sender: declare` même quand le `from` déclaré se
// résolvait à l'appelant lui-même : son adresse humaine (`lignée@nom`) ou un
// ancien nom. La clef ne se jugeait alors plus « à soi » — `estAMoi` ne connaît
// que le nom DÉRIVÉ et, pour une chaise, sa lignée — et `posterSousUneClefASoi`
// reposait la lettre sous une clef neuve avant de lever `clef_indisponible` :
// deux lettres au destinataire, une erreur à l'appelant (mesuré : deux lignes
// par appel, quatre après un renvoi). La lettre part maintenant sous l'identité
// DÉRIVÉE, exactement comme sans `from` ; seule la lignée nue d'une chaise reste
// honorée telle quelle, parce que `estAMoi` la connaît.
test("J1 — send avec from = l'adresse humaine ou un ancien nom de l'appelant : UNE lettre, sous l'identité dérivée, sans erreur ; un renvoi ne la double pas", async () => {
  const { root, maison, ouvrir } = bureauMcp("cc2cc-v2-mcp-j1-");
  // La fiche de session du runner se nomme « runner » : l'adresse humaine de la chaise est donc lignee-t@runner.
  ficheDuRunner(maison, "ALPHA");
  const db = ouvrir();
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid, house: maison, sessionName: "runner" });
  deposerAncienNom(db, "ancien-t", "lignee-t");
  db.close();
  const c = await connecter(root, "lignee-t", { CLAUDE_CONFIG_DIR: maison });
  // Une erreur d'outil n'est pas du JSON : on la rend telle quelle pour qu'une
  // régression se lise dans le message du test.
  const appeler = async (name, args) => {
    const r = await c.callTool({ name, arguments: args });
    return r.isError ? { erreur: r.content[0].text } : JSON.parse(r.content[0].text);
  };
  const lignes = (corps) => {
    const v = ouvrir();
    try {
      return v.prepare("SELECT msg_id, sender, recipient FROM messages WHERE body = ? ORDER BY seq").all(corps);
    } finally {
      v.close();
    }
  };
  try {
    assert.equal((await outil(c, "whoami")).id, "lignee-t#ALPHA");
    for (const [nom, from] of [["adresse humaine", "lignee-t@runner"], ["ancien nom", "ancien-t"]]) {
      const corps = `J1 ${nom}`;
      const envoi = await appeler("send", { to: "bob-eternal", from, body: corps });
      assert.equal(envoi.sent, true, `${nom} : pas d'erreur — ${JSON.stringify(envoi)}`);
      assert.deepEqual(
        lignes(corps).map((l) => [l.sender, l.recipient]),
        [["lignee-t#ALPHA", "bob-eternal"]],
        `${nom} : exactement une ligne, sous l'identité dérivée`
      );
      // Le renvoi sous la même clef ne crée toujours qu'une ligne.
      const renvoi = await appeler("send", { to: "bob-eternal", from, body: corps, msg_id: envoi.msg_id });
      assert.equal(renvoi.sent, true, `${nom} : le renvoi aussi — ${JSON.stringify(renvoi)}`);
      assert.equal(renvoi.msg_id, envoi.msg_id, `${nom} : sous la même clef`);
      assert.equal(lignes(corps).length, 1, `${nom} : le renvoi ne double pas la lettre`);
    }
    // Ce qui marchait reste tel quel : la lignée nue de la chaise, déclarée, est
    // honorée (une ligne, expéditeur = la lignée), et sans `from` c'est la chaise.
    const nue = await appeler("send", { to: "bob-eternal", from: "lignee-t", body: "J1 lignée nue" });
    assert.equal(nue.sent, true, JSON.stringify(nue));
    assert.deepEqual(lignes("J1 lignée nue").map((l) => l.sender), ["lignee-t"], "la lignée nue d'une chaise reste honorée");
    const sans = await appeler("send", { to: "bob-eternal", body: "J1 sans from" });
    assert.deepEqual(lignes("J1 sans from").map((l) => l.sender), ["lignee-t#ALPHA"], "sans from : la valeur dérivée");

    // `broadcast` partage la vérification : la diffusion part de la chaise, et
    // ne s'adresse plus à la lignée de l'expéditeur lui-même.
    await outil(c, "register", { id: "bob-eternal", description: "destinataire de la diffusion" });
    const diffusion = await appeler("broadcast", { from: "lignee-t@runner", body: "J1 diffusion" });
    assert.equal(diffusion.broadcast, true, JSON.stringify(diffusion));
    assert.deepEqual(diffusion.results.map((r) => r.to), ["bob-eternal"], "pas de lettre à sa propre lignée");
    assert.deepEqual(lignes("J1 diffusion").map((l) => l.sender), ["lignee-t#ALPHA"], "la diffusion part de la chaise");
  } finally {
    await c.close();
  }
});
