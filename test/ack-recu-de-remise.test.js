// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// `ack` ACCEPTE L'IDENTIFIANT MONTRÉ À LA REMISE.
//
// Le pli que le Facteur dépose dans une session (`plierLaLettre`,
// src/facteur/round.js) porte une ligne `Receipt: <attempt_id>` juste au-dessus
// du corps : l'uuid de la TENTATIVE de portage (`facteur_attempts.attempt_id`),
// pas le `msg_id` de la lettre. Les agents l'ont donné à `ack`, qui répondait
// « Message not found » (10/11, 14/11, 21/11). Une tentative porte UNE lettre :
// l'identifiant se résout sans ambiguïté, et la règle de la sœur (la chaise
// voisine ne signe pas) reste vraie quel que soit l'identifiant employé.
// Toutes les bases sont JETABLES (mkdtemp + CC2CC_V2_HOME).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { insertMessage, openDatabase } from "../src/lib/database.js";
import { migrate } from "../src/lib/migrations.js";
import { instanceId, registerInstance } from "../src/lib/registry.js";
import { poserLeBureau } from "./aide-env.js";

const depot = path.resolve(new URL("..", import.meta.url).pathname);

function bureau() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-recu-"));
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  registerInstance(db, { lineage: "alice", sessionId: "sess-1" });
  registerInstance(db, { lineage: "alice", sessionId: "sess-2" });
  insertMessage(db, { msg_id: "msg-r1", sender: "bob", recipient: instanceId("alice", "sess-1"), body: "pour la chaise 1" });
  // Une tentative close, comme celle que le pli nomme `Receipt:`.
  const attemptId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO facteur_attempts (attempt_id, msg_id, owner_id, state, claimed_at_ms, lease_until_ms, finished_at_ms)
    VALUES (?, 'msg-r1', 'porteur', 'remise', 1000, 2000, 1500)
  `).run(attemptId);
  db.close();
  return { root, attemptId };
}

function ficheDeSession(root, sessionId) {
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, messagingSocketPath: path.join(maison, "r.sock"), name: "session" }));
  return maison;
}

async function ackComme(root, sessionId, id) {
  const client = new Client({ name: "cc2cc-v2-recu", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(depot, "src/mcp-server/server.js")],
    env: { PATH: process.env.PATH, HOME: root, CC2CC_V2_HOME: root, CC2CC_SELF: "alice", CLAUDE_CONFIG_DIR: ficheDeSession(root, sessionId) }
  });
  try {
    await client.connect(transport);
    const texte = (await client.callTool({ name: "ack", arguments: { msg_id: id } })).content[0].text;
    try { return { texte, json: JSON.parse(texte) }; } catch { return { texte, json: null }; }
  } finally {
    await client.close().catch(() => {});
  }
}

const accuse = (root) => {
  const db = openDatabase({ file: path.join(root, "broker.db") });
  try { return db.prepare("SELECT acked_at FROM messages WHERE msg_id = 'msg-r1'").get().acked_at; } finally { db.close(); }
};

test("ack by msg_id still works", async () => {
  const { root } = bureau();
  const r = await ackComme(root, "sess-1", "msg-r1");
  assert.equal(r.json?.acked, true, r.texte);
  assert.ok(accuse(root));
});

test("ack by the `Receipt:` id shown at delivery acks the letter it carried", async () => {
  const { root, attemptId } = bureau();
  const r = await ackComme(root, "sess-1", attemptId);
  assert.equal(r.json?.acked, true, r.texte);
  assert.equal(r.json.message.msg_id, "msg-r1", "the answer names the letter's own msg_id");
  assert.ok(accuse(root), "acked_at is set on the letter");
});

test("a sister chair is refused with the delivery id too, and the refusal names the msg_id", async () => {
  const { root, attemptId } = bureau();
  const r = await ackComme(root, "sess-2", attemptId);
  assert.equal(r.json?.acked, false, r.texte);
  assert.equal(r.json.refus, "accuse-refuse-lettre");
  assert.equal(r.json.msg_id, "msg-r1");
  assert.equal(accuse(root), null, "the refused ack leaves the letter untouched");
  // Le même refus avec le msg_id : les deux identifiants ferment la même porte.
  const direct = await ackComme(root, "sess-2", "msg-r1");
  assert.equal(direct.json?.refus, "accuse-refuse-lettre");
  assert.equal(accuse(root), null);
});

test("an unknown id says Message not found and points at the msg_id shown as id=", async () => {
  const { root } = bureau();
  const r = await ackComme(root, "sess-1", crypto.randomUUID());
  assert.match(r.texte, /Message not found/);
  assert.match(r.texte, /acknowledge with the msg_id shown as `id=` in the delivery/);
  assert.equal(accuse(root), null);
});
