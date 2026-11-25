// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'IDENTIFIANT DE CHAISE COURT (1.1.0, Tâche 8) — `lignée#<8 hexadécimaux ou plus>`.
//
// « alice#35e98d0b-3f2c-4d66-9fa6-08608bb889cf » est exact et illisible ; « alice#35e98d0b » est
// ce que `valxos-peers` et `list_peers` montrent (`ficheLisible.chaise`) et ce qu'un humain tape.
// Il se résout s'il désigne UNE chaise en service ; deux candidates → la lettre attend (jamais les
// dés). Au guichet, la lettre s'écrit sous l'adresse ENTIÈRE de la chaise — c'est sous elle que
// ses hooks, son moniteur et son `inbox` relèvent.
//
// Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) ; aucune socket. Le
// plancher se pose AVANT le premier test (remède F2) et l'état d'origine se restaure à la fin.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-chaise-courte-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { ackMessage, getMessageById, getPendingForContext, insertMessage, openDatabase } from "../src/lib/database.js";
import { canoniserLaChaiseCourte, posterAUneTable, posterUneLettre } from "../src/lib/guichet.js";
import { adressesDuRepli } from "../src/lib/identity.js";
import { ajouterMembre, creerTable, poserEnclos } from "../src/lib/tables.js";
import {
  attenteDeLaLettre,
  estUneChaiseCourte,
  ficheLisible,
  getInstance,
  instanceId,
  registerInstance,
  resolveRecipient
} from "../src/lib/registry.js";

// I1 : la résolution consulte la VIE d'une chaise ; une chaise censée vivre porte un pid vivant.
const PID_VIVANT = process.pid;
const S_WORK = "35e98d0b-3f2c-4d66-9fa6-08608bb889cf";
const S_JUMELLE = "35e98d0b-7a11-4e02-b3cd-991122334455"; // même début sur neuf caractères
const S_AUTRE = "9c1f2a3b-0000-4000-8000-000000000001";

function bureauDePoste(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-chaise-courte-"));
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return db;
}

function chaise(db, lignee, sessionId, extra = {}) {
  return registerInstance(db, { lineage: lignee, sessionId, house: "/h/work", pid: PID_VIVANT, ...extra });
}

// ── LA FORME ───────────────────────────────────────────────────────────────────────────────────
test("estUneChaiseCourte : lignée, « # », huit hexadécimaux ou plus (tirets permis ensuite) — et rien d'autre", () => {
  for (const oui of ["alice#35e98d0b", "alice#35E98D0B", "alice#35e98d0b-3f2c", `alice#${S_WORK}`, "claude-bob#0123abcd"]) {
    assert.equal(estUneChaiseCourte(oui), true, oui);
  }
  for (const non of ["alice", "alice#35e98d0", "alice#s-1abcdef", "alice#atelier1", "#35e98d0b", "alice@35e98d0b", "alice#35e98d0b-zz", "", null, undefined]) {
    assert.equal(estUneChaiseCourte(non), false, String(non));
  }
});

// ── LA RÉSOLUTION ──────────────────────────────────────────────────────────────────────────────
test("« lignée#<8 hex> » mène à l'unique chaise en service dont la session commence ainsi — et le dit (abrege)", (t) => {
  const db = bureauDePoste(t);
  const row = chaise(db, "alice", S_WORK);
  chaise(db, "alice", S_AUTRE);
  for (const ecrit of ["alice#35e98d0b", "alice#35E98D0B", "alice#35e98d0b-3f2c", "alice#35e98d0b-3f2c-4d66"]) {
    const res = resolveRecipient(db, ecrit);
    assert.equal(res.kind, "instance", ecrit);
    assert.equal(res.targets.length, 1, ecrit);
    assert.equal(res.targets[0].id, row.id, "la cible porte l'adresse ENTIÈRE");
    assert.equal(res.abrege, ecrit, "la résolution dit qu'elle vient d'une forme courte");
  }
  // L'adresse entière résout comme avant (marche 1), sans `abrege`.
  const entiere = resolveRecipient(db, row.id);
  assert.equal(entiere.kind, "instance");
  assert.equal(entiere.abrege, undefined);
  // La forme que `valxos-peers` et `list_peers` montrent est exactement celle qui résout.
  const montree = ficheLisible(row).chaise;
  assert.equal(montree, "alice#35e98d0b");
  assert.equal(resolveRecipient(db, montree).targets[0].id, row.id);
  // Une autre lignée au même début de session ne répond pas à « alice# » — et réciproquement.
  const bob = chaise(db, "bob", "35e98d0b-aaaa-4000-8000-000000000002");
  assert.equal(resolveRecipient(db, "alice#35e98d0b").targets[0].id, row.id);
  assert.equal(resolveRecipient(db, "bob#35e98d0b").targets[0].id, bob.id);
});

