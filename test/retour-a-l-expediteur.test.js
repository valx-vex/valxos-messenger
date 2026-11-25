// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// LE RETOUR À L'EXPÉDITEUR (1.1.0, Tâche 3). Le cas réel : un modèle local a écrit deux lettres
// au nom nu d'une lignée qui n'existait que sous un nom long (`alice` quand seule `alice-atelier`
// vivait). Elles ont attendu sans être livrées, et personne ne le savait, pas même l'expéditeur.
// Ces lettres venaient d'un greffon d'un autre harnais qui écrit DIRECTEMENT dans SQLite, sans
// passer par le serveur MCP : le retour se fait donc à la tournée du Facteur, qui lit le bureau.
//
// Ce qu'on prouve ici :
//   · les suggestions (préfixe `<nom>-`, distance d'édition ≤ 2), et aucune quand rien n'approche ;
//   · l'avis du `send` (MCP) les porte, avec la phrase « No one has this name; did you mean … ? » ;
//   · le retour après le délai (horloge injectée), une lettre calme de `facteur` ;
//   · pas de retour pour un nom déjà porté (fiche morte, fiche retirée, réexpédition) ;
//   · la lettre d'origine reste au bureau, marquée, jamais effacée, jamais retournée deux fois ;
//   · le retour vaut aussi pour une lettre insérée en SQL nu (le cas du greffon).
// ⚠️ Bases JETABLES (mkdtemp + poserLeBureau) : le bureau vivant n'ouvre jamais.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { REGLAGES_FACTEUR_PAR_DEFAUT, reglagesDuFacteur, verifierLesReglages } from "../src/lib/config.js";
import {
  getPendingForContext,
  insertMessage,
  openDatabase,
  registerPeer,
  unregisterPeer
} from "../src/lib/database.js";
import {
  attenteDeLaLettre,
  deposerAncienNom,
  nomJamaisPorte,
  reapDeadPeers,
  registerInstance,
  suggestionsPourUnNom
} from "../src/lib/registry.js";
import { faireLaTournee, lettreCalme } from "../src/facteur/round.js";
import { demarrerLeFacteur } from "../src/facteur/daemon.js";
import {
  EVENEMENT_RETOUR,
  EXPEDITEUR_DU_RETOUR,
  lettreDeRetour,
  marqueDuRetour,
  retournerUneLettre
} from "../src/facteur/retour.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const repo = path.resolve(new URL("..", import.meta.url).pathname);

const decors = [];
function racineJetable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-retour-"));
  decors.push(dir);
  return dir;
}
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(racineJetable());
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
  for (const dir of decors) fs.rmSync(dir, { recursive: true, force: true });
});

function bureau(t) {
  const root = racineJetable();
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  db.racine = root;
  t.after(() => {
    try {
      db.close();
    } catch {
      /* base jetable */
    }
  });
  return db;
}

let sessions = 0;
function chaiseVivante(db, lignee) {
  sessions += 1;
  const n = String(sessions).padStart(12, "0");
  return registerInstance(db, { lineage: lignee, sessionId: `aaaa0000-0000-4000-8000-${n}`, house: "/h/carton", pid: process.pid });
}

// L'heure de référence des lettres : leur `created_at`, écrit en clair, et l'horloge injectée
// de la tournée qui part de là. Rien ne dépend de l'heure réelle.
const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const DELAI = REGLAGES_FACTEUR_PAR_DEFAUT.retourApresMs;

// Une tournée sans maison réelle, sans porte Codex, sans pause : seule la décision compte.
function tournee(db, maintenant, extra = {}) {
  const journal = [];
  const bilan = faireLaTournee(db, {
    horloge: () => maintenant,
    tourHouses: () => ({ boxes: [], houses: [] }),
    fichesCodex: () => [],
    dormir: async () => {},
    porteur: "facteur@test#1",
    journal: (ligne) => journal.push(ligne),
    env: {},
    ...extra
  });
  return bilan.then((b) => ({ bilan: b, journal }));
}

function retoursVers(db, destinataire) {
  return db
    .prepare("SELECT * FROM messages WHERE sender = ? AND recipient = ? ORDER BY seq ASC")
    .all(EXPEDITEUR_DU_RETOUR, destinataire);
}

// ── LES SUGGESTIONS ─────────────────────────────────────────────────────────

test("les suggestions : les lignées vivantes qui commencent par « <nom>- », puis celles à deux fautes au plus", (t) => {
  const db = bureau(t);
  chaiseVivante(db, "alice-atelier");
  chaiseVivante(db, "alice-veille");
  chaiseVivante(db, "carol");
  chaiseVivante(db, "bob");
  // Une lignée MORTE n'est pas une suggestion : on n'envoie personne écrire à un mort.
  chaiseVivante(db, "alice-ancienne");
  db.prepare("UPDATE peers SET status = 'dead', dead_at = ? WHERE lineage = ?").run("2026-11-01T00:00:00.000Z", "alice-ancienne");

  assert.deepEqual(suggestionsPourUnNom(db, "alice"), ["alice-atelier", "alice-veille"], "le préfixe suivi d'un tiret");
  assert.deepEqual(suggestionsPourUnNom(db, "carl"), ["carol"], "une faute de frappe (distance 1)");
  assert.deepEqual(suggestionsPourUnNom(db, "karoll"), ["carol"], "deux fautes (distance 2)");
  assert.deepEqual(suggestionsPourUnNom(db, "kxrxl"), [], "trois fautes : plus une suggestion");
  assert.deepEqual(suggestionsPourUnNom(db, "Alice"), ["alice-atelier", "alice-veille"], "la casse ne cache pas le préfixe");
  assert.deepEqual(suggestionsPourUnNom(db, "CAROL"), ["carol"], "ni la distance");
  // Le préfixe d'abord, puis la distance : « bobx » est à une faute de « bob ».
  chaiseVivante(db, "bobx-maison");
  assert.deepEqual(suggestionsPourUnNom(db, "bobx"), ["bobx-maison", "bob"]);
  // Une adresse de chaise se juge par sa lignée.
  assert.deepEqual(suggestionsPourUnNom(db, "alice#0123abcd"), ["alice-atelier", "alice-veille"]);
});

