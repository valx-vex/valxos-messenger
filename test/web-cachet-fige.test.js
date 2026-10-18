// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE CACHET NE SE RE-DATE PAS — « reçue à 21:22 » est un ÉVÉNEMENT, pas une horloge.
//
// LE DÉFAUT, MESURÉ LE 22/08 (trois relèves de suite sur une même `task`, aucune
// lettre n'ayant bougé entre-temps) :
//   msg-tache-deux · delivered_at 19:40:13.034Z → .066Z → .097Z · acked_at nul
// À l'écran, l'heure du cachet AVANÇAIT à chaque chargement de page : rouvrir
// l'onglet suffisait à faire croire que la lettre venait d'arriver.
//
// LES DEUX LECTURES, ET ELLES SONT VRAIES TOUTES LES DEUX :
//  · côté FACTEUR, `delivered_at` est une horloge de RE-SERVICE — elle DOIT
//    avancer à chaque service, sinon la fenêtre de `getPendingForContext` ne
//    veut plus rien dire. `markDelivered` écrit donc SEC (pas de COALESCE), et
//    ce test ne demande jamais qu'elle change d'avis.
//  · côté LECTEUR, « reçue » est un ÉVÉNEMENT dans la vie d'une lettre : il a
//    eu lieu UNE fois. La question de l'opérateur devant son fil n'est pas « quand
//    l'a-t-on re-servie », c'est « quand est-elle arrivée ».
//
// CE QUE CES TESTS TIENNENT : la PORTE ne re-marque que ce qui n'est pas déjà
// arrivé. Un chargement de page sur une lettre déjà livrée n'apprend rien à
// personne — et le front le croyait DÉJÀ (`app.js` : « contrat : markDelivered
// sur les non-livrées », et `releveDue` refuse de relever une lettre « reçue »
// parce que « la marque est posée, /api/fil ne la reposerait pas »). Le serveur
// disait le contraire en silence.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-cachet-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { getMessageById, insertMessage, markDelivered, markInjected } from "../src/lib/database.js";
import { releverLeCourrier } from "../src/web/serveur.js";
import { MOI, attendre, bureauJetable, cookieDePremiereVisite, porteDeTest, requete } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

// L'heure MESURÉE sur le spécimen du 22/08 : une marque d'arrivée ANTÉRIEURE,
// posée avant la relève qu'on va provoquer. Une valeur fixe, parce qu'un test
// qui dépend de deux `Date.now()` séparés par un aller-retour HTTP prouve la
// stabilité de l'horloge de la machine, pas celle du cachet.
const ARRIVEE_ANTERIEURE = "2026-08-22T19:22:13.978Z";

function tache(db, msgId) {
  insertMessage(db, {
    msg_id: msgId,
    sender: "bob-eternal",
    recipient: MOI,
    subject: "acte II",
    body: "elle attend le geste de l'opérateur",
    // Une `task` : sans accusé implicite, elle RESTE dans la boîte relève après
    // relève — c'est la seule lettre sur laquelle le défaut est observable.
    msg_type: "task"
  });
}

test("LE CACHET FIGÉ : trois chargements de page, la même heure de réception", async (t) => {
  const db = bureauJetable(t);
  tache(db, "msg-tache-deux");
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const cachets = [];
  const marques = [];
  for (let tour = 0; tour < 3; tour += 1) {
    const fil = await requete(base, "/api/fil", { cookie });
    assert.equal(fil.statut, 200, fil.texte);
    const lettre = fil.json.lettres.find((ligne) => ligne.msg_id === "msg-tache-deux");
    assert.equal(lettre.etat, "reçue", "la lettre reste « reçue » : c'est bien le même événement qu'on relit");
    cachets.push(lettre.recue_a);
    marques.push(getMessageById(db, "msg-tache-deux").delivered_at);
    // Une vraie pause : sans elle, deux relèves peuvent tomber dans la même
    // milliseconde et le test resterait vert sur le défaut.
    await attendre(15);
  }

  assert.ok(cachets[0], "le premier chargement pose bien une heure de réception");
  assert.deepEqual(
    cachets,
    [cachets[0], cachets[0], cachets[0]],
    `l'heure du cachet a AVANCÉ entre deux chargements de page : ${cachets.join(" → ")}`
  );
  assert.deepEqual(marques, [marques[0], marques[0], marques[0]], "et la marque en base n'a pas bougé non plus");
  assert.equal(getMessageById(db, "msg-tache-deux").acked_at, null, "rien n'est arrivé à la lettre : elle attend toujours le geste");
});