test("deux chaises en service au même début : AMBIGU, deux cibles, jamais les dés — et un préfixe plus long tranche", (t) => {
  const db = bureauDePoste(t);
  const work = chaise(db, "alice", S_WORK);
  const jumelle = chaise(db, "alice", S_JUMELLE);
  const res = resolveRecipient(db, "alice#35e98d0b");
  assert.equal(res.kind, "ambigu");
  assert.deepEqual(res.targets.map((c) => c.id).sort(), [work.id, jumelle.id].sort());
  assert.equal(res.abrege, "alice#35e98d0b");
  assert.equal(resolveRecipient(db, "alice#35e98d0b-3").targets[0].id, work.id, "dix caractères suffisent ici");
  assert.equal(resolveRecipient(db, "alice#35e98d0b-7").targets[0].id, jumelle.id);
});

test("l'avis d'attente d'une chaise courte ambiguë dit chaise-ambigue, la lignée, le préfixe, les candidates et le remède", (t) => {
  const db = bureauDePoste(t);
  chaise(db, "alice", S_WORK);
  chaise(db, "alice", S_JUMELLE);
  const avis = attenteDeLaLettre(db, "alice#35e98d0b");
  assert.equal(avis.motif, "chaise-ambigue");
  assert.equal(avis.candidats, 2);
  assert.equal(avis.lignee, "alice");
  assert.equal(avis.prefixe, "35e98d0b");
  assert.match(avis.message, /^Ambiguous short chair id: 2 chairs of lineage "alice" start with "35e98d0b"\. /);
  assert.match(avis.message, /more characters of the session id/);
  assert.match(avis.message, /once a single chair in service matches it, that chair's hooks and its MCP inbox collect it/,
    "l'avis promet ce que le repli fait (adressesDuRepli ③), et rien de plus");
  assert.doesNotMatch(avis.message, /designat/i, "une désignation ne tranche pas un préfixe : le remède est de l'allonger");
  // La lignée elle-même reste « ambiguë » au sens d'avant, avec son avis d'avant.
  assert.equal(attenteDeLaLettre(db, "alice").motif, "lignee-ambigue");
});

test("trop court, pas hexadécimal, inconnu, autre lignée, hors service : personne ne répond — jamais une approximation", (t) => {
  const db = bureauDePoste(t);
  const row = chaise(db, "alice", S_WORK);
  assert.equal(resolveRecipient(db, "alice#35e98d0").kind, "unknown", "sept caractères : une devinette, pas une abréviation");
  assert.equal(resolveRecipient(db, "alice#35e98d0b-zz").kind, "unknown", "un caractère hors hexadécimal : pas une forme courte");
  assert.equal(resolveRecipient(db, "alice#9c1f2a3b").kind, "unknown", "un début que personne ne porte");
  assert.equal(resolveRecipient(db, "carol#35e98d0b").kind, "unknown", "la lignée compte : ce début est chez alice");
  db.prepare("UPDATE peers SET status = 'offline' WHERE id = ?").run(row.id);
  assert.equal(resolveRecipient(db, "alice#35e98d0b").kind, "unknown", "une chaise hors service ne répond plus à sa forme courte");
});

// Les deux INVARIANTS de test/adresse-humaine.test.js, rejoués sur la marche 5.
test("INVARIANT — une résolution AMBIGUË ne nomme JAMAIS une seule cible", (t) => {
  const db = bureauDePoste(t);
  chaise(db, "alice", S_WORK);
  chaise(db, "alice", S_JUMELLE);
  const res = resolveRecipient(db, "alice#35e98d0b");
  assert.equal(res.kind, "ambigu");
  assert.ok(res.targets.length >= 2, "une ambiguïté qui ne nomme qu'une personne n'en est pas une");
});