test("aucune suggestion quand rien n'approche, et la liste reste bornée", (t) => {
  const db = bureau(t);
  chaiseVivante(db, "alice-atelier");
  assert.deepEqual(suggestionsPourUnNom(db, "zzz-personne"), []);
  assert.deepEqual(suggestionsPourUnNom(db, ""), []);
  assert.deepEqual(suggestionsPourUnNom(null, "alice"), [], "une suggestion qui casse se tait");
  for (const suffixe of ["a", "b", "c", "d", "e", "f", "g", "h"]) chaiseVivante(db, `dave-${suffixe}`);
  assert.equal(suggestionsPourUnNom(db, "dave").length, 5, "cinq au plus");
});

test("un nom jamais porté : aucune fiche, aucune réexpédition, rien au carnet ; une fiche morte ou retirée l'a porté", (t) => {
  const db = bureau(t);
  chaiseVivante(db, "alice-atelier");
  assert.equal(nomJamaisPorte(db, "alice"), true);
  assert.equal(nomJamaisPorte(db, "alice#0123abcd"), true, "la lignée d'une adresse de chaise");
  assert.equal(nomJamaisPorte(db, "alice-atelier"), false);
  assert.equal(nomJamaisPorte(db, "alice-atelier@atelier"), false, "une adresse humaine d'une lignée connue");

  chaiseVivante(db, "carol");
  reapDeadPeers(db, { isProcessAlive: () => false });
  assert.equal(nomJamaisPorte(db, "carol"), false, "une fiche morte a porté le nom");

  registerPeer(db, { id: "dave", status: "active" });
  unregisterPeer(db, "dave");
  assert.equal(nomJamaisPorte(db, "dave"), false, "une fiche retirée du service aussi");

  deposerAncienNom(db, "erin", "alice-atelier");
  assert.equal(nomJamaisPorte(db, "erin"), false, "un ancien nom réexpédié a une destination");
  deposerAncienNom(db, "frank", "gina");
  assert.equal(nomJamaisPorte(db, "gina"), false, "une lignée annoncée par une réexpédition est attendue");

  db.prepare("INSERT INTO carnet (chaise_id, lineage, mac, vu_at, parti_at) VALUES (?, ?, ?, ?, ?)")
    .run("hank#0000", "hank", "autre-mac", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
  assert.equal(nomJamaisPorte(db, "hank"), false, "une lignée vue sur l'autre Mac, même partie");

  assert.equal(nomJamaisPorte(db, ""), false, "un nom vide ne se juge pas");
  assert.equal(nomJamaisPorte(null, "alice"), false, "un registre illisible ne condamne personne");
});

// ── L'AVIS DU SEND ──────────────────────────────────────────────────────────

// Revue finale 2, point 7 : l'avis ne promet un retour que s'il aura lieu.
test("l'avis ne promet pas de retour quand VALXOS_RETOUR_APRES_S=0, ni pour une lettre au nom système facteur", (t) => {
  const db = bureau(t);
  const avant = process.env.VALXOS_RETOUR_APRES_S;
  t.after(() => {
    if (avant === undefined) delete process.env.VALXOS_RETOUR_APRES_S;
    else process.env.VALXOS_RETOUR_APRES_S = avant;
  });
  delete process.env.VALXOS_RETOUR_APRES_S;
  assert.match(attenteDeLaLettre(db, "zzz-personne").message, /return delay \(15 minutes by default\)/, "par défaut, la promesse reste");
  assert.doesNotMatch(attenteDeLaLettre(db, "facteur").message, /return delay|sends its sender/, "à facteur : aucun retour promis");
  assert.match(attenteDeLaLettre(db, "facteur").message, /no return notice/);
  process.env.VALXOS_RETOUR_APRES_S = "0";
  const eteint = attenteDeLaLettre(db, "zzz-personne");
  assert.equal(eteint.motif, "destinataire-inconnu");
  assert.doesNotMatch(eteint.message, /return delay|sends its sender/, "retours éteints : aucune promesse");
  assert.match(eteint.message, /switched off/);
  assert.match(eteint.message, /still arrives if someone takes this name/, "la lettre reste et arrive quand même");
});

test("l'avis d'un nom jamais porté : les suggestions, et la phrase « No one has this name; did you mean … ? »", (t) => {
  const db = bureau(t);
  chaiseVivante(db, "alice-atelier");
  const avis = attenteDeLaLettre(db, "alice");
  assert.equal(avis.motif, "destinataire-inconnu", "le motif ne change pas : c'est le contrat");
  assert.deepEqual(avis.suggestions, ["alice-atelier"]);
  assert.match(avis.message, /^No one has this name; did you mean alice-atelier\? /);
  assert.match(avis.message, /waits until/, "l'avis dit toujours ce que la lettre attend");
  assert.match(avis.message, /sends its sender a return notice; the letter itself stays/, "et qu'elle reviendra, sans quitter le bureau");

  const deux = attenteDeLaLettre(db, "alice-atelie");
  assert.deepEqual(deux.suggestions, ["alice-atelier"]);
  chaiseVivante(db, "alice-veille");
  assert.match(attenteDeLaLettre(db, "alice").message, /^No one has this name; did you mean alice-atelier or alice-veille\? /);

  const rien = attenteDeLaLettre(db, "zzz-personne");
  assert.deepEqual(rien.suggestions, []);
  assert.match(rien.message, /^No one has this name\. The letter is accepted and waits until /);
});

test("l'avis d'un nom déjà porté ne change pas : ni suggestions, ni retour annoncé", (t) => {
  const db = bureau(t);
  chaiseVivante(db, "carol");
  chaiseVivante(db, "carole");
  db.prepare("UPDATE peers SET status = 'dead', dead_at = ? WHERE lineage = ?").run("2026-11-01T00:00:00.000Z", "carol");
  const avis = attenteDeLaLettre(db, "carol");
  assert.equal(avis.motif, "destinataire-inconnu");
  assert.equal(avis.suggestions, undefined, "pas de champ suggestions pour un nom porté");
  assert.match(avis.message, /^No peer in service answers to this name: /);
  assert.doesNotMatch(avis.message, /return notice/);
});

test("le send MCP porte les suggestions dans son avis — et sent:true reste sent:true", async () => {
  const root = racineJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  chaiseVivante(db, "alice-atelier");
  db.close();
  const client = new Client({ name: "cc2cc-retour-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "bob" }
  });
  await client.connect(transport);
  try {
    const reponse = await client.callTool({ name: "send", arguments: { to: "alice", body: "au nom nu" } });
    const contenu = JSON.parse(reponse.content[0].text);
    assert.equal(contenu.sent, true, "l'avis ne casse JAMAIS la prise en charge (A9)");
    assert.equal(contenu.attente.motif, "destinataire-inconnu");
    assert.deepEqual(contenu.attente.suggestions, ["alice-atelier"]);
    assert.match(contenu.attente.message, /^No one has this name; did you mean alice-atelier\?/);
  } finally {
    await client.close();
  }
});

// ── LE RETOUR ───────────────────────────────────────────────────────────────

test("après le délai, la lettre revient à l'expéditeur : une lettre calme de `facteur`, avec l'objet, la raison et les suggestions", async (t) => {
  const db = bureau(t);
  chaiseVivante(db, "alice-atelier");
  insertMessage(db, {
    msg_id: "L-nu",
    sender: "bob",
    recipient: "alice",
    subject: "the plan for tonight",
    body: "letter to a bare name",
    thread_id: "fil-1",
    created_at: new Date(T0).toISOString()
  });

  const avant = await tournee(db, T0 + DELAI - 1);
  assert.equal(retoursVers(db, "bob").length, 0, "avant le délai, rien ne revient");
  assert.equal(avant.bilan.motifs["retour-a-l-expediteur"], undefined);

  const apres = await tournee(db, T0 + DELAI);
  const [retour, ...autres] = retoursVers(db, "bob");
  assert.ok(retour, "au délai, la lettre revient");
  assert.equal(autres.length, 0);
  assert.equal(retour.sender, "facteur");
  assert.equal(retour.msg_type, "status");
  assert.equal(retour.sans_reveil, 1, "SANS CLOCHE : la lettre calme, que le Facteur ne porte jamais");
  assert.equal(retour.reponse_a, "L-nu", "le retour dit à quelle lettre il répond");
  assert.equal(retour.thread_id, "fil-1", "dans le fil de la lettre d'origine");
  assert.match(retour.subject, /the plan for tonight/, "l'objet d'origine");
  assert.match(retour.body, /L-nu/);
  assert.match(retour.body, /"alice"/);
  assert.match(retour.body, /no one has this name/i, "la raison");
  assert.match(retour.body, /destinataire-inconnu/, "et son code");
  assert.match(retour.body, /alice-atelier/, "les suggestions");
  assert.equal(lettreCalme(db, retour.msg_id), true);
  assert.equal(apres.bilan.motifs["retour-a-l-expediteur"], 1, "le bilan de la tournée le compte");
  const dit = apres.journal.find((l) => l.evenement === "facteur_retour_a_l_expediteur");
  assert.ok(dit, "le journal le dit");
  assert.equal(dit.msg_id, "L-nu");
  assert.equal(dit.retour_msg_id, retour.msg_id);
  assert.equal(dit.subject, undefined, "jamais l'objet au journal");

  // Le canal de repli sert la lettre calme à l'expéditeur au tour suivant.
  const servies = getPendingForContext(db, "bob");
  assert.ok(servies.some((l) => l.msg_id === retour.msg_id), "on la lit au tour suivant");
});

test("le délai se lit dans VALXOS_RETOUR_APRES_S (900 s par défaut), et se refuse au démarrage s'il est absurde", async (t) => {
  assert.equal(REGLAGES_FACTEUR_PAR_DEFAUT.retourApresMs, 900_000);
  assert.equal(reglagesDuFacteur({}).retourApresMs, 900_000);
  assert.equal(reglagesDuFacteur({ VALXOS_RETOUR_APRES_S: "60" }).retourApresMs, 60_000);
  assert.equal(reglagesDuFacteur({ CC2CC_RETOUR_APRES_S: "120" }).retourApresMs, 120_000, "l'alias historique");
  assert.equal(reglagesDuFacteur({ VALXOS_RETOUR_APRES_S: "60", CC2CC_RETOUR_APRES_S: "120" }).retourApresMs, 60_000);
  // 0 éteint les retours (test suivant) ; négatif ou non fini, le démon refuse de partir.
  assert.throws(() => verifierLesReglages({ ...reglagesDuFacteur({}), retourApresMs: -1_000 }), /retourApresMs/);
  assert.throws(() => verifierLesReglages({ ...reglagesDuFacteur({}), retourApresMs: Infinity }), /retourApresMs/);
  assert.throws(() => verifierLesReglages({ ...reglagesDuFacteur({}), retourApresMs: Number.NaN }), /retourApresMs/);

  const db = bureau(t);
  insertMessage(db, { msg_id: "L-court", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0).toISOString() });
  await tournee(db, T0 + 60_000 - 1, { env: { VALXOS_RETOUR_APRES_S: "60" } });
  assert.equal(retoursVers(db, "bob").length, 0);
  await tournee(db, T0 + 60_000, { env: { VALXOS_RETOUR_APRES_S: "60" } });
  assert.equal(retoursVers(db, "bob").length, 1, "le délai de l'environnement gouverne");
  assert.match(retoursVers(db, "bob")[0].body, /No name in service is close to it/, "sans suggestion, le retour le dit");
});

