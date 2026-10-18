// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// I1 (revue finale de la branche, 28/09) — UNE CHAISE DÉSIGNÉE MORTE MAIS PAS
// MOISSONNÉE NE CAPTURE PLUS LE COURRIER DE SA LIGNÉE.
//
// Depuis que plus aucun processus automatique ne moissonne (doctor en
// rapport, moniteur sans moisson au démarrage), une chaise désignée dont le
// processus est parti restait `active` et `is_primary` : la lignée lui était
// routée, la sœur vivante recevait une copie « livrée à <la morte> », et le
// Facteur frappait à une porte morte pour toujours. La résolution consulte
// désormais `verdictDeChaise` de la désignée (lecture seule, aucune écriture) :
// morte → la lettre est TENUE (ambigu), l'histoire `designee_morte` est dite.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-designee-morte-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});
const { insertMessage, openDatabase } = await import("../src/lib/database.js");
const { designatePrimary, registerInstance, resolveRecipient, listLineages } = await import("../src/lib/registry.js");
const { adressesDuRepli, copiesPourChaise } = await import("../src/lib/identity.js");
const { trouverLaBoite } = await import("../src/facteur/round.js");

const repo = path.resolve(new URL("..", import.meta.url).pathname);

function pidMort() {
  const r = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(r.stdout.trim());
}

function scene() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-designee-morte-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "lin", sessionId: "ALPHA", pid: pidMort() });
  registerInstance(db, { lineage: "lin", sessionId: "INST", pid: process.pid });
  designatePrimary(db, "lin", "ALPHA");
  const lettre = insertMessage(db, { sender: "bob", recipient: "lin", body: "pour la lignée" });
  return { root, db, lettre };
}

test("I1 — désignée morte non moissonnée : la lettre de la lignée est TENUE, la sœur vivante en voit la copie sans-chaise, rien n'est livré à la morte", () => {
  const { db, lettre } = scene();
  try {
    const resolution = resolveRecipient(db, "lin");
    assert.equal(resolution.kind, "ambigu", JSON.stringify(resolution));
    assert.ok(!resolution.targets.some((t) => t.id === "lin#ALPHA"), "la morte n'est pas une cible");
    assert.equal(resolution.designee_morte?.session, "ALPHA", "l'histoire de la désignée morte est dite");
    assert.equal(db.prepare("SELECT status FROM peers WHERE id = 'lin#ALPHA'").get().status, "active", "lecture seule : aucune écriture de statut");

    assert.deepEqual(adressesDuRepli(db, "lin", { session_id: "INST" }), ["lin#INST"], "la lignée tenue n'est dans la boîte de personne");
    const cc = copiesPourChaise(db, "lin", "INST");
    assert.equal(cc.sansChaiseDesignee, true, "la copie dit sans-chaise-designee (vrai), plus « livrée à la morte »");
    assert.equal(cc.rows[0].msg_id, lettre.msg_id);

    const boite = trouverLaBoite(db, lettre, { parSession: new Map(), houses: [], resoudre: resolveRecipient });
    assert.equal(boite.motif, "lignee-ambigue", "le Facteur tient la lettre au lieu de frapper à une porte morte");

    const lignee = listLineages(db).find((l) => l.lineage === "lin");
    assert.equal(lignee.designee_morte?.session, "ALPHA", "`valxos-chaise lignees` dit désignée morte");
  } finally {
    db.close();
  }
});

test("I1 — le moniteur Python résout pareil : lignée tenue, rien à relever pour la sœur", (t) => {
  const { root, db } = scene();
  db.close();
  const python = spawnSync("python3", ["-B", "-c",
    "import importlib.util,sys,json; " +
    `s=importlib.util.spec_from_file_location('m',${JSON.stringify(path.join(repo, "src/monitor/valxos_monitor.py"))}); ` +
    "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);" +
    "mon=m.Monitor(); mon.session_id='INST'; c=mon.connect_db(); r=mon.resolution_de_lignee(c);" +
    "print(json.dumps({'kind': r['kind'], 'ids': [x['id'] for x in r['targets']], 'drain': mon.may_drain_lineage(c)}))"],
  { encoding: "utf8", env: envPropre({ CC2CC_V2_HOME: root, CC2CC_SELF: "lin" }) });
  assert.equal(python.status, 0, python.stderr);
  const r = JSON.parse(python.stdout.trim().split("\n").pop());
  assert.equal(r.kind, "ambigu");
  assert.ok(!r.ids.includes("lin#ALPHA"));
  assert.equal(r.drain, false, "la sœur ne relève pas la lettre de lignée tenue");
});

test("I1 — une désignée VIVANTE garde la lignée (inchangé)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-designee-vivante-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  try {
    registerInstance(db, { lineage: "lin", sessionId: "ALPHA", pid: process.pid });
    registerInstance(db, { lineage: "lin", sessionId: "INST", pid: process.pid });
    designatePrimary(db, "lin", "ALPHA");
    const r = resolveRecipient(db, "lin");
    assert.equal(r.kind, "lineage");
    assert.equal(r.targets[0].id, "lin#ALPHA");
  } finally {
    db.close();
  }
});
