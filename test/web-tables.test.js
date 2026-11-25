// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA PORTE WEB ET LES TABLES (1.1.0, Tâche 7).
//
// Envoyer à `table:<nom>` passe par le MÊME guichet que le serveur MCP et `valxos-send`
// (`posterAUneTable`) : une lettre par membre hors de l'opérateur, liées par un `envoi_id`, et la
// réponse montre les membres sous la forme partagée (`lettreDeTableRendue`). Ce que le guichet
// refuse (l'enclos, une table inconnue, un expéditeur qui n'en est pas membre, un nom hors forme)
// se rend en JSON et n'écrit rien ; un envoi qui casse en chemin dit ce qui est parti. La garde
// n°2 vaut pour une table : la clef d'un tiers, dérivée par membre, est écartée par le guichet
// (F12), et la porte refuse de RENDRE une ligne qui n'est pas au courrier de l'opérateur. Le fil
// et le flux portent la table, sa position courante, le nom de la chaise qui a posté et le
// rappel ; la page dessine une ligne de table sous l'en-tête du pli — la même que les hooks, à
// l'octet — et rien d'autre.
//
// Même doctrine que test/web-front.test.js : aucune forme d'API écrite à la main. Chaque forme vient
// d'une VRAIE requête à une VRAIE porte sur un VRAI bureau jetable.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir aide-porte.js (remède de la
// revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-tables-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { getMessageById, insertMessage } from "../src/lib/database.js";
import { registerInstance } from "../src/lib/registry.js";
import { ajouterMembre, creerTable, modifierTable, poserEnclos, retirerMembre } from "../src/lib/tables.js";
import { deposerAUneTablePourLOperateur, refusDuGuichet } from "../src/web/serveur.js";
import { MOI, bureauJetable, cookieDePremiereVisite, fluxSSE, porteDeTest, requete } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";
import { ligneDeTable } from "../src/lib/format.js";
// LA PAGE ELLE-MÊME : un module, qui ne touche au DOM que devant un écran (test/web-front.test.js).
import { dessinerPli, ligneDeTableDuPli, normaliserLettre } from "../src/web/public/app.js";

// L'état local d'un pli qui vient d'arriver du bureau (test/web-front.test.js).
const PLI_SAIN = { nonPartie: false, refus: null, rejouable: true, accuseEnvoye: false };

// L'échappement HTML de la page (app.js, `echapper`), pour lire le pli tel qu'il est écrit.
const enHtml = (texte) =>
  texte.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const racine = path.resolve(new URL("..", import.meta.url).pathname);

// LE DÉCOR DES TABLES : une table OUVERTE `famille-test` dont l'opérateur est membre avec alice et
// bob, et une table OUVERTE `film-test` (mode direct, une position) sans lui. Les chaises d'alice et
// de bob sont au registre : alice a un nom humain (« atelier »), bob n'en a pas. Les maisons sont de
// carton — aucune socket ne répond, les lettres attendent, et c'est sans importance ici.
function decorDesTables(db) {
  registerInstance(db, { lineage: "alice", sessionId: "s-alice", house: "/maison/carton", pid: 4242, sessionName: "atelier" });
  registerInstance(db, { lineage: "bob", sessionId: "s-bob", house: "/maison/carton", pid: 4243 });
  creerTable(db, { nom: "famille-test", creeePar: "office-test" });
  for (const adresse of [MOI, "alice", "bob"]) ajouterMembre(db, "famille-test", adresse, { ajoutePar: "office-test" });
  creerTable(db, { nom: "film-test", mode: "direct", creeePar: "office-test" });
  for (const adresse of ["alice", "bob"]) ajouterMembre(db, "film-test", adresse, { ajoutePar: "office-test" });
  modifierTable(db, "film-test", { position: "seen up to 1:25:00", positionPar: "alice" });
}

// Une porte de test, ouverte et déverrouillée comme le navigateur la trouve, sur le décor.
async function porteSurLesTables(t, options = {}) {
  const db = bureauJetable(t);
  decorDesTables(db);
  const { base } = await porteDeTest(t, { db, ...options });
  const { cookie } = await cookieDePremiereVisite(base);
  const poster = (corps) => requete(base, "/api/poster", { methode: "POST", cookie, corps });
  return { db, base, cookie, poster };
}

function compterLesLettres(db) {
  return db.prepare("SELECT count(*) AS n FROM messages").get().n;
}

// Ce que la porte écrit sur stderr pendant un appel, sans l'imprimer dans le rapport du test (la
// porte de test tourne dans ce processus : test/web-jeton-merge.test.js fait de même).
async function avecStderrCapte(appel) {
  const ecrire = process.stderr.write;
  let sortie = "";
  process.stderr.write = (bloc, ...reste) => {
    sortie += String(bloc);
    const rappel = reste.find((r) => typeof r === "function");
    if (rappel) rappel();
    return true;
  };
  try {
    return { valeur: await appel(), sortie };
  } finally {
    process.stderr.write = ecrire;
  }
}

// ── L'ENVOI À UNE TABLE ─────────────────────────────────────────────────────