// L'ÂGE RÉEL (vague finale, 21/11). Au premier passage sur un vrai bureau, de vieilles lettres
// (1 à 90 jours) reviennent ; chacune disait « It waited 15 minutes », le délai, pas son âge. Le
// retour dit maintenant l'âge lu dans `created_at`, dans une unité lisible, et « more than » le
// délai quand l'âge ne se lit pas.
test("le retour dit l'âge réel de la lettre, pas le délai ; « more than » le délai quand l'âge ne se lit pas", () => {
  const nee = { msg_id: "M", sender: "S", recipient: "R", subject: null, created_at: new Date(T0).toISOString() };
  const age = (ms) => lettreDeRetour(nee, { apresMs: DELAI, maintenant: T0 + ms }).body.split("\n")[2];
  assert.equal(age(DELAI), "It waited 15 minutes and no one took this name.");
  assert.equal(age(1_000), "It waited 1 second and no one took this name.");
  assert.equal(age(45_500), "It waited 45 seconds and no one took this name.");
  assert.equal(age(90 * 60_000), "It waited 90 minutes and no one took this name.");
  assert.equal(age(5 * 3_600_000 + 59 * 60_000), "It waited 5 hours and no one took this name.");
  assert.equal(age(3 * 86_400_000), "It waited 3 days and no one took this name.");
  assert.equal(age(90 * 86_400_000), "It waited 90 days and no one took this name.");

  for (const illisible of [{ ...nee, created_at: "pas une date" }, { ...nee, created_at: null }]) {
    const { body } = lettreDeRetour(illisible, { apresMs: DELAI, maintenant: T0 + DELAI });
    assert.match(body, /\nIt waited more than 15 minutes and no one took this name\.\n/, "l'âge illisible : plus que le délai");
  }
  const sansHorloge = lettreDeRetour(nee, { apresMs: DELAI });
  assert.match(sansHorloge.body, /It waited more than 15 minutes/, "sans heure de la tournée, l'âge ne se calcule pas");
});

