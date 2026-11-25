// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE PAQUET DU RELAIS : exporter, importer, marquer — et les marques visibles.
//
// Deux bureaux jetables dans le même processus : A = MacBook, B = Studio.
// Chaque bureau s'ouvre par `openDatabase({ file })`, jamais par
// `getDatabase()` ; le bureau de poste vivant n'est JAMAIS ouvert ici. Le
// réveil ne frappe à aucune vraie porte (`reveiller` injecté) et le scan des
// maisons est vide (`scanner` injecté).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AccuseRefuse,
  ackMessage,
  getMessageById,
  insertMessage,
  listInbox,
  markDelivered,
  markInjected,
  openDatabase
} from "../src/lib/database.js";
import { migrate } from "../src/lib/migrations.js";
import { designatePrimary, registerInstance, resolveRecipient, undesignate } from "../src/lib/registry.js";
import { adressesDuRepli } from "../src/lib/identity.js";
import { posterUneLettre } from "../src/lib/guichet.js";
import { formatAdditionalContext } from "../src/lib/format.js";
import { ecrireLeCarnet } from "../src/lib/relais/carnet.js";
import { exporterPour, importerDe, lettresPortees, marquerPortees, marquerRendus } from "../src/lib/relais/paquet.js";
import { ajouterMembre, creerTable, poserEnclos, retirerEnclos } from "../src/lib/tables.js";
import { poserLeBureau } from "./aide-env.js";

const MACBOOK = "MacBook";
const STUDIO = "Studio";
const AT = "2026-11-16T12:00:00.000Z";
const LIGNEE = "lignee-a";

const CHAMPS_DE_LA_LETTRE = [
  "msg_id", "sender", "recipient", "thread_id", "subject", "body", "priority", "msg_type", "created_at",
  "sender_model", "envoi_id", "table_nom", "reponse_a", "sans_reveil", "sans_copie", "sender_chaise"
];

