// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'HISTORIQUE EST UNE BOÎTE, PAS LA TABLE — G1, fix round 1 (finding
// réviseur CRITICAL 1).
//
// `history()` ne filtrait par `self` QUE dans la branche `self && peer` :
// sans `peer`, elle rendait la TABLE ENTIÈRE (corps des lettres compris) ;
// `thread_id` REMPLAÇAIT le filtre `self` au lieu de s'y AJOUTER, donc un
// thread étranger se lisait en entier par n'importe qui. La garde d'identité
// du guichet MCP (server.js) ne changeait rien à ça : elle décide QUI a le
// droit de porter un nom, jamais CE QUE la requête SQL rend une fois le nom
// accepté — deux questions différentes, deux endroits différents.
//
// ⚠️ Toutes les bases ici sont JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau
// de poste vivant (~/.cc2cc-v2/broker.db) n'est JAMAIS ouvert ici.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { history, insertMessage, openDatabase } from "../src/lib/database.js";
import { migrate } from "../src/lib/migrations.js";
import { poserLeBureau } from "./aide-env.js";

// ⚠️ LE JETABLE VAUT AUSSI POUR CE PROCESSUS-CI (revue adverse F2, 21/08). Un `file`
// explicite ne protège PAS le bureau vivant : `ensureRuntimeDirs`,
// `writeHeartbeat` et le registre lisent `baseDir()` — donc l'ENV du runner,
// jamais le fichier qu'on vient de leur imposer. Sans ce plancher, les gestes
// EN PROCESSUS de ce fichier écrivaient dans le VRAI ~/.cc2cc-v2 (fiches et
// répertoires constatés le 21/08). Les tests qui posent leur propre racine la
// posent par-dessus ; l'état d'origine se restaure à la fin du fichier.
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-histoire-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});


function migratedDb(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-histoire-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  t.after(() => {
    try {
      db.close();
    } catch {
      /* base jetable */
    }
  });
  return db;
}

test("sans peer ni thread_id, l'historique rend SA correspondance — jamais la table entière", (t) => {
  const db = migratedDb(t);
  insertMessage(db, { msg_id: "H1", sender: "a", recipient: "b", body: "SECRET-DE-A-VERS-B" });
  insertMessage(db, { msg_id: "H2", sender: "c", recipient: "d", body: "SECRET-DE-C-VERS-D" });

  const vueDeA = history(db, { self: "a" });
  assert.equal(vueDeA.length, 1, "« a » ne voit QUE sa propre lettre, jamais celle de c/d");
  assert.equal(vueDeA[0].msg_id, "H1");
  assert.equal(
    vueDeA.some((m) => m.body === "SECRET-DE-C-VERS-D"),
    false,
    "le corps de la lettre d'un autre couple ne doit JAMAIS apparaître"
  );

  const vueDeC = history(db, { self: "c" });
  assert.equal(vueDeC.length, 1);
  assert.equal(vueDeC[0].msg_id, "H2");
});

test("un thread ÉTRANGER (self n'y participe pas) rend un historique VIDE, jamais le thread d'un autre", (t) => {
  const db = migratedDb(t);
  insertMessage(db, { msg_id: "H3", sender: "a", recipient: "b", thread_id: "T-AB", body: "privé A/B" });

  const espion = history(db, { self: "espion", thread_id: "T-AB" });
  assert.deepEqual(espion, [], "un thread où « espion » n'est ni expéditeur ni destinataire reste invisible");

  const participant = history(db, { self: "a", thread_id: "T-AB" });
  assert.equal(participant.length, 1, "un participant du thread continue de le lire par son propre nom");
});

test("sans identité, l'historique ne rend rien — jamais un repli sur la table entière", (t) => {
  const db = migratedDb(t);
  insertMessage(db, { msg_id: "H4", sender: "a", recipient: "b", body: "x" });

  assert.deepEqual(history(db, {}), [], "self absent : une boîte sans nom ne s'ouvre pas");
  assert.deepEqual(history(db, { self: "   " }), [], "self blanc n'est pas un nom");
});

test("self ET peer restent bornés au couple exact (régression : ce chemin était déjà correct)", (t) => {
  const db = migratedDb(t);
  insertMessage(db, { msg_id: "H5", sender: "a", recipient: "b", body: "a vers b" });
  insertMessage(db, { msg_id: "H6", sender: "b", recipient: "a", body: "b vers a" });
  insertMessage(db, { msg_id: "H7", sender: "a", recipient: "c", body: "a vers c, hors du couple a/b" });

  const couple = history(db, { self: "a", peer: "b" });
  assert.equal(couple.length, 2);
  assert.ok(
    couple.every((m) => m.msg_id === "H5" || m.msg_id === "H6"),
    "H7 (a vers c) n'appartient pas au couple a/b"
  );
});
