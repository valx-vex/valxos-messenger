// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// RÉPONDRE EST UN GESTE DU MESSENGER, PAS UNE ADRESSE À RETAPER (1.1.0, Q1 = A).
// `reply` lit la lettre et répond à son auteur — sa chaise quand elle est
// connue — dans le même fil, avec `reponse_a`. « Toute la table » est un choix
// explicite ; en mode direct, c'est le défaut, et la réaction ne réveille personne.
//
// ⚠️ Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME),
// garde du bureau vivant posée pour le runner et pour chaque serveur enfant.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { getCopiesPourChaise, insertMessage, openDatabase, registerPeer } from "../src/lib/database.js";
import { ajouterMembre, creerTable, poserEnclos, retirerMembre } from "../src/lib/tables.js";
import { designatePrimary, registerInstance } from "../src/lib/registry.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
const GARDE_INITIALE = process.env.CC2CC_GARDE_BUREAU;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-reply-plancher-")));
process.env.CC2CC_GARDE_BUREAU = "1";
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
  if (GARDE_INITIALE === undefined) delete process.env.CC2CC_GARDE_BUREAU;
  else process.env.CC2CC_GARDE_BUREAU = GARDE_INITIALE;
});

const repo = path.resolve(new URL("..", import.meta.url).pathname);

async function connecter(root, self, envEnPlus = {}) {
  const client = new Client({ name: `valxos-reply-test-${self}`, version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: self, ...envEnPlus }
  });
  await client.connect(transport);
  return client;
}

const outil = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return r.isError ? { erreur: r.content[0].text } : JSON.parse(r.content[0].text);
};

// Deux tables ouvertes (alice, bob, carol) : « famille-test » en mode normal,
// « film-test » en mode direct.
function bureauDuFil(prefixe) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  creerTable(db, { nom: "famille-test", creeePar: "alice" });
  creerTable(db, { nom: "film-test", mode: "direct", creeePar: "alice" });
  for (const nom of ["famille-test", "film-test"]) {
    for (const membre of ["alice", "bob", "carol"]) ajouterMembre(db, nom, membre, { ajoutePar: "alice" });
  }
  db.close();
  return { root, ouvrir: () => openDatabase({ file: path.join(root, "broker.db") }) };
}

function ligne(ouvrir, msgId) {
  const db = ouvrir();
  try {
    return db.prepare("SELECT * FROM messages WHERE msg_id = ?").get(msgId);
  } finally {
    db.close();
  }
}

// ── 1. LA RÉPONSE REVIENT À L'AUTEUR, DANS SON FIL, AVEC reponse_a ───────────
test("reply à une lettre directe : à l'auteur, thread_id = la lettre (ou son fil), reponse_a, msg_type response, sujet repris", async () => {
  const { root, ouvrir } = bureauDuFil("valxos-reply-direct-");
  const alice = await connecter(root, "alice");
  const bob = await connecter(root, "bob");
  try {
    const lettre = await outil(alice, "send", { to: "bob", subject: "hello", body: "how are you" });
    const reponse = await outil(bob, "reply", { msg_id: lettre.msg_id, body: "fine" });
    assert.equal(reponse.sent, true, JSON.stringify(reponse));
    assert.equal(reponse.reponse_a, lettre.msg_id);
    assert.equal(reponse.recipient, "alice");
    assert.equal(reponse.thread_id, lettre.msg_id, "sans fil, le fil est la lettre elle-même");
    assert.ok("wake" in reponse);
    const enBase = ligne(ouvrir, reponse.msg_id);
    assert.equal(enBase.sender, "bob");
    assert.equal(enBase.recipient, "alice");
    assert.equal(enBase.msg_type, "response");
    assert.equal(enBase.reponse_a, lettre.msg_id);
    assert.equal(enBase.thread_id, lettre.msg_id);
    assert.equal(enBase.subject, "hello", "le sujet de la lettre est repris par défaut");
    assert.equal(enBase.table_nom, null);
    assert.equal(enBase.envoi_id, null);

    // Un fil existant est suivi ; un sujet et une priorité donnés sont honorés.
    const dansUnFil = await outil(alice, "send", { to: "bob", subject: "thread", body: "x", thread_id: "fil-1" });
    const suite = await outil(bob, "reply", { msg_id: dansUnFil.msg_id, body: "y", subject: "re: thread", priority: "high" });
    assert.equal(suite.thread_id, "fil-1");
    assert.equal(ligne(ouvrir, suite.msg_id).subject, "re: thread");
    assert.equal(ligne(ouvrir, suite.msg_id).priority, "high");

    // Une réponse va toujours à l'AUTEUR de la lettre : alice qui « répond » à
    // sa propre lettre s'écrit à elle-même — permis (elle en est l'expéditrice).
    const aSoi = await outil(alice, "reply", { msg_id: lettre.msg_id, body: "note to self" });
    assert.equal(aSoi.sent, true, JSON.stringify(aSoi));
    assert.equal(aSoi.recipient, "alice");
  } finally {
    await alice.close();
    await bob.close();
  }
});

// ── 1 bis. L'AUTEUR, C'EST SA CHAISE QUAND ELLE EST CONNUE ───────────────────
test("reply à une lettre postée par une chaise : la réponse va à la chaise (sender_chaise), pas à la lignée nue", async () => {
  const { root, ouvrir } = bureauDuFil("valxos-reply-chaise-");
  const prepare = ouvrir();
  const lettre = insertMessage(prepare, { sender: "alice", sender_chaise: "alice#S1", recipient: "bob", subject: "from a chair", body: "hi" });
  prepare.close();
  const bob = await connecter(root, "bob");
  try {
    const reponse = await outil(bob, "reply", { msg_id: lettre.msg_id, body: "to the chair" });
    assert.equal(reponse.sent, true, JSON.stringify(reponse));
    assert.equal(reponse.recipient, "alice#S1");
    assert.equal(ligne(ouvrir, reponse.msg_id).recipient, "alice#S1");
  } finally {
    await bob.close();
  }
});