test("POSTER à table:<nom> : une lettre par membre hors de l'opérateur, liées par un envoi_id — et la réponse montre les membres", async (t) => {
  const { db, poster } = await porteSurLesTables(t);

  const reponse = await poster({ a: "table:famille-test", objet: "Beat 1", corps: "the first beat", msg_id: "m-table-1" });

  assert.equal(reponse.statut, 200, reponse.texte);
  assert.equal(reponse.json.count, 2, "deux membres hors de l'opérateur : alice et bob");
  assert.equal(reponse.json.destinataire, "table:famille-test");
  assert.match(reponse.json.envoi_id, /^envoi-/);
  assert.deepEqual(
    reponse.json.table,
    { nom: "famille-test", mode: "normal", reveil: "reveil", fermee: false, position: null },
    "la table est l'objet du guichet, comme au MCP et à valxos-send"
  );
  assert.deepEqual(reponse.json.results.map((r) => r.to).sort(), ["alice", "bob"], "la réponse montre les membres");
  for (const resultat of reponse.json.results) {
    assert.ok(resultat.seq > 0);
    assert.ok("wake" in resultat, "le réveil rendu par le guichet voyage jusqu'au client, membre par membre");
    assert.equal(typeof resultat.sans_reveil, "boolean");
    assert.equal(typeof resultat.motif_reveil, "string");
    assert.equal(resultat.envoi_id, undefined, "une lettre de CET envoi ne répète pas l'envoi_id de tête (lettreDeTableRendue)");
  }
  assert.equal(reponse.json.msg_id, undefined, "un envoi n'a pas UNE clef : il en a une par membre, dans results");
  assert.deepEqual(
    reponse.json.results.map((r) => r.msg_id).sort(),
    ["m-table-1#alice", "m-table-1#bob"],
    "la clef du client se dérive par membre (idempotence par membre, guichet)"
  );

  // LA PREUVE EST EN BASE : deux lignes signées de l'opérateur, aucune pour lui.
  const lignes = db.prepare("SELECT * FROM messages ORDER BY seq").all();
  assert.equal(lignes.length, 2);
  assert.deepEqual(lignes.map((l) => l.recipient).sort(), ["alice", "bob"], "l'opérateur, membre, ne reçoit pas sa propre lettre");
  for (const ligne of lignes) {
    assert.equal(ligne.sender, MOI, "la porte signe l'opérateur configuré, TOUJOURS");
    assert.equal(ligne.table_nom, "famille-test");
    assert.equal(ligne.envoi_id, reponse.json.envoi_id);
    assert.equal(ligne.subject, "Beat 1");
    assert.equal(ligne.body, "the first beat");
    assert.equal(ligne.sender_chaise, null, "un humain sans chaise");
  }

  // LE REJEU : la même clef renvoyée ne crée pas une troisième lettre (R2, par membre), et chaque
  // lettre rejouée le dit, sous la forme partagée.
  const rejeu = await poster({ a: "table:famille-test", corps: "the first beat", msg_id: "m-table-1" });
  assert.equal(rejeu.statut, 200, rejeu.texte);
  assert.equal(compterLesLettres(db), 2, "le rejeu rend LES lettres, jamais deux de plus");
  for (const resultat of rejeu.json.results) {
    assert.equal(resultat.motif_reveil, "rejeu");
    assert.equal(resultat.rejeu.motif, "msg_id-deja-connu");
    assert.equal(resultat.envoi_id, reponse.json.envoi_id, "une lettre rejouée appartient à l'envoi qui l'a fait naître");
  }

  // LE PRÉFIXE SE LIT SANS CASSE, comme au guichet (`nomDeTableDe`) : `TABLE:Famille-Test` est la table.
  const casse = await poster({ a: "TABLE:Famille-Test", corps: "loud prefix" });
  assert.equal(casse.statut, 200, casse.texte);
  assert.equal(casse.json.destinataire, "table:famille-test", "le nom normalisé du carnet, jamais l'écriture du client");
  assert.equal(compterLesLettres(db), 4);
});

// ── LES REFUS DU GUICHET ────────────────────────────────────────────────────
// Ce que le guichet refuse d'écrire n'est pas une panne de la porte : un code (`refus`), un motif
// anglais, le bon statut — et la base n'a pas bougé.
test("POSTER à une table : table inconnue (404), opérateur non membre (403), nom hors forme (400) — motivés, et rien n'est écrit", async (t) => {
  const { db, poster } = await porteSurLesTables(t);

  const inconnue = await poster({ a: "table:nulle-part", corps: "to nobody" });
  assert.equal(inconnue.statut, 404, inconnue.texte);
  assert.equal(inconnue.json.refus, "table-inconnue");
  assert.equal(inconnue.json.table, "nulle-part", "le nom normalisé par le guichet");

  // `film-test` existe, alice et bob en sont ; l'opérateur, non.
  const pasMembre = await poster({ a: "table:film-test", corps: "not mine to post" });
  assert.equal(pasMembre.statut, 403, pasMembre.texte);
  assert.equal(pasMembre.json.refus, "pas-membre");
  assert.equal(pasMembre.json.table, "film-test");

  const horsForme = await poster({ a: "table:Not A Name!", corps: "no such form" });
  assert.equal(horsForme.statut, 400, horsForme.texte);
  assert.equal(horsForme.json.refus, "nom-de-table-invalide");
  assert.equal(horsForme.json.table, "Not A Name!", "l'écho de l'entrée, borné");
  assert.match(horsForme.json.motif, /is not a table name: 1 to 32 characters/, "la règle se dit par la phrase du carnet, jamais une copie");

  // Un préfixe sans nom n'est pas un pair nommé « table: » : c'est un nom de table vide.
  const vide = await poster({ a: "table:", corps: "no name at all" });
  assert.equal(vide.statut, 400, vide.texte);
  assert.equal(vide.json.refus, "nom-de-table-invalide");

  for (const refus of [inconnue, pasMembre, horsForme, vide]) {
    assert.ok(typeof refus.json.motif === "string" && refus.json.motif.length > 0, "un refus se MOTIVE");
    assert.doesNotMatch(refus.json.motif, /[éèêàç]/, "en anglais, comme tout ce que la porte dit");
    assert.notEqual(refus.json.refus, "panne-de-la-porte", "un refus du produit n'est pas une panne de la porte");
    assert.equal(refus.entetes["x-porte-verdict"], "route", "un refus du guichet est une réponse de la route, pas une panne");
  }
  assert.equal(compterLesLettres(db), 0, "aucun refus n'a laissé de lettre derrière lui");
});