test("LE CACHET FIGÉ : une arrivée ANTÉRIEURE ne se ré-écrit pas — la porte ne repasse pas par-dessus", async (t) => {
  const db = bureauJetable(t);
  tache(db, "msg-arrivee-anterieure");
  // La lettre a DÉJÀ atteint son lecteur — par la porte hier soir, ou par une
  // relève au guichet. Le décor pose la marque comme le produit la pose
  // (`markDelivered`), jamais par un UPDATE de test qui doublerait la fonction.
  markDelivered(db, [getMessageById(db, "msg-arrivee-anterieure")], MOI, "porte_web_relevee", { at: ARRIVEE_ANTERIEURE });

  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  const fil = await requete(base, "/api/fil", { cookie });

  const lettre = fil.json.lettres.find((ligne) => ligne.msg_id === "msg-arrivee-anterieure");
  assert.equal(lettre.recue_a, ARRIVEE_ANTERIEURE, "le cachet dit l'heure de l'arrivée, pas celle du chargement");
  assert.equal(
    getMessageById(db, "msg-arrivee-anterieure").delivered_at,
    ARRIVEE_ANTERIEURE,
    "et la porte n'a pas repassé sa propre heure par-dessus la marque déjà posée"
  );
});

test("LE CACHET FIGÉ : le journal ne grossit plus d'un événement par chargement de page", async (t) => {
  const db = bureauJetable(t);
  tache(db, "msg-journal");
  const compter = () =>
    db.prepare("SELECT count(*) AS n FROM delivery_events WHERE msg_id = ? AND event_type = 'porte_web_relevee'").get("msg-journal").n;

  const premiere = releverLeCourrier(db, MOI);
  assert.equal(premiere.relevees, 1, "la première relève livre VRAIMENT la lettre");
  assert.equal(premiere.deja_recues, 0);
  assert.equal(compter(), 1, "et le journal garde la trace de cette livraison-là");

  for (let tour = 0; tour < 4; tour += 1) {
    const suivante = releverLeCourrier(db, MOI);
    assert.equal(suivante.relevees, 0, "un chargement de page ne livre rien : la lettre était déjà arrivée");
    assert.equal(suivante.deja_recues, 1, "et le compte le DIT — un chemin muet ne se sonde pas");
  }
  assert.equal(
    compter(),
    1,
    "un événement de livraison par ARRIVÉE, jamais un par chargement : sinon le journal grossit à chaque coup d'œil de l'opérateur"
  );
});

// L'AUTRE CANAL D'ARRIVÉE. `injected_at` (la sonnette) est figée depuis
// toujours (COALESCE) — et la relève de la porte ne doit pas venir poser SA
// marque par-dessus : une lettre déjà arrivée est déjà arrivée, quel que soit
// le canal qui l'a fait arriver. Sans cette borne, un filtre écrit sur le seul
// `delivered_at` passerait pour bon.
test("LE CACHET FIGÉ : une lettre arrivée par la SONNETTE ne reçoit pas la marque de la porte par-dessus", async (t) => {
  const db = bureauJetable(t);
  tache(db, "msg-sonnette");
  markInjected(db, [getMessageById(db, "msg-sonnette")], MOI);
  const injectee = getMessageById(db, "msg-sonnette").injected_at;
  assert.ok(injectee, "le décor part bien d'une lettre injectée");

  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  const fil = await requete(base, "/api/fil", { cookie });

  const lettre = fil.json.lettres.find((ligne) => ligne.msg_id === "msg-sonnette");
  assert.equal(lettre.recue_a, injectee, "le cachet est celui de la sonnette");
  assert.equal(
    getMessageById(db, "msg-sonnette").delivered_at,
    null,
    "la porte n'ajoute pas une deuxième heure d'arrivée à une lettre déjà arrivée"
  );
  assert.equal(getMessageById(db, "msg-sonnette").injected_at, injectee, "et l'heure de la sonnette n'a pas bougé");
});