// ── 2. LETTRE DE TABLE EN MODE NORMAL : à l'auteur par défaut, toute la table sur demande ─
test("reply à une lettre de table (mode normal) : à l'auteur seul par défaut ; toute_la_table: true répond à chaque membre, dans le fil de l'envoi", async () => {
  const { root, ouvrir } = bureauDuFil("valxos-reply-table-normale-");
  const alice = await connecter(root, "alice");
  const bob = await connecter(root, "bob");
  try {
    const envoi = await outil(alice, "send", { to: "table:famille-test", subject: "Beat 7", body: "the beat" });
    const pourBob = envoi.results.find((r) => r.to === "bob");

    const aLAuteur = await outil(bob, "reply", { msg_id: pourBob.msg_id, body: "nice beat" });
    assert.equal(aLAuteur.sent, true, JSON.stringify(aLAuteur));
    assert.equal(aLAuteur.recipient, "alice");
    assert.equal(aLAuteur.envoi_id, undefined, "à l'auteur seul : pas un envoi de table");
    assert.equal(aLAuteur.thread_id, envoi.envoi_id, "le fil de la lettre de table est l'envoi_id de l'envoi");
    assert.equal(ligne(ouvrir, aLAuteur.msg_id).reponse_a, pourBob.msg_id);

    const aToute = await outil(bob, "reply", { msg_id: pourBob.msg_id, body: "for everyone", toute_la_table: true });
    assert.equal(aToute.sent, true, JSON.stringify(aToute));
    assert.equal(aToute.reponse_a, pourBob.msg_id);
    assert.equal(aToute.table.nom, "famille-test");
    assert.equal(aToute.count, 2);
    assert.deepEqual(aToute.results.map((r) => r.to).sort(), ["alice", "carol"]);
    for (const r of aToute.results) {
      assert.equal(r.sans_reveil, false, "mode normal : une réponse réveille comme une lettre");
      assert.equal(r.motif_reveil, "table");
      const enBase = ligne(ouvrir, r.msg_id);
      assert.equal(enBase.reponse_a, pourBob.msg_id);
      assert.equal(enBase.thread_id, envoi.envoi_id);
      assert.equal(enBase.table_nom, "famille-test");
      assert.equal(enBase.envoi_id, aToute.envoi_id);
      assert.equal(enBase.msg_type, "response");
    }
    assert.notEqual(aToute.envoi_id, envoi.envoi_id, "une réponse à toute la table est un envoi à part, dans le même fil");
  } finally {
    await alice.close();
    await bob.close();
  }
});

// ── 3. MODE DIRECT : la réaction part à toute la table, sans réveiller personne ─
test("reply dans une table en mode direct : toute la table par défaut, calme (reaction-directe) ; reveiller et high réveillent ; toute_la_table: false ramène à l'auteur", async () => {
  const { root, ouvrir } = bureauDuFil("valxos-reply-table-directe-");
  const alice = await connecter(root, "alice");
  const bob = await connecter(root, "bob");
  try {
    const beat = await outil(alice, "send", { to: "table:film-test", subject: "Beat 7", body: "the beat" });
    const pourBob = beat.results.find((r) => r.to === "bob");
    assert.equal(pourBob.sans_reveil, false, "le beat lui-même réveille : ce n'est pas une réaction");

    const reaction = await outil(bob, "reply", { msg_id: pourBob.msg_id, body: "haha" });
    assert.equal(reaction.sent, true, JSON.stringify(reaction));
    assert.equal(reaction.count, 2, "en direct, le défaut est toute la table");
    assert.deepEqual(reaction.results.map((r) => r.to).sort(), ["alice", "carol"]);
    for (const r of reaction.results) {
      assert.equal(r.sans_reveil, true, "une réaction ne réveille personne");
      assert.equal(r.motif_reveil, "reaction-directe");
      assert.equal(r.wake?.skipped, "sans-reveil", "le guichet n'a pas frappé à la socket");
      assert.equal(Number(ligne(ouvrir, r.msg_id).sans_reveil), 1);
    }

    const mention = await outil(bob, "reply", { msg_id: pourBob.msg_id, body: "carol, look", reveiller: ["carol"] });
    assert.equal(mention.results.find((r) => r.to === "carol").sans_reveil, false, "une mention sonne");
    assert.equal(mention.results.find((r) => r.to === "carol").motif_reveil, "mention");
    assert.equal(mention.results.find((r) => r.to === "alice").sans_reveil, true);

    const urgente = await outil(bob, "reply", { msg_id: pourBob.msg_id, body: "stop the film", priority: "high" });
    for (const r of urgente.results) {
      assert.equal(r.sans_reveil, false, "high réveille toujours, mode direct compris");
      assert.equal(r.motif_reveil, "priorite-haute");
    }

    const aLAuteur = await outil(bob, "reply", { msg_id: pourBob.msg_id, body: "just for you", toute_la_table: false });
    assert.equal(aLAuteur.recipient, "alice");
    assert.equal(aLAuteur.envoi_id, undefined);
    assert.equal(aLAuteur.wake?.skipped, undefined, "à l'auteur seul, la réponse réveille comme une lettre");
  } finally {
    await alice.close();
    await bob.close();
  }
});

