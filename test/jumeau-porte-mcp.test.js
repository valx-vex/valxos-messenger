// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// F3 (passe adverse du Run 6, 28/09) — UN JUMEAU REFUSÉ À LA PORTE MCP NE
// PARLE PAS EN LIGNÉE NUE.
//
// Reproduit par l'adversaire : une lignée dont la SEULE chaise vivante
// (confirmée, non désignée) est `lignee-t#ALPHA`. Un second processus porte une
// fiche de la même session ALPHA et lance le serveur MCP. Les hooks le refusent
// (`jumeau`) ; le serveur, lui, retombait sur la lignée nue — `inbox` livrait
// la lettre de la vraie session et `ack` l'éteignait. Lettre perdue, personne
// prévenu.
//
// La règle d'ici : un refus de chaise (jumeau, fiche d'une autre session) ne
// se convertit JAMAIS en droits de lignée nue. `whoami` dit le refus, `inbox`
// rend une boîte vide qui dit pourquoi, `ack` et `history` sont refusés, `send`
// part sous la lignée nue marquée `sans_chaise`. Et, à part : un signataire nu
// SANS fiche ne signe pas la lettre d'une lignée qui mène à UNE chaise vivante
// avec session, désignée ou non (la porte 1 de `gardeDeLaCopie`).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-jumeau-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

const { insertMessage, openDatabase, registerPeer, ackMessage } = await import("../src/lib/database.js");
const { designatePrimary, registerInstance } = await import("../src/lib/registry.js");
const { procStartOf } = await import("../src/lib/postbox.js");

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const outil = async (c, name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);

async function connecter(root, self, extra = {}) {
  const client = new Client({ name: "valxos-jumeau", version: "0" });
  await client.connect(new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: self, ...extra }
  }));
  return client;
}

// La vraie session : un `sleep` vivant dont l'heure de naissance est inscrite
// (chaise CONFIRMÉE). Le jumeau : ce runner, parent du serveur MCP, dont la
// fiche porte LA MÊME session ALPHA.
function scene(t, { designer }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-jumeau-"));
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  const vrai = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => { try { vrai.kill("SIGKILL"); } catch { /* déjà parti */ } });
  const naissance = procStartOf(vrai.pid);
  assert.ok(naissance, "sonde impossible : ps n'a pas rendu d'heure de naissance");
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "ALPHA", messagingSocketPath: path.join(maison, "r.sock"), name: "jumeau" }));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: vrai.pid, procStart: naissance, house: maison });
  if (designer) designatePrimary(db, "lignee-t", "ALPHA");
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "lignee-t", body: "pour la vraie session ALPHA" });
  db.close();
  return { root, maison, lettre, ouvrir: () => openDatabase({ file: path.join(root, "broker.db") }) };
}

for (const designer of [false, true]) {
  test(`F3 — un jumeau à la porte MCP (chaise désignée=${designer}) ne lit, ne signe, ni ne relit la lettre de la vraie session`, async (t) => {
    const s = scene(t, { designer });
    const c = await connecter(s.root, "lignee-t", { CLAUDE_CONFIG_DIR: s.maison });
    try {
      const qui = await outil(c, "whoami");
      assert.equal(qui.id, null, "un jumeau n'a pas d'identité au guichet");
      assert.equal(qui.self, null);
      assert.equal(qui.refus, "chaise-refusee");
      assert.equal(qui.raison, "jumeau");

      const peers = await outil(c, "list_peers");
      assert.equal(peers.self, null);

      for (const args of [{}, { self: "lignee-t" }, { self: "lignee-t#ALPHA" }]) {
        const inbox = await outil(c, "inbox", args);
        assert.equal(inbox.count, 0, `inbox ${JSON.stringify(args)} : boîte vide`);
        assert.deepEqual(inbox.messages, []);
        assert.equal(inbox.refus, "chaise-refusee");
        assert.equal(inbox.raison, "jumeau");
      }
      for (const args of [{ msg_id: s.lettre.msg_id }, { msg_id: s.lettre.msg_id, self: "lignee-t" }, { msg_id: s.lettre.msg_id, self: "lignee-t#ALPHA" }]) {
        const ack = await outil(c, "ack", args);
        assert.equal(ack.acked, false, `ack ${JSON.stringify(args)} refusé`);
        assert.equal(ack.refus, "chaise-refusee");
      }
      const histoire = await outil(c, "history", {});
      assert.equal(histoire.refus, "chaise-refusee");
      assert.equal(histoire.messages, undefined, "l'historique de la lignée n'est pas servi au jumeau");

      const envoi = await outil(c, "send", { to: "bob-eternal", body: "je parle quand même" });
      assert.equal(envoi.sent, true, "écrire reste possible");
      assert.equal(envoi.sans_chaise, true);
      assert.equal(envoi.refus_chaise, "jumeau");
    } finally {
      await c.close();
    }
    const v = s.ouvrir();
    const ligne = v.prepare("SELECT delivered_at, acked_at FROM messages WHERE msg_id = ?").get(s.lettre.msg_id);
    const envoye = v.prepare("SELECT sender FROM messages WHERE sender LIKE 'lignee-t%' ORDER BY seq DESC LIMIT 1").get();
    const cartes = v.prepare("SELECT id FROM peers WHERE id = 'lignee-t'").all();
    v.close();
    assert.equal(ligne.acked_at, null, "la lettre de la vraie session n'est pas éteinte");
    assert.equal(ligne.delivered_at, null, "ni même livrée au jumeau");
    assert.equal(envoye.sender, "lignee-t", "l'envoi part sous la lignée nue");
    assert.deepEqual(cartes, [], "le jumeau ne pose aucune fiche nue à côté de la chaise");
    const journal = path.join(s.root, "logs", "lignee-t.log");
    const refus = fs.readFileSync(journal, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => l.message === "chaise_refusee");
    assert.equal(refus.length, 1, "le refus se journalise une fois, pas un par appel");
  });
}