test("la vague du premier passage : de vieilles lettres reviennent une fois chacune, avec leur âge", async (t) => {
  const db = bureau(t);
  // Les heures jusqu'à deux jours, puis les jours : un jour se lit « 24 hours ».
  const ages = [1, 2, 7, 30, 90];
  const dit = { 1: "24 hours", 2: "2 days", 7: "7 days", 30: "30 days", 90: "90 days" };
  for (const jours of ages) {
    insertMessage(db, {
      msg_id: `L-vieille-${jours}`,
      sender: "bob",
      recipient: "zzz-personne",
      body: "x",
      created_at: new Date(T0 - jours * 86_400_000).toISOString()
    });
  }
  const { bilan } = await tournee(db, T0);
  assert.equal(bilan.motifs["retour-a-l-expediteur"], ages.length, "toutes reviennent au premier passage");
  const retours = retoursVers(db, "bob");
  for (const jours of ages) {
    const retour = retours.find((l) => l.reponse_a === `L-vieille-${jours}`);
    assert.ok(retour, `la lettre de ${jours} jour(s) revient`);
    assert.ok(retour.body.includes(`\nIt waited ${dit[jours]} and no one took this name.\n`), `l'âge de ${jours} jour(s) : ${dit[jours]}`);
    assert.equal(retour.sans_reveil, 1, "au calme");
  }
  await tournee(db, T0 + DELAI);
  assert.equal(retoursVers(db, "bob").length, ages.length, "une fois chacune");
});