// ── 4. LES REFUS : lettre inconnue, pas destinataire, toute la table sans table ─
test("reply refuse — lettre-inconnue, pas-destinataire (ni destinataire ni auteur), toute-la-table-sans-table — et n'écrit rien", async () => {
  const { root, ouvrir } = bureauDuFil("valxos-reply-refus-");
  const alice = await connecter(root, "alice");
  const bob = await connecter(root, "bob");
  const carol = await connecter(root, "carol");
  try {
    const lettre = await outil(alice, "send", { to: "bob", subject: "private", body: "between us" });
    const avant = ligne(ouvrir, lettre.msg_id).seq;

    const inconnue = await outil(bob, "reply", { msg_id: "msg-nulle-part", body: "x" });
    assert.equal(inconnue.sent, false, JSON.stringify(inconnue));
    assert.equal(inconnue.refus, "lettre-inconnue");

    const intruse = await outil(carol, "reply", { msg_id: lettre.msg_id, body: "me too" });
    assert.equal(intruse.sent, false, JSON.stringify(intruse));
    assert.equal(intruse.refus, "pas-destinataire");

    const sansTable = await outil(bob, "reply", { msg_id: lettre.msg_id, body: "x", toute_la_table: true });
    assert.equal(sansTable.sent, false, JSON.stringify(sansTable));
    assert.equal(sansTable.refus, "toute-la-table-sans-table");

    const db = ouvrir();
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE seq > ?").get(avant).n, 0, "trois refus, zéro lettre");
    } finally {
      db.close();
    }
  } finally {
    await alice.close();
    await bob.close();
    await carol.close();
  }
});

// ── 5. L'ENCLOS, LA TABLE QU'ON A QUITTÉE, LA PANNE EN CHEMIN ────────────────
test("reply sous enclos : refusé avant toute écriture vers un auteur hors de la table fermée ; hors_enclos: true le laisse sortir", async () => {
  const { root, ouvrir } = bureauDuFil("valxos-reply-enclos-");
  const prepare = ouvrir();
  creerTable(prepare, { nom: "office-test", fermee: true, creeePar: "alice" });
  for (const membre of ["alice", "hal-test"]) ajouterMembre(prepare, "office-test", membre, { ajoutePar: "alice" });
  poserEnclos(prepare, "hal-test", "office-test", { posePar: "operator" });
  const lettre = insertMessage(prepare, { sender: "bob", recipient: "hal-test", subject: "outside", body: "hi hal" });
  prepare.close();
  const hal = await connecter(root, "hal-test");
  try {
    const refuse = await outil(hal, "reply", { msg_id: lettre.msg_id, body: "can I answer?" });
    assert.equal(refuse.sent, false, JSON.stringify(refuse));
    assert.equal(refuse.refus, "hors-enclos");
    assert.equal(refuse.enclos, "office-test");
    assert.deepEqual(refuse.destinataires_refuses, ["bob"]);
    assert.equal(ligneCount(ouvrir), 1, "seule la lettre de bob existe");
    const sortie = await outil(hal, "reply", { msg_id: lettre.msg_id, body: "yes, on purpose", hors_enclos: true });
    assert.equal(sortie.sent, true, JSON.stringify(sortie));
    assert.equal(sortie.recipient, "bob");
  } finally {
    await hal.close();
  }
});

test("reply toute_la_table à une table qu'on a quittée : pas-membre, rien d'écrit ; à l'auteur seul, la réponse part", async () => {
  const { root, ouvrir } = bureauDuFil("valxos-reply-quittee-");
  const alice = await connecter(root, "alice");
  const bob = await connecter(root, "bob");
  try {
    const envoi = await outil(alice, "send", { to: "table:famille-test", body: "the beat" });
    const pourBob = envoi.results.find((r) => r.to === "bob");
    const prepare = ouvrir();
    retirerMembre(prepare, "famille-test", "bob", { retirePar: "alice" });
    prepare.close();
    const avant = ligneCount(ouvrir);
    const refuse = await outil(bob, "reply", { msg_id: pourBob.msg_id, body: "for everyone", toute_la_table: true });
    assert.equal(refuse.sent, false, JSON.stringify(refuse));
    assert.equal(refuse.refus, "pas-membre");
    assert.equal(refuse.table, "famille-test");
    assert.equal(ligneCount(ouvrir), avant);
    const aLAuteur = await outil(bob, "reply", { msg_id: pourBob.msg_id, body: "just you" });
    assert.equal(aLAuteur.sent, true, JSON.stringify(aLAuteur));
    assert.equal(aLAuteur.recipient, "alice");
  } finally {
    await alice.close();
    await bob.close();
  }
});

test("reply à toute la table qui casse en chemin : la réponse dit les lettres parties et le membre fautif", async () => {
  const { root, ouvrir } = bureauDuFil("valxos-reply-panne-");
  const alice = await connecter(root, "alice");
  const bob = await connecter(root, "bob");
  try {
    const envoi = await outil(alice, "send", { to: "table:famille-test", body: "the beat" });
    const pourBob = envoi.results.find((r) => r.to === "bob");
    const prepare = ouvrir();
    prepare.exec("CREATE TRIGGER panne_carol BEFORE INSERT ON messages WHEN NEW.recipient = 'carol' BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;");
    prepare.close();
    const reponse = await outil(bob, "reply", { msg_id: pourBob.msg_id, body: "for everyone", toute_la_table: true });
    assert.equal(reponse.sent, false, JSON.stringify(reponse));
    assert.equal(reponse.interrompu, true);
    assert.equal(reponse.refus, "envoi-interrompu", "un code à nous");
    assert.match(reponse.cause, /^SQLITE_CONSTRAINT/, "le code d'origine part dans cause");
    assert.equal(reponse.adresse, "carol");
    assert.deepEqual(reponse.lettres_ecrites.map((l) => l.to), ["alice"], "la réponse à alice est partie");
    assert.equal(ligne(ouvrir, reponse.lettres_ecrites[0].msg_id).reponse_a, pourBob.msg_id);
  } finally {
    await alice.close();
    await bob.close();
  }
});

