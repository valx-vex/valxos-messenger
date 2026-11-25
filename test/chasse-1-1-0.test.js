// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// LA CHASSE 1.0.0, PORTÉE SUR LA 1.1.0 (relais, Task 1b). Un processus Claude
// porte une session à la fois, mais plusieurs de suite (`/clear`). La session
// neuve du processus de la désignée tient la lignée ; une sœur d'un autre
// processus n'en a qu'une copie. Un appel servi (`served:`) n'est pas une chaise.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-chasse-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});
const { insertMessage, openDatabase } = await import("../src/lib/database.js");
const { designatePrimary, registerInstance } = await import("../src/lib/registry.js");
const { adressesDuRepli, copiesPourChaise, deciderLaCopie } = await import("../src/lib/identity.js");

const repo = path.resolve(new URL("..", import.meta.url).pathname);

function scene() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-chasse-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  return { root, db };
}

test("une session neuve du processus de la désignée tient la lignée", () => {
  const { db } = scene();
  try {
    registerInstance(db, { lineage: "lignee-a", sessionId: "s-ancienne", pid: process.ppid });
    registerInstance(db, { lineage: "lignee-a", sessionId: "s-neuve", pid: process.ppid });
    registerInstance(db, { lineage: "lignee-a", sessionId: "s-soeur", pid: process.pid });
    designatePrimary(db, "lignee-a", "s-ancienne");
    insertMessage(db, { sender: "bob", recipient: "lignee-a", body: "pour la lignée" });

    assert.ok(adressesDuRepli(db, "lignee-a", { session_id: "s-neuve" }).includes("lignee-a"),
      "la session neuve du même processus tient la lignée");
    assert.ok(!adressesDuRepli(db, "lignee-a", { session_id: "s-soeur" }).includes("lignee-a"),
      "une sœur d'un autre processus n'a qu'une copie");
    assert.equal(copiesPourChaise(db, "lignee-a", "s-neuve").chaiseId, null, "pas de copie pour la session du même processus");
    assert.equal(copiesPourChaise(db, "lignee-a", "s-soeur").rows.length, 1);
  } finally { db.close(); }
});

test("la règle du même processus ne se déclenche qu'avec un pid > 1 identique", () => {
  const cible = { id: "lignee-a#s1", instance_session_id: "s1", lineage: "lignee-a", pid: 4242 };
  const resolution = { kind: "lineage", targets: [cible] };
  const raison = (pidDeMaChaise) => deciderLaCopie({ lignee: "lignee-a", sessionId: "s2", resolution, pidDeMaChaise }).raison;
  assert.equal(raison(4242), "destinataire-meme-processus");
  assert.equal(raison(4243), "cc");
  assert.equal(raison(null), "cc");
  const un = { ...resolution, targets: [{ ...cible, pid: 1 }] };
  assert.equal(deciderLaCopie({ lignee: "lignee-a", sessionId: "s2", resolution: un, pidDeMaChaise: 1 }).raison, "cc");
});

test("un appel servi (served:) n'est pas une chaise", () => {
  const { root, db } = scene();
  registerInstance(db, { lineage: "lignee-a", sessionId: "s-vraie", pid: process.pid });
  insertMessage(db, { sender: "bob", recipient: "lignee-a", priority: "high", body: "pour la lignée" });
  db.close();
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  // Le hook lit `sessions/<ppid>.json` : son parent est ce processus-ci.
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "served:caller-x" }));
  const lancer = (script, event) => spawnSync("node", [path.join(repo, "src/hooks", script)], {
    input: JSON.stringify({ hook_event_name: event, session_id: "served:caller-x" }),
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "lignee-a", CLAUDE_CONFIG_DIR: maison }
  });
  const post = lancer("piggyback_fetch.js", "PostToolUse");
  assert.equal(post.status, 0, post.stderr);
  assert.deepEqual(JSON.parse(post.stdout), {});
  const stop = lancer("safety_net_poll.js", "Stop");
  assert.equal(stop.status, 0, stop.stderr);
  assert.deepEqual(JSON.parse(stop.stdout), {});
  const relu = openDatabase({ file: path.join(root, "broker.db") });
  try {
    assert.equal(relu.prepare("SELECT COUNT(*) AS n FROM peers WHERE id LIKE '%served:%' OR instance_session_id LIKE 'served:%'").get().n, 0);
  } finally { relu.close(); }
});
