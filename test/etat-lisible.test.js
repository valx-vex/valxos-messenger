// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// E3 — L'ÉTAT LISIBLE D'UNE LETTRE : dérivé, jamais stocké.
//
// La doctrine de round.js (l'état se dérive, les colonnes sont des observations)
// rendue visible à l'humain. L'échelle : accusée > reçue > au guichet > en
// attente — « reçue » FUSIONNE injected_at et delivered_at, deux canaux
// parallèles que l'affichage refuse de classer entre eux (décision produit
// 19/08, sur les faits de la passe adverse). La dette d'origine (18/08) : une
// lettre injectée puis accusée SANS delivered_at avait fait croire à un trou de
// livraison — elle doit se dire « accusée », jamais « non livrée ».
//
// ⚠️ Toutes les bases ici sont JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau
// de poste vivant n'est JAMAIS ouvert.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import * as format from "../src/lib/format.js";
import { insertMessage, openDatabase } from "../src/lib/database.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

// ⚠️ LE JETABLE VAUT AUSSI POUR CE PROCESSUS-CI (revue adverse F2, 21/08). Un `file`
// explicite ne protège PAS le bureau vivant : `ensureRuntimeDirs`,
// `writeHeartbeat` et le registre lisent `baseDir()` — donc l'ENV du runner,
// jamais le fichier qu'on vient de leur imposer. Sans ce plancher, les gestes
// EN PROCESSUS de ce fichier écrivaient dans le VRAI ~/.cc2cc-v2 (fiches et
// répertoires constatés le 21/08). Les tests qui posent leur propre racine la
// posent par-dessus ; l'état d'origine se restaure à la fin du fichier.
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-etat-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});


const repo = path.resolve(new URL("..", import.meta.url).pathname);

function maisonJetable() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-etat-"));
  return root;
}

test("l'état se dérive du jalon le plus avancé — et l'injectée+accusée sans delivered_at est « accusée », jamais « non livrée »", () => {
  const etat = format.etatDeLaLettre;
  assert.equal(typeof etat, "function", "etatDeLaLettre existe dans format.js");
  assert.equal(etat({}), "en attente");
  assert.equal(etat({ carried_at: "t" }), "au guichet");
  // « reçue » : la sonnette (injected_at) OU la relève (delivered_at), peu
  // importe lequel, peu importe l'ordre — rien n'a le droit d'en dépendre.
  assert.equal(etat({ carried_at: "t", injected_at: "t" }), "reçue");
  assert.equal(etat({ delivered_at: "t" }), "reçue");
  assert.equal(etat({ injected_at: "t", delivered_at: "t" }), "reçue");
  assert.equal(etat({ delivered_at: "t", acked_at: "t" }), "accusée");
  // LA dette du 18/08 :
  assert.equal(
    etat({ injected_at: "t", acked_at: "t", delivered_at: null }),
    "accusée",
    "une lettre injectée et accusée sans delivered_at est ACCUSÉE, jamais « non livrée »"
  );
});

test("cc2cc-inbox affiche l'état lisible de chaque lettre sans toucher aux colonnes", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => db.close());
  insertMessage(db, { msg_id: "E3-in", sender: "a", recipient: "destinataire-e3", body: "x" });
  db.prepare("UPDATE messages SET injected_at = '2026-08-19T08:00:00Z' WHERE msg_id = 'E3-in'").run();
  const sortie = execFileSync(
    "node",
    [path.join(repo, "src/bin/valxos-inbox.js"), "--self", "destinataire-e3", "--mark-delivered", "false"],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "destinataire-e3" } }
  );
  const rapport = JSON.parse(sortie);
  assert.equal(rapport.count, 1);
  assert.equal(rapport.messages[0].etat, "reçue");
  assert.equal(rapport.messages[0].injected_at, "2026-08-19T08:00:00Z", "les timestamps bruts restent visibles");
});

test("sur le chemin par défaut, l'état affiché reflète la base APRÈS la relève", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { msg_id: "E3-defaut", sender: "a", recipient: "dest-defaut", body: "x" });
  db.prepare("UPDATE messages SET injected_at = '2026-08-19T08:00:00Z' WHERE msg_id = 'E3-defaut'").run();
  const sortie = execFileSync(
    "node",
    [path.join(repo, "src/bin/valxos-inbox.js"), "--self", "dest-defaut"],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "dest-defaut" } }
  );
  const rapport = JSON.parse(sortie);
  assert.equal(rapport.count, 1);
  // La relève par défaut pose delivered_at : l'état affiché doit être celui de
  // la base APRÈS cet effet de bord, jamais celui d'avant (finding de la revue adverse, HAUT).
  assert.equal(rapport.messages[0].etat, "reçue");
  const enBase = db.prepare("SELECT delivered_at FROM messages WHERE msg_id = 'E3-defaut'").get();
  db.close();
  assert.ok(enBase.delivered_at, "la base porte la marque");
  assert.equal(rapport.messages[0].delivered_at, enBase.delivered_at, "et l'affichage la montre, identique");
});