function bureauJetable(t, prefixe) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  t.after(() => {
    try { db.close(); } catch { /* base jetable */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return db;
}

function deuxMacs(t) {
  return { a: bureauJetable(t, "relais-paquet-a-"), b: bureauJetable(t, "relais-paquet-b-") };
}

// Le réveil n'est qu'un nom de porte noté ; le scan des maisons est vide.
function depsDeTest() {
  const portes = [];
  return {
    portes,
    deps: {
      scanner: () => ({ houses: [], parSession: new Map() }),
      reveiller: async (porte, msgId) => {
        portes.push({ porte, msgId });
        return { ok: false, socketPath: `/carton/${porte}.sock`, error: "ENOENT" };
      }
    }
  };
}

// Une chaise de CE Mac. `designeAt` : absent = non désignée.
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

const compter = (db, table = "messages") => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const evenementsDe = (db, msgId, type) =>
  db.prepare("SELECT agent_id, detail_json FROM delivery_events WHERE msg_id = ? AND event_type = ? ORDER BY id").all(msgId, type);

// B montre ses chaises à A : un paquet de B, sans lettre, importé dans A.
async function montrerLesChaises(de, vers, { deMac, versMac, deps }) {
  const paquet = exporterPour(de, versMac, { moi: deMac });
  return importerDe(vers, deMac, paquet, { moi: versMac, at: AT, deps });
}

// ── EXPORTER ────────────────────────────────────────────────────────────────

test("exporte les lettres à porter vers ce Mac, dans l'ordre", (t) => {
  const a = bureauJetable(t, "relais-paquet-a-");
  ecrireLeCarnet(a, STUDIO, [chaiseDuPaquet("alice", "s-9")], { at: AT });
  const locale = chaiseLocale(a, "carol", "s-1");
  insertMessage(a, { msg_id: "L-1", sender: "bob", recipient: "alice#s-9", body: "un" });
  insertMessage(a, { msg_id: "L-ici", sender: "bob", recipient: locale, body: "une lettre locale" });
  insertMessage(a, { msg_id: "L-2", sender: "bob", recipient: "alice#s-9", body: "deux", subject: "s", thread_id: "fil-1" });
  insertMessage(a, { msg_id: "L-3", sender: "bob", recipient: "alice#s-9", body: "trois", priority: "high" });
  // Déjà accusée, ou déjà portée : elles ne repartent pas.
  insertMessage(a, { msg_id: "L-accusee", sender: "bob", recipient: "alice#s-9", body: "x" });
  a.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = 'L-accusee'").run(AT);
  insertMessage(a, { msg_id: "L-portee", sender: "bob", recipient: "alice#s-9", body: "x" });
  assert.equal(marquerPortees(a, STUDIO, ["L-portee"], { at: AT }), 1);

  const paquet = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.equal(paquet.version, 1);
  assert.equal(paquet.schema, 8);
  assert.equal(paquet.de, MACBOOK);
  assert.equal(paquet.pour, STUDIO);
  assert.deepEqual(paquet.lettres.map((l) => l.msg_id), ["L-1", "L-2", "L-3"]);
  const seqs = paquet.lettres.map((l) => getMessageById(a, l.msg_id).seq);
  assert.ok(seqs[0] < seqs[1] && seqs[1] < seqs[2], `seq croissants : ${seqs}`);
  assert.deepEqual(Object.keys(paquet.lettres[0]).sort(), [...CHAMPS_DE_LA_LETTRE].sort(), "les champs d'une lettre, et eux seuls");
  const l2 = paquet.lettres[1];
  assert.equal(l2.subject, "s");
  assert.equal(l2.thread_id, "fil-1");
  assert.equal(l2.created_at, getMessageById(a, "L-2").created_at);
  assert.equal(paquet.lettres[2].priority, "high");
  assert.deepEqual(paquet.evenements, []);
  assert.deepEqual(paquet.chaises, [
    { chaise_id: locale, lineage: "carol", instance_session_id: "s-1", is_primary: 0, designe_at: null }
  ]);
  // Le paquet est du JSON : il traverse un tube tel quel.
  assert.deepEqual(JSON.parse(JSON.stringify(paquet)), paquet);
});

test("marquerPortees pose porte_at et porte_vers, une fois, et la lettre ne repart plus", (t) => {
  const a = bureauJetable(t, "relais-paquet-a-");
  ecrireLeCarnet(a, STUDIO, [chaiseDuPaquet("alice", "s-9")], { at: AT });
  insertMessage(a, { msg_id: "L-1", sender: "bob", recipient: "alice#s-9", body: "un" });
  insertMessage(a, { msg_id: "L-2", sender: "bob", recipient: "alice#s-9", body: "deux" });

  assert.equal(marquerPortees(a, STUDIO, ["L-1", "inconnue"], { at: AT }), 1);
  const l1 = getMessageById(a, "L-1");
  assert.equal(l1.porte_at, AT);
  assert.equal(l1.porte_vers, STUDIO);
  assert.equal(evenementsDe(a, "L-1", "relais_porte").length, 1);
  assert.deepEqual(JSON.parse(evenementsDe(a, "L-1", "relais_porte")[0].detail_json), { mac: STUDIO });
  // Rejouer ne change rien : ni l'heure, ni le journal.
  assert.equal(marquerPortees(a, STUDIO, ["L-1"], { at: "2026-11-16T13:00:00.000Z" }), 0);
  assert.equal(getMessageById(a, "L-1").porte_at, AT);
  assert.equal(evenementsDe(a, "L-1", "relais_porte").length, 1);
  assert.deepEqual(exporterPour(a, STUDIO, { moi: MACBOOK }).lettres.map((l) => l.msg_id), ["L-2"]);
});

test("n'exporte jamais une lettre arrivée par le relais", async (t) => {
  const a = bureauJetable(t, "relais-paquet-a-");
  const { deps } = depsDeTest();
  // Le Studio envoie une lettre pour une chaise que le carnet de A place AUSSI sur le Studio.
  const paquet = {
    version: 1,
    schema: 8,
    de: STUDIO,
    pour: MACBOOK,
    lettres: [{
      msg_id: "L-venue", sender: "bob", recipient: "alice#s-9", thread_id: null, subject: null, body: "venue du Studio",
      priority: "normal", msg_type: "message", created_at: AT, sender_model: null, envoi_id: null, table_nom: null,
      reponse_a: null, sans_reveil: 0, sans_copie: 0, sender_chaise: null
    }],
    evenements: [],
    chaises: [chaiseDuPaquet("alice", "s-9")]
  };
  const bilan = await importerDe(a, STUDIO, paquet, { moi: MACBOOK, at: AT, deps });
  assert.equal(bilan.neuves, 1);
  const venue = getMessageById(a, "L-venue");
  assert.equal(venue.via, "relais");
  const resolution = resolveRecipient(a, "alice#s-9");
  assert.equal(resolution.kind, "distant", "SONDE : la lettre serait à porter si elle était née ici");
  assert.equal(resolution.mac, STUDIO);
  assert.deepEqual(exporterPour(a, STUDIO, { moi: MACBOOK }).lettres, [], "le ping-pong est fermé");
  // Et marquerPortees ne marque jamais une lettre venue par le relais.
  assert.equal(marquerPortees(a, STUDIO, ["L-venue"], { at: AT }), 0);
  assert.equal(getMessageById(a, "L-venue").porte_at, null);
});

test("un paquet porte au plus 200 lettres, les plus anciennes d'abord", (t) => {
  const a = bureauJetable(t, "relais-paquet-a-");
  ecrireLeCarnet(a, STUDIO, [chaiseDuPaquet("alice", "s-9")], { at: AT });
  a.transaction(() => {
    for (let i = 1; i <= 250; i += 1) {
      insertMessage(a, { msg_id: `L-${String(i).padStart(3, "0")}`, sender: "bob", recipient: "alice#s-9", body: `n°${i}` });
    }
  })();
  const paquet = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.equal(paquet.lettres.length, 200);
  const parSeq = a.prepare("SELECT msg_id FROM messages ORDER BY seq ASC").all().map((r) => r.msg_id);
  assert.equal(paquet.lettres.at(-1).msg_id, parSeq[199], "la dernière est la 200ᵉ par seq");
  assert.deepEqual(paquet.lettres.map((l) => l.msg_id), parSeq.slice(0, 200));
  assert.equal(exporterPour(a, STUDIO, { moi: MACBOOK, limite: 5 }).lettres.length, 5);
});

// ── IMPORTER ────────────────────────────────────────────────────────────────

// A a trois lettres pour la chaise `alice#s-9` du Studio ; le carnet de A la
// connaît par un vrai paquet de B (sans lettre).
async function troisLettresPourLeStudio(t) {
  const { a, b } = deuxMacs(t);
  const { deps, portes } = depsDeTest();
  chaiseLocale(b, "alice", "s-9", { pid: process.ppid });
  await montrerLesChaises(b, a, { deMac: STUDIO, versMac: MACBOOK, deps });
  for (const i of [1, 2, 3]) {
    insertMessage(a, { msg_id: `L-${i}`, sender: "bob", recipient: "alice#s-9", body: `lettre ${i}`, created_at: `2026-11-16T09:0${i}:00.000Z` });
  }
  const paquet = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.equal(paquet.lettres.length, 3, "SONDE : les trois lettres sont à porter");
  return { a, b, deps, portes, paquet };
}

test("importer garde msg_id, expéditeur et heure, et pose les deux marques", async (t) => {
  const { a, b, deps, portes, paquet } = await troisLettresPourLeStudio(t);
  const bilan = await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  assert.deepEqual(bilan, { neuves: 3, rejeux: 0, conflits: 0, refus: [], evenements: 0, chaises: paquet.chaises.length });
  for (const i of [1, 2, 3]) {
    const surB = getMessageById(b, `L-${i}`);
    assert.equal(surB.via, "relais");
    assert.equal(surB.mac_origine, MACBOOK);
    assert.equal(surB.sender, "bob");
    assert.equal(surB.recipient, "alice#s-9");
    assert.equal(surB.body, `lettre ${i}`);
    assert.equal(surB.created_at, getMessageById(a, `L-${i}`).created_at, "l'heure de A");
    assert.equal(surB.porte_at, null);
    assert.equal(surB.porte_vers, null);
  }
  const seqsB = [1, 2, 3].map((i) => getMessageById(b, `L-${i}`).seq);
  assert.ok(seqsB[0] < seqsB[1] && seqsB[1] < seqsB[2], "l'ordre du paquet");
  // Le guichet réveille la chaise locale, sans code de plus.
  assert.deepEqual(portes.map((p) => p.msgId), ["L-1", "L-2", "L-3"]);
});

test("importer deux fois ne double rien", async (t) => {
  const { b, deps, portes, paquet } = await troisLettresPourLeStudio(t);
  await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  const sonnees = portes.length;
  const bilan = await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  assert.equal(bilan.neuves, 0);
  assert.equal(bilan.rejeux, 3);
  assert.equal(bilan.conflits, 0);
  assert.deepEqual(bilan.refus, []);
  assert.equal(compter(b), 3);
  assert.equal(portes.length, sonnees, "une lettre déjà là ne fait sonner personne de plus");
});

test("refuse un paquet qui n'est pas pour moi, ou d'une autre version, sans rien écrire", async (t) => {
  const { b, deps, paquet } = await troisLettresPourLeStudio(t);
  const avant = compter(b, "carnet");
  const refus = async (p, mac, moi, code) =>
    assert.rejects(importerDe(b, mac, p, { moi, at: AT, deps }), (e) => e.code === code, code);
  await refus(paquet, MACBOOK, MACBOOK, "paquet-mal-adresse"); // pour MacBook, importé par « MacBook »
  await refus(paquet, STUDIO, STUDIO, "paquet-mal-adresse"); // de MacBook, annoncé du Studio
  await refus(paquet, MACBOOK, undefined, "paquet-mal-adresse"); // qui suis-je ?
  await refus({ ...paquet, de: "Mac\nBook" }, "Mac\nBook", STUDIO, "paquet-mal-adresse"); // un nom de Mac qui forgerait une ligne
  await refus({ ...paquet, schema: 7 }, MACBOOK, STUDIO, "paquet-schema");
  await refus({ ...paquet, version: 2 }, MACBOOK, STUDIO, "paquet-version");
  await refus({ ...paquet, lettres: [{ ...paquet.lettres[0], msg_id: "" }] }, MACBOOK, STUDIO, "paquet-invalide");
  await refus({ ...paquet, lettres: [...paquet.lettres, { ...paquet.lettres[0], msg_id: "L-sans-corps", body: "" }] }, MACBOOK, STUDIO, "paquet-invalide");
  await refus({ ...paquet, lettres: [{ ...paquet.lettres[0], created_at: null }] }, MACBOOK, STUDIO, "paquet-invalide"); // l'heure de là-bas, ou rien
  await refus({ ...paquet, pour: MACBOOK }, MACBOOK, MACBOOK, "paquet-mal-adresse"); // d'un Mac à lui-même
  await refus({ ...paquet, evenements: [{ type: "lu", msg_id: "L-1", at: AT, origine: STUDIO }] }, MACBOOK, STUDIO, "paquet-invalide");
  // Revue, fix round 1 (finding 2) : chaque champ a son type, vérifié AVANT la première écriture.
  const premiere = paquet.lettres[0];
  for (const [nom, defaut] of Object.entries({
    "subject objet": { subject: {} }, "thread_id booléen": { thread_id: true }, "sender_chaise tableau": { sender_chaise: ["x"] },
    "priority nombre": { priority: 5 }, "sans_reveil 2": { sans_reveil: 2 }, "sans_copie texte": { sans_copie: "1" }
  })) {
    // Le défaut est sur la DERNIÈRE lettre : les deux premières, valides, ne doivent pas s'écrire non plus.
    await refus({ ...paquet, lettres: [...paquet.lettres.slice(0, 2), { ...paquet.lettres[2], ...defaut }] }, MACBOOK, STUDIO, "paquet-invalide");
    assert.equal(compter(b), 0, `${nom} : rien d'écrit`);
  }
  for (const chaise of [{ chaise_id: {}, lineage: "alice" }, { chaise_id: "alice#s-1", lineage: "alice", instance_session_id: 5 },
    { chaise_id: "alice#s-1", lineage: "alice", is_primary: 2 }, { chaise_id: "alice#s-1", lineage: "alice", designe_at: {} }, "alice#s-1"]) {
    await refus({ ...paquet, chaises: [chaise] }, MACBOOK, STUDIO, "paquet-invalide");
  }
  for (const evenement of [
    { type: "accuse", msg_id: "L-1", at: AT }, // sans origine
    { type: "accuse", msg_id: "L-1", at: AT, origine: "ailleurs" },
    { type: "remise", msg_id: "L-1", at: AT, origine: MACBOOK }, // une remise parle toujours d'une lettre née chez qui la reçoit
    { type: "accuse", msg_id: "L-1", at: 12, origine: STUDIO }
  ]) {
    await refus({ ...paquet, evenements: [evenement] }, MACBOOK, STUDIO, "paquet-invalide");
  }
  assert.equal(premiere.msg_id, "L-1", "SONDE : le paquet de départ n'a pas bougé");
  await refus({ ...paquet, chaises: "toutes" }, MACBOOK, STUDIO, "paquet-invalide");
  await refus(null, MACBOOK, STUDIO, "paquet-invalide");
  assert.equal(compter(b), 0, "aucune lettre écrite");
  assert.equal(compter(b, "carnet"), avant, "le carnet n'a pas bougé");
});

// Trois lettres de A pour la chaise `alice#s-9` du Studio, dans cet ordre :
// `L-1`, `milieu` (écrite par `expediteurDuMilieu`), `L-3`.
async function troisLettresDontCelleDuMilieu(t, { expediteurDuMilieu = "bob" } = {}) {
  const { a, b } = deuxMacs(t);
  const { deps, portes } = depsDeTest();
  chaiseLocale(b, "alice", "s-9", { pid: process.ppid });
  await montrerLesChaises(b, a, { deMac: STUDIO, versMac: MACBOOK, deps });
  insertMessage(a, { msg_id: "L-1", sender: "bob", recipient: "alice#s-9", body: "la première" });
  insertMessage(a, { msg_id: "L-milieu", sender: expediteurDuMilieu, recipient: "alice#s-9", body: "le corps du MacBook" });
  insertMessage(a, { msg_id: "L-3", sender: "bob", recipient: "alice#s-9", body: "la troisième" });
  return { a, b, deps, portes };
}

test("R18 : même msg_id, autre contenu : la lettre du milieu est refusée (conflit), les deux autres arrivent", async (t) => {
  const { a, b, deps, portes } = await troisLettresDontCelleDuMilieu(t);
  insertMessage(b, { msg_id: "L-milieu", sender: "carol", recipient: "dave", body: "le corps du Studio" });
  const avant = getMessageById(b, "L-milieu");
  const paquet = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.deepEqual(paquet.lettres.map((l) => l.msg_id), ["L-1", "L-milieu", "L-3"], "SONDE : celle du milieu est au milieu");
  const bilan = await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  assert.deepEqual(bilan, {
    neuves: 2, rejeux: 0, conflits: 1, refus: [{ msg_id: "L-milieu", raison: "conflit" }], evenements: 0, chaises: paquet.chaises.length
  });
  assert.equal(getMessageById(b, "L-1").body, "la première");
  assert.equal(getMessageById(b, "L-3").body, "la troisième", "la lettre d'après arrive aussi");
  assert.ok(getMessageById(b, "L-1").seq < getMessageById(b, "L-3").seq, "dans l'ordre");
  assert.deepEqual(getMessageById(b, "L-milieu"), avant, "la lettre locale reste intacte, à l'octet");
  assert.deepEqual(portes.map((p) => p.msgId), ["L-1", "L-3"], "la lettre en conflit ne fait sonner personne");
  // Le contrat de l'aller : seules les lettres non refusées se marquent portées.
  assert.deepEqual(lettresPortees(paquet, bilan.refus), ["L-1", "L-3"]);
  // Revue, fix round 1 (finding 1) : un `refus` absent ou cassé n'est jamais « rien de refusé ».
  for (const casse of [undefined, null, "oops", { msg_id: "L-milieu" }, [{}], [{ msg_id: "" }], ["L-milieu"]]) {
    assert.throws(() => lettresPortees(paquet, casse), (e) => e.code === "paquet-invalide", JSON.stringify(casse) ?? "undefined");
  }
  assert.throws(() => lettresPortees({}, []), (e) => e.code === "paquet-invalide");
  assert.deepEqual(lettresPortees(paquet, []), ["L-1", "L-milieu", "L-3"]);
  assert.equal(marquerPortees(a, STUDIO, lettresPortees(paquet, bilan.refus), { at: AT }), 2);
  assert.deepEqual(exporterPour(a, STUDIO, { moi: MACBOOK }).lettres.map((l) => l.msg_id), ["L-milieu"],
    "la lettre refusée reste en route et se représente à la tournée suivante");
});

test("R18 : un expéditeur sous enclos sur ce bureau : sa lettre est refusée, visible, et les autres arrivent", async (t) => {
  const { a, b, deps } = await troisLettresDontCelleDuMilieu(t, { expediteurDuMilieu: "carol" });
  // Sur le Studio, carol est sous l'enclos d'une table fermée dont alice#s-9 n'est pas membre.
  creerTable(b, { nom: "fermee-test", fermee: true, creeePar: "office-test" });
  ajouterMembre(b, "fermee-test", "carol", { ajoutePar: "office-test" });
  poserEnclos(b, "carol", "fermee-test", { posePar: "office-test" });

  const paquet = exporterPour(a, STUDIO, { moi: MACBOOK });
  const bilan = await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  assert.equal(bilan.neuves, 2);
  assert.equal(bilan.conflits, 0);
  assert.deepEqual(bilan.refus, [{ msg_id: "L-milieu", raison: "hors-enclos" }]);
  assert.equal(getMessageById(b, "L-milieu"), undefined, "rien n'est écrit pour la lettre refusée");
  assert.ok(getMessageById(b, "L-3"), "la lettre d'après arrive");
  const refus = evenementsDe(b, "L-milieu", "relais_refus");
  assert.equal(refus.length, 1);
  assert.deepEqual(JSON.parse(refus[0].detail_json), { mac: MACBOOK, raison: "hors-enclos" });

  // Rejouée à chaque tournée : refusée encore, comptée, sans doubler le journal.
  const encore = await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  assert.deepEqual(encore.refus, [{ msg_id: "L-milieu", raison: "hors-enclos" }]);
  assert.equal(encore.rejeux, 2);
  assert.equal(evenementsDe(b, "L-milieu", "relais_refus").length, 1);

  // A ne marque portées que les lettres acceptées ; l'enclos levé, la lettre passe.
  marquerPortees(a, STUDIO, lettresPortees(paquet, bilan.refus), { at: AT });
  assert.equal(getMessageById(a, "L-milieu").porte_at, null, "la lettre refusée n'est pas portée");
  retirerEnclos(b, "carol", { retirePar: "office-test" });
  const suivant = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.deepEqual(suivant.lettres.map((l) => l.msg_id), ["L-milieu"]);
  const apres = await importerDe(b, MACBOOK, suivant, { moi: STUDIO, at: AT, deps });
  assert.equal(apres.neuves, 1);
  assert.deepEqual(apres.refus, []);
  assert.equal(getMessageById(b, "L-milieu").sender, "carol");
});

test("R18 : une lettre déjà arrivée reste un rejeu, même si son expéditeur est mis sous enclos ensuite", async (t) => {
  const { a, b, deps } = await troisLettresDontCelleDuMilieu(t, { expediteurDuMilieu: "carol" });
  const paquet = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.equal((await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps })).neuves, 3);
  // La réponse de cette tournée s'est perdue (A n'a rien marqué) ; entre-temps, le Studio enclôt carol.
  creerTable(b, { nom: "fermee-test", fermee: true, creeePar: "office-test" });
  ajouterMembre(b, "fermee-test", "carol", { ajoutePar: "office-test" });
  poserEnclos(b, "carol", "fermee-test", { posePar: "office-test" });
  const encore = await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  assert.deepEqual(encore.refus, [], "l'enclos garde les écritures ; un rejeu n'écrit rien");
  assert.equal(encore.rejeux, 3);
  assert.equal(evenementsDe(b, "L-milieu", "relais_refus").length, 0);
  assert.deepEqual(lettresPortees(paquet, encore.refus), ["L-1", "L-milieu", "L-3"], "A peut tout marquer porté");
});