test("reply : la clef recopiée dans un refus est bornée", async () => {
  const { root } = bureauDuFil("valxos-reply-borne-");
  const bob = await connecter(root, "bob");
  try {
    const inconnue = await outil(bob, "reply", { msg_id: `msg-${"x".repeat(100)}\n`, body: "x" });
    assert.equal(inconnue.refus, "lettre-inconnue");
    assert.equal([...inconnue.msg_id].length, 65);
  } finally {
    await bob.close();
  }
});

function ligneCount(ouvrir) {
  const db = ouvrir();
  try {
    return db.prepare("SELECT count(*) AS n FROM messages").get().n;
  } finally {
    db.close();
  }
}

// ── 6. ROUND 1 (f) : UNE COPIE CC NE SE RÉPOND PAS ───────────────────────────
// La lettre de la lignée appartient à sa chaise désignée ; une autre chaise de
// la lignée n'en voit qu'une copie (« do not answer as its recipient »). La
// règle est celle d'`ack` (`droitDeSigner`), jamais une deuxième.
test("reply : une chaise qui ne voit la lettre de sa lignée qu'en copie cc reçoit pas-destinataire ; désignée, elle répond", async () => {
  const { root, ouvrir } = bureauDuFil("valxos-reply-copie-");
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "ALPHA", messagingSocketPath: path.join(maison, "r.sock"), name: "runner" }));
  const prepare = ouvrir();
  registerInstance(prepare, { lineage: "alice", sessionId: "ALPHA", pid: process.pid, house: maison, sessionName: "runner" });
  registerInstance(prepare, { lineage: "alice", sessionId: "BETA", pid: process.ppid });
  designatePrimary(prepare, "alice", "BETA");
  const lettre = insertMessage(prepare, { sender: "bob", recipient: "alice", subject: "for the lineage", body: "hi alice" });
  prepare.close();
  const alice = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maison });
  try {
    assert.equal((await outil(alice, "whoami")).id, "alice#ALPHA", "sonde impossible sinon : la chaise du serveur");
    const boite = await outil(alice, "inbox", { mark_delivered: false });
    assert.deepEqual((boite.copies || []).map((c) => c.msg_id), [lettre.msg_id], "contrôle : la lettre n'est qu'une copie pour ALPHA");
    const avant = ligneCount(ouvrir);
    const refuse = await outil(alice, "reply", { msg_id: lettre.msg_id, body: "answering a copy" });
    assert.equal(refuse.sent, false, JSON.stringify(refuse));
    assert.equal(refuse.refus, "pas-destinataire");
    assert.equal(ligneCount(ouvrir), avant, "rien d'écrit");

    const designe = ouvrir();
    designatePrimary(designe, "alice", "ALPHA");
    designe.close();
    const reponse = await outil(alice, "reply", { msg_id: lettre.msg_id, body: "now it is mine" });
    assert.equal(reponse.sent, true, JSON.stringify(reponse));
    assert.equal(reponse.recipient, "bob");
  } finally {
    await alice.close();
  }
});

// ── 7. A2 (revue finale I-1, passe adverse) : LA RÉPONSE À UNE LETTRE FERMÉE RESTE FERMÉE ──
// La réponse directe (mode normal) à une lettre d'une table fermée est une lettre neuve, hors
// table, qui reprend le sujet et le fil. Elle naissait `sans_copie = 0` : quand l'auteur a posté
// sous sa lignée nue et que cette lignée a deux chaises, la chaise NON désignée la voyait en copie
// cc (PostToolUse, inbox). Elle hérite maintenant `sans_copie = 1` de la lettre répondue. Le
// contrôle — une lettre directe ordinaire de carol à alice — se voit bien en copie depuis la sœur :
// le silence n'est pas un trou de l'instrument.
test("A2 — reply à une lettre de table fermée (auteur en lignée nue à deux chaises) : la réponse hérite sans_copie = 1 ; la chaise sœur ne la voit ni par inbox ni par PostToolUse", async () => {
  const { root, ouvrir } = bureauDuFil("valxos-reply-fermee-");
  const maison = path.join(root, "maison-s2");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "s2", messagingSocketPath: path.join(maison, "s2.sock"), name: "sister" }));
  const prepare = ouvrir();
  creerTable(prepare, { nom: "fermee-test", fermee: true, creeePar: "alice" });
  for (const membre of ["alice", "bob", "carol"]) ajouterMembre(prepare, "fermee-test", membre, { ajoutePar: "alice" });
  registerInstance(prepare, { lineage: "alice", sessionId: "s1", pid: process.ppid });
  registerInstance(prepare, { lineage: "alice", sessionId: "s2", pid: process.pid, house: maison, sessionName: "sister" });
  designatePrimary(prepare, "alice", "s1");
  prepare.close();
  const nu = { CLAUDE_CONFIG_DIR: path.join(root, "maison-absente") };
  const alice = await connecter(root, "alice", nu);
  const carol = await connecter(root, "carol", nu);
  let reponse;
  try {
    assert.equal((await outil(alice, "whoami")).id, "alice", "sonde impossible sinon : alice poste sous sa lignée nue");
    const envoi = await outil(alice, "send", { to: "table:fermee-test", subject: "secret", body: "closed body" });
    const pourCarol = envoi.results.find((r) => r.to === "carol");
    assert.ok(pourCarol, JSON.stringify(envoi));
    assert.equal(ligne(ouvrir, pourCarol.msg_id).sans_copie, 1, "contrôle : la lettre de la table fermée est sans copie");
    reponse = await outil(carol, "reply", { msg_id: pourCarol.msg_id, body: "reply to the closed letter" });
    assert.equal(reponse.sent, true, JSON.stringify(reponse));
    assert.equal(reponse.recipient, "alice", "la réponse va à la lignée nue de l'auteur");
  } finally {
    await alice.close();
    await carol.close();
  }
  const enBase = ligne(ouvrir, reponse.msg_id);
  assert.deepEqual([enBase.table_nom, enBase.sans_copie, enBase.subject], [null, 1, "secret"], "hors table, mais fermée comme la lettre répondue");
  const db = ouvrir();
  try {
    assert.deepEqual(getCopiesPourChaise(db, "alice", "alice#s2").map((r) => r.msg_id), [], "aucune copie pour la chaise sœur");
    insertMessage(db, { msg_id: "controle-inbox", sender: "carol", recipient: "alice", body: "open control letter" });
  } finally {
    db.close();
  }

  // inbox de la chaise sœur (un serveur MCP qui EST alice#s2).
  const soeur = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maison });
  try {
    assert.equal((await outil(soeur, "whoami")).id, "alice#s2", "sonde impossible sinon : le serveur est la chaise sœur");
    const boite = await outil(soeur, "inbox", { mark_delivered: false });
    assert.equal(boite.erreur, undefined, boite.erreur);
    const vus = [...(boite.messages || []), ...(boite.copies || [])].map((l) => l.msg_id);
    assert.ok(vus.includes("controle-inbox"), `contrôle : la lettre ouverte se voit depuis la sœur\n${JSON.stringify(boite)}`);
    assert.ok(!vus.includes(reponse.msg_id), "la réponse fermée n'est ni une lettre ni une copie de la sœur");
  } finally {
    await soeur.close();
  }

  // PostToolUse de la chaise sœur (le vrai hook, une maison jetable et vide).
  const db2 = ouvrir();
  insertMessage(db2, { msg_id: "controle-hook", sender: "carol", recipient: "alice", body: "open control for the hook" });
  db2.close();
  const maisonVide = path.join(root, "maison-hook");
  fs.mkdirSync(path.join(maisonVide, "sessions"), { recursive: true });
  const hook = spawnSync("node", [path.join(repo, "src/hooks/piggyback_fetch.js")], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s2" }),
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: "alice", CLAUDE_CONFIG_DIR: maisonVide }
  });
  assert.equal(hook.status, 0, hook.stderr);
  const vu = JSON.parse(hook.stdout || "{}").hookSpecificOutput?.additionalContext ?? "";
  assert.match(vu, /open control for the hook/, `contrôle : le bloc CC de la sœur montre la lettre ouverte\n${vu}`);
  assert.doesNotMatch(vu, /reply to the closed letter/, "PostToolUse de la sœur ne montre pas la réponse fermée");
  assert.doesNotMatch(vu, /Subject: secret/);
});

