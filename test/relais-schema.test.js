// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE SCHÉMA 8 ET LA CONFIGURATION DU RELAIS.
//
// Toutes les bases de ce fichier sont JETABLES (mkdtemp + bureau posé) : le
// bureau de poste vivant n'est JAMAIS ouvert ici.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase } from "../src/lib/database.js";
import { SCHEMA_VERSION, migrate, schemaVersion } from "../src/lib/migrations.js";
import { designatePrimary, registerInstance } from "../src/lib/registry.js";
import { lireLaConfigDuRelais } from "../src/lib/relais/config.js";
import { poserLeBureau } from "./aide-env.js";

function bureauJetable(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relais-schema-"));
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => {
    try { db.close(); } catch { /* base jetable */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, db };
}

const colonnes = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

test("schéma 8 : les colonnes du relais existent", (t) => {
  const { db } = bureauJetable(t);
  migrate(db);
  const lettres = colonnes(db, "messages");
  for (const c of ["via", "mac_origine", "porte_at", "porte_vers", "remise_rendue_at", "accuse_rendu_at"]) {
    assert.ok(lettres.includes(c), `messages.${c}`);
  }
  assert.ok(colonnes(db, "peers").includes("designe_at"), "peers.designe_at");
  assert.deepEqual(
    colonnes(db, "carnet"),
    ["chaise_id", "lineage", "instance_session_id", "mac", "is_primary", "designe_at", "vu_at", "parti_at"]
  );
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'carnet' AND name LIKE 'idx_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(index, ["idx_carnet_lineage", "idx_carnet_mac"]);
  assert.equal(SCHEMA_VERSION, 8);
  assert.equal(schemaVersion(db), 8);
});

test("une base en version 7 migre en 8 sans perdre une lettre", (t) => {
  const { db } = bureauJetable(t);
  migrate(db);
  // Le bureau tel que la version 7 le laissait : ni les colonnes du relais, ni le carnet.
  db.exec("DROP TABLE carnet");
  for (const c of ["via", "mac_origine", "porte_at", "porte_vers", "remise_rendue_at", "accuse_rendu_at"]) {
    db.exec(`ALTER TABLE messages DROP COLUMN ${c}`);
  }
  db.exec("ALTER TABLE peers DROP COLUMN designe_at");
  db.pragma("user_version = 7");
  db.prepare(`INSERT INTO messages (msg_id, sender, recipient, subject, body)
    VALUES ('v7-1', 'bob', 'alice', 'lettre de la version 7', 'Le phare compte les vagues.')`).run();
  assert.equal(schemaVersion(db), 7);
  assert.ok(!colonnes(db, "messages").includes("via"), "SONDE : le décor n'a pas `via`");

  const bilan = migrate(db);
  assert.equal(bilan.from, 7);
  assert.equal(bilan.to, 8);
  assert.deepEqual(bilan.manquantes, []);
  assert.equal(schemaVersion(db), 8);
  const lettre = db.prepare("SELECT * FROM messages WHERE msg_id = 'v7-1'").get();
  assert.equal(lettre.body, "Le phare compte les vagues.");
  assert.equal(lettre.via, null);
  assert.equal(lettre.mac_origine, null);
  assert.equal(lettre.porte_vers, null, "une lettre d'avant n'a été portée nulle part");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM carnet").get().n, 0, "le carnet naît vide");
});

test("designatePrimary date la désignation", (t) => {
  const { db } = bureauJetable(t);
  migrate(db);
  registerInstance(db, { lineage: "alice", sessionId: "sess-1", house: "/h/a", pid: process.pid });
  registerInstance(db, { lineage: "alice", sessionId: "sess-2", house: "/h/b", pid: process.pid });
  const dater = (s) => db.prepare("SELECT designe_at FROM peers WHERE instance_session_id = ?").get(s).designe_at;
  assert.equal(dater("sess-1"), null, "SONDE : une chaise jamais désignée n'a pas d'heure");
  const chaise = designatePrimary(db, "alice", "sess-1");
  assert.match(chaise.designe_at, /^\d{4}-\d\d-\d\dT/);
  assert.match(dater("sess-1"), /^\d{4}-\d\d-\d\dT/);
  assert.equal(dater("sess-2"), null, "l'autre chaise n'est pas datée");
});

function racineAvec(t, contenu) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relais-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (contenu !== undefined) fs.writeFileSync(path.join(root, "relais.json"), typeof contenu === "string" ? contenu : JSON.stringify(contenu));
  return root;
}

test("lireLaConfigDuRelais : null sans fichier", (t) => {
  assert.equal(lireLaConfigDuRelais(racineAvec(t)), null);
});

test("lireLaConfigDuRelais : l'exemple complet, intervalle par défaut à 2000", (t) => {
  const root = racineAvec(t, { moi: "Studio", macs: { MacBook: { ssh: "m3", node: "/opt/homebrew/bin/node", depot: "/opt/valxos/cc2cc-v2", bureau: "/opt/valxos/bureau" } } });
  assert.deepEqual(lireLaConfigDuRelais(root), {
    moi: "Studio",
    macs: { MacBook: { ssh: "m3", node: "/opt/homebrew/bin/node", depot: "/opt/valxos/cc2cc-v2", bureau: "/opt/valxos/bureau" } },
    intervalle_ms: 2000
  });
});

test("lireLaConfigDuRelais : macs absent vaut {}", (t) => {
  assert.deepEqual(lireLaConfigDuRelais(racineAvec(t, { moi: "Studio" })), { moi: "Studio", macs: {}, intervalle_ms: 2000 });
});

test("lireLaConfigDuRelais : une config invalide lève config-relais-invalide", (t) => {
  const mac = { ssh: "m3", node: "/n", depot: "/d", bureau: "/b" };
  const cas = {
    "objet vide": {},
    "Mac sans node, depot, bureau": { moi: "Studio", macs: { MacBook: { ssh: "m3" } } },
    "bureau en ~": { moi: "Studio", macs: { MacBook: { ...mac, bureau: "~/.valxos-messenger" } } },
    "depot relatif": { moi: "Studio", macs: { MacBook: { ...mac, depot: "repos/x" } } },
    "node relatif": { moi: "Studio", macs: { MacBook: { ...mac, node: "node" } } },
    "macs contient moi": { moi: "Studio", macs: { Studio: mac } },
    "JSON illisible": "{pas du json"
  };
  for (const [nom, contenu] of Object.entries(cas)) {
    assert.throws(() => lireLaConfigDuRelais(racineAvec(t, contenu)), { code: "config-relais-invalide" }, nom);
  }
});