// ── L'ENVOI QUI CASSE EN CHEMIN ─────────────────────────────────────────────
// Une panne au milieu d'un envoi de table (ici, la base qui refuse la lettre de bob) laisse derrière
// elle les lettres déjà parties. La porte le dit sous la forme du guichet (`interruptionDEnvoi`) :
// 500 parce que l'envoi n'a pas abouti, mais JAMAIS « panne, rien d'écrit » — un renvoi sans clef
// doublerait alice. Et comme pour `servirLaPanne`, le message de la base reste côté serveur : le
// client lit un code (`cause`) et une phrase fixe, stderr reçoit l'erreur entière.
test("POSTER à une table : une panne au milieu de l'envoi rend 500 envoi-interrompu avec les lettres déjà écrites — jamais « rien d'écrit »", async (t) => {
  const { db, poster } = await porteSurLesTables(t);
  // Les membres partent dans l'ordre du carnet (alice, puis bob) : la base refuse la seconde, avec
  // un message qui porte un détail interne et un chemin.
  db.exec(
    "CREATE TRIGGER panne_pour_bob BEFORE INSERT ON messages WHEN NEW.recipient = 'bob' " +
      "BEGIN SELECT RAISE(ABORT, 'INTERNAL-DB-DETAIL /var/db/office.sqlite'); END;"
  );

  const { valeur: reponse, sortie } = await avecStderrCapte(() => poster({ a: "table:famille-test", corps: "half a send" }));
  assert.equal(reponse.statut, 500, reponse.texte);
  for (const trace of ["INTERNAL-DB-DETAIL", "/var/db/office.sqlite"]) {
    assert.ok(!reponse.texte.includes(trace), `le message de la base atteint le client par « ${trace} » (${reponse.texte})`);
  }
  assert.match(sortie, /^web door: .*INTERNAL-DB-DETAIL/m, "l'erreur entière part sur stderr, comme une panne de la porte");
  assert.equal(reponse.entetes["x-porte-verdict"], "route", "la route répond elle-même : ce n'est pas `panne-de-la-porte`");
  assert.equal(reponse.json.refus, "envoi-interrompu");
  assert.equal(reponse.json.cause, "SQLITE_CONSTRAINT_TRIGGER", "le code brut d'origine part dans `cause`, jamais dans `refus`");
  assert.equal(reponse.json.interrompu, true);
  assert.equal(reponse.json.table, "famille-test");
  assert.equal(reponse.json.adresse, "bob", "le membre où l'envoi a cassé");
  assert.match(reponse.json.envoi_id, /^envoi-/);
  assert.equal(
    reponse.json.motif,
    "the send stopped partway: the letters in lettres_ecrites were written, the others were not",
    "une phrase fixe : le motif ne recopie rien de la panne d'origine"
  );

  const ecrites = db.prepare("SELECT * FROM messages ORDER BY seq").all();
  assert.deepEqual(ecrites.map((l) => l.recipient), ["alice"], "SONDE : la lettre d'alice est bien partie avant la panne");
  assert.deepEqual(
    reponse.json.lettres_ecrites.map((l) => [l.to, l.msg_id]),
    [["alice", ecrites[0].msg_id]],
    "la réponse nomme EXACTEMENT ce qui est parti, sous la forme partagée"
  );
  assert.equal(ecrites[0].envoi_id, reponse.json.envoi_id);
});

// LA QUESTION DE LA PORTE, AVANT DE RENDRE (garde n°2). Le guichet ne rend aujourd'hui que des
// lignes au courrier de l'opérateur (F12, ses formes = son nom) ; la porte ne le croit pas sur
// parole. Un guichet qui rendrait la ligne d'autrui — simulé ici, il ne sait pas le faire — ne la
// fait pas sortir : l'envoi se dit interrompu, avec les seules lettres qui sont à l'opérateur.
test("GARDE N°2 À LA SORTIE : une ligne d'envoi qui n'est pas au courrier de l'opérateur n'est jamais rendue — l'envoi se dit interrompu", async (t) => {
  const db = bureauJetable(t);
  const ligne = (msg_id, sender, recipient, body) => ({ msg_id, seq: 1, sender, recipient, body, envoi_id: "envoi-simule" });
  const sienne = { to: "alice", row: ligne("m-a-moi#alice", MOI, "alice", "mine"), wake: null, attente: null, sans_reveil: false, motif_reveil: "table" };
  const dAutrui = { to: "bob", row: ligne("m-a-moi#bob", "carol", "bob", "SECRET-CAROL-VERS-BOB"), wake: null, attente: null, sans_reveil: false, motif_reveil: "table" };
  const guichetMenteur = async () => ({
    table: { nom: "famille-test", mode: "normal", reveil: "reveil", fermee: false, position: null },
    envoi_id: "envoi-simule",
    count: 2,
    lettres: [sienne, dAutrui]
  });

  let erreur = null;
  try {
    await deposerAUneTablePourLOperateur(db, MOI, { sender: MOI, table: "famille-test", body: "x" }, "m-a-moi", { poster: guichetMenteur });
  } catch (e) {
    erreur = e;
  }
  assert.ok(erreur, "la porte ne rend pas un envoi qui porte la ligne d'autrui");
  assert.equal(erreur.code, "clef_indisponible");
  const refus = refusDuGuichet(erreur);
  assert.equal(refus.statut, 500);
  assert.equal(refus.corps.refus, "envoi-interrompu");
  assert.equal(refus.corps.cause, "clef_indisponible");
  assert.equal(refus.corps.adresse, "bob");
  assert.deepEqual(refus.corps.lettres_ecrites.map((l) => l.msg_id), ["m-a-moi#alice"], "les seules lettres qui sont à lui");
  const brut = JSON.stringify(refus.corps);
  for (const trace of ["SECRET-CAROL-VERS-BOB", "carol", "m-a-moi#bob"]) {
    assert.ok(!brut.includes(trace), `la ligne d'autrui fuit par « ${trace} » (${brut})`);
  }

  // LE SILENCE DES CAS SAINS : un envoi tout à lui passe tel quel.
  const sain = await deposerAUneTablePourLOperateur(db, MOI, { sender: MOI, table: "famille-test", body: "x" }, "", {
    poster: async () => ({ ...(await guichetMenteur()), count: 1, lettres: [sienne] })
  });
  assert.deepEqual(sain.lettres, [sienne]);
});