// ── 8. S9 (seconde passe adverse) : DEUX ENCLOS HÉRITÉS SUR DEUX FORMES DE LA CHAISE ──
// `alice` enclose dans « one », `alice#s1` dans « two » (posés avant que le carnet ne le
// refuse) : la chaise ne choisit plus « le premier trouvé ». Chaque surface MCP qui écrit
// refuse, `enclos-conflit` avec les deux tables, et rien ne s'écrit ; la clef de
// l'expéditeur (`hors_enclos: true`) reste la sienne.
test("S9 — la chaise que deux enclos hérités tiennent dans deux tables : reply, send direct, send à table et broadcast refusés (enclos-conflit, les tables), rien d'écrit", async () => {
  const { root, ouvrir } = bureauDuFil("valxos-reply-conflit-");
  const maison = path.join(root, "maison-s1");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "s1", messagingSocketPath: path.join(maison, "s1.sock"), name: "chair" }));
  const prepare = ouvrir();
  for (const [nom, membres] of [["one", ["alice", "bob"]], ["two", ["alice#s1", "carol"]]]) {
    creerTable(prepare, { nom, fermee: true, creeePar: "operator" });
    for (const membre of membres) ajouterMembre(prepare, nom, membre, { ajoutePar: "operator" });
  }
  registerInstance(prepare, { lineage: "alice", sessionId: "s1", pid: process.pid, house: maison, sessionName: "chair" });
  registerPeer(prepare, { id: "bob", status: "active" });
  const inserer = prepare.prepare("INSERT INTO enclos (expediteur, nom_table, pose_par, pose_le) VALUES (?, ?, 'operator', '2026-10-21T00:00:00.000Z')");
  inserer.run("alice", "one");
  inserer.run("alice#s1", "two");
  const lettre = insertMessage(prepare, { sender: "carol", recipient: "alice#s1", subject: "inside two", body: "hi" });
  prepare.close();
  const alice = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maison });
  try {
    assert.equal((await outil(alice, "whoami")).id, "alice#s1", "sonde impossible sinon : le serveur est la chaise");
    const avant = ligneCount(ouvrir);
    for (const [nom, args] of [
      ["reply", { msg_id: lettre.msg_id, body: "answer" }],
      ["send", { to: "carol", body: "direct" }],
      ["send", { to: "table:two", body: "to the table" }],
      ["broadcast", { body: "to all" }]
    ]) {
      const r = await outil(alice, nom, args);
      assert.equal(r.refus, "enclos-conflit", `${nom} ${JSON.stringify(r)}`);
      assert.deepEqual(r.tables, ["one", "two"], nom);
      assert.deepEqual(r.enclos_poses, [{ expediteur: "alice", table: "one" }, { expediteur: "alice#s1", table: "two" }], nom);
      assert.match(r.motif, /more than one table/, nom);
    }
    assert.equal(ligneCount(ouvrir), avant, "rien d'écrit");
    const sortie = await outil(alice, "reply", { msg_id: lettre.msg_id, body: "on purpose", hors_enclos: true });
    assert.equal(sortie.sent, true, JSON.stringify(sortie));
    assert.equal(sortie.recipient, "carol");
  } finally {
    await alice.close();
  }
});