test("INVARIANT — un nom neuf ne passe jamais devant un nom qui marchait déjà : la fiche héritée gagne (Camp B)", (t) => {
  const db = bureauDePoste(t);
  // Une fiche d'avant les lignées dont l'id a la forme d'une chaise courte (un roster écrit à la main).
  db.prepare(`
    INSERT INTO peers (id, status, registered_at, last_seen)
    VALUES ('alice#35e98d0b', 'active', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z')
  `).run();
  chaise(db, "alice", S_WORK);
  const res = resolveRecipient(db, "alice#35e98d0b");
  assert.equal(res.kind, "instance");
  assert.equal(res.targets[0].id, "alice#35e98d0b", "l'adresse qui marchait hier gagne");
  assert.equal(res.targets[0].instance_session_id, null, "et c'est bien la fiche héritée, pas la chaise");
  assert.equal(res.abrege, undefined);
});

// ── LE GUICHET : la lettre s'écrit sous l'adresse ENTIÈRE ──────────────────────────────────────
// Les hooks relèvent `lignée` et `lignée#<session entière>` (adressesDuRepli), le moniteur et
// `inbox` aussi : une lettre gardée sous « alice#35e98d0b » ne serait relevée par personne. Le
// guichet résout la forme courte AVANT d'écrire, et écrit l'adresse de la chaise ; la forme tapée
// reste au journal (`chaise_courte_appliquee`), Camp B. Aucune vraie porte ici : le réveil est
// enregistré (le NOM frappé), jamais frappé (test/guichet.test.js, `reveilEnregistre`).
const MAISONS_VIDES = () => ({ houses: [], parSession: new Map() });
function reveilEnregistre() {
  const portes = [];
  return {
    portes,
    reveiller: async (agentId, payload) => {
      portes.push({ agentId, payload });
      return { ok: false, socketPath: `/carton/${agentId}.sock`, error: "ENOENT" };
    }
  };
}

test("posterUneLettre vers « alice#35e98d0b » écrit la lettre à « alice#<session entière> », frappe chez alice, journalise la forme tapée", async (t) => {
  const db = bureauDePoste(t);
  const row = chaise(db, "alice", S_WORK);
  const { portes, reveiller } = reveilEnregistre();
  const envoi = await posterUneLettre(
    db,
    { msg_id: "m-courte", sender: "carol", to: "alice#35e98d0b", body: "par la forme courte" },
    { reveiller, maisons: MAISONS_VIDES() }
  );
  assert.equal(envoi.row.recipient, row.id, "l'adresse ENTIÈRE de la chaise, pas la forme tapée");
  assert.equal(envoi.resolution.kind, "instance");
  assert.equal(envoi.resolution.abrege, undefined, "la résolution partagée est celle de l'adresse ENTIÈRE (marche 1), pas de la forme tapée");
  // Le registre n'a rien à redire (ni `chaise-ambigue`, ni `destinataire-inconnu`) ; seule la
  // tournée note que la maison de carton (`/h/work`) n'est pas dans l'inventaire VIDE de ce test —
  // exactement ce que `avisDAttente` dit d'une chaise vivante à l'adresse entière.
  assert.equal(envoi.attente?.motif, "maison-inconnue");
  assert.deepEqual(portes.map((p) => p.agentId), ["alice"], "on frappe à la porte de la lignée, comme pour toute chaise");
  const trace = db.prepare(
    "SELECT agent_id, detail_json FROM delivery_events WHERE msg_id = 'm-courte' AND event_type = 'chaise_courte_appliquee'"
  ).all();
  assert.equal(trace.length, 1);
  assert.equal(trace[0].agent_id, "carol");
  assert.deepEqual(JSON.parse(trace[0].detail_json), { demande: "alice#35e98d0b", chaise: row.id });

  // Le rejeu (même msg_id, autre destinataire) : la ligne existante gagne, canonisée ou pas (R2).
  const rejeu = await posterUneLettre(
    db,
    { msg_id: "m-courte", sender: "carol", to: "bob", body: "autre" },
    { reveiller, maisons: MAISONS_VIDES() }
  );
  assert.equal(rejeu.row.recipient, row.id);
  assert.equal(rejeu.rejeu?.motif, "msg_id-deja-connu");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE event_type = 'chaise_courte_appliquee'").get().n,
    1,
    "le rejeu ne journalise pas deux fois"
  );
});