// LE REFUS DE L'ENCLOS PORTE TOUT CE QUE LE GUICHET A COMPTÉ : au-delà de vingt refusés, la liste
// s'arrête et `autres` compte le reste (`verifierEnclos`). Le taire ferait lire « deux refusés » là
// où il y en a vingt-trois.
test("refusDuGuichet : hors-enclos rend 403 avec enclos, destinataires_refuses et autres — autres absent quand le guichet n'en compte pas", () => {
  const avecAutres = refusDuGuichet({ code: "hors-enclos", enclos: "office-test", destinataires_refuses: ["bob", "carol"], autres: 3 });
  assert.equal(avecAutres.statut, 403);
  assert.equal(avecAutres.corps.refus, "hors-enclos");
  assert.equal(avecAutres.corps.enclos, "office-test");
  assert.deepEqual(avecAutres.corps.destinataires_refuses, ["bob", "carol"]);
  assert.equal(avecAutres.corps.autres, 3);
  const sansAutres = refusDuGuichet({ code: "hors-enclos", enclos: "office-test", destinataires_refuses: ["bob"] });
  assert.equal("autres" in sansAutres.corps, false, "le silence des cas sains");
  assert.equal(refusDuGuichet(new Error("anything else")), null, "ce que la porte ne connaît pas remonte en panne");
  // S9 : deux enclos qui tiennent l'opérateur dans deux tables — 403, les tables nommées.
  const conflit = refusDuGuichet({ code: "enclos-conflit", tables: ["one", "two"], enclos_poses: [{ expediteur: "alice", table: "one" }] });
  assert.equal(conflit.statut, 403);
  assert.deepEqual([conflit.corps.refus, conflit.corps.tables, conflit.corps.enclos_poses], ["enclos-conflit", ["one", "two"], [{ expediteur: "alice", table: "one" }]]);
  assert.match(conflit.corps.motif, /more than one table/);
});

// ── L'ENCLOS ────────────────────────────────────────────────────────────────
// L'opérateur enclos dans une table FERMÉE (`office-test` : lui et alice) ne poste que vers ses
// membres. Le refus précède toute écriture, il est ENTIER pour un envoi à une table, et la clef
// reste dans sa main : `hors_enclos: true`. L'enclos se pose par le geste humain (CLI) ; ici, par
// la bibliothèque — la porte n'administre pas les tables dans cette version.
test("L'ENCLOS : 403 hors-enclos vers un non-membre, sur une lettre comme sur une table, sans une ligne écrite — et hors_enclos: true laisse sortir", async (t) => {
  const { db, poster } = await porteSurLesTables(t);
  creerTable(db, { nom: "office-test", fermee: true, creeePar: "office-test" });
  for (const adresse of [MOI, "alice"]) ajouterMembre(db, "office-test", adresse, { ajoutePar: "office-test" });
  poserEnclos(db, MOI, "office-test", { posePar: "office-test" });

  // ① Une lettre à bob, qui n'est pas de la table fermée : refusée avant toute écriture.
  const aBob = await poster({ a: "bob", corps: "outside the fence" });
  assert.equal(aBob.statut, 403, aBob.texte);
  assert.equal(aBob.json.refus, "hors-enclos");
  assert.equal(aBob.json.enclos, "office-test");
  assert.deepEqual(aBob.json.destinataires_refuses, ["bob"]);
  assert.doesNotMatch(aBob.json.motif, /[éèêàç]/);
  assert.equal(compterLesLettres(db), 0, "un envoi refusé n'écrit rien");

  // ② Un envoi à la table ouverte famille-test : bob en est, le refus est ENTIER — alice n'a pas
  //    reçu la sienne non plus (spec A §4 : « le guichet refuse tout l'envoi »).
  const aLaFamille = await poster({ a: "table:famille-test", corps: "to the whole family" });
  assert.equal(aLaFamille.statut, 403, aLaFamille.texte);
  assert.equal(aLaFamille.json.refus, "hors-enclos");
  assert.equal(aLaFamille.json.enclos, "office-test");
  assert.deepEqual(aLaFamille.json.destinataires_refuses, ["bob"]);
  assert.equal(aLaFamille.json.table, "famille-test");
  assert.equal(aLaFamille.json.lettres_ecrites, undefined, "rien n'est parti : pas d'envoi interrompu à raconter");
  const enCapitales = await poster({ a: "TABLE:Famille-Test", corps: "loud" });
  assert.equal(enCapitales.statut, 403, enCapitales.texte);
  assert.equal(enCapitales.json.table, "famille-test", "le nom normalisé, comme table-inconnue, pas-membre et la réponse 200");
  assert.equal(compterLesLettres(db), 0, "le refus est entier : aucune lettre, même pour alice");

  // ③ Vers alice, membre de la table fermée : la lettre part.
  const aAlice = await poster({ a: "alice", corps: "inside the fence" });
  assert.equal(aAlice.statut, 200, aAlice.texte);
  assert.equal(getMessageById(db, aAlice.json.msg_id).recipient, "alice");

  // ④ `hors_enclos: true` est la clef dans la main de l'opérateur — un booléen STRICT : la chaîne
  //    « true » n'ouvre rien, comme aucune valeur qu'un formulaire aurait pu glisser.
  const sortie = await poster({ a: "bob", corps: "outside, on purpose", hors_enclos: true });
  assert.equal(sortie.statut, 200, sortie.texte);
  assert.equal(getMessageById(db, sortie.json.msg_id).recipient, "bob");
  for (const fausseClef of ["true", 1]) {
    const refusee = await poster({ a: "bob", corps: "not a key", hors_enclos: fausseClef });
    assert.equal(refusee.statut, 403, `${JSON.stringify(fausseClef)} n'est pas la clef`);
  }
  assert.equal(compterLesLettres(db), 2, "alice, puis bob hors enclos : deux lettres, pas une de plus");

  // ⑤ La même clef vaut pour un envoi à une table : la famille entière, d'un geste.
  const famille = await poster({ a: "table:famille-test", corps: "the family, on purpose", hors_enclos: true });
  assert.equal(famille.statut, 200, famille.texte);
  assert.deepEqual(famille.json.results.map((r) => r.to).sort(), ["alice", "bob"]);
  assert.equal(compterLesLettres(db), 4);
});