test("même msg_id, autre contenu : un conflit compté et visible, jamais un rejeu", async (t) => {
  const { a, b, deps } = await troisLettresPourLeStudio(t);
  insertMessage(a, { msg_id: "L-x", sender: "bob", recipient: "alice#s-9", body: "le corps du MacBook" });
  insertMessage(b, { msg_id: "L-x", sender: "carol", recipient: "dave", body: "le corps du Studio" });
  const paquet = exporterPour(a, STUDIO, { moi: MACBOOK });
  const bilan = await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  assert.equal(bilan.conflits, 1);
  assert.equal(bilan.rejeux, 0);
  assert.equal(bilan.neuves, 3);
  assert.deepEqual(bilan.refus, [{ msg_id: "L-x", raison: "conflit" }]);
  const locale = getMessageById(b, "L-x");
  assert.equal(locale.body, "le corps du Studio", "la lettre locale reste intacte");
  assert.equal(locale.sender, "carol");
  assert.equal(locale.via, null);
  const conflits = evenementsDe(b, "L-x", "relais_conflit");
  assert.equal(conflits.length, 1);
  const detail = JSON.parse(conflits[0].detail_json);
  assert.equal(detail.mac, MACBOOK);
  assert.deepEqual(detail.champs, ["body", "recipient", "sender"]);
  assert.equal(detail.ecarte.body, "le corps du MacBook", "le contenu écarté reste lisible au journal");
  // Rejoué, le conflit se compte encore, et le journal ne double pas.
  const encore = await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  assert.equal(encore.conflits, 1);
  assert.deepEqual(encore.refus, [{ msg_id: "L-x", raison: "conflit" }]);
  assert.equal(encore.rejeux, 3);
  assert.equal(evenementsDe(b, "L-x", "relais_conflit").length, 1);
});