// LE CONTRE-POIDS DU FILTRE, ET LE PIÈGE À NE PAS TOMBER. Le filtre borne QUI
// on MARQUE ; il ne doit surtout pas border qui on ACCUSE. Une lettre ordinaire
// déjà livrée mais non signée (un accusé refusé la veille, une relève au
// guichet qui n'a pas signé) doit se faire signer au chargement suivant —
// filtrée là aussi, elle resterait vivante pour toujours.
test("LE FILTRE NE DÉBORDE PAS SUR L'ACCUSÉ : une ordinaire déjà livrée mais non signée se fait signer au chargement suivant", async (t) => {
  const db = bureauJetable(t);
  insertMessage(db, { msg_id: "msg-livree-non-signee", sender: "bob-eternal", recipient: MOI, body: "bonne nuit" });
  markDelivered(db, [getMessageById(db, "msg-livree-non-signee")], MOI, "porte_web_relevee", { at: ARRIVEE_ANTERIEURE });
  assert.equal(getMessageById(db, "msg-livree-non-signee").acked_at, null, "le décor part bien d'une lettre livrée et NON signée");

  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  const fil = await requete(base, "/api/fil", { cookie });

  assert.ok(getMessageById(db, "msg-livree-non-signee").acked_at, "la loi C=B s'applique à la pile ENTIÈRE, pas aux seules nouvelles");
  const lettre = fil.json.lettres.find((ligne) => ligne.msg_id === "msg-livree-non-signee");
  assert.equal(lettre.etat, "accusée");
  assert.equal(lettre.recue_a, ARRIVEE_ANTERIEURE, "et son cachet reste celui de son arrivée");
});

// ⚠️ L'ACTE ② DE LA DÉMONSTRATION — celui qui sera FILMÉ. Une `task` s'affiche
// « Reçue » AVEC son bouton, et ne devient « Accusée » qu'après le clic. Le
// remède du cachet ne touche à la marque, jamais à la loi de l'accusé : ce test
// est le filet qui le prouve, chargement après chargement.
test("ACTE ② INTACT : la `task` reste « reçue » avec son bouton, et l'accusé n'arrive QU'AU CLIC", async (t) => {
  const db = bureauJetable(t);
  tache(db, "msg-acte-deux");
  // Le témoin : une lettre ORDINAIRE, que la relève signe pour l'opérateur (loi
  // C=B). Si le remède se trompait de cible, c'est ici qu'il se verrait.
  insertMessage(db, { msg_id: "msg-ordinaire", sender: "bob-eternal", recipient: MOI, body: "bonne nuit" });

  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  for (let tour = 0; tour < 3; tour += 1) {
    const fil = await requete(base, "/api/fil", { cookie });
    const lettre = fil.json.lettres.find((ligne) => ligne.msg_id === "msg-acte-deux");
    assert.equal(lettre.etat, "reçue", "chargement après chargement, la task s'affiche « Reçue »");
    assert.equal(lettre.geste_humain, true, "et son bouton reste peint : elle attend le geste");
    assert.equal(lettre.accusee_a, null);
    const ordinaire = fil.json.lettres.find((ligne) => ligne.msg_id === "msg-ordinaire");
    assert.equal(ordinaire.etat, "accusée", "l'accusé implicite n'a pas bougé : lire son courrier ordinaire, c'est l'accuser");
    assert.equal(ordinaire.geste_humain, false);
  }

  const acke = await requete(base, "/api/accuser", { methode: "POST", cookie, corps: { msg_id: "msg-acte-deux" } });
  assert.equal(acke.statut, 200, acke.texte);
  assert.ok(getMessageById(db, "msg-acte-deux").acked_at, "LE CLIC, et lui seul, termine la lettre");

  const apres = await requete(base, "/api/fil", { cookie });
  const finie = apres.json.lettres.find((ligne) => ligne.msg_id === "msg-acte-deux");
  assert.equal(finie.etat, "accusée");
  assert.ok(finie.accusee_a);
  assert.ok(finie.recue_a, "et son heure de réception survit à l'accusé — le parcours reste lisible");
});