// ── LA CLEF D'UN TIERS, DÉRIVÉE PAR MEMBRE (garde n°2 pour une table) ───────
// Le guichet dérive la clef par membre (`<clef>#<adresse>`) et rend LA LIGNE EXISTANTE quand elle
// est prise (R2). Une dérivée qui désigne le courrier d'un tiers ferait donc sonner chez lui et
// jetterait la lettre de l'opérateur pour ce membre-là — le trou que test/web-poster-mon-
// courrier.test.js ferme pour une lettre, multiplié par les membres. La loi des trois portes vit au
// guichet (F12, `posterSousUneClefASoi` par lettre) : la dérivée prise est écartée POUR CE MEMBRE,
// sa lettre part sous une clef générée, `clef_ecartee` le dit sur elle ; les autres membres gardent
// la leur. Ce test tient la porte à cette loi, sur une vraie requête.
const SECRET = "SECRET-BOB-VERS-ALICE";

test("POSTER à une table : une dérivée de clef tenue par le courrier d'un tiers est ÉCARTÉE pour ce membre — chaque membre a sa lettre, le tiers reste intact", async (t) => {
  const { db, poster } = await porteSurLesTables(t);
  // Le courrier des tiers, sous la clef que le guichet dériverait pour alice.
  const tiers = insertMessage(db, { msg_id: "m-prise#alice", sender: "bob", recipient: "alice", subject: "entre eux", body: SECRET });

  const reponse = await poster({ a: "table:famille-test", corps: "MA-LETTRE-A-MOI", msg_id: "m-prise" });
  assert.equal(reponse.statut, 200, reponse.texte);

  // ① PAS UN MOT du courrier des tiers dans la réponse BRUTE — une fuite se cache toujours dans
  //    le champ auquel personne n'a pensé. La seule trace de sa clef est la dérivée que
  //    l'opérateur a lui-même demandée, rendue comme ÉCARTÉE (le bit d'existence documenté).
  for (const trace of [SECRET, "entre eux"]) {
    assert.ok(!reponse.texte.includes(trace), `la porte laisse fuir « ${trace} » — c'est le courrier des autres (${reponse.texte})`);
  }
  const parMembre = new Map(reponse.json.results.map((r) => [r.to, r]));
  assert.notEqual(parMembre.get("alice").msg_id, "m-prise#alice", "la lettre d'autrui n'est pas rendue comme la sienne");
  assert.notEqual(parMembre.get("alice").seq, tiers.seq);
  assert.equal(reponse.texte.split("m-prise#alice").length - 1, 1, "une seule mention : la clef écartée, jamais la ligne");

  // ② LA LETTRE DE L'OPÉRATEUR EST AU BUREAU POUR CHAQUE MEMBRE, sous des clefs à lui (A8 : un
  //    doublon vaut mieux qu'une lettre perdue — ici, aucune n'est perdue).
  const siennes = db.prepare("SELECT * FROM messages WHERE sender = ? AND body = ? ORDER BY recipient").all(MOI, "MA-LETTRE-A-MOI");
  assert.deepEqual(siennes.map((l) => l.recipient), ["alice", "bob"], "une lettre par membre, aucune perdue");
  assert.ok(!siennes[0].msg_id.startsWith("m-prise"), "alice : une clef générée, ni la clef écartée ni une dérivée");
  assert.equal(siennes[1].msg_id, "m-prise#bob", "bob : sa dérivée était libre, elle est honorée");
  assert.deepEqual(reponse.json.results.map((r) => r.msg_id).sort(), siennes.map((l) => l.msg_id).sort(), "la réponse nomme les clefs sous lesquelles les lettres sont VRAIMENT parties");
  // ③ IL LE SAIT, membre par membre.
  assert.deepEqual(parMembre.get("alice").clef_ecartee, { demandee: "m-prise#alice", motif: "clef-deja-prise" });
  assert.equal(parMembre.get("bob").clef_ecartee, undefined);
  assert.equal(reponse.json.clef_ecartee, undefined, "un envoi n'a pas UNE clef : l'écart se dit sur la lettre");
  // ④ LE TIERS N'A PAS BOUGÉ D'UN OCTET, et personne n'a travaillé dessus.
  const apres = getMessageById(db, "m-prise#alice");
  assert.equal(apres.body, tiers.body, "Camp B : la lettre des tiers n'a pas bougé");
  assert.equal(apres.sender, "bob");
  assert.equal(apres.injected_at, null);
  assert.equal(apres.delivered_at, null);
  assert.deepEqual(
    db.prepare("SELECT event_type FROM delivery_events WHERE msg_id = ? ORDER BY rowid").all("m-prise#alice").map((e) => e.event_type),
    ["created"],
    "aucun reçu de plus au journal : la porte n'a pas travaillé sur le courrier d'un autre"
  );

  // LE SILENCE DES CAS SAINS : sa propre clef est honorée, dérivée par membre, rien d'écarté.
  const saine = await poster({ a: "table:famille-test", corps: "mine", msg_id: "m-a-moi" });
  assert.equal(saine.statut, 200, saine.texte);
  assert.deepEqual(saine.json.results.map((r) => r.msg_id).sort(), ["m-a-moi#alice", "m-a-moi#bob"]);
  assert.ok(saine.json.results.every((r) => r.clef_ecartee === undefined), "rien d'écarté : la clef était la sienne");
});

