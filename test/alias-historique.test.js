// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// F8 (passe adverse du Run 6, 28/09) — UN ALIAS N'HÉRITE PAS DU PASSÉ DU NOM.
//
// `bob` et `carol` s'écrivent, `bob` part, `valxos-chaise alias bob mallory`
// passe sans un mot : `history({self:"bob"})` au guichet MCP de mallory rendait
// les deux lettres, toutes écrites AVANT l'alias. Désormais : sous un alias ou
// un ancien nom, l'historique est borné aux lettres d'après son `depose_at` ;
// et `alias` dit combien de lettres passées le nom porte, et exige `--force`
// quand il y en a.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-alias-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});
const { insertMessage, openDatabase, registerPeer, unregisterPeer, history } = await import("../src/lib/database.js");

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const outil = async (c, name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);

function scene() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-alias-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerPeer(db, { id: "bob", status: "active" });
  registerPeer(db, { id: "carol", status: "active" });
  const passees = [
    insertMessage(db, { sender: "carol", recipient: "bob", body: "carol à bob, avant tout alias" }),
    insertMessage(db, { sender: "bob", recipient: "carol", body: "bob à carol, réponse privée" })
  ];
  unregisterPeer(db, "bob");
  // mallory est un client MCP simple (sa fiche sans session) : depuis le fix
  // round 2, un nom nu ne relève plus en propriétaire une adresse qui mène à
  // une chaise de session — le cas de la fuite est le client en bac à sable.
  registerPeer(db, { id: "mallory", status: "active" });
  db.close();
  const env = envPropre({ CC2CC_V2_HOME: root });
  const chaise = (...args) => spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-chaise.js"), ...args], { env, encoding: "utf8" });
  return { root, env, passees, chaise, ouvrir: () => openDatabase({ file: path.join(root, "broker.db") }) };
}

test("F8 — alias sur un nom qui porte des lettres passées : le compte est dit, --force exigé, rien posé sans lui", () => {
  const s = scene();
  const refus = s.chaise("alias", "bob", "mallory");
  assert.notEqual(refus.status, 0, "sans --force, l'alias ne se pose pas");
  assert.match(refus.stderr + refus.stdout, /2 past letter/);
  assert.match(refus.stderr + refus.stdout, /--force/);
  const v = s.ouvrir();
  assert.equal(v.prepare("SELECT COUNT(*) AS n FROM anciens_noms").get().n, 0, "rien n'a été posé");
  v.close();
  const pose = s.chaise("alias", "bob", "mallory", "--force", "--json");
  assert.equal(pose.status, 0, pose.stderr);
  assert.equal(JSON.parse(pose.stdout).lettres_passees, 2);
});

test("F8 — sous un alias, history ne rend que les lettres d'après le dépôt (MCP et base)", async () => {
  const s = scene();
  assert.equal(s.chaise("alias", "bob", "mallory", "--force").status, 0);
  const db = s.ouvrir();
  const apres = insertMessage(db, {
    sender: "carol", recipient: "bob", body: "après l'alias", created_at: new Date(Date.now() + 5000).toISOString()
  });
  assert.deepEqual(history(db, { self: "bob" }).map((m) => m.msg_id), [apres.msg_id], "la base borne l'historique du nom");
  assert.deepEqual(history(db, { self: "bob", peer: "carol" }).map((m) => m.msg_id), [apres.msg_id]);
  db.close();
  const c = new Client({ name: "valxos-alias", version: "0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: [path.join(repo, "src/mcp-server/server.js")], env: { ...s.env, CC2CC_SELF: "mallory" }
  }));
  try {
    const h = await outil(c, "history", { self: "bob" });
    const ids = (h.messages || []).map((m) => m.msg_id);
    for (const passee of s.passees) assert.ok(!ids.includes(passee.msg_id), "une lettre d'avant l'alias ne passe pas");
    assert.ok(ids.includes(apres.msg_id), "une lettre d'après l'alias passe");
  } finally {
    await c.close();
  }
});

test("F8 — un nom sans lettres passées s'aliase sans --force", () => {
  const s = scene();
  const r = s.chaise("alias", "personne", "mallory");
  assert.equal(r.status, 0, r.stderr);
});