test("F3 — un client nu SANS fiche ne signe pas la lettre d'une lignée menant à UNE chaise vivante avec session, même non désignée", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-nu-seule-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid });
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "lignee-t", body: "pour ALPHA" });
  db.close();
  const c = await connecter(root, "lignee-t", { CLAUDE_CONFIG_DIR: path.join(root, "maison-absente") });
  try {
    const inbox = await outil(c, "inbox");
    assert.equal(inbox.count, 0, "la lettre est à la chaise, pas au client nu");
    assert.equal(inbox.copies.length, 1);
    assert.equal(inbox.copies[0].chaise_designee, "lignee-t#ALPHA");
    const ack = await outil(c, "ack", { msg_id: lettre.msg_id });
    assert.equal(ack.acked, false);
    assert.match(ack.raison, /cc copy/);
    assert.ok(!ack.raison.includes("lignee-t#ALPHA"), "le refus ne nomme pas la chaise (fix round 1)");
  } finally {
    await c.close();
  }
  const v = openDatabase({ file: path.join(root, "broker.db") });
  const ligne = v.prepare("SELECT delivered_at, acked_at FROM messages WHERE msg_id = ?").get(lettre.msg_id);
  v.close();
  assert.equal(ligne.acked_at, null);
  assert.equal(ligne.delivered_at, null);
});

test("F3 — la même règle au niveau de la base : ackMessage refuse le nom nu devant une chaise seule non désignée, accepte la chaise", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-nu-base-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  try {
    registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid });
    const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "lignee-t", body: "pour ALPHA" });
    assert.throws(() => ackMessage(db, lettre.msg_id, "lignee-t"), (e) => e.code === "accuse_refuse" && /cc copy/.test(e.raison));
    assert.equal(ackMessage(db, lettre.msg_id, "lignee-t#ALPHA").acked_at !== null, true, "la chaise signe sa lettre");
  } finally {
    db.close();
  }
});

test("F3 — un client nu avec SA seule fiche sans session signe toujours ses propres lettres (Codex, Gemini, Antigravity)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-nu-solo-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  try {
    registerPeer(db, { id: "client-solo", description: "client MCP simple", status: "active" });
    assert.equal(db.prepare("SELECT instance_session_id FROM peers WHERE id = 'client-solo'").get().instance_session_id, null,
      "la fiche du client n'a pas de session");
    const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "client-solo", body: "pour toi" });
    assert.ok(ackMessage(db, lettre.msg_id, "client-solo").acked_at, "le client solo éteint sa lettre");
  } finally {
    db.close();
  }
});