test("le guichet refuse une marque de relais qui ne vient pas du relais", async (t) => {
  const b = bureauJetable(t, "relais-paquet-b-");
  const { deps } = depsDeTest();
  const lettre = { msg_id: "L-forgee", sender: "bob", recipient: "alice", body: "x" };
  for (const marque of [{ via: "relais" }, { mac_origine: MACBOOK }, { via: "relais", mac_origine: MACBOOK }]) {
    await assert.rejects(posterUneLettre(b, { ...lettre, ...marque }, deps), (e) => e.code === "via-reservee-au-relais");
    await assert.rejects(
      posterUneLettre(b, { ...lettre, ...marque }, { ...deps, porteParLeRelais: "yes" }),
      (e) => e.code === "via-reservee-au-relais",
      "seul `true` ouvre la porte"
    );
  }
  assert.equal(compter(b), 0, "rien n'est écrit");
  // Une surface qui ne dit rien de ces champs (null) n'est pas refusée.
  const { row } = await posterUneLettre(b, { ...lettre, via: null, mac_origine: null }, deps);
  assert.equal(row.via, null);
  // Le relais, lui, passe.
  const { row: portee } = await posterUneLettre(b, { ...lettre, msg_id: "L-portee", via: "relais", mac_origine: MACBOOK }, { ...deps, porteParLeRelais: true });
  assert.equal(portee.via, "relais");
  assert.equal(portee.mac_origine, MACBOOK);
});