// VALXOS_RETOUR_APRES_S=0 (vague finale, 21/11) : il arrêtait le Facteur au démarrage (« must be
// strictly positive »). Arbitrage : 0 veut dire « retours éteints » — aucun balayage, le Facteur
// part et porte le reste du courrier. Une valeur négative ou non finie reste refusée.
test("VALXOS_RETOUR_APRES_S=0 éteint les retours : le Facteur part, et aucun balayage ne tourne", async (t) => {
  assert.equal(reglagesDuFacteur({ VALXOS_RETOUR_APRES_S: "0" }).retourApresMs, 0);
  assert.doesNotThrow(() => verifierLesReglages({ ...reglagesDuFacteur({}), retourApresMs: 0 }), "0 n'arrête plus le Facteur");
  assert.throws(() => verifierLesReglages(reglagesDuFacteur({ VALXOS_RETOUR_APRES_S: "-1" })), /retourApresMs/, "négatif : refusé");

  const db = bureau(t);
  insertMessage(db, { msg_id: "L-eteint", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0).toISOString() });
  const memoireDuRetour = {};
  const { bilan } = await tournee(db, T0 + 100 * DELAI, { env: { VALXOS_RETOUR_APRES_S: "0" }, memoireDuRetour });
  assert.equal(retoursVers(db, "bob").length, 0, "rien ne revient");
  assert.equal(bilan.motifs["retour-a-l-expediteur"], undefined);
  assert.equal(memoireDuRetour.dernierBalayageMs, undefined, "aucun balayage n'a tourné");

  // Le démon part avec 0 : le réglage se vérifie au démarrage, et il passe.
  const { parti } = await demarrerLeFacteur({
    db,
    verrou: path.join(racineJetable(), "facteur.verrou"),
    tours: 1,
    journal: () => {},
    attendre: async () => {},
    reglages: { retourApresMs: 0 },
    faireLaTournee: async () => ({ prises: 0, remises: 0, ajournees: 0, motifs: {} })
  });
  assert.equal(parti, true, "le Facteur démarre avec les retours éteints");
});

test("pas de retour pour un nom déjà porté : fiche morte, fiche retirée, réexpédition", async (t) => {
  const db = bureau(t);
  chaiseVivante(db, "carol");
  reapDeadPeers(db, { isProcessAlive: () => false });
  registerPeer(db, { id: "dave", status: "active" });
  unregisterPeer(db, "dave");
  deposerAncienNom(db, "frank", "gina");
  for (const destinataire of ["carol", "dave", "frank", "gina"]) {
    insertMessage(db, { msg_id: `L-${destinataire}`, sender: "bob", recipient: destinataire, body: "x", created_at: new Date(T0).toISOString() });
  }
  const { bilan } = await tournee(db, T0 + 10 * DELAI);
  assert.equal(retoursVers(db, "bob").length, 0, "le régime d'un nom porté ne change pas");
  assert.equal(bilan.motifs["retour-a-l-expediteur"], undefined);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM delivery_events WHERE event_type = ?").get(EVENEMENT_RETOUR).n,
    0
  );
});

test("la lettre d'origine reste au bureau, marquée retournée, jamais effacée, jamais retournée deux fois", async (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L-orig", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0).toISOString() });
  assert.equal(marqueDuRetour(db, "L-orig"), null, "pas de marque avant le retour");
  const totalAvant = db.prepare("SELECT count(*) AS n FROM messages").get().n;

  await tournee(db, T0 + DELAI);
  const original = db.prepare("SELECT * FROM messages WHERE msg_id = ?").get("L-orig");
  assert.ok(original, "la lettre d'origine est toujours là");
  assert.equal(original.acked_at, null, "et elle attend toujours : si quelqu'un prend ce nom, elle arrive");
  assert.equal(original.recipient, "zzz-personne");
  const [retour] = retoursVers(db, "bob");
  const marque = marqueDuRetour(db, "L-orig");
  assert.ok(marque, "la lettre d'origine est marquée");
  assert.equal(marque.retour_msg_id, retour.msg_id);
  assert.equal(marque.a, "bob");
  assert.ok(marque.at, "la marque est datée");

  await tournee(db, T0 + 2 * DELAI);
  await tournee(db, T0 + 50 * DELAI);
  assert.equal(retoursVers(db, "bob").length, 1, "un retour par lettre, pas un par tournée");
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages").get().n, totalAvant + 1, "rien n'est effacé, rien n'est doublé");
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM delivery_events WHERE msg_id = ? AND event_type = ?").get("L-orig", EVENEMENT_RETOUR).n,
    1
  );

  // Le retour lui-même ne revient jamais : son destinataire (bob) n'a jamais eu de fiche, mais
  // une lettre de `facteur` n'a pas d'expéditeur à qui revenir.
  assert.equal(marqueDuRetour(db, retour.msg_id), null);
  assert.equal(retoursVers(db, "facteur").length, 0);
});

// LE COÛT DU BALAYAGE (vague finale, 21/11). Mesuré : 7,3 ms par tournée à la tête, chaque
// seconde, pour un délai de quinze minutes. Le démon balaie maintenant au plus une fois par
// minute : sa mémoire (`memoireDuRetour`) traverse les tournées, et l'horloge injectée la
// gouverne. Une horloge qui RECULE balaie (sans quoi un saut d'une heure en arrière tairait les
// retours une heure). Sans mémoire (le one-shot `--une-tournee`), chaque tournée balaie.
const UNE_MINUTE = 60_000;