test("cc2cc-doctor compte les lettres par état lisible", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { msg_id: "E3-d1", sender: "a", recipient: "b", body: "x" });
  insertMessage(db, { msg_id: "E3-d2", sender: "a", recipient: "b", body: "y" });
  db.prepare(
    "UPDATE messages SET injected_at = '2026-08-19T08:00:00Z', acked_at = '2026-08-19T08:01:00Z' WHERE msg_id = 'E3-d2'"
  ).run();
  db.close();
  const sortie = execFileSync("node", [path.join(repo, "src/bin/valxos-doctor.js")], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root }
  });
  const rapport = JSON.parse(sortie);
  assert.deepEqual(rapport.checks.lettres, {
    "accusée": 1,
    "reçue": 0,
    "au guichet": 0,
    "en attente": 1
  });
  // Base vide : les cinq clés existent quand même, à zéro — « 0 lettres dans
  // l'état X » et « l'état X n'est pas suivi » ne doivent pas se ressembler.
  const rootVide = maisonJetable();
  const sortieVide = execFileSync("node", [path.join(repo, "src/bin/valxos-doctor.js")], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: rootVide }
  });
  assert.deepEqual(JSON.parse(sortieVide).checks.lettres, {
    "accusée": 0,
    "reçue": 0,
    "au guichet": 0,
    "en attente": 0
  });
});

test("l'inbox MCP affiche l'état de la base APRÈS sa propre marque — sur le chemin PAR DÉFAUT", async () => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { msg_id: "E3-mcp", sender: "a", recipient: "destinataire-mcp", body: "x" });
  db.close();
  const client = new Client({ name: "cc2cc-etat-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "destinataire-mcp" }
  });
  await client.connect(transport);
  try {
    // AUCUN argument : le chemin par défaut (mark_delivered omis = true) — c'est
    // exactement là que vivait le mensonge (leçon d un cas réel d interversion).
    const reponse = await client.callTool({ name: "inbox", arguments: {} });
    const contenu = JSON.parse(reponse.content[0].text);
    assert.equal(contenu.count, 1);
    const lettre = contenu.messages[0];
    assert.equal(lettre.etat, "reçue", "la relève vient de poser delivered_at : l'état lisible est « reçue »");
    assert.ok(lettre.delivered_at, "delivered_at non nul dans la RÉPONSE — la base après l'effet de bord, jamais l'objet d'avant");
  } finally {
    await client.close();
  }
});

test("l'outil MCP history rend l'état lisible par lettre", async () => {
  const root = maisonJetable();
  const client = new Client({ name: "etat-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "etat-a" }
  });
  await client.connect(transport);
  // G1 : l'accusé se signe. « etat-a » ne peut plus déclarer être « etat-b » —
  // le destinataire accuse par SA PROPRE session, une seconde porte MCP.
  const clientB = new Client({ name: "etat-test-b", version: "0.1.0" });
  const transportB = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "etat-b" }
  });
  await clientB.connect(transportB);
  try {
    await client.callTool({ name: "register", arguments: { id: "etat-a" } });
    await clientB.callTool({ name: "register", arguments: { id: "etat-b" } });
    const sent = await client.callTool({
      name: "send",
      arguments: { from: "etat-a", to: "etat-b", body: "bonjour", msg_id: "E3-mcp" }
    });
    assert.equal(JSON.parse(sent.content[0].text).sent, true);
    const acked = await clientB.callTool({ name: "ack", arguments: { msg_id: "E3-mcp" } });
    assert.equal(JSON.parse(acked.content[0].text).acked, true, "etat-b signe par sa propre porte");
    const hist = await client.callTool({
      name: "history",
      arguments: { self: "etat-a", peer: "etat-b", limit: 5 }
    });
    const rows = JSON.parse(hist.content[0].text).messages;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].etat, "accusée");
  } finally {
    await client.close();
    await clientB.close();
  }
});