// ── LA REMISE, PUIS L'ACCUSÉ ────────────────────────────────────────────────

test("la remise revient avant l'accusé, et jamais d'accusé sans remise", async (t) => {
  const { a, b, deps, paquet } = await troisLettresPourLeStudio(t);
  await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  assert.equal(marquerPortees(a, STUDIO, paquet.lettres.map((l) => l.msg_id), { at: AT }), 3);

  // L-1 : remise sur B, puis accusée. L-2 : accusée sans remise.
  const T1 = "2026-11-16T12:01:00.000Z";
  const T2 = "2026-11-16T12:02:00.000Z";
  const T3 = "2026-11-16T12:03:00.000Z";
  markDelivered(b, [getMessageById(b, "L-1")], "alice#s-9", "delivered", { at: T1 });
  ackMessage(b, "L-1", "alice#s-9", { at: T2 });
  ackMessage(b, "L-2", "alice#s-9", { at: T3 });
  // R19 : la remise est `delivered_at` seul. L-3, poussée par un crochet (injected_at) et
  // jamais marquée remise, ne fait partir aucune remise (son accusé, plus tard, la posera).
  markInjected(b, [getMessageById(b, "L-3")], "alice#s-9");
  assert.ok(getMessageById(b, "L-3").injected_at, "SONDE : L-3 est injectée");

  const retour = exporterPour(b, MACBOOK, { moi: STUDIO });
  assert.deepEqual(retour.lettres, []);
  assert.deepEqual(retour.evenements, [
    { type: "remise", msg_id: "L-1", at: T1, origine: MACBOOK },
    { type: "accuse", msg_id: "L-1", at: T2, origine: MACBOOK, par: "alice#s-9" },
    { type: "accuse", msg_id: "L-2", at: T3, origine: MACBOOK, par: "alice#s-9" }
  ]);

  const bilan = await importerDe(a, STUDIO, retour, { moi: MACBOOK, at: AT, deps });
  assert.equal(bilan.evenements, 3);
  const l1 = getMessageById(a, "L-1");
  assert.equal(l1.delivered_at, T1);
  assert.equal(l1.acked_at, T2);
  assert.ok(l1.delivered_at <= l1.acked_at);
  const l2 = getMessageById(a, "L-2");
  assert.equal(l2.delivered_at, T3, "un accusé sans remise pose la remise à son heure");
  assert.equal(l2.acked_at, T3);
  assert.equal(getMessageById(a, "L-3").acked_at, null, "L-3 attend toujours");
  assert.equal(getMessageById(a, "L-3").delivered_at, null, "une injection seule ne rend pas de remise");
  assert.equal(marquerRendus(b, MACBOOK, [{ type: "remise", msg_id: "L-3", at: T1 }], { at: AT }), 0,
    "une remise qui n'a pas eu lieu ici ne se marque pas rendue");
  assert.equal(evenementsDe(a, "L-1", "relais_remise").length, 1);
  const accuses = evenementsDe(a, "L-1", "relais_accuse");
  assert.equal(accuses.length, 1);
  assert.deepEqual(JSON.parse(accuses[0].detail_json), { mac: STUDIO, par: "alice#s-9" });
  // Aucun écho : A ne renvoie pas au Studio l'accusé qu'il vient d'en recevoir.
  assert.deepEqual(exporterPour(a, STUDIO, { moi: MACBOOK }).evenements, []);
  // Réimporté, le même retour ne change rien.
  const encore = await importerDe(a, STUDIO, retour, { moi: MACBOOK, at: AT, deps });
  assert.equal(encore.evenements, 0);
  assert.equal(evenementsDe(a, "L-1", "relais_accuse").length, 1);
});

