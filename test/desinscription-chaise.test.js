// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// N1 (seconde passe adverse du Run 6, 28/09) — ON NE DÉSINSCRIT PAS LA CHAISE
// D'UN AUTRE.
//
// Un client MCP simple (sans fiche, n'importe quel nom) appelait
// `unregister({id:"lignee-t#ALPHA"})` sur une chaise vivante et confirmée : la
// chaise passait `offline`, la lignée retombait sur la fiche nue, et le même
// client relevait puis accusait la lettre de la vraie session. Tout F3 reposait
// sur « une chaise vivante de session », et n'importe qui effaçait ce fait.
// Désormais : une chaise ne se désinscrit que par elle-même (sa fiche la
// dérive) ou quand son processus est mort (`verdictDeChaise`) ; le CLI exige
// `--force` pour une chaise vivante ; et la garde du nom nu compte aussi une
// chaise `offline` dont le processus est encore la même incarnation.
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
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-desinscription-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});
const { insertMessage, openDatabase, unregisterPeer, ackMessage } = await import("../src/lib/database.js");
const { registerInstance, designatePrimary } = await import("../src/lib/registry.js");
const { procStartOf } = await import("../src/lib/postbox.js");

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const outil = async (c, name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);

async function connecter(root, self, extra = {}) {
  const c = new Client({ name: "valxos-desinscription", version: "0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: [path.join(repo, "src/mcp-server/server.js")],
    env: envPropre({ CC2CC_V2_HOME: root, CC2CC_SELF: self, ...extra })
  }));
  return c;
}

function scene(t, { designer = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-desinscription-"));
  const vrai = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => { try { vrai.kill("SIGKILL"); } catch { /* parti */ } });
  const naissance = procStartOf(vrai.pid);
  assert.ok(naissance, "sonde impossible : ps n'a pas rendu d'heure de naissance");
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: vrai.pid, procStart: naissance });
  if (designer) designatePrimary(db, "lignee-t", "ALPHA");
  const lettre = insertMessage(db, { sender: "bob-eternal", recipient: "lignee-t", body: "pour la chaise ALPHA vivante" });
  db.close();
  return { root, lettre, ouvrir: () => openDatabase({ file: path.join(root, "broker.db") }) };
}

for (const designer of [false, true]) {
  test(`N1 — un client simple ne désinscrit pas une chaise vivante, puis ne prend pas sa lettre (désignée=${designer})`, async (t) => {
    const s = scene(t, { designer });
    for (const nom of ["lignee-t", "etranger"]) {
      const c = await connecter(s.root, nom);
      try {
        const u = await outil(c, "unregister", { id: "lignee-t#ALPHA" });
        assert.equal(u.unregistered, false, `${nom} : ${JSON.stringify(u)}`);
        assert.equal(u.refus, "desinscription-refusee");
        const inbox = await outil(c, "inbox");
        assert.equal(inbox.count, 0);
        if (nom === "lignee-t") assert.equal((await outil(c, "ack", { msg_id: s.lettre.msg_id })).acked, false);
      } finally {
        await c.close();
      }
    }
    const v = s.ouvrir();
    assert.equal(v.prepare("SELECT status FROM peers WHERE id = 'lignee-t#ALPHA'").get().status !== "offline", true, "la chaise reste en service");
    assert.equal(v.prepare("SELECT acked_at FROM messages WHERE msg_id = ?").get(s.lettre.msg_id).acked_at, null);
    const refus = v.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE event_type = 'desinscription_refusee'").get().n;
    v.close();
    assert.ok(refus >= 1, "le refus se lit au journal du bureau");
  });
}

test("N1 — une chaise se désinscrit elle-même (sa fiche la dérive)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-desinscription-soi-"));
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "ALPHA", messagingSocketPath: path.join(maison, "r.sock"), name: "alpha" }));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "lignee-t", sessionId: "ALPHA", pid: process.pid, house: maison });
  db.close();
  const c = await connecter(root, "lignee-t", { CLAUDE_CONFIG_DIR: maison });
  try {
    const u = await outil(c, "unregister", { id: "lignee-t#ALPHA" });
    assert.equal(u.unregistered, true, JSON.stringify(u));
  } finally {
    await c.close();
  }
});

test("N1 — une chaise morte se désinscrit par n'importe qui", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-desinscription-morte-"));
  const mort = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  const pidMort = Number(mort.stdout.trim());
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "lignee-t", sessionId: "PARTIE", pid: pidMort, procStart: "Mon Jan  1 00:00:00 2024" });
  db.close();
  const c = await connecter(root, "etranger");
  try {
    const u = await outil(c, "unregister", { id: "lignee-t#PARTIE" });
    assert.equal(u.unregistered, true, JSON.stringify(u));
  } finally {
    await c.close();
  }
});

test("N1 — valxos-unregister refuse une chaise vivante sans --force ; --force la retire, journalisé", (t) => {
  const s = scene(t);
  const env = envPropre({ CC2CC_V2_HOME: s.root, CC2CC_SELF: "operateur" });
  const bin = path.join(repo, "src/bin/valxos-unregister.js");
  const refus = spawnSync(process.execPath, [bin, "--id", "lignee-t#ALPHA"], { encoding: "utf8", env });
  assert.equal(refus.status, 1, `${refus.stdout}\n${refus.stderr}`);
  assert.match(refus.stderr, /--force/);
  // Le verdict se lit en anglais (18/10) : plus « chair verdict vivante
  // (meme-incarnation) », deux codes français dans une phrase anglaise.
  assert.match(refus.stderr, /\(chair verdict: alive \(same incarnation\): only the chair itself/);
  let v = s.ouvrir();
  assert.notEqual(v.prepare("SELECT status FROM peers WHERE id = 'lignee-t#ALPHA'").get().status, "offline");
  v.close();
  const force = spawnSync(process.execPath, [bin, "--id", "lignee-t#ALPHA", "--force"], { encoding: "utf8", env });
  assert.equal(force.status, 0, force.stderr);
  v = s.ouvrir();
  assert.equal(v.prepare("SELECT status FROM peers WHERE id = 'lignee-t#ALPHA'").get().status, "offline");
  const geste = v.prepare("SELECT detail_json FROM delivery_events WHERE event_type = 'peer_unregistered' ORDER BY id DESC LIMIT 1").get();
  v.close();
  assert.match(geste.detail_json, /force/);
});

test("N1 — ceinture : une chaise offline mais vivante (même incarnation) tient toujours la lignée contre un nom nu", (t) => {
  const s = scene(t);
  const db = s.ouvrir();
  try {
    unregisterPeer(db, "lignee-t#ALPHA");
    assert.throws(() => ackMessage(db, s.lettre.msg_id, "lignee-t"), (e) => e.code === "accuse_refuse");
  } finally {
    db.close();
  }
});