test("ambiguë, entière, lignée nue, inconnue : le guichet n'y touche pas — et l'avis dit chaise-ambigue", async (t) => {
  const db = bureauDePoste(t);
  const work = chaise(db, "alice", S_WORK);
  chaise(db, "alice", S_JUMELLE);
  const { reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  const ambigue = await posterUneLettre(db, { msg_id: "m-ambigue", sender: "carol", to: "alice#35e98d0b", body: "x" }, deps);
  assert.equal(ambigue.row.recipient, "alice#35e98d0b", "deux candidates : on n'écrit pas aux dés, l'adresse reste telle qu'écrite");
  assert.equal(ambigue.attente.motif, "chaise-ambigue");
  assert.equal(ambigue.attente.candidats, 2);

  const entiere = await posterUneLettre(db, { msg_id: "m-entiere", sender: "carol", to: work.id, body: "x" }, deps);
  assert.equal(entiere.row.recipient, work.id);
  const nue = await posterUneLettre(db, { msg_id: "m-nue", sender: "carol", recipient: "alice", body: "x" }, deps);
  assert.equal(nue.row.recipient, "alice");
  const inconnue = await posterUneLettre(db, { msg_id: "m-inconnue", sender: "carol", to: "carol#deadbeef", body: "x" }, deps);
  assert.equal(inconnue.row.recipient, "carol#deadbeef", "un début que personne ne porte reste tel qu'écrit, comme un nom inconnu");
  assert.equal(inconnue.attente.motif, "destinataire-inconnu");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE event_type = 'chaise_courte_appliquee'").get().n,
    0,
    "aucune forme n'a été réécrite"
  );
});

test("canoniserLaChaiseCourte est pure sur l'entrée : une entrée neuve, l'objet du posteur intact, une seule orthographe", (t) => {
  const db = bureauDePoste(t);
  const row = chaise(db, "alice", S_WORK);
  const entree = { sender: "carol", to: "alice#35e98d0b", body: "x" };
  const canon = canoniserLaChaiseCourte(db, entree);
  assert.deepEqual(entree, { sender: "carol", to: "alice#35e98d0b", body: "x" }, "l'objet du posteur est intact");
  assert.deepEqual(canon.chaiseCourte, { demande: "alice#35e98d0b", chaise: row.id });
  assert.equal(canon.entree.recipient, row.id);
  assert.equal("to" in canon.entree, false, "une seule orthographe reste : la base ne doit pas trancher entre deux (⑦)");
  const rien = canoniserLaChaiseCourte(db, { sender: "carol", recipient: "alice", body: "x" });
  assert.equal(rien.chaiseCourte, null);
  assert.equal(rien.entree.recipient, "alice");
  // C2 : la résolution injectée est celle qu'on écoute — une résolution qui lève n'empêche rien.
  const sourde = canoniserLaChaiseCourte(db, entree, { resoudre: () => { throw new Error("registre en panne"); } });
  assert.equal(sourde.chaiseCourte, null);
  assert.equal(sourde.entree, entree, "sans résolution, l'entrée part telle quelle (la lettre d'abord)");
});

// ── LE REPLI : la chaise relève sa forme courte, elle aussi ────────────────────────────────────
// Après le guichet, une lettre à « alice#35e98d0b » est écrite à l'adresse entière : le repli
// d'avant la relève. Reste la lettre écrite PENDANT une ambiguïté (deux chaises au même début :
// l'adresse est restée courte) : quand une seule chaise reste, elle est à elle — A9, « acked_at
// nul ⇒ la lettre finit toujours par revenir ». Le repli ajoute donc la forme courte de SA session
// (`ficheLisible.chaise`, huit caractères) quand le guichet la ramène à elle, et à elle seule —
// la même garde qu'au « @nom ».
test("le repli relève une lettre écrite à l'adresse entière par la forme courte — sous ses adresses d'avant", async (t) => {
  const db = bureauDePoste(t);
  const row = chaise(db, "alice", S_WORK);
  const { reveiller } = reveilEnregistre();
  await posterUneLettre(db, { msg_id: "m-1", sender: "carol", to: "alice#35e98d0b", body: "x" }, { reveiller, maisons: MAISONS_VIDES() });
  const adresses = adressesDuRepli(db, "alice", { session_id: S_WORK });
  assert.ok(adresses.includes(row.id));
  assert.deepEqual(getPendingForContext(db, adresses).map((r) => r.msg_id), ["m-1"]);
});