// FIX ROUND 1 (revue du 28/09, I-1) — UN APPELANT SANS CHAISE NE DÉCLARE PAS
// UNE CHAISE. Le refus du nom nu disait « signez sous la chaise (X) » ; le
// client sans fiche déclarait `self: "X"` à l'appel suivant, la famille
// d'identité l'acceptait (une chaise de sa lignée), et l'accusé passait. Une
// chaise déclarée n'est honorée que quand la fiche de l'appelant dérive CETTE
// chaise-là ; le refus ne nomme plus aucune chaise.
test("fix 1 — un client sans fiche refusé en nom nu ne rouvre pas la porte en déclarant la chaise (ack et inbox)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-nu-declare-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid });
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "lignee-t", body: "pour ALPHA" });
  db.close();
  const c = await connecter(root, "lignee-t", { CLAUDE_CONFIG_DIR: path.join(root, "maison-absente") });
  try {
    const nu = await outil(c, "ack", { msg_id: lettre.msg_id });
    assert.equal(nu.acked, false);
    assert.ok(!String(nu.raison).includes("lignee-t#ALPHA"), `le refus ne nomme pas la chaise : ${nu.raison}`);
    assert.doesNotMatch(String(nu.raison), /signez sous|sign under/i);
    const declare = await outil(c, "ack", { msg_id: lettre.msg_id, self: "lignee-t#ALPHA" });
    assert.equal(declare.acked, false, "déclarer la chaise ne rouvre pas la porte");
    assert.equal(declare.refus, "accuse-refuse");
    assert.ok(!JSON.stringify(declare).includes("signez"), "aucune consigne vers une chaise");
    const releve = await outil(c, "inbox", { self: "lignee-t#ALPHA" });
    assert.equal(releve.refus, "releve-refusee");
    assert.equal(releve.messages, undefined, "aucune lettre servie sous une chaise déclarée");
  } finally {
    await c.close();
  }
  const v = openDatabase({ file: path.join(root, "broker.db") });
  const ligne = v.prepare("SELECT delivered_at, acked_at FROM messages WHERE msg_id = ?").get(lettre.msg_id);
  v.close();
  assert.equal(ligne.acked_at, null, "la lettre reste à sa vraie session (A8 : non accusée plutôt que prise)");
  assert.equal(ligne.delivered_at, null);
});

test("fix 1 — le refus du nom nu en base ne contient plus l'id de la chaise", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-nu-texte-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  try {
    registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid });
    const lettre = insertMessage(db, { sender: "x", recipient: "lignee-t", body: "y" });
    assert.throws(() => ackMessage(db, lettre.msg_id, "lignee-t"),
      (e) => e.code === "accuse_refuse" && /cc copy/.test(e.raison) && !e.raison.includes("lignee-t#ALPHA"));
  } finally {
    db.close();
  }
});

test("fix 1 — un serveur AVEC fiche qui dérive la chaise la déclare et accuse (chemin de la Task 7)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-fiche-declare-"));
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "ALPHA", messagingSocketPath: path.join(maison, "r.sock"), name: "runner" }));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid, house: maison });
  registerInstance(db, { lineage: "lignee-t", sessionId: "AUTRE", pid: process.pid });
  designatePrimary(db, "lignee-t", "ALPHA");
  const lettre = insertMessage(db, { sender: "x", recipient: "lignee-t", body: "pour ALPHA" });
  const soeur = insertMessage(db, { sender: "x", recipient: "lignee-t#AUTRE", body: "pour la sœur" });
  db.close();
  const c = await connecter(root, "lignee-t", { CLAUDE_CONFIG_DIR: maison });
  try {
    assert.equal((await outil(c, "whoami")).id, "lignee-t#ALPHA");
    assert.equal((await outil(c, "ack", { msg_id: lettre.msg_id, self: "lignee-t#ALPHA" })).acked, true, "sa propre chaise déclarée");
    const autre = await outil(c, "ack", { msg_id: soeur.msg_id, self: "lignee-t#AUTRE" });
    assert.equal(autre.acked, false, "une chaise ne déclare pas sa sœur");
    assert.equal(autre.refus, "accuse-refuse");
  } finally {
    await c.close();
  }
});

// FIX ROUND 2 (re-revue r1, 28/09) — UNE RÈGLE EN BASE, TOUTES LES FORMES
// D'ADRESSE. Un signataire nu (sans chaise) ne lit ni ne signe en
// propriétaire vers une chaise vivante de session, quelle que soit l'adresse
// par laquelle on y arrive : adresse humaine (`lignee-t@alphaname`), chaise
// nominative (`lignee-t#ALPHA`), alias, lignée. Deux routes restaient ouvertes
// après un premier correctif : la relève/l'accusé sous l'adresse humaine déclarée, et
// l'accusé nu d'une lettre adressée à la chaise.
function sceneHumaine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-nu-humain-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid, sessionName: "alphaname" });
  const humaine = insertMessage(db, { sender: "m", recipient: "lignee-t@alphaname", body: "à l'adresse humaine" });
  const nominative = insertMessage(db, { sender: "m", recipient: "lignee-t#ALPHA", body: "à la chaise" });
  db.close();
  return { root, humaine, nominative, ouvrir: () => openDatabase({ file: path.join(root, "broker.db") }) };
}