// ── LE FIL ──────────────────────────────────────────────────────────────────
// `enrichirPourAffichage` (Tâche 4) est la seule source : la table (colonne `table_nom`), le mode et
// la position COURANTS de la table, le nom humain de la chaise qui a posté (`sender_chaise` →
// `session_name`), le rappel (`reservices`). Rien ne s'invente : une lettre nue porte des nuls. La
// position d'une table FERMÉE ne se montre qu'à un membre, et l'opérateur est le lecteur.
test("LA RELÈVE : une lettre de table porte sa table, le mode et la position de la table, le nom de la chaise, le rappel — une lettre nue porte des nuls", async (t) => {
  const db = bureauJetable(t);
  decorDesTables(db);
  // Deux tables FERMÉES : l'opérateur est de `bureau-test`, pas de `coulisse-test`.
  creerTable(db, { nom: "bureau-test", fermee: true, creeePar: "office-test" });
  for (const adresse of [MOI, "alice"]) ajouterMembre(db, "bureau-test", adresse, { ajoutePar: "office-test" });
  modifierTable(db, "bureau-test", { position: "item 3 of 5", positionPar: "alice" });
  creerTable(db, { nom: "coulisse-test", fermee: true, creeePar: "office-test" });
  for (const adresse of ["alice", "bob"]) ajouterMembre(db, "coulisse-test", adresse, { ajoutePar: "office-test" });
  modifierTable(db, "coulisse-test", { position: "BACKSTAGE-ONLY", positionPar: "alice" });

  insertMessage(db, {
    msg_id: "m-de-table",
    sender: "alice",
    sender_chaise: "alice#s-alice",
    recipient: MOI,
    subject: "Beat 7",
    thread_id: "envoi-1",
    body: "the beat",
    msg_type: "task",
    table_nom: "film-test",
    envoi_id: "envoi-1"
  });
  insertMessage(db, { msg_id: "m-nue", sender: "bob", recipient: MOI, body: "no table", msg_type: "task" });
  insertMessage(db, { msg_id: "m-du-bureau", sender: "alice", recipient: MOI, body: "closed, mine", msg_type: "task", table_nom: "bureau-test", reponse_a: "m-nue" });
  // Une lettre de `coulisse-test`, dont l'opérateur n'est pas (ou plus) membre : il la relit, sans la position.
  insertMessage(db, { msg_id: "m-de-coulisse", sender: "alice", recipient: MOI, body: "closed, not mine", msg_type: "task", table_nom: "coulisse-test" });
  // Le courrier des AUTRES membres d'une table dont il est : jamais au fil.
  insertMessage(db, { msg_id: "m-alice-bob", sender: "alice", recipient: "bob", body: "BETWEEN-ALICE-AND-BOB", msg_type: "task", table_nom: "famille-test", envoi_id: "envoi-9" });
  insertMessage(db, { msg_id: "m-sans-copie", sender: "alice", recipient: "bob", body: "NO-COPY-FOR-ANYONE", msg_type: "task", table_nom: "bureau-test", sans_copie: 1 });
  assert.equal(getMessageById(db, "m-de-table").table_nom, "film-test", "SONDE IMPOSSIBLE : insertMessage n'écrit pas table_nom (Tâche 2)");
  db.prepare("UPDATE messages SET reservices = 2 WHERE msg_id = 'm-nue'").run();
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const fil = await requete(base, "/api/fil", { cookie });
  assert.equal(fil.statut, 200, fil.texte);
  const par = new Map(fil.json.lettres.map((l) => [l.msg_id, l]));
  const deTable = par.get("m-de-table");
  assert.equal(deTable.table, "film-test");
  assert.equal(deTable.table_mode, "direct");
  assert.equal(deTable.position, "seen up to 1:25:00", "une table OUVERTE montre sa position à tout lecteur");
  assert.equal(deTable.chaise_nom, "atelier", "le nom humain de la chaise qui a posté, lu au registre");
  assert.equal(deTable.rappel, 0);
  assert.equal(deTable.envoi_id, "envoi-1");
  assert.equal(deTable.reponse_a, null);
  // Les colonnes d'avant n'ont pas bougé : la relève a marqué, l'état rendu est celui d'après.
  assert.equal(deTable.de, "alice");
  assert.equal(deTable.etat, "reçue");

  const nue = par.get("m-nue");
  assert.equal(nue.table, null);
  assert.equal(nue.table_mode, null);
  assert.equal(nue.position, null);
  assert.equal(nue.chaise_nom, null, "une lettre sans chaise ne donne aucun nom");
  assert.equal(nue.rappel, 2, "deux re-services font rappel 2 (la Tâche 8 incrémente, la porte lit)");
  assert.equal(nue.envoi_id, null);

  const duBureau = par.get("m-du-bureau");
  assert.equal(duBureau.position, "item 3 of 5", "une table FERMÉE dont l'opérateur est membre : il lit sa position");
  assert.equal(duBureau.reponse_a, "m-nue");
  const deCoulisse = par.get("m-de-coulisse");
  assert.equal(deCoulisse.table, "coulisse-test", "la lettre garde sa table");
  assert.equal(deCoulisse.table_mode, "normal");
  assert.equal(deCoulisse.position, null, "une table FERMÉE dont il n'est pas : sa position ne se montre pas");
  assert.ok(!fil.texte.includes("BACKSTAGE-ONLY"));

  // GARDE N°2 : une table n'ouvre pas le courrier de ses autres membres, copie ou pas.
  for (const trace of ["m-alice-bob", "BETWEEN-ALICE-AND-BOB", "m-sans-copie", "NO-COPY-FOR-ANYONE"]) {
    assert.ok(!fil.texte.includes(trace), `le fil porte « ${trace} » — c'est le courrier des autres membres`);
  }
});

