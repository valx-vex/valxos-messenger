// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE CARNET D'ADRESSES DE L'AUTRE MAC, ET LA RÉSOLUTION « DISTANT ».
//
// Chaque Mac garde son bureau. Le carnet dit quelles chaises vivent sur l'autre
// Mac ; une lettre pour l'une d'elles est « à porter » (`kind: "distant"`). La
// règle de tenue d'une lignée est la même sur les deux Macs : exactement une
// chaise la tient, même à égalité d'heure, même avec des horloges décalées.
//
// Toutes les bases de ce fichier sont JETABLES (mkdtemp + bureau posé) : le
// bureau de poste vivant n'est JAMAIS ouvert ici. Deux bureaux dans un même
// processus s'ouvrent par `openDatabase({ file })`, jamais par `getDatabase()`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AccuseRefuse, ackMessage, getMessageById, insertMessage, openDatabase, unregisterPeer } from "../src/lib/database.js";
import { migrate } from "../src/lib/migrations.js";
import {
  attenteDeLaLettre,
  broadcastRecipients,
  deciderLaCopie,
  designatePrimary,
  laLigneeEstTenueAilleurs,
  registerInstance,
  resolveRecipient,
  undesignate
} from "../src/lib/registry.js";
import { adressesDuRepli, copiesPourChaise } from "../src/lib/identity.js";
import { chaiseDistante, ecrireLeCarnet } from "../src/lib/relais/carnet.js";
import { faireLaTournee } from "../src/facteur/round.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const RACINE = path.resolve(new URL("..", import.meta.url).pathname);

