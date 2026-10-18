// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// Revue finale (28/09), « tests les plus faibles » n°2 : « le Facteur ne
// moissonne jamais » n'était prouvé que par un grep de trois fichiers source.
// Ici, le geste : une tournée réelle sur un bureau jetable, avec une chaise
// désignée dont le processus est mort — son statut ne bouge pas (aucune
// moisson automatique ; seuls `valxos-doctor --reap` et `valxos-chaise
// moissonner` écrivent), et la lettre de la lignée est tenue (I1).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
const racine = poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-facteur-moisson-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});
const { insertMessage, openDatabase } = await import("../src/lib/database.js");
const { designatePrimary, registerInstance } = await import("../src/lib/registry.js");
const { faireLaTournee } = await import("../src/facteur/round.js");

test("une tournée du Facteur ne marque jamais une chaise morte : son statut reste celui d'avant", async () => {
  const db = openDatabase({ file: path.join(racine, "broker.db") });
  try {
    const mort = Number(spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim());
    registerInstance(db, { lineage: "lin", sessionId: "MORTE", pid: mort });
    registerInstance(db, { lineage: "lin", sessionId: "VIVE", pid: process.pid });
    designatePrimary(db, "lin", "MORTE");
    insertMessage(db, { sender: "x", recipient: "lin", body: "pour la lignée" });
    await faireLaTournee(db, { maisons: [], journal: () => {} });
    const statut = db.prepare("SELECT status FROM peers WHERE id = 'lin#MORTE'").get().status;
    assert.equal(statut, "active", "aucune moisson automatique : le statut n'est écrit par personne");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE event_type = 'peer_reaped'").get().n, 0);
    assert.equal(db.prepare("SELECT carried_at FROM messages").get().carried_at, null, "la lettre tenue n'est portée à personne");
  } finally {
    db.close();
  }
});