test("marquer les rendus vide les évènements du prochain paquet", async (t) => {
  const { a, b, deps, paquet } = await troisLettresPourLeStudio(t);
  await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  markDelivered(b, [getMessageById(b, "L-1")], "alice#s-9", "delivered", { at: "2026-11-16T12:01:00.000Z" });
  ackMessage(b, "L-1", "alice#s-9", { at: "2026-11-16T12:02:00.000Z" });
  markDelivered(b, [getMessageById(b, "L-3")], "alice#s-9", "delivered", { at: "2026-11-16T12:03:00.000Z" });
  const retour = exporterPour(b, MACBOOK, { moi: STUDIO });
  assert.equal(retour.evenements.length, 3, "SONDE : remise et accusé de L-1, remise de L-3");
  await importerDe(a, STUDIO, retour, { moi: MACBOOK, at: AT, deps });

  assert.equal(marquerRendus(b, MACBOOK, retour.evenements, { at: AT }), 3);
  assert.equal(exporterPour(b, MACBOOK, { moi: STUDIO }).evenements.length, 0);
  assert.equal(marquerRendus(b, MACBOOK, retour.evenements, { at: AT }), 0, "rejouer ne marque rien de plus");
  assert.equal(getMessageById(b, "L-1").remise_rendue_at, AT);
  assert.equal(getMessageById(b, "L-1").accuse_rendu_at, AT);
  // Un rendu vu ne cache pas l'étape suivante : L-3, accusée maintenant, repart.
  ackMessage(b, "L-3", "alice#s-9", { at: "2026-11-16T12:04:00.000Z" });
  assert.deepEqual(exporterPour(b, MACBOOK, { moi: STUDIO }).evenements, [
    { type: "accuse", msg_id: "L-3", at: "2026-11-16T12:04:00.000Z", origine: MACBOOK, par: "alice#s-9" }
  ]);
  // Un rendu pour un AUTRE Mac ne marque rien ici.
  assert.equal(marquerRendus(b, STUDIO, [{ type: "accuse", msg_id: "L-3", at: AT }], { at: AT }), 0);
});

// La garde de `marquerRendus` (relecture finale, constat 4 : le mutant M9, qui
// retirait `acked_at IS NOT NULL`, survivait) : une marque « rendu » ne se pose
// que sur un fait qui existe ICI. Un évènement forgé, ou en avance sur les faits
// d'ici, ne tait jamais la remise ni l'accusé à venir.
test("marquerRendus ne marque ni un accusé ni une remise qui n'existent pas encore ici, et les vrais partent ensuite", async (t) => {
  const { a, b, deps, paquet } = await troisLettresPourLeStudio(t);
  await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  // L-1 : ni remise ni accusée sur B. L-2 : remise, pas accusée.
  markDelivered(b, [getMessageById(b, "L-2")], "alice#s-9", "delivered", { at: "2026-11-16T12:01:00.000Z" });
  const forges = [
    { type: "remise", msg_id: "L-1", at: AT, origine: MACBOOK },
    { type: "accuse", msg_id: "L-1", at: AT, origine: MACBOOK },
    { type: "accuse", msg_id: "L-2", at: AT, origine: MACBOOK }
  ];
  assert.equal(marquerRendus(b, MACBOOK, forges, { at: AT }), 0, "aucun fait d'ici ne répond : rien n'est marqué");
  for (const id of ["L-1", "L-2"]) {
    const l = getMessageById(b, id);
    assert.equal(l.accuse_rendu_at, null, `${id} : l'accusé à venir n'est pas tu`);
  }
  assert.equal(getMessageById(b, "L-1").remise_rendue_at, null, "L-1 : la remise à venir n'est pas tue");

  // Les vrais faits : L-1 remise et accusée, L-2 accusée. Ils partent au prochain export.
  markDelivered(b, [getMessageById(b, "L-1")], "alice#s-9", "delivered", { at: "2026-11-16T12:02:00.000Z" });
  ackMessage(b, "L-1", "alice#s-9", { at: "2026-11-16T12:03:00.000Z" });
  ackMessage(b, "L-2", "alice#s-9", { at: "2026-11-16T12:04:00.000Z" });
  const retour = exporterPour(b, MACBOOK, { moi: STUDIO });
  assert.deepEqual(retour.evenements.map((e) => [e.type, e.msg_id]), [
    ["remise", "L-1"], ["accuse", "L-1"], ["remise", "L-2"], ["accuse", "L-2"]
  ]);
  await importerDe(a, STUDIO, retour, { moi: MACBOOK, at: AT, deps });
  assert.equal(getMessageById(a, "L-1").acked_at, "2026-11-16T12:03:00.000Z", "l'accusé réel arrive à l'origine");
  assert.equal(getMessageById(a, "L-2").acked_at, "2026-11-16T12:04:00.000Z");
});