test("avec la mémoire du démon, le balayage tourne au plus une fois par minute ; une horloge qui recule balaie", async (t) => {
  const db = bureau(t);
  const memoireDuRetour = {};
  insertMessage(db, { msg_id: "L-1", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0).toISOString() });
  insertMessage(db, { msg_id: "L-2", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0 + 1_000).toISOString() });
  const retournees = () => retoursVers(db, "bob").map((l) => l.reponse_a).sort();

  const S = T0 + DELAI;
  await tournee(db, S, { memoireDuRetour });
  assert.deepEqual(retournees(), ["L-1"], "le premier balayage : L-1 seule est due");
  await tournee(db, S + 30_000, { memoireDuRetour });
  assert.deepEqual(retournees(), ["L-1"], "trente secondes plus tard, L-2 est due mais le balayage attend");
  await tournee(db, S + UNE_MINUTE - 1, { memoireDuRetour });
  assert.deepEqual(retournees(), ["L-1"], "une minute moins une milliseconde : toujours pas");
  await tournee(db, S + UNE_MINUTE, { memoireDuRetour });
  assert.deepEqual(retournees(), ["L-1", "L-2"], "une minute après le dernier balayage, il repasse");

  insertMessage(db, { msg_id: "L-3", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0 - DELAI).toISOString() });
  await tournee(db, S + 10_000, { memoireDuRetour });
  assert.deepEqual(retournees(), ["L-1", "L-2", "L-3"], "l'horloge a reculé : le balayage passe, il ne se tait pas");
});

test("le démon garde la mémoire du balayage d'une tournée à l'autre", async (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L-d1", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0).toISOString() });
  insertMessage(db, { msg_id: "L-d2", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0 + 500).toISOString() });
  let tic = T0 + DELAI - 1_000;
  const lignes = [];
  const { parti, tours } = await demarrerLeFacteur({
    db,
    verrou: path.join(racineJetable(), "facteur.verrou"),
    tours: 3,
    journal: (l) => lignes.push(l),
    attendre: async () => {},
    depsDeTournee: {
      // Chaque tournée lit l'heure une seconde plus tard : T0+DELAI, +1 s, +2 s.
      horloge: () => tic,
      tourHouses: () => ({ boxes: [], houses: [] }),
      fichesCodex: () => [],
      dormir: async () => {},
      porteur: "facteur@test#1",
      env: {}
    },
    faireLaTournee: async (bureauDuDemon, deps) => {
      tic += 1_000;
      return faireLaTournee(bureauDuDemon, deps);
    }
  });
  assert.equal(parti, true);
  assert.equal(tours, 3);
  assert.deepEqual(
    retoursVers(db, "bob").map((l) => l.reponse_a),
    ["L-d1"],
    "L-d2 est due dès la deuxième tournée, mais le démon a balayé il y a moins d'une minute"
  );
});

test("l'index de la marque : delivery_events(msg_id, event_type), sans montée de schéma", (t) => {
  const db = bureau(t);
  const index = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_delivery_events_msg_type'")
    .get();
  assert.ok(index, "l'index existe");
  assert.match(index.sql, /ON delivery_events\(msg_id, event_type\)/);
  assert.equal(db.pragma("user_version", { simple: true }), 8, "le schéma reste à 8");
  const plan = db
    .prepare("EXPLAIN QUERY PLAN SELECT 1 FROM delivery_events e WHERE e.msg_id = ? AND e.event_type = ?")
    .all("M", EVENEMENT_RETOUR)
    .map((ligne) => ligne.detail)
    .join("\n");
  assert.match(plan, /idx_delivery_events_msg_type/, `la garde du balayage lit l'index : ${plan}`);
  // Idempotent : un bureau rouvert (la migration repasse) garde un seul index et le schéma 8.
  const fichier = db.name;
  db.close();
  const relu = openDatabase({ file: fichier });
  t.after(() => relu.close());
  assert.equal(
    relu.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_delivery_events_msg_type'").get().n,
    1
  );
  assert.equal(relu.pragma("user_version", { simple: true }), 8);
});

// LA RÉPONSE AU RETOUR (vague finale, 21/11, reproduit) : `facteur` n'est le nom de personne, donc
// une réponse à un retour était une lettre vers un nom jamais porté — elle rebondissait chez son
// expéditeur, une fois. Le balayage écarte maintenant toute lettre ADRESSÉE à `facteur`, et le
// retour dit en dernière ligne qu'il n'attend pas de réponse.
test("une réponse au retour (une lettre à `facteur`) ne revient pas, et le retour dit qu'il n'attend pas de réponse", async (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L-avant-reponse", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0).toISOString() });
  await tournee(db, T0 + DELAI);
  const [retour] = retoursVers(db, "bob");
  assert.ok(retour, "le retour est parti");
  assert.match(retour.body, /\nAutomatic notice; no need to reply\.$/, "la dernière ligne du retour");

  insertMessage(db, {
    msg_id: "L-reponse-au-facteur",
    sender: "bob",
    recipient: EXPEDITEUR_DU_RETOUR,
    body: "thanks, I fixed the address",
    reponse_a: retour.msg_id,
    created_at: new Date(T0 + DELAI).toISOString()
  });
  const { bilan } = await tournee(db, T0 + 10 * DELAI);
  assert.equal(retoursVers(db, "bob").length, 1, "la réponse à `facteur` ne rebondit pas");
  assert.equal(marqueDuRetour(db, "L-reponse-au-facteur"), null, "elle n'est pas marquée retournée");
  assert.equal(bilan.motifs["retour-a-l-expediteur"], undefined);
  assert.ok(db.prepare("SELECT 1 FROM messages WHERE msg_id = ?").get("L-reponse-au-facteur"), "et elle reste au bureau (rien n'est effacé)");
});