test("le repli ajoute la forme courte de MA session quand elle mène à moi seule ; pas quand une jumelle la partage", (t) => {
  const db = bureauDePoste(t);
  chaise(db, "alice", S_WORK);
  const seule = adressesDuRepli(db, "alice", { session_id: S_WORK });
  assert.ok(seule.includes("alice#35e98d0b"), "une adresse qu'aucun repli ne lit est une lettre perdue (A9)");
  // Camp B : les adresses d'avant sont toujours là, dans le même ordre.
  assert.equal(seule[0], "alice");
  assert.ok(seule.includes(instanceId("alice", S_WORK)));

  chaise(db, "alice", S_JUMELLE);
  assert.ok(
    !adressesDuRepli(db, "alice", { session_id: S_WORK }).includes("alice#35e98d0b"),
    "le guichet dit ATTENDS : le repli ne doit pas ouvrir la porte de derrière"
  );
  assert.ok(!adressesDuRepli(db, "alice", { session_id: S_JUMELLE }).includes("alice#35e98d0b"));
});

test("A9 — une lettre écrite pendant l'ambiguïté revient à la chaise qui reste, qui peut l'accuser", async (t) => {
  const db = bureauDePoste(t);
  const work = chaise(db, "alice", S_WORK);
  const jumelle = chaise(db, "alice", S_JUMELLE);
  const { reveiller } = reveilEnregistre();
  const envoi = await posterUneLettre(
    db,
    { msg_id: "m-tenue", sender: "carol", to: "alice#35e98d0b", body: "x" },
    { reveiller, maisons: MAISONS_VIDES() }
  );
  assert.equal(envoi.row.recipient, "alice#35e98d0b");
  assert.equal(envoi.attente.motif, "chaise-ambigue");
  assert.deepEqual(getPendingForContext(db, adressesDuRepli(db, "alice", { session_id: S_WORK })), [], "tenue : personne ne la relève");

  db.prepare("UPDATE peers SET status = 'offline' WHERE id = ?").run(jumelle.id);
  const adresses = adressesDuRepli(db, "alice", { session_id: S_WORK });
  assert.ok(adresses.includes("alice#35e98d0b"), "la jumelle partie, la forme courte mène à moi seule");
  assert.deepEqual(getPendingForContext(db, adresses).map((r) => r.msg_id), ["m-tenue"]);
  // Le guichet mène cette adresse à la chaise qui reste : elle signe (porte 4, `droitDAccuser`).
  ackMessage(db, "m-tenue", work.id);
  assert.ok(getMessageById(db, "m-tenue").acked_at, "la chaise qui reste signe : A9 se referme");
});

// ── L'ENCLOS (round 1 de la revue, Important 1) ────────────────────────────────────────────────
// Un expéditeur sous enclos n'écrit qu'aux membres actifs de sa table fermée, comparés à l'octet
// (`estMembre`). La forme courte se canonise AVANT l'enclos, par la même résolution qui décide ce
// qui s'écrit ; l'enclos accepte si la forme TAPÉE ou la forme CANONISÉE est membre. Rien ne
// s'écrit entre les deux : la canonisation est pure, le journal vient après l'inscription.
function tableFermeeAvecEnclos(db, membres) {
  creerTable(db, { nom: "fermee-test", fermee: true, creeePar: "office-test" });
  for (const adresse of ["carol", ...membres]) ajouterMembre(db, "fermee-test", adresse, { ajoutePar: "office-test" });
  poserEnclos(db, "carol", "fermee-test", { posePar: "office-test" });
}
const compterLesLettres = (db) => db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
const compterLesCanonisations = (db) =>
  db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE event_type = 'chaise_courte_appliquee'").get().n;

test("ENCLOS — la forme courte UNIQUE d'un membre inscrit sous l'adresse entière passe l'enclos, s'écrit à l'adresse entière, et la forme tapée reste au journal", async (t) => {
  const db = bureauDePoste(t);
  const row = chaise(db, "alice", S_WORK);
  tableFermeeAvecEnclos(db, [row.id]);
  const { reveiller } = reveilEnregistre();
  const envoi = await posterUneLettre(
    db,
    { msg_id: "m-enclos", sender: "carol", to: "alice#35e98d0b", body: "x" },
    { reveiller, maisons: MAISONS_VIDES() }
  );
  assert.equal(envoi.row.recipient, row.id, "la lettre va au membre que la forme courte désigne");
  const trace = db.prepare(
    "SELECT detail_json FROM delivery_events WHERE msg_id = 'm-enclos' AND event_type = 'chaise_courte_appliquee'"
  ).all();
  assert.deepEqual(trace.map((e) => JSON.parse(e.detail_json)), [{ demande: "alice#35e98d0b", chaise: row.id }]);
});