// ── R16 : L'ACCUSÉ VA DANS LES DEUX SENS (la copie zombie) ──────────────────
//
// Une lettre née sur A, portée sur B, puis tenue de nouveau sur A (la fenêtre
// où la lignée change de Mac). A la sert selon la résolution, jamais selon
// `porte_at`, et l'accuse ; l'accusé part vers B, pour que la copie de B ne
// reste pas non accusée à jamais.
test("R16 : une lettre portée puis tenue ici de nouveau est servie ici, et son accusé part vers la copie de là-bas", async (t) => {
  const { a, b } = deuxMacs(t);
  const { deps } = depsDeTest();
  const chaiseA = chaiseLocale(a, LIGNEE, "s-a", { pid: process.pid, designeAt: "2026-11-16T10:00:00.000Z" });
  chaiseLocale(b, LIGNEE, "s-b", { pid: process.ppid, designeAt: "2026-11-16T11:00:00.000Z" });
  // L'état stable : la désignée la plus récente est au Studio, il tient la lignée.
  ecrireLeCarnet(a, STUDIO, [chaiseDuPaquet(LIGNEE, "s-b", { designeAt: "2026-11-16T11:00:00.000Z" })], { at: AT });
  ecrireLeCarnet(b, MACBOOK, [chaiseDuPaquet(LIGNEE, "s-a", { designeAt: "2026-11-16T10:00:00.000Z" })], { at: AT });
  assert.equal(resolveRecipient(a, LIGNEE).kind, "distant", "prémisse : A porte vers le Studio");

  // Née sur A, portée sur B.
  insertMessage(a, { msg_id: "L-zombie", sender: "bob", recipient: LIGNEE, body: "pour la lignée" });
  const aller = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.deepEqual(aller.lettres.map((l) => l.msg_id), ["L-zombie"]);
  await importerDe(b, MACBOOK, aller, { moi: STUDIO, at: AT, deps });
  assert.equal(marquerPortees(a, STUDIO, ["L-zombie"], { at: AT }), 1);
  assert.throws(() => ackMessage(a, "L-zombie", chaiseA), (e) => e instanceof AccuseRefuse && /tenue-ailleurs/.test(e.raison),
    "SONDE : tant que le Studio tient, A n'accuse pas");

  // La désignée du Studio s'en va ; l'échange suivant le montre (ruling R3 : le carnet).
  undesignate(b, LIGNEE);
  ecrireLeCarnet(a, STUDIO, [chaiseDuPaquet(LIGNEE, "s-b")], { at: "2026-11-16T12:05:00.000Z" });
  assert.equal(resolveRecipient(a, LIGNEE).kind, "lineage", "A tient de nouveau la lignée");
  assert.equal(resolveRecipient(b, LIGNEE).kind, "distant", "B ne la sert pas (elle vit sur A)");

  // A la sert selon la résolution, malgré porte_at.
  assert.ok(getMessageById(a, "L-zombie").porte_at, "SONDE : elle a été portée");
  assert.ok(adressesDuRepli(a, LIGNEE, { session_id: "s-a" }).includes(LIGNEE), "la chaise de A relève sa lignée");
  const servies = listInbox(a, LIGNEE);
  assert.deepEqual(servies.map((r) => r.msg_id), ["L-zombie"]);
  markDelivered(a, servies, chaiseA, "delivered", { at: "2026-11-16T12:06:00.000Z" });
  ackMessage(a, "L-zombie", chaiseA, { at: "2026-11-16T12:07:00.000Z" });

  // Le paquet suivant de A porte l'accusé vers la copie de B.
  const retour = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.deepEqual(retour.lettres, []);
  assert.deepEqual(retour.evenements, [
    { type: "accuse", msg_id: "L-zombie", at: "2026-11-16T12:07:00.000Z", origine: MACBOOK, par: chaiseA }
  ]);
  assert.equal(getMessageById(b, "L-zombie").acked_at, null, "SONDE : la copie de B n'est pas encore accusée");
  const bilan = await importerDe(b, MACBOOK, retour, { moi: STUDIO, at: AT, deps });
  assert.equal(bilan.evenements, 1);
  const copie = getMessageById(b, "L-zombie");
  assert.equal(copie.via, "relais");
  assert.equal(copie.acked_at, "2026-11-16T12:07:00.000Z");
  assert.equal(copie.delivered_at, "2026-11-16T12:07:00.000Z");
  assert.deepEqual(JSON.parse(evenementsDe(b, "L-zombie", "relais_accuse")[0].detail_json), { mac: MACBOOK, par: chaiseA });

  // Un second import ne change rien.
  const journal = compter(b, "delivery_events");
  const encore = await importerDe(b, MACBOOK, retour, { moi: STUDIO, at: AT, deps });
  assert.equal(encore.evenements, 0);
  assert.deepEqual(getMessageById(b, "L-zombie"), copie);
  assert.equal(compter(b, "delivery_events"), journal);
  // Aucun écho de B vers A.
  assert.deepEqual(exporterPour(b, MACBOOK, { moi: STUDIO }).evenements, []);
  // A marque l'accusé rendu : il ne repart plus.
  assert.equal(marquerRendus(a, STUDIO, retour.evenements, { at: AT }), 1);
  assert.equal(getMessageById(a, "L-zombie").accuse_rendu_at, AT);
  assert.deepEqual(exporterPour(a, STUDIO, { moi: MACBOOK }).evenements, []);
});

// R20 (revue, fix round 1, finding 3) : la réponse d'une tournée se perd. B a
// importé la lettre, A n'a rien marqué ; puis A tient la lignée, la sert et
// l'accuse. L'OFFRE (`porte_vers`, posée à l'export) suffit pour que l'accusé
// parte vers la copie de B ; `porte_at` reste la confirmation.
test("R20 : la réponse perdue — l'offre suffit pour que l'accusé rejoigne la copie de là-bas", async (t) => {
  const { a, b } = deuxMacs(t);
  const { deps } = depsDeTest();
  const chaiseA = chaiseLocale(a, LIGNEE, "s-a", { pid: process.pid, designeAt: "2026-11-16T10:00:00.000Z" });
  chaiseLocale(b, LIGNEE, "s-b", { pid: process.ppid, designeAt: "2026-11-16T11:00:00.000Z" });
  ecrireLeCarnet(a, STUDIO, [chaiseDuPaquet(LIGNEE, "s-b", { designeAt: "2026-11-16T11:00:00.000Z" })], { at: AT });
  ecrireLeCarnet(b, MACBOOK, [chaiseDuPaquet(LIGNEE, "s-a", { designeAt: "2026-11-16T10:00:00.000Z" })], { at: AT });

  insertMessage(a, { msg_id: "L-perdue", sender: "bob", recipient: LIGNEE, body: "la réponse s'est perdue" });
  const aller = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.deepEqual(aller.lettres.map((l) => l.msg_id), ["L-perdue"]);
  const offerte = getMessageById(a, "L-perdue");
  assert.equal(offerte.porte_vers, STUDIO, "l'export pose l'offre");
  assert.equal(offerte.porte_at, null, "la confirmation attend marquerPortees");
  await importerDe(b, MACBOOK, aller, { moi: STUDIO, at: AT, deps });
  // La réponse est perdue : A ne marque rien. Puis la lignée revient à A.
  undesignate(b, LIGNEE);
  ecrireLeCarnet(a, STUDIO, [chaiseDuPaquet(LIGNEE, "s-b")], { at: "2026-11-16T12:05:00.000Z" });
  assert.equal(resolveRecipient(a, LIGNEE).kind, "lineage");
  const servies = listInbox(a, LIGNEE);
  assert.deepEqual(servies.map((r) => r.msg_id), ["L-perdue"]);
  markDelivered(a, servies, chaiseA, "delivered", { at: "2026-11-16T12:06:00.000Z" });
  ackMessage(a, "L-perdue", chaiseA, { at: "2026-11-16T12:07:00.000Z" });

  const retour = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.deepEqual(retour.lettres, []);
  assert.deepEqual(retour.evenements, [
    { type: "accuse", msg_id: "L-perdue", at: "2026-11-16T12:07:00.000Z", origine: MACBOOK, par: chaiseA }
  ]);
  assert.equal((await importerDe(b, MACBOOK, retour, { moi: STUDIO, at: AT, deps })).evenements, 1);
  assert.equal(getMessageById(b, "L-perdue").acked_at, "2026-11-16T12:07:00.000Z", "la copie de B est accusée");
  assert.equal(marquerRendus(a, STUDIO, retour.evenements, { at: AT }), 1);
  assert.deepEqual(exporterPour(a, STUDIO, { moi: MACBOOK }).evenements, []);
});