// ── 9. S14 (troisième passe adverse) : UNE CHAISE NON MEMBRE D'UNE TABLE FERMÉE ──────────────────
// La sonde de la passe adverse, rejouée de bout en bout : une table fermée dont les seuls membres
// sont la CHAISE `alice#S1` et `bob` ; S1 poste par `send` sous sa lignée nue (`sender: alice`,
// `sender_chaise: alice#S1`, `sans_copie: 1`). La chaise sœur S2, non membre, rabattait sa chaise à
// la lignée : `history` lui rendait le corps, et `reply` et `envoi_status` la prenaient pour
// l'expéditrice (`formes.includes(row.sender)`). Les droits d'auteur vont maintenant à la chaise
// posée ; `history` (MCP et CLI) omet une lettre fermée à qui n'en est ni le destinataire, ni la
// chaise expéditrice, ni un membre de la table.
function deuxChaises(prefixe, membres) {
  const { root, ouvrir } = bureauDuFil(prefixe);
  const maisons = { S1: path.join(root, "maison-s1"), S2: path.join(root, "maison-s2") };
  for (const [session, maison] of Object.entries(maisons)) {
    fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: session, messagingSocketPath: path.join(maison, `${session}.sock`), name: session }));
  }
  const prepare = ouvrir();
  registerInstance(prepare, { lineage: "alice", sessionId: "S1", pid: process.pid, house: maisons.S1 });
  registerInstance(prepare, { lineage: "alice", sessionId: "S2", pid: process.pid, house: maisons.S2, sessionName: "sister" });
  creerTable(prepare, { nom: "secret-test", fermee: true, creeePar: "alice" });
  for (const membre of membres) ajouterMembre(prepare, "secret-test", membre, { ajoutePar: "alice" });
  prepare.close();
  return { root, ouvrir, maisons };
}

async function posterDepuisS1(root, maisons, ouvrir) {
  const s1 = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maisons.S1 });
  try {
    assert.equal((await outil(s1, "whoami")).id, "alice#S1", "sonde impossible sinon : le serveur est la chaise S1");
    const envoi = await outil(s1, "send", { from: "alice", to: "table:secret-test", body: "closed body" });
    assert.equal(envoi.sent, true, JSON.stringify(envoi));
    const db = ouvrir();
    try {
      const lettres = db.prepare("SELECT * FROM messages WHERE envoi_id = ? ORDER BY seq").all(envoi.envoi_id);
      return { envoi, lettres };
    } finally {
      db.close();
    }
  } finally {
    await s1.close();
  }
}