test("deux porteurs qui ont lu la même lettre se départagent sous le verrou d'écriture : un seul retour", (t) => {
  const db = bureau(t);
  const lue = insertMessage(db, { msg_id: "L-course", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0).toISOString() });
  // Les deux ont lu la ligne AVANT tout retour : c'est la marque relue dans la transaction qui tranche.
  const premier = retournerUneLettre(db, lue, { apresMs: DELAI, porteur: "facteur@a#1", maintenant: T0 + DELAI });
  const second = retournerUneLettre(db, lue, { apresMs: DELAI, porteur: "facteur@b#2", maintenant: T0 + DELAI });
  assert.ok(premier, "le premier retourne");
  assert.equal(second, null, "le second trouve la marque");
  assert.equal(retoursVers(db, "bob").length, 1);
});

// LA RELECTURE SOUS LE VERROU (vague finale, 21/11) : entre la lecture du balayage et la
// transaction, quelqu'un peut relever, porter ou accuser la lettre. La transaction relit ces
// quatre colonnes avec la marque, et une lettre prise entre-temps ne revient pas.
test("une lettre relevée, portée ou accusée entre la lecture et la transaction ne revient pas", (t) => {
  const db = bureau(t);
  for (const colonne of ["carried_at", "delivered_at", "injected_at", "acked_at"]) {
    const msgId = `L-prise-${colonne}`;
    const lue = insertMessage(db, { msg_id: msgId, sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0).toISOString() });
    // La ligne a été lue AVANT : c'est la relecture sous le verrou qui doit voir la prise.
    db.prepare(`UPDATE messages SET ${colonne} = ? WHERE msg_id = ?`).run(new Date(T0 + 1000).toISOString(), msgId);
    const retour = retournerUneLettre(db, lue, { apresMs: DELAI, porteur: "facteur@test#1", maintenant: T0 + DELAI });
    assert.equal(retour, null, `${colonne} posé entre-temps : pas de retour`);
    assert.equal(marqueDuRetour(db, msgId), null, `${colonne} : pas de marque`);
  }
  assert.equal(retoursVers(db, "bob").length, 0);
});

test("le retour vaut pour une lettre insérée en SQL nu, comme le fait le greffon d'un autre harnais", async (t) => {
  const db = bureau(t);
  chaiseVivante(db, "alice-atelier");
  // La forme exacte du greffon : il n'écrit ni drapeau, ni échéance — les défauts de la base.
  db.prepare(`
    INSERT INTO messages (msg_id, sender, recipient, thread_id, subject, body, priority, msg_type, created_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'autre-harnais')
  `).run("msg-greffon-1", "local-model", "alice", null, "hello", "from outside the MCP server", "normal", "message", new Date(T0).toISOString());
  db.prepare("INSERT INTO delivery_events (msg_id, agent_id, event_type, detail_json) VALUES (?, ?, 'created', ?)")
    .run("msg-greffon-1", "alice", JSON.stringify({ sender: "local-model" }));

  await tournee(db, T0 + DELAI);
  const [retour] = retoursVers(db, "local-model");
  assert.ok(retour, "la tournée lit le bureau : toutes les sources en profitent");
  assert.equal(retour.reponse_a, "msg-greffon-1");
  assert.match(retour.body, /alice-atelier/);
  assert.ok(marqueDuRetour(db, "msg-greffon-1"));
});

test("le retour ne dépend pas de la sélection de la tournée : une lettre ajournée ou calme revient aussi", async (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L-calme", sender: "bob", recipient: "zzz-personne", body: "x", sans_reveil: true, created_at: new Date(T0).toISOString() });
  insertMessage(db, { msg_id: "L-ajournee", sender: "bob", recipient: "yyy-personne", body: "x", created_at: new Date(T0).toISOString() });
  db.prepare("UPDATE messages SET facteur_not_before_ms = ? WHERE msg_id = ?").run(T0 + 100 * DELAI, "L-ajournee");
  const { bilan } = await tournee(db, T0 + DELAI);
  assert.equal(bilan.prises, 0, "la tournée n'a pris aucune des deux");
  assert.deepEqual(retoursVers(db, "bob").map((l) => l.reponse_a).sort(), ["L-ajournee", "L-calme"]);
});

test("une lettre déjà relevée par quelqu'un, ou accusée, ne revient pas", async (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L-lue", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0).toISOString() });
  insertMessage(db, { msg_id: "L-accusee", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0).toISOString() });
  db.prepare("UPDATE messages SET delivered_at = ? WHERE msg_id = ?").run(new Date(T0 + 1000).toISOString(), "L-lue");
  db.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = ?").run(new Date(T0 + 1000).toISOString(), "L-accusee");
  await tournee(db, T0 + DELAI);
  assert.equal(retoursVers(db, "bob").length, 0, "quelqu'un la lit : elle n'est pas perdue");
});