// ── LE FLUX ─────────────────────────────────────────────────────────────────
// La même vue que le fil (`vueDeLaLettre`), donc la même table. Et la POSITION bouge pendant la
// séance (le porteur avance le film) : une page ouverte doit la voir sans recharger. La signature
// que le flux compare porte donc l'en-tête de table (mode et position), à côté de l'état et du cri —
// l'état de la lettre, lui, ne bouge pas.
test("SSE : une lettre de table tombe avec sa table et sa position ; la position qui change repasse en `etat` sans que l'état bouge", async (t) => {
  const db = bureauJetable(t);
  decorDesTables(db);
  const { base } = await porteDeTest(t, { db, periodeMs: 20 });
  const { cookie } = await cookieDePremiereVisite(base);
  const flux = fluxSSE(base, { cookie });
  await flux.pret;
  t.after(() => flux.fermer());
  await flux.attendre((e) => e.type === "pairs");

  // Le courrier des autres membres d'abord, copie ou pas : il ne doit JAMAIS tomber dans ce flux.
  insertMessage(db, { msg_id: "m-flux-autrui", sender: "alice", recipient: "bob", body: "OTHERS-ONLY", msg_type: "task", table_nom: "famille-test" });
  insertMessage(db, { msg_id: "m-flux-sans-copie", sender: "alice", recipient: "bob", body: "NO-COPY-IN-STREAM", msg_type: "task", table_nom: "famille-test", sans_copie: 1 });
  insertMessage(db, {
    msg_id: "m-flux-table",
    sender: "alice",
    sender_chaise: "alice#s-alice",
    recipient: MOI,
    body: "beat",
    msg_type: "task",
    table_nom: "film-test",
    envoi_id: "envoi-2"
  });
  const tombee = await flux.attendre((e) => e.type === "lettre" && e.donnees.msg_id === "m-flux-table");
  assert.equal(tombee.donnees.table, "film-test");
  assert.equal(tombee.donnees.table_mode, "direct");
  assert.equal(tombee.donnees.position, "seen up to 1:25:00");
  assert.equal(tombee.donnees.chaise_nom, "atelier");
  assert.equal(tombee.donnees.envoi_id, "envoi-2");
  assert.equal(tombee.donnees.rappel, 0);

  // La position avance : un `etat` repart, l'état de la lettre n'a pas bougé. Le texte non fiable
  // voyage tel quel, dans le JSON — c'est la page qui l'échappe.
  modifierTable(db, "film-test", { position: "seen up to 1:40:00 <b>", positionPar: "alice" });
  const avancee = await flux.attendre(
    (e) => e.type === "etat" && e.donnees.msg_id === "m-flux-table" && e.donnees.position === "seen up to 1:40:00 <b>"
  );
  assert.equal(avancee.donnees.etat, tombee.donnees.etat, "l'état de la lettre n'a pas bougé : seule la position a changé");
  assert.equal(avancee.donnees.table, "film-test");

  // Le mode aussi est dans la ligne de table : il repasse de même.
  modifierTable(db, "film-test", { mode: "normal" });
  await flux.attendre((e) => e.type === "etat" && e.donnees.msg_id === "m-flux-table" && e.donnees.table_mode === "normal");

  assert.ok(
    flux.evenements.every((e) => !["m-flux-autrui", "OTHERS-ONLY", "m-flux-sans-copie", "NO-COPY-IN-STREAM"].some((trace) => e.brut.includes(trace))),
    "le flux ne porte que le courrier de l'opérateur, jamais celui des autres membres d'une table"
  );
});

// ── LE LECTEUR, C'EST L'OPÉRATEUR ───────────────────────────────────────────
// La position d'une table FERMÉE ne se montre qu'à un membre, et le membre qui compte est celui qui
// LIT (`enrichirPourAffichage(…, { lecteur: [operateur] })`), pas le destinataire de la ligne. Sur
// une lettre reçue, les deux se confondent ; sur une lettre ENVOYÉE, le destinataire est un membre
// et l'opérateur ne l'est peut-être plus. Retiré, il relit sa lettre sans la position d'aujourd'hui
// — ni au fil, ni au flux, ni quand elle change.
test("LE LECTEUR : retiré d'une table fermée, l'opérateur relit sa propre lettre sans la position — au fil comme au flux", async (t) => {
  const db = bureauJetable(t);
  decorDesTables(db);
  creerTable(db, { nom: "huis-clos-test", fermee: true, creeePar: "office-test" });
  for (const adresse of [MOI, "alice"]) ajouterMembre(db, "huis-clos-test", adresse, { ajoutePar: "office-test" });
  modifierTable(db, "huis-clos-test", { position: "SECRET-POSITION", positionPar: "alice" });
  const { base } = await porteDeTest(t, { db, periodeMs: 20 });
  const { cookie } = await cookieDePremiereVisite(base);
  const poster = (corps) => requete(base, "/api/poster", { methode: "POST", cookie, corps });
  const flux = fluxSSE(base, { cookie });
  await flux.pret;
  t.after(() => flux.fermer());
  await flux.attendre((e) => e.type === "pairs");

  // Membre, il poste à la table fermée : sa lettre va à alice, et il en lit la position.
  const envoi = await poster({ a: "table:huis-clos-test", corps: "inside the closed room", msg_id: "m-huis-clos" });
  assert.equal(envoi.statut, 200, envoi.texte);
  assert.deepEqual(envoi.json.results.map((r) => r.to), ["alice"]);
  const tombee = await flux.attendre((e) => e.type === "lettre" && e.donnees.msg_id === "m-huis-clos#alice");
  assert.equal(tombee.donnees.de, MOI, "SONDE : c'est SA lettre, envoyée");
  assert.equal(tombee.donnees.position, "SECRET-POSITION", "membre, il lit la position");

  // Retiré : la position se cache, au flux (un `etat`) comme au fil.
  retirerMembre(db, "huis-clos-test", MOI, { retirePar: "office-test" });
  const cachee = await flux.attendre((e) => e.type === "etat" && e.donnees.msg_id === "m-huis-clos#alice" && e.donnees.position === null);
  assert.equal(cachee.donnees.table, "huis-clos-test", "la lettre garde sa table");
  const fil = await requete(base, "/api/fil", { cookie });
  const sienne = fil.json.lettres.find((l) => l.msg_id === "m-huis-clos#alice");
  assert.equal(sienne.position, null, "le lecteur est l'opérateur, pas alice qui en est encore");
  assert.ok(!fil.texte.includes("SECRET-POSITION"), "la position ne fuit par aucun champ du fil");

  // La position change après son départ : le flux n'en dit rien (pas même qu'elle a changé). Une
  // lettre neuve sert de borne : le tour qui la porte a vu le changement, qui le précède.
  modifierTable(db, "huis-clos-test", { position: "SECRET-POSITION-2", positionPar: "alice" });
  insertMessage(db, { msg_id: "m-borne", sender: "bob", recipient: MOI, body: "barrier", msg_type: "task" });
  await flux.attendre((e) => e.type === "lettre" && e.donnees.msg_id === "m-borne");
  const apresDepart = flux.evenements.slice(flux.evenements.indexOf(cachee) + 1);
  assert.ok(
    apresDepart.every((e) => !e.brut.includes("SECRET-POSITION") && !(e.type === "etat" && e.donnees.msg_id === "m-huis-clos#alice")),
    `le flux parle d'une table dont il n'est plus (${JSON.stringify(apresDepart.map((e) => e.type))})`
  );
});