test("ENCLOS — une forme courte AMBIGUË ou celle d'un non-membre est refusée sous la forme tapée, sans une ligne écrite", async (t) => {
  const db = bureauDePoste(t);
  const row = chaise(db, "alice", S_WORK);
  chaise(db, "alice", S_JUMELLE);
  chaise(db, "bob", S_AUTRE);
  tableFermeeAvecEnclos(db, [row.id]);
  const { reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };
  for (const [msgId, to] of [["m-ambigue", "alice#35e98d0b"], ["m-bob", "bob#9c1f2a3b"]]) {
    await assert.rejects(
      posterUneLettre(db, { msg_id: msgId, sender: "carol", to, body: "x" }, deps),
      (erreur) => {
        assert.equal(erreur.code, "hors-enclos", to);
        assert.deepEqual(erreur.destinataires_refuses, [to], "le refus nomme ce que l'expéditeur a tapé");
        return true;
      }
    );
  }
  assert.equal(compterLesLettres(db), 0, "l'enclos refuse avant la moindre écriture");
  assert.equal(compterLesCanonisations(db), 0);
});

test("ENCLOS — un membre inscrit sous sa forme COURTE reste joignable par elle, en direct comme par posterAUneTable", async (t) => {
  const db = bureauDePoste(t);
  const row = chaise(db, "alice", S_WORK);
  tableFermeeAvecEnclos(db, ["alice#35e98d0b"]);
  const { reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };
  const direct = await posterUneLettre(db, { msg_id: "m-direct", sender: "carol", to: "alice#35e98d0b", body: "x" }, deps);
  assert.equal(direct.row.recipient, row.id, "la forme tapée est membre : l'enclos passe, la lettre s'écrit à l'adresse entière");
  const envoi = await posterAUneTable(db, { sender: "carol", table: "fermee-test", body: "à la table" }, deps);
  assert.deepEqual(envoi.lettres.map((l) => [l.to, l.row.recipient]), [["alice#35e98d0b", row.id]]);
});

// ── LE REPLI RELÈVE TOUTE FORME COURTE QUI MÈNE À MA CHAISE (round 1, mineur 2) ───────────────
// Une lettre TENUE garde l'adresse telle qu'écrite : en majuscules, ou plus longue que huit
// caractères. Le repli ne lisait que `ficheLisible.chaise` (huit minuscules) : ces lettres ne
// revenaient jamais (A9). Il relève maintenant les adresses en attente `<lignée>#<préfixe>` dont
// le préfixe (huit hexadécimaux au moins, sans casse) commence ma session — et que le guichet
// ramène à moi seule, la même garde qu'au « @nom ».
const S_JUMELLE_LONGUE = "35e98d0b-3f2c-4e02-b3cd-991122334455"; // quatorze caractères communs avec S_WORK