function bureauJetable(t, prefixe = "relais-carnet-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  db.racine = root;
  t.after(() => {
    try { db.close(); } catch { /* base jetable */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return db;
}

// Une chaise de CE Mac. `designeAt` : absent = non désignée ; une chaîne ou null
// = désignée, avec cette heure de désignation (null : une désignée d'avant le
// schéma 8).
function chaiseLocale(db, lignee, session, { pid = process.pid, designeAt } = {}) {
  registerInstance(db, { lineage: lignee, sessionId: session, pid, house: "/maison/carton" });
  const id = `${lignee}#${session}`;
  if (designeAt !== undefined) {
    designatePrimary(db, lignee, session);
    db.prepare("UPDATE peers SET designe_at = ? WHERE id = ?").run(designeAt, id);
  }
  return id;
}

// Une chaise de l'AUTRE Mac, telle qu'un paquet la porte.
function chaiseDuPaquet(lignee, session, { designeAt } = {}) {
  return {
    chaise_id: `${lignee}#${session}`,
    lineage: lignee,
    instance_session_id: session,
    is_primary: designeAt !== undefined ? 1 : 0,
    designe_at: designeAt ?? null
  };
}

const AT = "2026-11-16T12:00:00.000Z";
const LIGNEE = "lignee-a";

// ── LE CARNET ───────────────────────────────────────────────────────────────

test("le carnet inscrit, puis marque parti, sans rien effacer", (t) => {
  const db = bureauJetable(t);
  const un = chaiseDuPaquet("alice", "s-1");
  const deux = chaiseDuPaquet("alice", "s-2", { designeAt: "2026-11-16T10:00:00.000Z" });
  ecrireLeCarnet(db, "Autre", [chaiseDuPaquet("bob", "s-7")], { at: AT });

  assert.deepEqual(ecrireLeCarnet(db, "Studio", [un, deux], { at: AT }), { inscrites: 2, parties: 0 });
  assert.deepEqual(
    ecrireLeCarnet(db, "Studio", [un], { at: "2026-11-16T12:05:00.000Z" }),
    { inscrites: 1, parties: 1 }
  );

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM carnet WHERE mac = 'Studio'").get().n, 2, "rien ne s'efface (Camp B)");
  const fiche = (id) => db.prepare("SELECT * FROM carnet WHERE chaise_id = ?").get(id);
  assert.equal(fiche("alice#s-2").parti_at, "2026-11-16T12:05:00.000Z", "l'absente porte parti_at");
  assert.equal(fiche("alice#s-2").is_primary, 1, "la fiche partie garde ce qu'elle était");
  assert.equal(fiche("alice#s-1").parti_at, null);
  assert.equal(fiche("alice#s-1").vu_at, "2026-11-16T12:05:00.000Z");
  assert.equal(fiche("alice#s-1").mac, "Studio");
  assert.equal(fiche("bob#s-7").parti_at, null, "les fiches d'un AUTRE Mac ne sont pas touchées");

  assert.equal(chaiseDistante(db, "alice#s-2"), null, "une chaise partie n'est plus à porter");
  assert.deepEqual(chaiseDistante(db, "alice#s-1"), { mac: "Studio", chaise_id: "alice#s-1" });

  // Elle revient : la même fiche reprend du service.
  assert.deepEqual(ecrireLeCarnet(db, "Studio", [un, deux], { at: "2026-11-16T12:10:00.000Z" }), { inscrites: 2, parties: 0 });
  assert.equal(fiche("alice#s-2").parti_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM carnet").get().n, 3);
});

// ── LA RÉSOLUTION ───────────────────────────────────────────────────────────

test("une chaise de l'autre Mac est à porter", (t) => {
  const db = bureauJetable(t);
  ecrireLeCarnet(db, "Studio", [chaiseDuPaquet("alice", "s-9")], { at: AT });

  assert.deepEqual(resolveRecipient(db, "alice#s-9"), {
    kind: "distant",
    targets: [],
    mac: "Studio",
    chaise_id: "alice#s-9",
    lineage: "alice"
  });
  const avis = attenteDeLaLettre(db, "alice#s-9");
  assert.equal(avis.motif, "a-porter");
  assert.equal(avis.mac, "Studio");
  assert.match(avis.message, /Studio/);

  // Partie de l'autre Mac : personne ne répond plus à ce nom.
  ecrireLeCarnet(db, "Studio", [], { at: "2026-11-16T12:05:00.000Z" });
  assert.equal(resolveRecipient(db, "alice#s-9").kind, "unknown");
});

test("un inconnu des deux Macs reste inconnu", (t) => {
  const db = bureauJetable(t);
  ecrireLeCarnet(db, "Studio", [chaiseDuPaquet("alice", "s-9")], { at: AT });
  assert.equal(resolveRecipient(db, "personne#s-0").kind, "unknown");
  assert.equal(resolveRecipient(db, "personne").kind, "unknown");
  assert.equal(attenteDeLaLettre(db, "personne").motif, "destinataire-inconnu");
});

test("une désignée de l'autre Mac plus récente tient la lignée ; plus ancienne, non", (t) => {
  const db = bureauJetable(t);
  const locale = chaiseLocale(db, LIGNEE, "s-loc", { designeAt: "2026-11-16T10:00:00Z" });

  ecrireLeCarnet(db, "Studio", [chaiseDuPaquet(LIGNEE, "s-st", { designeAt: "2026-11-16T11:00:00Z" })], { at: AT });
  const plusRecente = resolveRecipient(db, LIGNEE);
  assert.equal(plusRecente.kind, "distant");
  assert.equal(plusRecente.mac, "Studio");
  assert.equal(plusRecente.chaise_id, `${LIGNEE}#s-st`);
  assert.deepEqual(laLigneeEstTenueAilleurs(db, LIGNEE), { mac: "Studio", chaise_id: `${LIGNEE}#s-st` });

  ecrireLeCarnet(db, "Studio", [chaiseDuPaquet(LIGNEE, "s-st", { designeAt: "2026-11-16T09:00:00Z" })], { at: AT });
  const plusAncienne = resolveRecipient(db, LIGNEE);
  assert.equal(plusAncienne.kind, "lineage");
  assert.equal(plusAncienne.targets[0].id, locale);
  assert.equal(laLigneeEstTenueAilleurs(db, LIGNEE), null);
});

// R31 : une lecture LOCALE ratée ne fait jamais pencher la lignée vers l'autre
// Mac. La doctrine du module : en cas de doute, le courrier reste ici (rendre
// « tenue ailleurs » sur une panne, c'est retirer la lettre à la chaise d'ici).
test("une lecture locale ratée ne donne pas la lignée à l'autre Mac", (t) => {
  const db = bureauJetable(t);
  chaiseLocale(db, LIGNEE, "s-loc", { designeAt: "2026-11-16T12:00:00Z" });
  ecrireLeCarnet(db, "Studio", [chaiseDuPaquet(LIGNEE, "s-st", { designeAt: "2026-11-16T11:00:00Z" })], { at: AT });
  assert.equal(laLigneeEstTenueAilleurs(db, LIGNEE), null, "SONDE : la désignée d'ici, plus récente, tient");

  // La même base, dont la lecture des fiches d'ici lève (le carnet, lui, se lit).
  let lecturesRatees = 0;
  const casse = new Proxy(db, {
    get(cible, clef) {
      if (clef === "prepare") {
        return (sql) => {
          if (/\bFROM peers\b/.test(sql)) {
            lecturesRatees += 1;
            throw Object.assign(new Error("simulated read failure"), { code: "SQLITE_IOERR" });
          }
          return cible.prepare(sql);
        };
      }
      const valeur = Reflect.get(cible, clef);
      return typeof valeur === "function" ? valeur.bind(cible) : valeur;
    }
  });
  assert.equal(laLigneeEstTenueAilleurs(casse, LIGNEE), null, "la panne ne pousse pas la lignée vers le Studio");
  assert.equal(lecturesRatees, 1, "SONDE : la lecture locale a bien été tentée, et elle a raté");
});

// Deux Macs, chacun sa désignée locale et la copie de l'autre au carnet. La
// règle doit rendre `distant` sur EXACTEMENT un des deux : sinon une lettre se
// lit deux fois, ou par personne.
function deuxMacs(t, { heureA, heureB, sessionA = "s-a", sessionB = "s-b" }) {
  const a = bureauJetable(t, "relais-carnet-a-");
  const b = bureauJetable(t, "relais-carnet-b-");
  chaiseLocale(a, LIGNEE, sessionA, { pid: process.pid, designeAt: heureA });
  chaiseLocale(b, LIGNEE, sessionB, { pid: process.ppid, designeAt: heureB });
  ecrireLeCarnet(a, "Studio", [chaiseDuPaquet(LIGNEE, sessionB, { designeAt: heureB })], { at: AT });
  ecrireLeCarnet(b, "MacBook", [chaiseDuPaquet(LIGNEE, sessionA, { designeAt: heureA })], { at: AT });
  return { a, b };
}

function quiTient(a, b) {
  const ra = resolveRecipient(a, LIGNEE);
  const rb = resolveRecipient(b, LIGNEE);
  const distantes = [ra, rb].filter((r) => r.kind === "distant").length;
  return { ra, rb, distantes };
}

test("une seule chaise tient la lignée sur les deux Macs, même à égalité d'heure", (t) => {
  const meme = "2026-11-16T10:00:00.000Z";
  const { a, b } = deuxMacs(t, { heureA: meme, heureB: meme });
  const { ra, rb, distantes } = quiTient(a, b);
  assert.equal(distantes, 1, `exactement une base rend distant (A: ${ra.kind}, B: ${rb.kind})`);
  // Celle qui garde la lignée la sert en local, à sa propre chaise.
  const locale = ra.kind === "distant" ? rb : ra;
  assert.equal(locale.kind, "lineage");
  // Et la distante pointe vers la chaise que l'autre garde.
  const distante = ra.kind === "distant" ? ra : rb;
  assert.equal(distante.chaise_id, locale.targets[0].id);
});

test("des horloges décalées de dix minutes : toujours une seule chaise", (t) => {
  // B a dix minutes d'avance, dans les deux sens de nommage.
  for (const [sessionA, sessionB] of [["s-a", "s-b"], ["s-b", "s-a"]]) {
    const { a, b } = deuxMacs(t, {
      heureA: "2026-11-16T10:00:00.000Z",
      heureB: "2026-11-16T10:10:00.000Z",
      sessionA,
      sessionB
    });
    const { ra, rb, distantes } = quiTient(a, b);
    assert.equal(distantes, 1, `exactement une base rend distant (A: ${ra.kind}, B: ${rb.kind})`);
    assert.equal(ra.kind, "distant", "la désignation la plus récente (lue) tient");
    assert.equal(rb.kind, "lineage");
  }
});

test("une désignée d'avant le schéma 8 (designe_at nul)", (t) => {
  // Une nulle ici contre une datée là-bas : la datée tient, des deux côtés.
  {
    const { a, b } = deuxMacs(t, { heureA: null, heureB: "2026-11-16T10:00:00.000Z" });
    const { ra, rb, distantes } = quiTient(a, b);
    assert.equal(distantes, 1);
    assert.equal(ra.kind, "distant");
    assert.equal(rb.kind, "lineage");
  }
  // Deux nulles : exactement une tient, départagée par chaise_id.
  for (const [sessionA, sessionB] of [["s-a", "s-b"], ["s-b", "s-a"]]) {
    const { a, b } = deuxMacs(t, { heureA: null, heureB: null, sessionA, sessionB });
    const { ra, rb, distantes } = quiTient(a, b);
    assert.equal(distantes, 1, `exactement une base rend distant (A: ${ra.kind}, B: ${rb.kind})`);
    const tenante = ra.kind === "distant" ? rb : ra;
    assert.equal(tenante.targets[0].id, `${LIGNEE}#s-b`, "le plus grand chaise_id tient");
  }
});

test("une désignation pendant que l'autre Mac dort : chaque Mac sert la sienne", (t) => {
  const a = bureauJetable(t, "relais-carnet-a-");
  const b = bureauJetable(t, "relais-carnet-b-");
  const chaiseA = chaiseLocale(a, LIGNEE, "s-a", { pid: process.pid, designeAt: "2026-11-16T10:00:00.000Z" });
  const chaiseB = chaiseLocale(b, LIGNEE, "s-b", { pid: process.ppid });
  // Le dernier échange : B n'avait pas de désignée.
  ecrireLeCarnet(a, "Studio", [chaiseDuPaquet(LIGNEE, "s-b")], { at: AT });
  ecrireLeCarnet(b, "MacBook", [chaiseDuPaquet(LIGNEE, "s-a", { designeAt: "2026-11-16T10:00:00.000Z" })], { at: AT });

  // Le MacBook dort ; on désigne au Studio.
  designatePrimary(b, LIGNEE, "s-b");
  b.prepare("UPDATE peers SET designe_at = ? WHERE id = ?").run("2026-11-16T11:00:00.000Z", chaiseB);

  // A ne le sait pas encore : il garde sa lignée en local, sans erreur et sans perte.
  insertMessage(a, { msg_id: "L-dort", sender: "bob", recipient: LIGNEE, body: "x" });
  const ra = resolveRecipient(a, LIGNEE);
  assert.equal(ra.kind, "lineage");
  assert.equal(ra.targets[0].id, chaiseA);
  assert.ok(adressesDuRepli(a, LIGNEE, { session_id: "s-a" }).includes(LIGNEE), "la chaise de A relève sa lignée");
  assert.equal(getMessageById(a, "L-dort").acked_at, null);
  // B sert la sienne : la limite connue, jusqu'au premier échange.
  assert.equal(resolveRecipient(b, LIGNEE).kind, "lineage");

  // Le premier échange (simulé par le carnet des deux côtés, ruling R3) : une seule tient.
  ecrireLeCarnet(a, "Studio", [chaiseDuPaquet(LIGNEE, "s-b", { designeAt: "2026-11-16T11:00:00.000Z" })], { at: "2026-11-16T12:05:00.000Z" });
  ecrireLeCarnet(b, "MacBook", [chaiseDuPaquet(LIGNEE, "s-a", { designeAt: "2026-11-16T10:00:00.000Z" })], { at: "2026-11-16T12:05:00.000Z" });
  const { ra: apresA, rb: apresB, distantes } = quiTient(a, b);
  assert.equal(distantes, 1);
  assert.equal(apresA.kind, "distant");
  assert.equal(apresA.mac, "Studio");
  assert.equal(apresB.kind, "lineage");
  assert.equal(apresB.targets[0].id, chaiseB);
});

// LA SECONDE FENÊTRE (revue, fix round 1) : la désignée du Mac qui TIENT la
// lignée quitte la désignation, ou le service, avant le prochain échange.
// Chaque Mac croit alors que l'autre la tient : les deux rendent `distant`,
// personne ici n'accuse, la lettre attend sans se perdre, et l'échange suivant
// rend la lignée à exactement une chaise.
for (const [cas, quitter] of [
  ["la désignée gagnante perd sa désignation", (a) => undesignate(a, LIGNEE)],
  ["la désignée gagnante sort du service", (a) => unregisterPeer(a, `${LIGNEE}#s-a`)]
]) {
  test(`une fenêtre où aucun Mac ne tient la lignée (${cas}) : rien ne se perd, l'échange guérit`, (t) => {
    const a = bureauJetable(t, "relais-carnet-a-");
    const b = bureauJetable(t, "relais-carnet-b-");
    // L'état stable : A (MacBook) a la désignation la plus récente et tient la lignée.
    chaiseLocale(a, LIGNEE, "s-a", { pid: process.pid, designeAt: "2026-11-16T11:00:00.000Z" });
    const chaiseB = chaiseLocale(b, LIGNEE, "s-b", { pid: process.ppid, designeAt: "2026-11-16T10:00:00.000Z" });
    ecrireLeCarnet(a, "Studio", [chaiseDuPaquet(LIGNEE, "s-b", { designeAt: "2026-11-16T10:00:00.000Z" })], { at: AT });
    ecrireLeCarnet(b, "MacBook", [chaiseDuPaquet(LIGNEE, "s-a", { designeAt: "2026-11-16T11:00:00.000Z" })], { at: AT });
    assert.equal(resolveRecipient(a, LIGNEE).kind, "lineage", "prémisse : A tient");
    assert.equal(resolveRecipient(b, LIGNEE).kind, "distant", "prémisse : B porte vers A");

    // Avant le prochain échange, la désignée de A s'en va.
    quitter(a);
    insertMessage(a, { msg_id: "L-fenetre-a", sender: "bob", recipient: LIGNEE, body: "x" });
    insertMessage(b, { msg_id: "L-fenetre-b", sender: "bob", recipient: LIGNEE, body: "x" });
    const ra = resolveRecipient(a, LIGNEE);
    const rb = resolveRecipient(b, LIGNEE);
    assert.equal(ra.kind, "distant", "A croit que B tient (la désignée de B au carnet)");
    assert.equal(ra.mac, "Studio");
    assert.equal(rb.kind, "distant", "B croit encore que A tient (le carnet d'avant)");
    assert.equal(rb.mac, "MacBook");
    // Personne n'accuse pendant la fenêtre : ni le nom nu, ni la chaise de B.
    assert.throws(() => ackMessage(a, "L-fenetre-a", LIGNEE), (e) => e instanceof AccuseRefuse && /tenue-ailleurs/.test(e.raison));
    assert.throws(() => ackMessage(b, "L-fenetre-b", LIGNEE), (e) => e instanceof AccuseRefuse && /tenue-ailleurs/.test(e.raison));
    assert.throws(() => ackMessage(b, "L-fenetre-b", chaiseB), (e) => e instanceof AccuseRefuse && /tenue-ailleurs/.test(e.raison));
    assert.equal(getMessageById(a, "L-fenetre-a").acked_at, null, "rien ne se perd sur A");
    assert.equal(getMessageById(b, "L-fenetre-b").acked_at, null, "rien ne se perd sur B");

    // L'échange (ruling R3) : chaque Mac montre ses chaises en service, telles qu'elles sont.
    const enService = (db) => db
      .prepare("SELECT id, lineage, instance_session_id, is_primary, designe_at FROM peers WHERE status NOT IN ('offline', 'dead') AND instance_session_id IS NOT NULL")
      .all()
      .map((p) => ({ chaise_id: p.id, lineage: p.lineage, instance_session_id: p.instance_session_id, is_primary: p.is_primary, designe_at: p.designe_at }));
    ecrireLeCarnet(a, "Studio", enService(b), { at: "2026-11-16T12:05:00.000Z" });
    ecrireLeCarnet(b, "MacBook", enService(a), { at: "2026-11-16T12:05:00.000Z" });

    const apresA = resolveRecipient(a, LIGNEE);
    const apresB = resolveRecipient(b, LIGNEE);
    assert.equal([apresA, apresB].filter((r) => r.kind === "distant").length, 1, `exactement une chaise tient (A: ${apresA.kind}, B: ${apresB.kind})`);
    assert.equal(apresA.kind, "distant");
    assert.equal(apresB.kind, "lineage");
    assert.equal(apresB.targets[0].id, chaiseB, "la désignée de B tient désormais");
    assert.equal(getMessageById(a, "L-fenetre-a").acked_at, null, "la lettre de A reste à porter vers B");
    assert.equal(getMessageById(b, "L-fenetre-b").acked_at, null, "la lettre de B est servie à sa chaise, pas perdue");
  });
}

test("une lignée qui ne vit que sur l'autre Mac est à porter", (t) => {
  const db = bureauJetable(t);
  ecrireLeCarnet(db, "Studio", [chaiseDuPaquet("lignee-b", "s-1")], { at: AT });
  const r = resolveRecipient(db, "lignee-b");
  assert.equal(r.kind, "distant");
  assert.equal(r.mac, "Studio");
  assert.equal(r.chaise_id, "lignee-b#s-1");
  assert.deepEqual(r.targets, []);
  assert.equal(attenteDeLaLettre(db, "lignee-b").motif, "a-porter");
});

test("le broadcast écrit une fois à une lignée qui ne vit que sur l'autre Mac", (t) => {
  const db = bureauJetable(t);
  chaiseLocale(db, LIGNEE, "s-loc", { pid: process.pid });
  chaiseLocale(db, "lignee-c", "s-c", { pid: process.ppid });
  ecrireLeCarnet(db, "Studio", [
    chaiseDuPaquet("lignee-b", "s-1"),
    chaiseDuPaquet("lignee-b", "s-2"),
    chaiseDuPaquet("lignee-c", "s-9"),
    chaiseDuPaquet(LIGNEE, "s-st"),
    chaiseDuPaquet("lignee-partie", "s-0")
  ], { at: AT });
  ecrireLeCarnet(db, "Studio", [
    chaiseDuPaquet("lignee-b", "s-1"),
    chaiseDuPaquet("lignee-b", "s-2"),
    chaiseDuPaquet("lignee-c", "s-9"),
    chaiseDuPaquet(LIGNEE, "s-st")
  ], { at: "2026-11-16T12:05:00.000Z" });

  const noms = broadcastRecipients(db, LIGNEE);
  assert.equal(noms.filter((n) => n === "lignee-b").length, 1, "une lignée de l'autre Mac : une lettre");
  assert.equal(noms.filter((n) => n === "lignee-c").length, 1, "une lignée des deux côtés : une lettre");
  assert.ok(!noms.includes(LIGNEE), "jamais à soi-même, même présente au carnet");
  assert.ok(!noms.includes("lignee-partie"), "une lignée partie de l'autre Mac ne reçoit plus rien");
  assert.deepEqual(noms, ["lignee-b", "lignee-c"]);
});

test("une chaise morte ici et vivante là-bas : la lettre est à porter", (t) => {
  const db = bureauJetable(t);
  const pidMort = spawnSync("true").pid;
  chaiseLocale(db, "alice", "s-9", { pid: pidMort });
  chaiseLocale(db, "alice", "s-vive", { pid: process.pid });
  ecrireLeCarnet(db, "Studio", [chaiseDuPaquet("alice", "s-9"), chaiseDuPaquet("alice", "s-vive")], { at: AT });

  const r = resolveRecipient(db, "alice#s-9");
  assert.equal(r.kind, "distant");
  assert.equal(r.mac, "Studio");
  assert.equal(r.chaise_id, "alice#s-9");

  // Témoin : une chaise VIVANTE ici garde sa lettre, quoi que dise le carnet.
  const vive = resolveRecipient(db, "alice#s-vive");
  assert.equal(vive.kind, "instance");
  assert.equal(vive.targets[0].id, "alice#s-vive");
});

// ── LES CONSOMMATEURS ───────────────────────────────────────────────────────

function ligneeTenueAuStudio(t) {
  const db = bureauJetable(t);
  const soeur = chaiseLocale(db, LIGNEE, "s-loc", { pid: process.ppid });
  ecrireLeCarnet(db, "Studio", [chaiseDuPaquet(LIGNEE, "s-st", { designeAt: "2026-11-16T10:00:00.000Z" })], { at: AT });
  return { db, soeur };
}

test("une sœur locale ne relève pas une lignée tenue ailleurs", (t) => {
  const { db, soeur } = ligneeTenueAuStudio(t);
  const adresses = adressesDuRepli(db, LIGNEE, { session_id: "s-loc" });
  assert.ok(!adresses.includes(LIGNEE), `la lignée n'est pas dans sa boîte : ${adresses.join(", ")}`);
  assert.ok(adresses.includes(soeur), "sa chaise, si");

  assert.deepEqual(
    deciderLaCopie({ lignee: LIGNEE, sessionId: "s-loc", resolution: resolveRecipient(db, LIGNEE), pidDeMaChaise: process.ppid }),
    { copie: true, raison: "cc-distant", chaise_designee: `${LIGNEE}#s-st`, sans_chaise_designee: false }
  );

  // La copie dit où la lettre est portée, jamais « en attente d'une désignation ».
  insertMessage(db, { msg_id: "L-cc", sender: "bob", recipient: LIGNEE, body: "x" });
  const cc = copiesPourChaise(db, LIGNEE, "s-loc");
  assert.equal(cc.rows.length, 1);
  assert.equal(cc.chaiseDesignee, `${LIGNEE}#s-st`);
  assert.equal(cc.sansChaiseDesignee, false);
  assert.match(cc.destinataire, /Studio/);
});

test("une sœur locale ne peut pas accuser une lettre de lignée tenue ailleurs", (t) => {
  const { db } = ligneeTenueAuStudio(t);
  insertMessage(db, { msg_id: "L-ack", sender: "bob", recipient: LIGNEE, body: "x" });
  assert.throws(
    () => ackMessage(db, "L-ack", `${LIGNEE}#s-loc`),
    (erreur) => erreur instanceof AccuseRefuse && /tenue-ailleurs/.test(erreur.raison) && /Studio/.test(erreur.raison)
  );
  assert.equal(getMessageById(db, "L-ack").acked_at, null, "le refus ne touche pas la lettre");
});

// R14 : un signataire SANS chaise (le nom de lignée nu, celui d'un client MCP
// sans fiche ou du CLI) n'accuse pas une lettre que l'autre Mac tient. Accusée
// ici, elle ne serait jamais portée (le paquet ne prend que les lettres non
// accusées) : une lettre perdue sans un bruit.
test("un nom nu ne peut pas accuser une lettre de lignée tenue sur l'autre Mac", (t) => {
  const db = bureauJetable(t);
  chaiseLocale(db, LIGNEE, "s-loc", { pid: process.ppid, designeAt: "2026-11-16T10:00:00.000Z" });
  ecrireLeCarnet(db, "Studio", [chaiseDuPaquet(LIGNEE, "s-st", { designeAt: "2026-11-16T11:00:00.000Z" })], { at: AT });
  assert.equal(resolveRecipient(db, LIGNEE).kind, "distant", "prémisse : la désignée de l'autre Mac, plus récente, tient");

  insertMessage(db, { msg_id: "L-nu", sender: "bob", recipient: LIGNEE, body: "x" });
  assert.throws(
    () => ackMessage(db, "L-nu", LIGNEE),
    (erreur) => erreur instanceof AccuseRefuse && /tenue-ailleurs/.test(erreur.raison) && /Studio/.test(erreur.raison)
  );
  assert.equal(getMessageById(db, "L-nu").acked_at, null, "la lettre reste à porter");

  // Une lignée qui ne vit QUE sur l'autre Mac : même refus.
  ecrireLeCarnet(db, "Studio", [
    chaiseDuPaquet(LIGNEE, "s-st", { designeAt: "2026-11-16T11:00:00.000Z" }),
    chaiseDuPaquet("lignee-b", "s-1")
  ], { at: AT });
  insertMessage(db, { msg_id: "L-nu-b", sender: "bob", recipient: "lignee-b", body: "x" });
  assert.throws(
    () => ackMessage(db, "L-nu-b", "lignee-b"),
    (erreur) => erreur instanceof AccuseRefuse && /tenue-ailleurs/.test(erreur.raison)
  );
  assert.equal(getMessageById(db, "L-nu-b").acked_at, null);
});

test("un nom nu, pour une lignée que l'autre Mac ne tient pas, accuse exactement comme avant", (t) => {
  // Deux bureaux au même montage local ; l'un a, au carnet, une désignée de
  // l'autre Mac PLUS ANCIENNE (la lignée reste tenue ici). Même verdict des deux côtés.
  const verdictDuNomNu = (avecCarnet) => {
    const db = bureauJetable(t);
    chaiseLocale(db, LIGNEE, "s-loc", { pid: process.ppid, designeAt: "2026-11-16T10:00:00.000Z" });
    if (avecCarnet) {
      ecrireLeCarnet(db, "Studio", [chaiseDuPaquet(LIGNEE, "s-st", { designeAt: "2026-11-16T09:00:00.000Z" })], { at: AT });
    }
    insertMessage(db, { msg_id: "L-tenue-ici", sender: "bob", recipient: LIGNEE, body: "x" });
    try {
      ackMessage(db, "L-tenue-ici", LIGNEE);
      return { accuse: getMessageById(db, "L-tenue-ici").acked_at !== null };
    } catch (erreur) {
      return { refus: erreur instanceof AccuseRefuse, raison: erreur.raison };
    }
  };
  const sans = verdictDuNomNu(false);
  const avec = verdictDuNomNu(true);
  assert.deepEqual(avec, sans, "le carnet ne change rien quand la lignée est tenue ici");
  assert.equal(avec.refus, true, "la règle d'avant : une chaise d'ici tient, le nom nu n'a qu'une copie");
  assert.doesNotMatch(avec.raison, /tenue-ailleurs/);

  // Une lignée sans aucune chaise, ni ici ni là-bas (le client solo) : le nom nu accuse sa lettre.
  const db = bureauJetable(t);
  ecrireLeCarnet(db, "Studio", [chaiseDuPaquet("lignee-b", "s-1")], { at: AT });
  insertMessage(db, { msg_id: "L-solo", sender: "bob", recipient: "lignee-solo", body: "x" });
  ackMessage(db, "L-solo", "lignee-solo");
  assert.notEqual(getMessageById(db, "L-solo").acked_at, null);
});

test("le Facteur ne compte pas une lettre à porter comme destinataire inconnu", async (t) => {
  const db = bureauJetable(t);
  ecrireLeCarnet(db, "Studio", [chaiseDuPaquet("alice", "s-9")], { at: AT });
  insertMessage(db, { msg_id: "L-fac", sender: "bob", recipient: "alice#s-9", body: "x" });

  const bilan = await faireLaTournee(db, {
    maisons: [],
    dormir: async () => {},
    tourHouses: () => ({ boxes: [], houses: [] }),
    horloge: () => 1_000_000
  });

  const derniere = db
    .prepare("SELECT reason FROM facteur_attempts WHERE msg_id = 'L-fac' ORDER BY rowid DESC LIMIT 1")
    .get();
  assert.equal(derniere.reason, "a-porter");
  assert.equal(bilan.motifs["a-porter"], 1);
  assert.equal(bilan.motifs["destinataire-inconnu"], undefined);
  assert.equal(getMessageById(db, "L-fac").acked_at, null, "la lettre attend le relais, elle ne se perd pas");
});

test("valxos-chaise dit qu'une lignée tenue ailleurs est portée, jamais « aucune chaise en service »", (t) => {
  const { db } = ligneeTenueAuStudio(t);
  db.close();
  const sortie = spawnSync(process.execPath, [path.join(RACINE, "src/bin/valxos-chaise.js"), "chaises", LIGNEE], {
    encoding: "utf8",
    env: envPropre({ CC2CC_V2_HOME: db.racine, CC2CC_GARDE_BUREAU: "1" })
  });
  assert.equal(sortie.status, 0, sortie.stderr);
  assert.doesNotMatch(sortie.stdout, /No chair in service/);
  assert.match(sortie.stdout, /other Mac \(Studio\)/);
});
