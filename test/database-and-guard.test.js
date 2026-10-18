// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ackMessage,
  getPeer,
  getPendingForContext,
  getPendingForMonitor,
  insertMessage,
  listPeers,
  markDelivered,
  markInjected,
  openDatabase,
  registerPeer,
  unregisterPeer
} from "../src/lib/database.js";
import { evaluateStopGuard, resetStopGuard } from "../src/lib/stop-guard.js";
import { poserLeBureau } from "./aide-env.js";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-test-"));
}

test("SQLite message lifecycle preserves order and state transitions", () => {
  const root = tempHome();
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });

  const first = insertMessage(db, {
    sender: "bob-opus",
    recipient: "alice-codex",
    subject: "A",
    body: "first"
  });
  const second = insertMessage(db, {
    sender: "bob-cli",
    recipient: "alice-codex",
    subject: "B",
    body: "second"
  });

  assert.equal(first.seq < second.seq, true);
  assert.deepEqual(
    getPendingForMonitor(db, "alice-codex").map((row) => row.msg_id),
    [first.msg_id, second.msg_id]
  );

  markInjected(db, [first], "alice-codex");
  assert.deepEqual(
    getPendingForMonitor(db, "alice-codex").map((row) => row.msg_id),
    [second.msg_id]
  );

  const pending = getPendingForContext(db, "alice-codex");
  assert.deepEqual(pending.map((row) => row.msg_id), [first.msg_id, second.msg_id]);
  markDelivered(db, pending, "alice-codex");
  assert.equal(getPendingForContext(db, "alice-codex").length, 0);

  const acked = ackMessage(db, first.msg_id, "alice-codex");
  assert.ok(acked.acked_at);
  db.close();
});

test("Stop guard blocks three times then allows the same message", () => {
  const root = tempHome();
  poserLeBureau(root);
  fs.mkdirSync(path.join(root, "run"), { recursive: true });

  resetStopGuard("alice-codex");
  assert.equal(evaluateStopGuard("alice-codex", "msg-1").shouldBlock, true);
  assert.equal(evaluateStopGuard("alice-codex", "msg-1").shouldBlock, true);
  assert.equal(evaluateStopGuard("alice-codex", "msg-1").shouldBlock, true);
  assert.equal(evaluateStopGuard("alice-codex", "msg-1").shouldBlock, false);
  assert.equal(evaluateStopGuard("alice-codex", "msg-2").shouldBlock, true);
});

// CAMP B EST CONSTITUTIONNEL (décision 20/08) : `unregisterPeer` n'a plus de
// voie destructive du tout — même en lui passant l'ancienne option par son
// nom exact, comme le ferait un appelant qui n'aurait pas suivi la migration.
// Il ne reste qu'un seul geste possible : marquer hors service.
test("unregisterPeer ignore l'ancienne option deleteRow — aucune ligne ne disparaît jamais", () => {
  const root = tempHome();
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });

  registerPeer(db, { id: "bob", description: "maison" });
  const avant = listPeers(db, { includeDead: true }).length;

  const result = unregisterPeer(db, "bob", { deleteRow: true });

  assert.equal(listPeers(db, { includeDead: true }).length, avant, "le compte des lignes ne descend jamais");
  assert.equal(result.status, "offline", "hors service, pas hors existence");
  assert.ok(getPeer(db, "bob"), "la fiche reste lisible — Camp B, rien ne s'efface");
  assert.equal(getPeer(db, "bob").status, "offline");
  db.close();
});

// Le chemin normal (sans option, l'appel de tous les jours) doit continuer
// à rendre exactement ce qu'il rendait avant ce chantier.
test("unregisterPeer sans option marque hors service — comportement inchangé", () => {
  const root = tempHome();
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });

  registerPeer(db, { id: "alice", description: "maison" });
  const result = unregisterPeer(db, "alice");

  assert.equal(result.status, "offline");
  assert.ok(getPeer(db, "alice"), "la fiche existe toujours");
  db.close();
});