function historiqueCli(root, self, ...args) {
  const r = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-history.js"), ...args, "--format", "json"], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: self }
  });
  assert.equal(r.status, 0, `${self} : ${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("S14 — table fermée dont la CHAISE alice#S1 est membre : la sœur S2 ne lit pas la lettre (history MCP et CLI), n'y répond pas, ne lit pas envoi_status ; S1 et bob la lisent et y répondent", async () => {
  const { root, ouvrir, maisons } = deuxChaises("valxos-reply-s14-", ["alice#S1", "bob"]);
  const { envoi, lettres } = await posterDepuisS1(root, maisons, ouvrir);
  const [lettre] = lettres;
  assert.deepEqual(
    lettres.map((l) => [l.sender, l.sender_chaise, l.recipient, l.sans_copie]),
    [["alice", "alice#S1", "bob", 1]],
    "la base de la passe adverse : la lignée nue en expéditeur, la chaise posée, bob seul destinataire"
  );
  const sansLaLettre = (rendu, quoi) => {
    const vues = rendu.messages || [];
    assert.ok(!vues.some((m) => m.msg_id === lettre.msg_id), `${quoi} : la lettre fermée est omise\n${JSON.stringify(rendu)}`);
    assert.doesNotMatch(JSON.stringify(rendu), /closed body/, `${quoi} : aucun corps`);
  };
  const avant = ligneCount(ouvrir);

  const s2 = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maisons.S2 });
  try {
    assert.equal((await outil(s2, "whoami")).id, "alice#S2", "sonde impossible sinon : le serveur est la chaise S2");
    sansLaLettre(await outil(s2, "history"), "history");
    sansLaLettre(await outil(s2, "history", { thread_id: lettre.thread_id }), "history par fil");
    sansLaLettre(await outil(s2, "history", { peer: "bob" }), "history avec bob");
    const reponse = await outil(s2, "reply", { msg_id: lettre.msg_id, body: "sister reply" });
    assert.deepEqual([reponse.sent, reponse.refus], [false, "pas-destinataire"], JSON.stringify(reponse));
    const etat = await outil(s2, "envoi_status", { envoi_id: envoi.envoi_id });
    assert.equal(etat.refus, "pas-expediteur", JSON.stringify(etat));
    assert.equal(etat.lettres, undefined);
  } finally {
    await s2.close();
  }
  assert.equal(ligneCount(ouvrir), avant, "rien d'écrit par la sœur");
  for (const self of ["alice#S2", "alice"]) {
    const cli = historiqueCli(root, self, "--table", "secret-test");
    assert.equal(cli.count, 0, `valxos-history sous ${self} : ${JSON.stringify(cli)}`);
    assert.doesNotMatch(JSON.stringify(cli), /closed body/);
  }

  // La chaise expéditrice et le destinataire, eux, lisent et répondent.
  const cliS1 = historiqueCli(root, "alice#S1", "--table", "secret-test");
  assert.deepEqual(cliS1.messages.map((m) => m.msg_id), [lettre.msg_id], "valxos-history sous la chaise S1");
  const s1 = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maisons.S1 });
  try {
    assert.ok((await outil(s1, "history")).messages.some((m) => m.msg_id === lettre.msg_id), "S1 lit sa lettre");
    const etat = await outil(s1, "envoi_status", { envoi_id: envoi.envoi_id });
    assert.equal(etat.count, 1, JSON.stringify(etat));
  } finally {
    await s1.close();
  }
  const bob = await connecter(root, "bob");
  try {
    assert.ok((await outil(bob, "history")).messages.some((m) => m.msg_id === lettre.msg_id), "bob lit la lettre qu'il a reçue");
    const reponse = await outil(bob, "reply", { msg_id: lettre.msg_id, body: "for the chair" });
    assert.equal(reponse.sent, true, JSON.stringify(reponse));
    assert.equal(reponse.recipient, "alice#S1", "la réponse va à la chaise qui a posté");
  } finally {
    await bob.close();
  }
});

test("S14 — table fermée dont la LIGNÉE alice est membre : chaque chaise de la lignée lit la lettre (membre) ; les droits d'auteur restent à la chaise qui a posté", async () => {
  const { root, ouvrir, maisons } = deuxChaises("valxos-reply-s14-lignee-", ["alice", "bob"]);
  const { envoi, lettres } = await posterDepuisS1(root, maisons, ouvrir);
  const [lettre] = lettres;
  assert.deepEqual(lettres.map((l) => [l.sender_chaise, l.recipient]), [["alice#S1", "bob"]]);
  const s2 = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maisons.S2 });
  try {
    assert.equal((await outil(s2, "whoami")).id, "alice#S2", "sonde impossible sinon");
    assert.ok((await outil(s2, "history")).messages.some((m) => m.msg_id === lettre.msg_id), "la lignée est membre : sa chaise S2 lit");
    const etat = await outil(s2, "envoi_status", { envoi_id: envoi.envoi_id });
    assert.equal(etat.refus, "pas-expediteur", "l'état d'un envoi reste à la chaise qui l'a posté");
  } finally {
    await s2.close();
  }
  assert.equal(historiqueCli(root, "alice#S2", "--table", "secret-test").count, 1, "valxos-history sous S2 : membre par sa lignée");
});

// R1 (re-revue du round 3) : LE LECTEUR DE LA GARDE EST L'IDENTITÉ DÉRIVÉE, JAMAIS UN `self`
// DÉCLARÉ. `history { self: "alice#S1" }` depuis la sœur S2 (ou un client nu `alice`) bâtissait le
// lecteur sur le nom déclaré : une fois S1 hors service, il rendait le courrier fermé de S1. Une
// chaise déclarée qui n'est pas celle de la session est refusée (`identite-refusee`), et le filtre
// juge toujours la session qui appelle ; à la CLI, `--self` qui n'est pas l'identité de
// l'environnement refuse (sortie 2).
test("R1 — history { self: \"alice#S1\" } depuis S2 ou un client nu est refusé (identite-refusee), même S1 morte ; S1 réelle lit ; valxos-history --self alice#S1 sous alice#S2 sort 2", async () => {
  const { root, ouvrir, maisons } = deuxChaises("valxos-reply-r1-", ["alice#S1", "bob"]);
  const { lettres } = await posterDepuisS1(root, maisons, ouvrir);
  const [lettre] = lettres;
  // Le courrier fermé de S1 sous sa CHAISE : une lettre postée sans `from` (sender = alice#S1), et la
  // réponse directe de bob (recipient = alice#S1, sans_copie) — ce que le nom déclaré rendait.
  const s1 = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maisons.S1 });
  try {
    assert.equal((await outil(s1, "send", { to: "table:secret-test", body: "closed body as chair" })).sent, true);
  } finally {
    await s1.close();
  }
  const bob = await connecter(root, "bob");
  try {
    const reponse = await outil(bob, "reply", { msg_id: lettre.msg_id, body: "closed body from bob" });
    assert.deepEqual([reponse.sent, reponse.recipient], [true, "alice#S1"], JSON.stringify(reponse));
  } finally {
    await bob.close();
  }
  // S1 passe hors service (statut et pid morts) : c'est là que le nom déclaré ouvrait la porte.
  const db = ouvrir();
  db.prepare("UPDATE peers SET status = 'dead', pid = 999999 WHERE id = 'alice#S1'").run();
  db.close();
  fs.rmSync(path.join(maisons.S1, "sessions", `${process.pid}.json`));
  const refuse = (rendu, quoi) => {
    assert.deepEqual([rendu.ok, rendu.refus], [false, "identite-refusee"], `${quoi} : ${JSON.stringify(rendu)}`);
    assert.equal(rendu.messages, undefined, `${quoi} : rien n'est rendu`);
    assert.doesNotMatch(JSON.stringify(rendu), /closed body/);
  };
  const s2 = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maisons.S2 });
  try {
    assert.equal((await outil(s2, "whoami")).id, "alice#S2", "sonde impossible sinon");
    refuse(await outil(s2, "history", { self: "alice#S1" }), "S2 déclare S1");
    refuse(await outil(s2, "history", { self: "alice#S1", peer: "bob" }), "S2 déclare S1, avec bob");
    const sansDeclaration = await outil(s2, "history", { self: "alice" });
    assert.ok(!(sansDeclaration.messages || []).some((m) => m.msg_id === lettre.msg_id), "sa lignée déclarée ne lui ouvre rien de fermé");
  } finally {
    await s2.close();
  }
  const nu = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: path.join(root, "maison-absente") });
  try {
    refuse(await outil(nu, "history", { self: "alice#S1" }), "le client nu déclare S1");
  } finally {
    await nu.close();
  }
  // Une session qui dérive vraiment S1 (sa fiche revient) lit sa lettre, en se déclarant ou non.
  fs.writeFileSync(path.join(maisons.S1, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "S1", messagingSocketPath: path.join(maisons.S1, "S1.sock"), name: "S1" }));
  const relance = ouvrir();
  registerInstance(relance, { lineage: "alice", sessionId: "S1", pid: process.pid, house: maisons.S1 });
  relance.close();
  const s1Relance = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maisons.S1 });
  try {
    assert.equal((await outil(s1Relance, "whoami")).id, "alice#S1", "sonde impossible sinon");
    const rendu = await outil(s1Relance, "history");
    assert.ok((rendu.messages || []).some((m) => m.msg_id === lettre.msg_id), `S1 réelle lit sa lettre postée sous la lignée : ${JSON.stringify(rendu)}`);
    const sousSaChaise = await outil(s1Relance, "history", { self: "alice#S1" });
    assert.equal(sousSaChaise.refus, undefined, "sa propre chaise déclarée n'est pas refusée");
    assert.match(JSON.stringify(sousSaChaise), /closed body as chair/, "sous sa chaise, S1 lit ce qu'elle a posté sous elle");
    assert.match(JSON.stringify(sousSaChaise), /closed body from bob/, "et la réponse de bob à sa chaise");
  } finally {
    await s1Relance.close();
  }
  for (const self of ["alice#S2", "alice"]) {
    const r = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-history.js"), "--table", "secret-test", "--self", "alice#S1", "--format", "json"], {
      encoding: "utf8",
      env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: self }
    });
    assert.equal(r.status, 2, `valxos-history --self alice#S1 sous ${self} : ${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /set VALXOS_SELF/);
    assert.doesNotMatch(r.stdout, /closed body/);
  }
});

// S19 (cinquième passe adverse) : L'HISTORIQUE D'UNE CHAISE EST TOUTE SA CORRESPONDANCE. Sous sa
// propre chaise, `history` (MCP et CLI) relisait sous la lignée seule, ou sous la chaise seule si elle
// se déclarait : une lettre postée `from: "alice"` et une lettre postée sous la chaise ne sortaient
// jamais ensemble. La chaise lit ce qui est à sa lignée ou à elle, ce qu'elle a posté sous l'une ou
// l'autre — et une lettre de table fermée seulement en destinataire, chaise expéditrice ou membre.
test("S19 — S1 relit ses deux lettres de table fermée (sous la lignée et sous sa chaise), MCP et CLI, déclarée ou non ; S2 n'en voit aucune", async () => {
  const { root, ouvrir, maisons } = deuxChaises("valxos-reply-s19-", ["alice#S1", "bob"]);
  const { lettres } = await posterDepuisS1(root, maisons, ouvrir);
  const sousLaLignee = lettres[0];
  const s1 = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maisons.S1 });
  let sousLaChaise;
  try {
    const envoi = await outil(s1, "send", { to: "table:secret-test", body: "closed body as chair" });
    sousLaChaise = envoi.results[0];
    for (const args of [{}, { self: "alice#S1" }, { self: "alice" }, { peer: "bob" }]) {
      const rendu = await outil(s1, "history", args);
      const ids = (rendu.messages || []).map((m) => m.msg_id);
      assert.ok(ids.includes(sousLaLignee.msg_id) && ids.includes(sousLaChaise.msg_id), `MCP ${JSON.stringify(args)} : les deux lettres\n${JSON.stringify(rendu)}`);
    }
  } finally {
    await s1.close();
  }
  const cli = (self, ...args) => spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-history.js"), "--table", "secret-test", ...args, "--format", "json"], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: self }
  });
  for (const args of [[], ["--self", "alice#S1"]]) {
    const r = cli("alice#S1", ...args);
    assert.equal(r.status, 0, `VALXOS_SELF=alice#S1 ${args.join(" ")} : ${r.stdout}\n${r.stderr}`);
    const lu = JSON.parse(r.stdout);
    assert.deepEqual(lu.messages.map((m) => m.body).sort(), ["closed body", "closed body as chair"], `CLI ${args.join(" ")}`);
    assert.equal(lu.self, "alice#S1", "la CLI dit le nom sous lequel elle a lu : la chaise de l'environnement");
  }
  assert.equal(cli("alice#S1", "--self", "alice").status, 2, "un autre nom que l'environnement : sortie 2");
  const s2 = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maisons.S2 });
  try {
    assert.doesNotMatch(JSON.stringify(await outil(s2, "history")), /closed body/);
  } finally {
    await s2.close();
  }
  const sœur = cli("alice#S2");
  assert.equal(sœur.status, 0, sœur.stderr);
  assert.equal(JSON.parse(sœur.stdout).count, 0, "la sœur n'en voit aucune");
});

// S-codes (cinquième passe) : un `self` déclaré qui n'est pas l'identité de la session se vérifie EN
// PREMIER et rend toujours `identite-refusee` — S1 vivante comme morte, un nom hors famille aussi.
test("S-codes — history : une chaise sœur vivante (casse comprise) ou un nom hors famille déclarés → identite-refusee, rien rendu", async () => {
  const { root, ouvrir, maisons } = deuxChaises("valxos-reply-scodes-", ["alice#S1", "bob"]);
  await posterDepuisS1(root, maisons, ouvrir);
  const s2 = await connecter(root, "alice", { CLAUDE_CONFIG_DIR: maisons.S2 });
  try {
    for (const self of ["alice#S1", "alice#s1", "bob", "mallory"]) {
      const rendu = await outil(s2, "history", { self });
      assert.deepEqual([rendu.ok, rendu.refus, rendu.messages], [false, "identite-refusee", undefined], `${self} : ${JSON.stringify(rendu)}`);
    }
    for (const self of ["alice#S2", "alice"]) {
      assert.equal((await outil(s2, "history", { self })).refus, undefined, `${self} : sa propre identité, ou sa lignée`);
    }
  } finally {
    await s2.close();
  }
});