test("fix 2 — un client sans fiche ne relève ni n'accuse sous l'adresse humaine d'une chaise vivante", async () => {
  const s = sceneHumaine();
  const c = await connecter(s.root, "lignee-t", { CLAUDE_CONFIG_DIR: path.join(s.root, "maison-absente") });
  try {
    const releve = await outil(c, "inbox", { self: "lignee-t@alphaname", mark_delivered: false });
    assert.equal(releve.refus, "releve-refusee", JSON.stringify(releve));
    assert.equal(releve.messages, undefined, "le msg_id de la chaise n'est pas servi");
    const ack = await outil(c, "ack", { msg_id: s.humaine.msg_id, self: "lignee-t@alphaname" });
    assert.equal(ack.acked, false);
  } finally {
    await c.close();
  }
  const v = s.ouvrir();
  assert.equal(v.prepare("SELECT acked_at FROM messages WHERE msg_id = ?").get(s.humaine.msg_id).acked_at, null);
  v.close();
});

test("fix 2 — un client sans fiche n'accuse pas, nu, une lettre adressée à la chaise (porte 3)", async () => {
  const s = sceneHumaine();
  const c = await connecter(s.root, "lignee-t", { CLAUDE_CONFIG_DIR: path.join(s.root, "maison-absente") });
  try {
    const ack = await outil(c, "ack", { msg_id: s.nominative.msg_id });
    assert.equal(ack.acked, false, JSON.stringify(ack));
  } finally {
    await c.close();
  }
  const v = s.ouvrir();
  assert.equal(v.prepare("SELECT acked_at FROM messages WHERE msg_id = ?").get(s.nominative.msg_id).acked_at, null);
  v.close();
});

test("fix 2 — la règle vit en base : ackMessage refuse un nom nu vers une chaise, sous toutes les formes", () => {
  const s = sceneHumaine();
  const db = s.ouvrir();
  try {
    for (const [lettre, signataire] of [[s.humaine, "lignee-t@alphaname"], [s.nominative, "lignee-t"], [s.humaine, "lignee-t"]]) {
      assert.throws(() => ackMessage(db, lettre.msg_id, signataire), (e) => e.code === "accuse_refuse", `${signataire} → ${lettre.recipient}`);
    }
    assert.ok(ackMessage(db, s.nominative.msg_id, "lignee-t#ALPHA").acked_at, "la chaise signe sa lettre");
  } finally {
    db.close();
  }
});

test("fix 2 — un serveur AVEC fiche accuse par sa propre adresse humaine (cas A)", async () => {
  const s = sceneHumaine();
  const maison = path.join(s.root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "ALPHA", messagingSocketPath: path.join(maison, "r.sock"), name: "alphaname" }));
  const c = await connecter(s.root, "lignee-t", { CLAUDE_CONFIG_DIR: maison });
  try {
    assert.equal((await outil(c, "whoami")).id, "lignee-t#ALPHA");
    const ack = await outil(c, "ack", { msg_id: s.humaine.msg_id, self: "lignee-t@alphaname" });
    assert.equal(ack.acked, true, JSON.stringify(ack));
  } finally {
    await c.close();
  }
});