test("A9 — une lettre tenue sous une forme courte en MAJUSCULES ou de douze caractères revient à la chaise qui reste, jamais tant que la jumelle est là", async (t) => {
  const db = bureauDePoste(t);
  const work = chaise(db, "alice", S_WORK);
  const jumelle = chaise(db, "alice", S_JUMELLE_LONGUE);
  const { reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };
  for (const [msgId, to] of [["m-majuscules", "alice#35E98D0B"], ["m-douze", "alice#35e98d0b-3f2"]]) {
    const envoi = await posterUneLettre(db, { msg_id: msgId, sender: "carol", to, body: "x" }, deps);
    assert.equal(envoi.row.recipient, to, `${to} : deux candidates, l'adresse reste telle qu'écrite`);
    assert.equal(envoi.attente.motif, "chaise-ambigue");
  }
  assert.deepEqual(getPendingForContext(db, adressesDuRepli(db, "alice", { session_id: S_WORK })), [], "tenues : personne ne les relève");

  db.prepare("UPDATE peers SET status = 'offline' WHERE id = ?").run(jumelle.id);
  // Le début de la jumelle partie, posté après son départ : personne ne répond, la lettre attend
  // sous sa forme — et elle n'est pas à moi, ce préfixe ne commence pas ma session.
  const etrangere = await posterUneLettre(db, { msg_id: "m-jumelle", sender: "carol", to: "alice#35e98d0b-3f2c-4e", body: "x" }, deps);
  assert.equal(etrangere.attente.motif, "destinataire-inconnu");
  const adresses = adressesDuRepli(db, "alice", { session_id: S_WORK });
  assert.ok(adresses.includes("alice#35E98D0B") && adresses.includes("alice#35e98d0b-3f2"), adresses.join(", "));
  assert.ok(!adresses.includes("alice#35e98d0b-3f2c-4e"), "un préfixe qui ne commence pas ma session n'est pas à moi");
  assert.deepEqual(getPendingForContext(db, adresses).map((r) => r.msg_id), ["m-majuscules", "m-douze"]);
  for (const msgId of ["m-majuscules", "m-douze"]) {
    ackMessage(db, msgId, work.id);
    assert.ok(getMessageById(db, msgId).acked_at, `${msgId} : la chaise qui reste signe`);
  }
  // Une autre lignée ne lit jamais ces adresses, même quand sa session commence pareil.
  chaise(db, "bob", "35e98d0b-aaaa-4000-8000-000000000002");
  assert.ok(!adressesDuRepli(db, "bob", { session_id: "35e98d0b-aaaa-4000-8000-000000000002" }).some((a) => a.startsWith("alice")));
});

test("A9 — une forme courte postée pendant que ma chaise était hors service revient quand elle reprend le service", async (t) => {
  const db = bureauDePoste(t);
  const work = chaise(db, "alice", S_WORK);
  const statut = getInstance(db, work.id).status;
  db.prepare("UPDATE peers SET status = 'offline' WHERE id = ?").run(work.id);
  const { reveiller } = reveilEnregistre();
  const envoi = await posterUneLettre(
    db,
    { msg_id: "m-absente", sender: "carol", to: "alice#35E98D0B-3F2C", body: "x" },
    { reveiller, maisons: MAISONS_VIDES() }
  );
  assert.equal(envoi.row.recipient, "alice#35E98D0B-3F2C");
  assert.equal(envoi.attente.motif, "destinataire-inconnu");
  db.prepare("UPDATE peers SET status = ? WHERE id = ?").run(statut, work.id);
  assert.deepEqual(getPendingForContext(db, adressesDuRepli(db, "alice", { session_id: S_WORK })).map((r) => r.msg_id), ["m-absente"]);
});

// L'avis `chaise-ambigue` dit « that chair's hooks and its MCP inbox collect it » : l'`inbox` MCP
// d'une chaise relève par `adressesDuRepli`, comme ses hooks. On le prouve au vrai guichet (stdio,
// bureau jetable, RIEN que l'outil `inbox` : aucun socket). FORME OBLIGATOIRE de
// test/accuse.test.js : on RÉCOLTE, on FERME, on ASSÈRE APRÈS — sinon l'enfant stdio pend la suite.
const depot = path.resolve(new URL("..", import.meta.url).pathname);
test("A9 — l'inbox MCP de la chaise relève la lettre tenue sous une forme courte en majuscules, comme ses hooks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-chaise-courte-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const maison = path.join(root, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: S_WORK, messagingSocketPath: path.join(maison, "r.sock"), name: "session" }));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "alice", sessionId: S_WORK, house: maison, pid: PID_VIVANT });
  insertMessage(db, { msg_id: "m-mcp", sender: "carol", recipient: "alice#35E98D0B-3F2C", body: "tenue" });
  db.close();

  const client = new Client({ name: "cc2cc-chaise-courte", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(depot, "src/mcp-server/server.js")],
    env: { PATH: process.env.PATH, HOME: root, CC2CC_V2_HOME: root, CC2CC_SELF: "alice", CLAUDE_CONFIG_DIR: maison }
  });
  let recolte;
  try {
    await client.connect(transport);
    recolte = JSON.parse((await client.callTool({ name: "inbox", arguments: {} })).content[0].text);
  } finally {
    await client.close().catch(() => {});
  }
  assert.deepEqual((recolte.messages || []).map((m) => m.msg_id), ["m-mcp"], JSON.stringify(recolte));
});