test("le mode une-lettre ne retourne rien : il ne porte que la lettre demandée", async (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L-filtre", sender: "bob", recipient: "zzz-personne", body: "x", created_at: new Date(T0).toISOString() });
  await tournee(db, T0 + DELAI, { seulementLaLettre: "L-filtre" });
  assert.equal(retoursVers(db, "bob").length, 0);
});

// ── LES GARDES DE PUBLICATION ───────────────────────────────────────────────

test("la lettre de retour est en anglais, et ne porte que les noms de la lettre", () => {
  assert.equal(EXPEDITEUR_DU_RETOUR, "facteur");
  const avec = lettreDeRetour(
    { msg_id: "M", sender: "S", recipient: "R", subject: "SUBJ" },
    { suggestions: ["X", "Y"], apresMs: 900_000 }
  );
  const sans = lettreDeRetour({ msg_id: "M", sender: "S", recipient: "R", subject: null }, { suggestions: [], apresMs: 90_000 });
  for (const { subject, body } of [avec, sans]) {
    const texte = `${subject}\n${body}`;
    assert.match(texte, /^[\x20-\x7e\n—]*$/, "de l'anglais en ASCII (et le tiret long de la signature)");
    // Le code du motif est un CONTRAT (`attente.motif`), pas de la prose : il reste tel quel.
    const prose = texte.replaceAll("destinataire-inconnu", "");
    assert.doesNotMatch(prose, /\b(lettre|retourn\w*|personne|nom|destinataire|expediteur|courrier)\b/i, "aucun mot français");
    // Les seuls mots propres sont ceux qu'on a donnés (et le nom du produit).
    const motsPropres = texte.match(/\b[A-Z][A-Z]+\b/g) || [];
    assert.deepEqual([...new Set(motsPropres)].filter((m) => !["M", "R", "S", "X", "Y", "SUBJ"].includes(m)), []);
  }
  assert.match(avec.subject, /^Returned to sender: SUBJ$/);
  assert.match(avec.body, /did you mean X or Y\?/);
  assert.match(avec.body, /15 minutes/);
  assert.match(sans.subject, /^Returned to sender: your letter to R$/);
  assert.match(sans.body, /No name in service is close to it/);
  assert.match(sans.body, /90 seconds/);
});

// ── UNE MAISON QUI DORT N'EST PAS UN NOM « JAMAIS PORTÉ » (Tâche 9) ─────────

test("une maison qui s'inscrit, écrit, puis se désinscrit (sa fiche disparaît) : une lettre vers elle n'est jamais retournée, et arrive à son retour", async (t) => {
  const db = bureau(t);
  chaiseVivante(db, "alice-maison");
  insertMessage(db, { msg_id: "L-sortante", sender: "alice-maison", recipient: "bob", body: "hello", created_at: new Date(T0).toISOString() });
  // La maison ferme : son harnais supprime sa ligne (rien de « retiré » ni de « mort »).
  db.prepare("DELETE FROM peers").run();
  assert.equal(db.prepare("SELECT count(*) AS n FROM peers").get().n, 0);
  assert.equal(nomJamaisPorte(db, "alice-maison"), false, "expéditeur d'une lettre : le nom a été porté");
  assert.equal(nomJamaisPorte(db, "alice-maison#0123abcd"), false, "la racine d'une adresse de chaise");

  insertMessage(db, { msg_id: "L-vers-la-maison", sender: "bob", recipient: "alice-maison", body: "wake up", created_at: new Date(T0).toISOString() });
  const { bilan } = await tournee(db, T0 + 10 * DELAI);
  assert.equal(retoursVers(db, "bob").length, 0, "aucun avis faux chez l'expéditeur");
  assert.equal(bilan.motifs["retour-a-l-expediteur"], undefined);

  chaiseVivante(db, "alice-maison");
  const servies = getPendingForContext(db, "alice-maison");
  assert.ok(servies.some((l) => l.msg_id === "L-vers-la-maison"), "elle arrive au réveil de la maison");
});

test("une chaise de livraison a porté le nom, même sans lettre envoyée ni fiche", (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L-x", sender: "bob", recipient: "carol-maison", body: "x", created_at: new Date(T0).toISOString() });
  db.prepare("INSERT INTO delivery_events (msg_id, agent_id, event_type) VALUES (?, ?, ?)").run("L-x", "carol-maison#abcd0001", "delivered");
  assert.equal(nomJamaisPorte(db, "carol-maison"), false, "la racine de la chaise d'une livraison");
  assert.equal(nomJamaisPorte(db, "carol-maison#abcd0001"), false);
  assert.equal(nomJamaisPorte(db, "carol-maisons"), true, "un nom voisin n'a pas été porté");
});

test("une faute de frappe jamais vue (alcie) revient toujours, même quand d'autres noms ont écrit", async (t) => {
  const db = bureau(t);
  insertMessage(db, { msg_id: "L-a", sender: "alice", recipient: "bob", body: "x", created_at: new Date(T0).toISOString() });
  insertMessage(db, { msg_id: "L-typo", sender: "bob", recipient: "alcie", body: "x", created_at: new Date(T0).toISOString() });
  assert.equal(nomJamaisPorte(db, "alcie"), true);
  await tournee(db, T0 + 10 * DELAI);
  assert.equal(retoursVers(db, "bob").length, 1, "la faute de frappe est retournée");
});
