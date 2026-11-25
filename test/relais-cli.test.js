// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA COMMANDE `valxos-relais` : echanger (une tournée, un démarrage de Node) et etat.
// Chaque test a son bureau jetable ; le bureau vivant n'est jamais ouvert.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { insertMessage, getMessageById, openDatabase } from "../src/lib/database.js";
import { ecrireLeCarnet } from "../src/lib/relais/carnet.js";
import { exporterPour } from "../src/lib/relais/paquet.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(repo, "src/bin/relais.js");
const SSH = { SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" };
const AT = "2026-11-16T12:00:00.000Z";

function bureau(t, { config = true, visite = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relais-cli-"));
  if (visite) {
    // Le Mac visité : il ne connaît que son nom (docs/RELAIS.md).
    fs.writeFileSync(path.join(root, "relais.json"), JSON.stringify({ moi: "MacBook" }));
  } else if (config) {
    fs.writeFileSync(path.join(root, "relais.json"), JSON.stringify({
      moi: "MacBook",
      macs: { Studio: { ssh: "studio", node: "/opt/valxos/node", depot: "/opt/valxos/repo", bureau: "/opt/valxos/bureau" } }
    }));
  }
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => {
    try { db.close(); } catch { /* base jetable */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, db };
}

function lancer(root, args, { entree = "", env = {} } = {}) {
  return spawnSync("node", [BIN, ...args], {
    cwd: repo,
    input: entree,
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_GARDE_BUREAU: "1", CC2CC_V2_HOME: root, ...env }
  });
}

const chaiseStudio = {
  chaise_id: "alice#s-9", lineage: "alice", instance_session_id: "s-9", is_primary: 0, designe_at: null
};
const compter = (db) => db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;

function paquetDuStudio({ lettres = [] } = {}) {
  return {
    version: 1, schema: 8, de: "Studio", pour: "MacBook", lettres, evenements: [], chaises: []
  };
}
const lettreDuStudio = (msg_id) => ({
  msg_id, sender: "bob", recipient: "carol", thread_id: null, subject: null, body: "bonjour", priority: "normal",
  msg_type: "message", created_at: AT, sender_model: null, envoi_id: null, table_nom: null, reponse_a: null,
  sans_reveil: 0, sans_copie: 0, sender_chaise: null
});

test("echanger refuse de s'ouvrir sans ssh, et n'écrit rien", (t) => {
  const { root, db } = bureau(t);
  const r = lancer(root, ["echanger", "--de", "Studio"], { entree: JSON.stringify({ marquer: { portees: [], rendus: [] }, paquet: paquetDuStudio() }) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /over ssh/);
  assert.equal(compter(db), 0);
});

test("echanger par ssh importe, puis rend le paquet de ce Mac", (t) => {
  const { root, db } = bureau(t);
  const entree = { marquer: { portees: [], rendus: [] }, paquet: paquetDuStudio({ lettres: [lettreDuStudio("L-1")] }) };
  const r = lancer(root, ["echanger", "--de", "Studio"], { entree: JSON.stringify(entree), env: SSH });
  assert.equal(r.status, 0, r.stderr);
  const sortie = JSON.parse(r.stdout);
  assert.equal(sortie.resume.neuves, 1);
  assert.deepEqual(sortie.resume.refus, []);
  assert.equal(sortie.paquet.de, "MacBook");
  assert.equal(sortie.paquet.pour, "Studio");
  assert.equal(compter(db), 1);
});

test("echanger applique les marques avant d'importer", (t) => {
  const { root, db } = bureau(t);
  ecrireLeCarnet(db, "Studio", [chaiseStudio], { at: AT });
  insertMessage(db, { msg_id: "L-loc", sender: "bob", recipient: "alice#s-9", body: "x" });
  const entree = { marquer: { portees: ["L-loc"], rendus: [] }, paquet: paquetDuStudio() };
  const r = lancer(root, ["echanger", "--de", "Studio"], { entree: JSON.stringify(entree), env: SSH });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(getMessageById(db, "L-loc").porte_at, "la lettre de la tournée d'avant est marquée portée");
  assert.deepEqual(JSON.parse(r.stdout).paquet.lettres, [], "et ne repart pas");
});

test("echanger refuse un paquet tronqué et n'écrit rien", (t) => {
  const { root, db } = bureau(t);
  ecrireLeCarnet(db, "Studio", [chaiseStudio], { at: AT });
  insertMessage(db, { msg_id: "L-loc", sender: "bob", recipient: "alice#s-9", body: "x" });
  const complet = JSON.stringify({ marquer: { portees: ["L-loc"], rendus: [] }, paquet: paquetDuStudio({ lettres: [lettreDuStudio("L-1")] }) });
  const r = lancer(root, ["echanger", "--de", "Studio"], { entree: complet.slice(0, Math.floor(complet.length / 2)), env: SSH });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /paquet-illisible/);
  assert.equal(compter(db), 1, "rien n'est importé");
  assert.equal(getMessageById(db, "L-loc").porte_at, null, "aucune marque posée");
});

test("echanger rend le code d'une erreur de paquet (code 1, son code sur stderr)", (t) => {
  const { root, db } = bureau(t);
  const mal = { ...paquetDuStudio(), version: 99 };
  const r = lancer(root, ["echanger", "--de", "Studio"], { entree: JSON.stringify({ marquer: { portees: [], rendus: [] }, paquet: mal }), env: SSH });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /paquet-version/);
  assert.equal(compter(db), 0);
});

test("echanger refuse un --de qui est ce Mac, ou qui n'est pas l'expéditeur du paquet, avant toute marque", (t) => {
  const { root, db } = bureau(t);
  ecrireLeCarnet(db, "Studio", [chaiseStudio], { at: AT });
  insertMessage(db, { msg_id: "L-loc", sender: "bob", recipient: "alice#s-9", body: "x" });
  const entree = JSON.stringify({ marquer: { portees: ["L-loc"], rendus: [] }, paquet: paquetDuStudio() });
  for (const de of ["MacBook", "Autre"]) {
    const r = lancer(root, ["echanger", "--de", de], { entree, env: SSH });
    assert.equal(r.status, 2, `--de ${de}: ${r.stderr}`);
    assert.match(r.stderr, /paquet-mal-adresse/);
    assert.equal(getMessageById(db, "L-loc").porte_at, null, `--de ${de}: aucune marque`);
    assert.equal(getMessageById(db, "L-loc").porte_vers, null, `--de ${de}: aucune offre`);
  }
  const pourAutre = JSON.stringify({ marquer: { portees: ["L-loc"], rendus: [] }, paquet: { ...paquetDuStudio(), pour: "Autre" } });
  const r = lancer(root, ["echanger", "--de", "Studio"], { entree: pourAutre, env: SSH });
  assert.equal(r.status, 2);
  assert.equal(getMessageById(db, "L-loc").porte_at, null);
});

test("sans relais.json, echanger et etat sortent 2", (t) => {
  const { root } = bureau(t, { config: false });
  const e = lancer(root, ["echanger", "--de", "Studio"], { entree: "{}", env: SSH });
  assert.equal(e.status, 2);
  assert.match(e.stderr, /not configured/);
  const s = lancer(root, ["etat"]);
  assert.equal(s.status, 2);
  assert.match(s.stderr, /not configured/);
});

test("etat compte les lettres en route", (t) => {
  const { root, db } = bureau(t);
  ecrireLeCarnet(db, "Studio", [chaiseStudio], { at: AT });
  insertMessage(db, { msg_id: "L-1", sender: "bob", recipient: "alice#s-9", body: "un" });
  insertMessage(db, { msg_id: "L-2", sender: "bob", recipient: "alice#s-9", body: "deux" });
  const r = lancer(root, ["etat"]);
  assert.equal(r.status, 0, r.stderr);
  const etat = JSON.parse(r.stdout);
  assert.equal(etat.moi, "MacBook");
  assert.equal(etat.en_route.Studio, 2);
  assert.equal(etat.derniere_tournee, null);
  assert.equal(getMessageById(db, "L-1").porte_vers, null, "etat n'offre rien (il ne passe pas par exporterPour)");
  // Une lettre offerte puis confirmée portée n'est plus en route.
  exporterPour(db, "Studio", { moi: "MacBook" });
  db.prepare("UPDATE messages SET porte_at = ? WHERE msg_id = 'L-1'").run(AT);
  fs.mkdirSync(path.join(root, "status"), { recursive: true });
  fs.writeFileSync(path.join(root, "status", "relais.json"), JSON.stringify({ at: AT }));
  const apres = JSON.parse(lancer(root, ["etat"]).stdout);
  assert.equal(apres.en_route.Studio, 1);
  assert.deepEqual(apres.offertes, { Studio: 1 }, "L-2 est offerte et pas confirmée ; L-1 est confirmée");
  assert.deepEqual(apres.derniere_tournee, { at: AT });
});

// R37 : la sonde R34 de la tâche 7. Sur le Mac visité, `relais.json` ne dit que
// `moi` : `etat` ne comptait rien en route (il ne regardait que `macs`), alors
// que des lettres attendaient le Studio et qu'une lettre offerte n'était pas
// confirmée. Il compte maintenant par Mac du CARNET, et les lettres offertes et
// pas confirmées par Mac à qui elles ont été offertes (`porte_vers`).
test("etat, sur le Mac visité : les lettres à porter par Mac du carnet, et les lettres offertes et pas confirmées, sans rien écrire", (t) => {
  const { root, db } = bureau(t, { visite: true });
  ecrireLeCarnet(db, "Studio", [chaiseStudio], { at: AT });
  for (const id of ["L-1", "L-2", "L-3"]) insertMessage(db, { msg_id: id, sender: "bob", recipient: "alice#s-9", body: id });
  insertMessage(db, { msg_id: "L-locale", sender: "bob", recipient: "carol", body: "reste ici" });
  insertMessage(db, { msg_id: "L-accusee", sender: "bob", recipient: "alice#s-9", body: "accusée" });
  db.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = 'L-accusee'").run(AT);

  let etat = JSON.parse(lancer(root, ["etat"]).stdout);
  assert.equal(etat.moi, "MacBook");
  assert.deepEqual(etat.en_route, { Studio: 3 }, "les trois lettres pour la chaise du Studio");
  assert.deepEqual(etat.offertes, { Studio: 0 }, "aucune n'est encore offerte");
  assert.deepEqual(etat.portees_non_accusees, { Studio: 0 });

  // Une tournée a offert les trois (l'export de `echanger`), puis a confirmé L-1.
  const offertes = exporterPour(db, "Studio", { moi: "MacBook" }).lettres.map((l) => l.msg_id);
  assert.deepEqual(offertes, ["L-1", "L-2", "L-3"], "SONDE : l'export offre les trois");
  db.prepare("UPDATE messages SET porte_at = ? WHERE msg_id = 'L-1'").run(AT);
  // Une offerte accusée ici n'est plus en vol (son accusé suit `porte_vers`).
  db.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = 'L-3'").run(AT);
  const avant = db.prepare("SELECT msg_id, porte_vers, porte_at FROM messages ORDER BY seq").all();
  const r = lancer(root, ["etat"]);
  assert.equal(r.status, 0, r.stderr);
  etat = JSON.parse(r.stdout);
  assert.deepEqual(etat.en_route, { Studio: 1 }, "L-2 attend encore d'être portée");
  assert.deepEqual(etat.offertes, { Studio: 1 }, "L-2 est offerte au Studio et pas confirmée");
  // R39 : L-1 est confirmée portée et personne ne l'a accusée : elle est sur les
  // deux Macs, et une lettre au nom nu y serait servie deux fois après le retrait.
  assert.deepEqual(etat.portees_non_accusees, { Studio: 1 }, "L-1, portée, pas accusée");
  assert.deepEqual(db.prepare("SELECT msg_id, porte_vers, porte_at FROM messages ORDER BY seq").all(), avant, "etat n'écrit rien");

  // Une offre faite à un Mac que le carnet ne connaît pas (un ancien nom) se compte sous son nom.
  insertMessage(db, { msg_id: "L-vieille", sender: "bob", recipient: "dave", body: "offerte jadis" });
  db.prepare("UPDATE messages SET porte_vers = 'Ancien' WHERE msg_id = 'L-vieille'").run();
  etat = JSON.parse(lancer(root, ["etat"]).stdout);
  assert.deepEqual(etat.offertes, { Studio: 1, Ancien: 1 });
  assert.deepEqual(etat.en_route, { Studio: 1 });
  // Accusée (l'accusé revenu de là-bas), elle ne compte plus.
  db.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = 'L-1'").run(AT);
  assert.deepEqual(JSON.parse(lancer(root, ["etat"]).stdout).portees_non_accusees, { Studio: 0 });
});

test("etat, sur un Mac sans carnet ni macs : des comptes vides, pas une erreur", (t) => {
  const { root } = bureau(t, { visite: true });
  const r = lancer(root, ["etat"]);
  assert.equal(r.status, 0, r.stderr);
  const etat = JSON.parse(r.stdout);
  assert.deepEqual(etat.en_route, {});
  assert.deepEqual(etat.offertes, {});
  assert.deepEqual(etat.portees_non_accusees, {});
});

// ── OUBLIER UN MAC (le retrait, R28) ────────────────────────────────────────

const fichesDe = (db, mac) => db.prepare("SELECT chaise_id, parti_at FROM carnet WHERE mac = ? ORDER BY chaise_id").all(mac);

test("oublier marche sans relais.json : toutes les fiches de ce Mac reçoivent parti_at, rien ne s'efface", (t) => {
  const { root, db } = bureau(t, { config: false });
  ecrireLeCarnet(db, "Studio", [chaiseStudio, { ...chaiseStudio, chaise_id: "bob#s-2", lineage: "bob", instance_session_id: "s-2" }], { at: AT });
  const r = lancer(root, ["oublier", "Studio"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { mac: "Studio", parties: 2 });
  const fiches = fichesDe(db, "Studio");
  assert.equal(fiches.length, 2, "Camp B : les fiches restent");
  assert.ok(fiches.every((f) => f.parti_at), "chacune porte parti_at");
  // Une seconde fois : rien de plus à oublier, et ce n'est pas une erreur.
  const encore = lancer(root, ["oublier", "Studio"]);
  assert.equal(encore.status, 0, encore.stderr);
  assert.deepEqual(JSON.parse(encore.stdout), { mac: "Studio", parties: 0 });
  assert.equal(encore.stderr, "", "le Mac est connu du carnet : aucune remarque");
});

test("oublier un Mac que le carnet ne connaît pas le dit, sans rien toucher", (t) => {
  const { root, db } = bureau(t, { config: false });
  ecrireLeCarnet(db, "Studio", [chaiseStudio], { at: AT });
  const r = lancer(root, ["oublier", "studio"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { mac: "studio", parties: 0 });
  assert.match(r.stderr, /no chair of "studio".*Studio/);
  assert.equal(fichesDe(db, "Studio")[0].parti_at, null);
});

test("oublier refuse un nom de Mac invalide, ce Mac lui-même, et une ligne de commande fausse, sans rien toucher", (t) => {
  const { root, db } = bureau(t);
  ecrireLeCarnet(db, "Studio", [chaiseStudio], { at: AT });
  for (const [quoi, args, motif] of [
    ["sans nom", ["oublier"], /usage/],
    ["deux noms", ["oublier", "Studio", "MacBook"], /usage/],
    ["un nom blanc", ["oublier", "  "], /paquet-mal-adresse/],
    ["un retour à la ligne", ["oublier", "Stu\ndio"], /paquet-mal-adresse/],
    ["ce Mac lui-même (moi de relais.json)", ["oublier", "MacBook"], /this Mac itself/],
    ["un --de", ["oublier", "Studio", "--de", "Studio"], /takes no --de/]
  ]) {
    const r = lancer(root, args);
    assert.equal(r.status, 2, `${quoi} : ${r.stderr}`);
    assert.match(r.stderr, motif, quoi);
    assert.equal(fichesDe(db, "Studio")[0].parti_at, null, `${quoi} : rien n'est oublié`);
  }
});

test("oublier ne passe pas pendant qu'une tournée tient le verrou du relais", async (t) => {
  const { root, db } = bureau(t);
  ecrireLeCarnet(db, "Studio", [chaiseStudio], { at: AT });
  const { prendreLeVerrou } = await import("../src/facteur/daemon.js");
  const jeton = prendreLeVerrou(path.join(root, "run", "relais.verrou"));
  assert.ok(jeton, "SONDE : ce processus vivant tient le verrou");
  try {
    const r = lancer(root, ["oublier", "Studio"]);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /relais\.verrou.*stop the relay first/);
    assert.equal(fichesDe(db, "Studio")[0].parti_at, null, "rien n'est oublié");
  } finally {
    jeton.relacher();
  }
  const r = lancer(root, ["oublier", "Studio"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(root, "run", "relais.verrou")), false, "oublier rend le verrou");
});

// ── LES REFUS RENDUS À L'ORIGINE (R29) ──────────────────────────────────────

test("echanger écrit relais_refus sur SA lettre que l'autre Mac a refusée (marquer.refusees), une fois par lettre et par raison", (t) => {
  const { root, db } = bureau(t);
  ecrireLeCarnet(db, "Studio", [chaiseStudio], { at: AT });
  insertMessage(db, { msg_id: "L-loc", sender: "bob", recipient: "alice#s-9", body: "x" });
  insertMessage(db, { msg_id: "L-jamais-offerte", sender: "bob", recipient: "carol", body: "locale" });
  exporterPour(db, "Studio", { moi: "MacBook" });
  assert.equal(getMessageById(db, "L-loc").porte_vers, "Studio", "SONDE : la lettre a été offerte au Studio");
  const refusDe = (id) => db.prepare("SELECT detail_json FROM delivery_events WHERE msg_id = ? AND event_type = 'relais_refus'").all(id)
    .map((e) => JSON.parse(e.detail_json));
  const refusees = [
    { msg_id: "L-loc", raison: "conflit" },
    { msg_id: "L-jamais-offerte", raison: "conflit" },
    { msg_id: "L-inconnue", raison: "conflit" }
  ];
  for (let i = 0; i < 2; i += 1) {
    const entree = { marquer: { portees: [], rendus: [], refusees }, paquet: paquetDuStudio() };
    const r = lancer(root, ["echanger", "--de", "Studio"], { entree: JSON.stringify(entree), env: SSH });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(refusDe("L-loc"), [{ mac: "Studio", raison: "conflit" }], "une fois, même redit à chaque tournée");
  assert.deepEqual(refusDe("L-jamais-offerte"), [], "une lettre jamais offerte au Studio ne reçoit pas son refus");
  assert.deepEqual(refusDe("L-inconnue"), []);
  // Une autre raison pour la même lettre : une ligne de plus.
  const enclos = { marquer: { portees: [], rendus: [], refusees: [{ msg_id: "L-loc", raison: "hors-enclos" }] }, paquet: paquetDuStudio() };
  assert.equal(lancer(root, ["echanger", "--de", "Studio"], { entree: JSON.stringify(enclos), env: SSH }).status, 0);
  assert.deepEqual(refusDe("L-loc"), [{ mac: "Studio", raison: "conflit" }, { mac: "Studio", raison: "hors-enclos" }]);
  // Sans `refusees` (une veille d'avant R29) : l'échange passe, comme avant.
  const ancien = { marquer: { portees: [], rendus: [] }, paquet: paquetDuStudio() };
  assert.equal(lancer(root, ["echanger", "--de", "Studio"], { entree: JSON.stringify(ancien), env: SSH }).status, 0);
});

test("echanger refuse des refusees mal formées avant toute marque", (t) => {
  const { root, db } = bureau(t);
  ecrireLeCarnet(db, "Studio", [chaiseStudio], { at: AT });
  insertMessage(db, { msg_id: "L-loc", sender: "bob", recipient: "alice#s-9", body: "x" });
  exporterPour(db, "Studio", { moi: "MacBook" });
  for (const refusees of [{}, ["L-loc"], [{ msg_id: "L-loc" }], [{ msg_id: "L-loc", raison: "" }], [{ msg_id: 7, raison: "conflit" }], [null]]) {
    const entree = { marquer: { portees: ["L-loc"], rendus: [], refusees }, paquet: paquetDuStudio({ lettres: [lettreDuStudio("L-1")] }) };
    const r = lancer(root, ["echanger", "--de", "Studio"], { entree: JSON.stringify(entree), env: SSH });
    assert.equal(r.status, 2, `${JSON.stringify(refusees)} : ${r.stderr}`);
    assert.match(r.stderr, /paquet-illisible/);
    assert.equal(getMessageById(db, "L-loc").porte_at, null, `${JSON.stringify(refusees)} : aucune marque`);
    assert.ok(!getMessageById(db, "L-1"), `${JSON.stringify(refusees)} : rien d'importé`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE event_type = 'relais_refus'").get().n, 0);
});