// ── LA PAGE ─────────────────────────────────────────────────────────────────
// UNE SEULE FORME POUR LA LIGNE : celle de `ligneDeTable` (format.js), que les hooks et
// `valxos-inbox` écrivent — la position bornée à 120 points de code et citée comme un littéral JSON.
// La page ne peut pas l'importer (elle vit dans un navigateur) : elle la REPRODUIT, et ce test tient
// les deux côte à côte pour qu'elles ne divergent jamais en silence.
test("LA PAGE : la lettre normalisée garde la table, le mode et la position ; la ligne du pli est celle des hooks, à l'octet ; une lettre nue n'en porte pas", async (t) => {
  const db = bureauJetable(t);
  decorDesTables(db);
  insertMessage(db, {
    msg_id: "m-page-table",
    sender: "alice",
    sender_chaise: "alice#s-alice",
    recipient: MOI,
    body: "beat",
    msg_type: "task",
    table_nom: "film-test",
    envoi_id: "envoi-3"
  });
  insertMessage(db, { msg_id: "m-page-nue", sender: "bob", recipient: MOI, body: "no table", msg_type: "task" });
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  const fil = await requete(base, "/api/fil", { cookie });
  const brute = fil.json.lettres.find((l) => l.msg_id === "m-page-table");
  const nue = fil.json.lettres.find((l) => l.msg_id === "m-page-nue");
  assert.equal(brute.table, "film-test", "SONDE IMPOSSIBLE : l'API ne rend pas la table");

  const l = normaliserLettre(brute);
  assert.equal(l.table, "film-test", "la forme du front JETAIT la table : tout le chantier s'arrêtait à la porte");
  assert.equal(l.table_mode, "direct");
  assert.equal(l.position, "seen up to 1:25:00");

  const attendue = ligneDeTable({ nom: "film-test", mode: "direct", position: "seen up to 1:25:00" });
  assert.equal(attendue, 'Table: film-test (direct) · position: "seen up to 1:25:00"', "SONDE : la forme de format.js (Tâche 4)");
  assert.equal(ligneDeTableDuPli(l), attendue, "la ligne de la page est celle des hooks, à l'octet");
  const longue = `${"é".repeat(118)}🎬🎬🎬 and more`;
  for (const position of [null, undefined, "", "   ", "line one\nline two\t  three", 'a "quoted" \\ word', longue, " padded "]) {
    assert.equal(
      ligneDeTableDuPli({ ...l, position }),
      ligneDeTable({ nom: "film-test", mode: "direct", position }),
      `même ligne pour la position ${JSON.stringify(position)}`
    );
  }
  assert.equal(ligneDeTableDuPli(normaliserLettre(nue)), "", "sans table, pas de ligne");
  // Une table que le carnet ne connaît pas (pas de mode) : les hooks ne posent pas de ligne, la page non plus.
  assert.equal(ligneDeTableDuPli({ ...l, table_mode: null }), "");

  // SUR LE PLI : une ligne sous l'en-tête, et rien d'autre.
  const html = dessinerPli(l, PLI_SAIN);
  assert.ok(html.includes(`<p class="pli__table">${enHtml(attendue)}</p>`), `la ligne de table, mot pour mot, sur le pli (${html})`);
  assert.equal(html.split("pli__table").length - 1, 1, "une ligne, pas deux");
  assert.ok(html.indexOf("pli__tete") < html.indexOf("pli__table") && html.indexOf("pli__table") < html.indexOf("pli__corps"), "sous l'en-tête, avant le corps");
  assert.doesNotMatch(html, /atelier/, "rien d'autre : le nom de chaise n'est pas sur le pli dans cette version");
  assert.doesNotMatch(dessinerPli(normaliserLettre(nue), PLI_SAIN), /pli__table/, "une lettre nue n'a pas de ligne de table");

  // LA POSITION EST DU TEXTE NON FIABLE (spec A §7) : elle s'échappe comme le corps.
  const piegee = dessinerPli({ ...l, position: '<b>bold</b><img src=x onerror="alert(1)">' }, PLI_SAIN);
  assert.ok(piegee.includes("&lt;b&gt;bold&lt;/b&gt;&lt;img"), `la position s'échappe (${piegee})`);
  assert.ok(!piegee.includes("<b>bold</b>") && !piegee.includes("<img"), "jamais du HTML venu d'un membre dans la page");

  // HABILLÉE AU REGISTRE DE LA MAQUETTE, sinon elle n'est pas dans la page — elle est dessus.
  assert.match(fs.readFileSync(path.join(racine, "src", "web", "public", "style.css"), "utf8"), /\.pli__table\b/);
});

// A5 (relecture du guichet, J1), À LA PORTE WEB : le dépôt de l'opérateur (`sender_chaise` nul) sous
// une adresse humaine. La porte refuse un tel opérateur au démarrage (`validateAgentId` : ni `#` ni
// `@`) ; la fonction de dépôt, elle, suit le guichet — l'expéditeur est exclu de sa table sous sa
// lignée, et l'enclos posé sur la lignée le tient.
test("A5 — deposerAUneTablePourLOperateur sous une adresse humaine : exclu sous sa lignée, l'enclos de la lignée lu", async (t) => {
  const db = bureauJetable(t);
  creerTable(db, { nom: "famille-test", creeePar: "office-test" });
  for (const adresse of ["alice", "alice@atelier", "bob"]) ajouterMembre(db, "famille-test", adresse, { ajoutePar: "office-test" });
  const operateur = "alice@atelier";
  const envoi = await deposerAUneTablePourLOperateur(db, operateur, { sender: operateur, sender_chaise: null, table: "famille-test", body: "beat" }, "");
  assert.deepEqual(envoi.lettres.map((l) => l.to), ["bob"]);

  creerTable(db, { nom: "office-test", fermee: true, creeePar: "office-test" });
  for (const adresse of ["alice", "carol"]) ajouterMembre(db, "office-test", adresse, { ajoutePar: "office-test" });
  poserEnclos(db, "alice", "office-test", { posePar: "office-test" });
  const avant = compterLesLettres(db);
  await assert.rejects(
    () => deposerAUneTablePourLOperateur(db, operateur, { sender: operateur, sender_chaise: null, table: "famille-test", body: "out" }, ""),
    (erreur) => erreur.code === "hors-enclos" && erreur.enclos === "office-test" && erreur.destinataires_refuses.join() === "bob"
  );
  assert.equal(compterLesLettres(db), avant, "rien d'écrit");
});
