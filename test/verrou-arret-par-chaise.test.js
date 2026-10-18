// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// F4 (passe adverse du Run 6, 28/09) — LE VERROU D'ARRÊT EST À LA CHAISE.
//
// Le filet de Stop promet « jamais plus de 3 blocages pour une lettre ». Il
// était tenu sous le nom de LIGNÉE (`run/<lignée>.stop_guard.json`) : deux
// chaises de la même lignée, chacune avec sa lettre urgente nominative,
// réécrivaient tour à tour `last_msg_id` — le compteur de l'autre retombait à
// 1, et aucun des deux Stop n'était jamais relâché (10 sur 10 bloqués, sonde
// de l'adversaire). Le verrou est désormais clé par chaise (`lignée#session`)
// dès qu'il y a une session ; la lignée seule ne sert qu'aux appelants sans
// session.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { envPropre, poserLeBureau } from "./aide-env.js";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const racine = poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-verrou-arret-")));
const { insertMessage, openDatabase } = await import("../src/lib/database.js");
const { cleDuVerrouDArret } = await import("../src/lib/stop-guard.js");

function scene(t) {
  const root = fs.mkdtempSync(path.join(racine, "bureau-"));
  const env = envPropre({ CC2CC_V2_HOME: root, CC2CC_SELF: "lin" });
  const crochet = (fichier, sessionId) => spawnSync(process.execPath, [path.join(repo, "src/hooks", fichier)], {
    env, encoding: "utf8", input: JSON.stringify({ session_id: sessionId, cwd: root, hook_event_name: "Stop" })
  });
  // Les deux chaises s'annoncent au premier passage d'un hook.
  for (const s of ["A", "B"]) assert.equal(crochet("safety_net_poll.js", s).status, 0);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { sender: "x", recipient: "lin#A", body: "pour A", priority: "high" });
  insertMessage(db, { sender: "x", recipient: "lin#B", body: "pour B", priority: "high" });
  db.close();
  return { root, crochet };
}

test("F4 — deux chaises d'une lignée, une lettre urgente chacune : chaque Stop est relâché après SES 3 blocages", (t) => {
  const { crochet } = scene(t);
  const blocages = { A: 0, B: 0 };
  for (let i = 0; i < 6; i++) {
    for (const s of ["A", "B"]) if (crochet("safety_net_poll.js", s).status === 2) blocages[s] += 1;
  }
  assert.deepEqual(blocages, { A: 3, B: 3 }, "le filet tient sa promesse par chaise, même en alternance");
});

test("F4 — la relève d'une chaise (PostToolUse) ne remet pas à zéro le verrou de sa sœur", (t) => {
  const { root, crochet } = scene(t);
  for (let i = 0; i < 3; i++) assert.equal(crochet("safety_net_poll.js", "A").status, 2);
  // B relève son courrier : SON verrou se remet à zéro, pas celui de A.
  assert.equal(crochet("piggyback_fetch.js", "B").status, 0);
  assert.equal(crochet("safety_net_poll.js", "A").status, 0, "A a eu ses 3 blocages : relâchée");
  assert.ok(fs.existsSync(path.join(root, "run", "lin_A.stop_guard.json")), "le verrou vit sous la chaise");
});

test("F4 — la clef : la chaise quand il y a une session, la lignée sinon", () => {
  assert.equal(cleDuVerrouDArret("lin", "A"), "lin#A");
  assert.equal(cleDuVerrouDArret("lin", null), "lin");
  assert.equal(cleDuVerrouDArret("lin#A", "A"), "lin#A", "une chaise déjà nommée ne se double pas");
});

// M-5 (revue du 28/09) — LA RELÈVE MCP D'UNE CHAISE LIBÈRE LE VERROU QUE SES
// HOOKS ONT POSÉ. Les clefs concordent par construction (`lignée#session`) ;
// ceci le prouve de bout en bout : un Stop bloque deux fois (hook), la chaise
// relève au guichet MCP (sa fiche la dérive), le verrou de la chaise est remis
// à zéro.
test("M-5 — l'inbox MCP d'une chaise remet à zéro le verrou d'arrêt posé par ses hooks", async (t) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const root = fs.mkdtempSync(path.join(racine, "bureau-mcp-"));
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "A", messagingSocketPath: path.join(maison, "r.sock"), name: "a" }));
  const env = envPropre({ CC2CC_V2_HOME: root, CC2CC_SELF: "lin", CLAUDE_CONFIG_DIR: maison });
  const crochet = () => spawnSync(process.execPath, [path.join(repo, "src/hooks/safety_net_poll.js")], {
    env, encoding: "utf8", input: JSON.stringify({ session_id: "A", cwd: root, hook_event_name: "Stop" })
  });
  assert.equal(crochet().status, 0, "la chaise s'annonce");
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { sender: "x", recipient: "lin#A", body: "urgente", priority: "high" });
  db.close();
  assert.equal(crochet().status, 2);
  assert.equal(crochet().status, 2);
  const fichier = path.join(root, "run", "lin_A.stop_guard.json");
  assert.equal(JSON.parse(fs.readFileSync(fichier, "utf8")).block_count, 2);
  const c = new Client({ name: "m5", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: [path.join(repo, "src/mcp-server/server.js")], env }));
  try {
    const inbox = JSON.parse((await c.callTool({ name: "inbox", arguments: {} })).content[0].text);
    assert.equal(inbox.self, "lin#A");
    assert.equal(inbox.count, 1);
  } finally {
    await c.close();
  }
  assert.equal(JSON.parse(fs.readFileSync(fichier, "utf8")).block_count, 0, "le verrou de la chaise est remis à zéro");
});