// FIX ROUND 2 (M-2) — un jumeau refusé ne se donne pas la chaise par `from`.
test("fix 2 — un jumeau qui envoie avec from = la chaise est refusé ; avec sa lignée nue, marqué sans_chaise", async (t) => {
  const s = scene(t, { designer: false });
  const c = await connecter(s.root, "lignee-t", { CLAUDE_CONFIG_DIR: s.maison });
  try {
    const chaise = await outil(c, "send", { to: "bob-eternal", from: "lignee-t#ALPHA", body: "au nom de la chaise" });
    assert.equal(chaise.sent, false, JSON.stringify(chaise));
    assert.equal(chaise.refus, "expediteur-refuse");
    const nue = await outil(c, "send", { to: "bob-eternal", from: "lignee-t", body: "sous la lignée nue" });
    assert.equal(nue.sent, true);
    assert.equal(nue.sans_chaise, true, "le marqueur tient aussi quand from est donné");
  } finally {
    await c.close();
  }
  const v = s.ouvrir();
  assert.equal(v.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender = 'lignee-t#ALPHA'").get().n, 0);
  v.close();
});

// FIX ROUND 3 (28/09) — LA LIGNÉE AMBIGUË AUSSI. Deux chaises vivantes de
// session, aucune désignée : la lettre de la lignée est TENUE. Un nom nu sans
// fiche qui se réclame de la lignée y est un imposteur autant que devant une
// chaise seule, et les lettres tenues sont les plus précieuses. Règle finale :
// un nom nu n'agit en propriétaire (relève, accusé) que sur une adresse qui ne
// mène à AUCUNE chaise de session.
function sceneAmbigue() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-nu-ambigu-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "lignee-t", sessionId: "UN", pid: process.pid });
  registerInstance(db, { lineage: "lignee-t", sessionId: "DEUX", pid: process.pid });
  const tenue = insertMessage(db, { sender: "m", recipient: "lignee-t", body: "tenue pour la lignée" });
  db.close();
  return { root, tenue, ouvrir: () => openDatabase({ file: path.join(root, "broker.db") }) };
}

test("fix 3 — lignée ambiguë : un client sans fiche a une boîte vide qui dit pourquoi, et son accusé est refusé", async () => {
  const s = sceneAmbigue();
  const c = await connecter(s.root, "lignee-t", { CLAUDE_CONFIG_DIR: path.join(s.root, "maison-absente") });
  try {
    const inbox = await outil(c, "inbox");
    assert.equal(inbox.count, 0, JSON.stringify(inbox));
    assert.deepEqual(inbox.messages, []);
    assert.match(String(inbox.raison), /without a chair/, "la boîte vide dit pourquoi");
    const ack = await outil(c, "ack", { msg_id: s.tenue.msg_id });
    assert.equal(ack.acked, false, JSON.stringify(ack));
    const histoire = await outil(c, "history", {});
    assert.ok(!(histoire.messages || []).some((m) => m.msg_id === s.tenue.msg_id), "l'historique ne rend pas la lettre tenue");
  } finally {
    await c.close();
  }
  const v = s.ouvrir();
  const ligne = v.prepare("SELECT delivered_at, acked_at FROM messages WHERE msg_id = ?").get(s.tenue.msg_id);
  v.close();
  assert.equal(ligne.acked_at, null);
  assert.equal(ligne.delivered_at, null, "la lettre tenue n'est pas livrée au nom nu");
});

test("fix 3 — la règle en base : ackMessage refuse le nom nu sur une lignée ambiguë ; valxos-inbox nu ne la relève pas", () => {
  const s = sceneAmbigue();
  const db = s.ouvrir();
  try {
    assert.throws(() => ackMessage(db, s.tenue.msg_id, "lignee-t"), (e) => e.code === "accuse_refuse");
  } finally {
    db.close();
  }
  const r = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-inbox.js")], {
    encoding: "utf8", env: envPropre({ CC2CC_V2_HOME: s.root, CC2CC_SELF: "lignee-t" })
  });
  assert.equal(r.status, 0, r.stderr);
  const sortie = JSON.parse(r.stdout);
  assert.equal(sortie.count, 0, r.stdout);
  assert.match(String(sortie.raison), /without a chair/);
});

test("fix 3 — une fiche de chaise dans la lignée ambiguë garde le comportement de la Task 7 (tenue, copie cc, accusé refusé)", async () => {
  const s = sceneAmbigue();
  const maison = path.join(s.root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "UN", messagingSocketPath: path.join(maison, "r.sock"), name: "un" }));
  const c = await connecter(s.root, "lignee-t", { CLAUDE_CONFIG_DIR: maison });
  try {
    const inbox = await outil(c, "inbox");
    assert.equal(inbox.self, "lignee-t#UN");
    assert.equal(inbox.count, 0);
    assert.equal(inbox.copies.length, 1);
    assert.equal(inbox.copies[0].sans_chaise_designee, true);
    const ack = await outil(c, "ack", { msg_id: s.tenue.msg_id });
    assert.equal(ack.acked, false);
    assert.match(ack.raison, /sans-chaise-designee/);
  } finally {
    await c.close();
  }
});