test("R20 : un accusé pour une lettre que l'autre Mac n'a jamais vue ne change rien là-bas, et se marque rendu ici", async (t) => {
  const { a, b, deps } = await troisLettresPourLeStudio(t);
  // A offre ses lettres ; le paquet n'arrive jamais sur B. Puis A accuse L-1 lui-même.
  const perdu = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.equal(getMessageById(a, "L-1").porte_vers, STUDIO);
  a.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = 'L-1'").run(AT);
  const retour = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.deepEqual(retour.evenements.map((e) => [e.type, e.msg_id, e.origine]), [["accuse", "L-1", MACBOOK]]);
  assert.deepEqual(retour.lettres.map((l) => l.msg_id), perdu.lettres.slice(1).map((l) => l.msg_id), "SONDE : les autres sont encore offertes");

  const journal = compter(b, "delivery_events");
  const bilan = await importerDe(b, MACBOOK, { ...retour, lettres: [] }, { moi: STUDIO, at: AT, deps });
  assert.equal(bilan.evenements, 0);
  assert.equal(compter(b), 0, "aucune lettre ne naît d'un accusé");
  assert.equal(compter(b, "delivery_events"), journal, "rien n'est écrit");
  assert.equal(marquerRendus(a, STUDIO, retour.evenements, { at: AT }), 1);
  assert.deepEqual(exporterPour(a, STUDIO, { moi: MACBOOK }).evenements, [], "il ne se répète pas");
});

// Le même `msg_id` vit des deux côtés avec deux contenus : l'accusé de la
// lettre de A ne touche JAMAIS la lettre de B (seulement une copie venue de A).
test("R20 : l'accusé d'une lettre refusée en conflit n'accuse jamais la lettre homonyme de l'autre Mac", async (t) => {
  const { a, b, deps } = await troisLettresDontCelleDuMilieu(t);
  insertMessage(b, { msg_id: "L-milieu", sender: "carol", recipient: "dave", body: "le corps du Studio" });
  const paquet = exporterPour(a, STUDIO, { moi: MACBOOK });
  const bilan = await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  assert.deepEqual(bilan.refus, [{ msg_id: "L-milieu", raison: "conflit" }]);
  marquerPortees(a, STUDIO, lettresPortees(paquet, bilan.refus), { at: AT });
  // A accuse sa propre L-milieu : l'accusé part (l'offre a été faite)…
  a.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = 'L-milieu'").run(AT);
  const retour = exporterPour(a, STUDIO, { moi: MACBOOK });
  assert.deepEqual(retour.evenements.map((e) => [e.type, e.msg_id, e.origine]), [["accuse", "L-milieu", MACBOOK]]);
  // … et B ne l'applique pas à SA lettre homonyme, née chez lui.
  const avant = getMessageById(b, "L-milieu");
  assert.equal((await importerDe(b, MACBOOK, retour, { moi: STUDIO, at: AT, deps })).evenements, 0);
  assert.deepEqual(getMessageById(b, "L-milieu"), avant, "la lettre de B n'est ni accusée ni remise");
  assert.equal(getMessageById(b, "L-milieu").acked_at, null);
});

test("R16 : une lettre née ici et jamais portée ne fait partir aucun accusé", (t) => {
  const a = bureauJetable(t, "relais-paquet-a-");
  const chaise = chaiseLocale(a, "carol", "s-1");
  insertMessage(a, { msg_id: "L-ici", sender: "bob", recipient: chaise, body: "x" });
  ackMessage(a, "L-ici", chaise, { at: AT });
  assert.deepEqual(exporterPour(a, STUDIO, { moi: MACBOOK }).evenements, []);
});

// ── LES MARQUES VISIBLES ────────────────────────────────────────────────────

test("la lettre portée se lit avec ses deux mentions", async (t) => {
  const { b, deps, paquet } = await troisLettresPourLeStudio(t);
  await importerDe(b, MACBOOK, paquet, { moi: STUDIO, at: AT, deps });
  const texte = formatAdditionalContext([getMessageById(b, "L-1")]);
  assert.ok(texte.includes("Via: relais · from: MacBook"), texte);
  const lignes = texte.split("\n");
  const de = lignes.indexOf("From: bob");
  assert.ok(de > 0, texte);
  assert.equal(lignes[de + 1], "Via: relais · from: MacBook", "sous From:");
  assert.equal(lignes[de + 2], "To: alice#s-9");
  // Une lettre née ici n'a pas la ligne.
  insertMessage(b, { msg_id: "L-locale", sender: "bob", recipient: "alice#s-9", body: "x" });
  assert.ok(!formatAdditionalContext([getMessageById(b, "L-locale")]).includes("Via:"));
});
