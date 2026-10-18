// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE FRONT DE LA PORTE — le verrou qui manquait.
//
// 1365 lignes de page, zéro test : les cinq écarts trouvés par les lentilles
// adverses du 22/08 sont TOUS de la même famille — le front redéfinit, devine
// ou jette une forme que l'API rend déjà. Une boîte hors service peinte en
// vert, un accusé que le serveur exige et que la page n'offre pas, une lettre
// affichée mais jamais relevée, un plafond muet, un cri jeté deux fois.
//
// ⚠️ LA RÈGLE DE CE FICHIER, ET C'EST TOUTE SA VALEUR : aucune réponse d'API
// n'est écrite à la main ici. Chaque forme vient d'une VRAIE requête à une
// VRAIE porte sur un VRAI bureau. Un objet littéral `{ nom: "amb", vivant:
// false }` serait une TROISIÈME définition de la forme — elle mentirait
// exactement comme le front mentait, et ce fichier serait vert le jour de
// l'incident. Les seuls littéraux tolérés sont les cas qu'aucune API ne peut
// produire (une clef absente, une panne réseau) : ils sont nommés comme tels.
//
// Ce que ce verrou ferme n'est donc pas « les cinq cas trouvés » mais la
// CLASSE : les deux moitiés de la porte lisent la même forme, et le test le
// prouve en faisant passer l'une dans l'autre.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js pour le pourquoi (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { identitesDeCetteMachine } from "./aide-identites.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-front-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { getMessageById, insertMessage, registerPeer, unregisterPeer } from "../src/lib/database.js";
import { PLAFOND_DU_CORPS, PLAFOND_DU_FIL, accuseImplicite } from "../src/web/serveur.js";
import { MOI, bureauJetable, cookieDePremiereVisite, fluxSSE, porteDeTest, requete } from "./aide-porte.js";
// LE PAPIER SANS NAVIGATEUR — voir aide-dom.js : le défaut du 22/08 n'est dans
// AUCUNE fonction pure, il est dans la POSE. Sans instrument qui pose vraiment
// le dessin et le relit après le geste, ce défaut-là est invisible.
import { papierDeTest } from "./aide-dom.js";
// LA PAGE ELLE-MÊME. Elle s'importe parce qu'elle est un module et qu'elle ne
// touche au DOM que devant un écran : ici, `document` n'existe pas, elle ne
// rend que ses fonctions.
import {
  attendUnAccuse,
  avarieDuRefus,
  choisirLaDestination,
  compteDeSouffrance,
  criDeLaLettre,
  dessinerBoite,
  dessinerPli,
  etatDuGuichet,
  ligneDeSouffrance,
  nomDeLaMachine,
  normaliser,
  normaliserBoite,
  normaliserLettre,
  phraseDuFilVide,
  phraseDuPlafond,
  pied,
  poserLesAccusesRefuses,
  reclasserLePli,
  refusDesAccuses,
  releveDue,
  retamponner,
  suiteDuDepot,
  surLettreDuFlux
} from "../src/web/public/app.js";
import { poserLeBureau } from "./aide-env.js";

const racine = path.resolve(new URL("..", import.meta.url).pathname);

// L'état local d'un pli qui vient d'arriver du bureau : rien n'a échoué, rien
// n'a été signé à la main.
const PLI_SAIN = { nonPartie: false, refus: null, rejouable: true, accuseEnvoye: false };

function source(...morceaux) {
  return fs.readFileSync(path.join(racine, ...morceaux), "utf8");
}

// Une porte de test, ouverte et déverrouillée comme le navigateur la trouve.
async function porteOuverte(t) {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  return { db, base, cookie };
}

async function pairsReels(base, cookie) {
  const reponse = await requete(base, "/api/pairs", { cookie });
  assert.equal(reponse.statut, 200, "SONDE IMPOSSIBLE : /api/pairs n'a pas répondu");
  return reponse.json;
}

// ⚠️ CETTE ROUTE RELÈVE (contrat) : l'appeler n'est jamais neutre.
async function filReel(base, cookie) {
  const reponse = await requete(base, "/api/fil", { cookie });
  assert.equal(reponse.statut, 200, "SONDE IMPOSSIBLE : /api/fil n'a pas répondu");
  return reponse.json;
}

/* ══ BLOQUANT 1 — `en_service`, la clef que l'API écrit vraiment ═══════════ */

test("une fiche HORS SERVICE arrive GRISE — le front lit `en_service`, pas une clef qui n'existe pas", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });
  registerPeer(db, { id: "amb", status: "active" });
  unregisterPeer(db, "amb"); // le geste réel d'une fiche qu'on retire du service

  const pairs = await pairsReels(base, cookie);
  const amb = pairs.pairs.find((p) => p.nom === "amb");
  const bob = pairs.pairs.find((p) => p.nom === "bob-eternal");
  // TROIS ISSUES : une sonde qui ne voit pas sa cible n'est pas un pass.
  assert.ok(amb, `SONDE IMPOSSIBLE : la fiche amb est absente du registre rendu (${JSON.stringify(pairs)})`);
  assert.equal(amb.en_service, false, "SONDE : l'API doit bien dire que amb est hors service");
  assert.equal(amb.libelle, "retired from service");

  const grise = normaliserBoite(amb);
  assert.equal(
    grise.vivant,
    false,
    "une fiche retirée du service s'affichait avec le VOYANT VERT — le défaut le plus visible de la porte"
  );
  // Le libellé du produit se LIT, il ne se réinvente pas : « retirée du
  // service » et « morte » ne disent pas la même chose.
  assert.equal(grise.libelle, "retired from service");

  // Contrôle positif : la garde n'est pas un mur, une boîte vivante reste verte.
  assert.equal(normaliserBoite(bob).vivant, true);
  assert.equal(normaliserBoite(bob).libelle, "in service");

  // CE QUI S'AFFICHE, LU SANS NAVIGATEUR : la fiche grise porte la classe de
  // la maquette, et le libellé qui s'y lit est celui du PRODUIT — « retirée du
  // service » et « morte » ne disent pas la même chose.
  const dessin = dessinerBoite(grise, null);
  assert.match(dessin, /boite--morte/, "la classe grise de la maquette");
  assert.ok(dessin.includes("retired from service"), `le libellé du bureau doit se lire sur la fiche (${dessin})`);
  assert.doesNotMatch(dessinerBoite(normaliserBoite(bob), null), /boite--morte/);

  // CAMP B À L'ÉCRAN : la fiche hors service ne disparaît pas de la liste.
  const boites = pairs.pairs.map(normaliserBoite);
  assert.ok(boites.some((b) => b.nom === "amb"), "rien ne s'efface, pas même à l'écran — elle grise, elle reste");

  // ET LA CONSÉQUENCE QUI SE VOYAIT À LA DÉMO : la porte s'ouvrait pointée sur
  // amb (première du registre, trié par nom) parce qu'elle la croyait vivante.
  assert.equal(boites[0].nom, "amb", "SONDE : amb trie bien en tête, c'est ce qui rendait le défaut visible");
  assert.equal(
    choisirLaDestination(boites, null, MOI),
    "bob-eternal",
    "le destinataire par défaut doit être une boîte EN SERVICE"
  );
});

/* ══ BLOQUANT 2 — `geste_humain` est calculé par l'API, et LU par le front ═ */

test("le bouton « Accuser réception » suit la loi du SERVEUR — une seule loi, calculée à un seul endroit", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });

  // Les quatre types que la loi de l'accusé sépare (serveur.js : seul
  // `message` en priorité ordinaire est signé par la relève).
  const posees = {};
  for (const [nom, type] of [
    ["ordinaire", "message"],
    ["diffusion", "broadcast"],
    ["reponse", "response"],
    ["statut", "status"]
  ]) {
    posees[nom] = insertMessage(db, {
      sender: "bob-eternal",
      recipient: MOI,
      body: `pli ${nom}`,
      msg_type: type
    }).msg_id;
  }

  const fil = await filReel(base, cookie); // ← la relève : elle signe ce qu'elle a le droit de signer
  const par = new Map(fil.lettres.map((l) => [l.msg_id, l]));
  assert.equal(par.size, 4, `SONDE IMPOSSIBLE : le fil devait porter les 4 plis (${par.size})`);

  // L'IMPASSE, NOMMÉE : le serveur refuse de signer une diffusion, et le front
  // n'offrait pas de la signer. La porte inscrit son opérateur au registre, donc
  // CHAQUE diffusion de la maison tombait dedans.
  const diffusion = par.get(posees.diffusion);
  assert.equal(diffusion.etat, "reçue", "SONDE : la relève l'a remise mais ne l'a pas signée");
  assert.equal(diffusion.geste_humain, true, "SONDE : l'API exige bien le geste humain sur une diffusion");
  assert.equal(
    attendUnAccuse(normaliserLettre(diffusion)),
    true,
    "sans bouton, cette lettre ne peut JAMAIS être accusée — le serveur refuse de signer, le front n'offre pas"
  );
  assert.match(
    dessinerPli(normaliserLettre(diffusion), PLI_SAIN),
    /data-accuser/,
    "et le bouton doit vraiment être SUR le pli, pas seulement dans un booléen"
  );

  // Une lettre ordinaire, elle, est DÉJÀ signée par la relève : pas de bouton,
  // et pas parce que le front l'a décidé — parce que l'API le dit.
  const ordinaire = par.get(posees.ordinaire);
  assert.equal(ordinaire.etat, "accusée");
  assert.equal(ordinaire.geste_humain, false);
  assert.equal(attendUnAccuse(normaliserLettre(ordinaire)), false);

  // LA CLASSE, pas les points : sur CHAQUE lettre du fil, le bouton du front
  // et la loi du serveur (`accuseImplicite`, lue sur la ligne en base) disent
  // la même chose. C'est le verrou qui ferme « les deux moitiés divergent ».
  for (const lettre of fil.lettres) {
    const l = normaliserLettre(lettre);
    const ligne = getMessageById(db, l.msg_id);
    const loiDuServeur = !accuseImplicite(ligne);
    const arrivee = normaliser(l.etat) === "reçue" && !l.mien;
    assert.equal(
      attendUnAccuse(l),
      arrivee && loiDuServeur,
      `le front et le serveur ne disent pas la même chose sur ${l.msg_id} (${ligne.msg_type}/${ligne.priority})`
    );
  }
});

/* ══ BLOQUANT 3 — la lettre qui arrive pendant que la page est OUVERTE ════ */

test("la lettre qui tombe pendant que la page est ouverte est RELEVÉE — le cachet cesse de mentir", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });

  const flux = fluxSSE(base, { cookie });
  await flux.pret;
  t.after(() => flux.fermer());

  // LA SCÈNE DE LA MAQUETTE : le pli de Bob qui se dépose tout seul.
  insertMessage(db, { sender: "bob-eternal", recipient: MOI, body: "Reçu cinq sur cinq" });
  const evenement = await flux.attendre((e) => e.type === "lettre");
  const brut = evenement.donnees;

  // L'ÉTAT AVANT : le pli est à l'écran, et en base RIEN n'est marqué.
  const avant = getMessageById(db, brut.msg_id);
  assert.equal(avant.carried_at, null);
  assert.equal(avant.delivered_at, null);
  assert.equal(avant.acked_at, null);

  // Le front, sur CET événement-là, doit demander une relève. Les actions sont
  // injectées pour être REGARDÉES : la décision, elle, reste dans la page.
  const gestes = [];
  surLettreDuFlux(brut, { peindre: () => gestes.push("peint"), relever: () => gestes.push("relève") });
  assert.deepEqual(
    gestes,
    ["peint", "relève"],
    "le front peignait le pli sans jamais le relever : l'opérateur l'a lu, l'expéditeur n'a jamais son tampon"
  );

  // Et la relève, c'est /api/fil — la SEULE surface qui marque (contrat).
  await filReel(base, cookie);
  const apres = getMessageById(db, brut.msg_id);
  assert.ok(apres.delivered_at, "après la relève, la base porte la remise");

  // L'ÉCHO DE MON PROPRE ENVOI NE RELÈVE RIEN. Sans cette borne, chaque lettre
  // postée déclencherait un GET /api/fil pour rien — la boucle de confort que
  // la page a explicitement refusée, par la petite porte.
  insertMessage(db, { sender: MOI, recipient: "bob-eternal", body: "depuis mon iPhone" });
  const echo = await flux.attendre((e) => e.type === "lettre" && e.donnees.mien === true);
  const gestesEcho = [];
  surLettreDuFlux(echo.donnees, {
    peindre: () => gestesEcho.push("peint"),
    relever: () => gestesEcho.push("relève")
  });
  assert.deepEqual(gestesEcho, ["peint"], "ma propre lettre n'a rien à relever");

  // La décision, nue : elle se lit sur la lettre, pas sur l'horloge.
  assert.equal(releveDue(brut, MOI), true);
  assert.equal(releveDue(echo.donnees, MOI), false);
  // Une lettre déjà arrivée ne se relève pas deux fois.
  const dejaLa = (await filReel(base, cookie)).lettres.find((l) => l.msg_id === brut.msg_id);
  assert.equal(normaliser(dejaLa.etat), "accusée", "SONDE : la relève a signé cette lettre ordinaire");
  assert.equal(releveDue(dejaLa, MOI), false);
});

/* ══ IMPORTANT 4 — le plafond du fil ne redevient pas muet ════════════════ */

test("le plafond se DIT : 505 lettres, 5 hors du fil, et la page l'annonce", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });

  // Le fil tient sous le plafond : la page se TAIT. (Le silence des cas sains,
  // mesuré sur une vraie réponse — pas sur un objet écrit à la main.)
  insertMessage(db, { sender: "bob-eternal", recipient: MOI, body: "une seule lettre" });
  const petit = await filReel(base, cookie);
  assert.equal(petit.au_dela_du_plafond, 0, "SONDE : rien au-delà du plafond sur un fil d'une lettre");
  assert.equal(phraseDuPlafond(petit), null, "une borne qui parle quand rien ne manque est un bruit");

  const debordement = 5;
  for (let i = 0; i < PLAFOND_DU_FIL + debordement - 1; i += 1) {
    insertMessage(db, { sender: "bob-eternal", recipient: MOI, body: `lettre ${i}` });
  }
  const fil = await filReel(base, cookie);
  assert.equal(fil.lettres.length, PLAFOND_DU_FIL, "SONDE : le fil est bien plafonné");
  assert.equal(fil.au_dela_du_plafond, debordement, "SONDE : l'API compte bien les disparues");

  const phrase = phraseDuPlafond(fil);
  assert.ok(phrase, "avec 505 lettres, 5 disparaissaient sans un mot — une borne muette se lit « tout est là »");
  assert.match(phrase, /\b5\b/, "la phrase dit COMBIEN manquent");
  assert.match(phrase, new RegExp(`\\b${PLAFOND_DU_FIL}\\b`), "et elle dit le plafond qui les retient");

  // Défensif : une réponse SANS ces clefs (une API plus vieille) ne casse rien
  // et ne raconte rien. Ces deux-là sont des littéraux assumés — aucune porte
  // ne rend cette forme aujourd'hui.
  assert.equal(phraseDuPlafond({}), null);
  assert.equal(phraseDuPlafond(null), null);

  // LE CÂBLAGE, et pas seulement le vocabulaire : savoir dire la phrase ne
  // sert à rien si personne ne l'appelle. Le test LIT les fichiers — même
  // instrument que la garde n°1, pour la même raison : une revue de code est
  // une opinion, pas un instrument.
  const page = source("src", "web", "public", "app.js");
  const appels = page.split("phraseDuPlafond").length - 1;
  assert.ok(appels >= 2, `la page doit APPELER la phrase, pas seulement savoir la dire (${appels} occurrence[s])`);
  assert.match(page, /fil__plafond/, "et la poser dans le fil, sous une classe à elle");
  assert.match(
    source("src", "web", "public", "style.css"),
    /\.fil__plafond/,
    "habillée au registre de la maquette, sinon elle n'est pas dans la page — elle est dessus"
  );
});

/* ══ IMPORTANT 5 — l'en-souffrance rendue deux fois, jetée deux fois ══════ */

test("une lettre EN SOUFFRANCE se voit — le cri de l'API traverse le front au lieu d'y mourir", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });

  // Le seuil d'âge, posé pour ce test : cinq heures de retard sur un seuil
  // d'une heure. Le calcul reste celui du médecin (`lettresEnSouffrance`).
  const seuilInitial = process.env.CC2CC_SOUFFRANCE_AGE_MS;
  process.env.CC2CC_SOUFFRANCE_AGE_MS = String(3_600_000);
  t.after(() => {
    if (seuilInitial === undefined) delete process.env.CC2CC_SOUFFRANCE_AGE_MS;
    else process.env.CC2CC_SOUFFRANCE_AGE_MS = seuilInitial;
  });

  const vieille = insertMessage(db, {
    sender: MOI,
    recipient: "bob-eternal",
    body: "tu me réponds ?",
    created_at: new Date(Date.now() - 5 * 3_600_000).toISOString()
  });

  const fil = await filReel(base, cookie);
  const lettre = fil.lettres.find((l) => l.msg_id === vieille.msg_id);
  assert.ok(lettre, "SONDE IMPOSSIBLE : la lettre n'est pas au fil");
  assert.ok(lettre.en_souffrance, "SONDE : l'API doit crier sur une lettre de cinq heures jamais signée");
  assert.equal(lettre.en_souffrance.depuis_h, 5);

  const normalisee = normaliserLettre(lettre);
  assert.deepEqual(
    normalisee.en_souffrance,
    lettre.en_souffrance,
    "la forme du front JETAIT le cri : tout le chantier H2 s'arrêtait à la porte"
  );

  const ligne = ligneDeSouffrance(normalisee.en_souffrance);
  // T4b-c (18/10) : l'écran dit « Overdue » ; le motif reste celui du Facteur.
  assert.match(ligne, /^Overdue\b/, "le cri se nomme en tête de ligne, dans la langue de la page");
  assert.match(ligne, /\b5\b/, "depuis combien de temps");

  // ET ELLE SE VOIT SUR LE PLI — sur la ligne d'expéditeur, qui existe déjà.
  const html = dessinerPli(normalisee, PLI_SAIN);
  assert.match(html, /pli__souffrance/, "une lettre en souffrance doit se VOIR : c'est pour ça que cette porte existe");
  assert.ok(html.includes(ligne), `le cri, mot pour mot, sur le pli (${html})`);
  assert.match(
    source("src", "web", "public", "style.css"),
    /\.pli__souffrance/,
    "à l'ocre de l'attente, qui est déjà au thème"
  );

  // Une lettre saine ne crie pas — sinon le cri ne veut plus rien dire.
  const saine = fil.lettres.find((l) => !l.en_souffrance);
  if (saine) assert.equal(ligneDeSouffrance(normaliserLettre(saine).en_souffrance), "");
  assert.equal(ligneDeSouffrance(null), "");

  // CÔTÉ FICHE DE PAIR, avec la vraie réponse de /api/pairs.
  const pairs = await pairsReels(base, cookie);
  const bob = pairs.pairs.find((p) => p.nom === "bob-eternal");
  assert.ok(bob, "SONDE IMPOSSIBLE : bob-eternal n'est pas au registre");
  assert.equal(normaliserBoite(bob).souffrance, compteDeSouffrance(bob.en_souffrance));

  // ⚠️ COORDINATION : l'API est en train de borner l'en-souffrance des PAIRS
  // au seul courrier de l'opérateur. Le front ne doit donc rien casser si la clef
  // change de forme ou disparaît — littéraux assumés, ils décrivent des
  // formes qu'aucune porte ne rend AUJOURD'HUI mais qu'une porte pourrait
  // rendre demain.
  assert.equal(compteDeSouffrance(undefined), 0, "une clef absente ne casse rien");
  assert.equal(compteDeSouffrance(null), 0);
  assert.equal(compteDeSouffrance(3), 3, "un simple compte (la forme de cc2cc-peers) se lit aussi");
  assert.equal(compteDeSouffrance({ lettres: 2 }), 2);
  assert.equal(compteDeSouffrance({ motif: "boite-endormie" }), 1, "un cri sans compte reste UN cri");
  assert.equal(normaliserBoite({ nom: "sans-clef" }).souffrance, 0);
});

/* ══ MINEUR 7 — le motif d'un refus ne se jette pas ═══════════════════════ */

test("un pli refusé DIT pourquoi — et « Réessayer » ne promet pas ce qu'il ne peut pas tenir", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });

  const tropGros = "x".repeat(PLAFOND_DU_CORPS + 64);
  const refus = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "bob-eternal", corps: tropGros }
  });
  assert.equal(refus.statut, 413, "SONDE : l'API doit refuser un pli de plus de 256 Kio");
  assert.equal(refus.json.refus, "pli-trop-gros");

  const avarie = avarieDuRefus(refus.statut, refus.json);
  assert.match(
    avarie.motif,
    /the letter exceeds/,
    "l'écran affichait « Non partie. » et rien d'autre — un échec qui ne dit pas pourquoi est pire qu'un échec"
  );
  assert.match(avarie.motif, new RegExp(String(PLAFOND_DU_CORPS)), "le motif du bureau, mot pour mot");
  assert.equal(
    avarie.rejouable,
    false,
    "rejouer le MÊME pli au même octet près donnerait le même refus : le bouton mentirait"
  );

  // Un destinataire manquant : même famille, même traitement.
  const sansDestinataire = await requete(base, "/api/poster", { methode: "POST", cookie, corps: { corps: "hé" } });
  assert.equal(sansDestinataire.statut, 400);
  assert.equal(avarieDuRefus(sansDestinataire.statut, sansDestinataire.json).rejouable, false);
  assert.match(avarieDuRefus(sansDestinataire.statut, sansDestinataire.json).motif, /without a recipient/);

  // Une PANNE, elle, se rejoue — c'est tout l'intérêt du msg_id d'idempotence.
  // (Littéraux assumés : un réseau coupé ne rend aucun corps.)
  assert.equal(avarieDuRefus(0, null).rejouable, true, "le bureau n'a pas répondu : la reprise a un sens");
  assert.equal(avarieDuRefus(503, { refus: "panne-de-la-porte" }).rejouable, true);

  // CE QUE L'ÉCRAN MONTRE, dans les deux cas.
  const pli = normaliserLettre({ de: MOI, a: "bob-eternal", corps: "…", etat: "en attente", mien: true });
  const refusee = pied(pli, { nonPartie: true, refus: avarie.motif, rejouable: false, accuseEnvoye: false });
  assert.match(refusee, /Not sent\./);
  assert.ok(refusee.includes(avarie.motif), `le motif du bureau s'affiche (${refusee})`);
  assert.doesNotMatch(refusee, /data-reprise/, "un bouton qui ne peut pas réussir est un mensonge poli");

  const enPanne = pied(pli, { nonPartie: true, refus: null, rejouable: true, accuseEnvoye: false });
  assert.match(enPanne, /data-reprise/, "une panne, elle, garde sa reprise — le msg_id est fait pour ça");

  // Le dépôt sain, lui, ne parle pas d'avarie du tout.
  const bonne = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "bob-eternal", corps: "une vraie lettre" }
  });
  assert.equal(bonne.statut, 200, "SONDE : le contrôle positif doit passer, sinon on mesure autre chose");
});

/* ══ MINEUR 8 — la porte ne s'écrit pas à elle-même ═══════════════════════ */

test("l'opérateur n'est pas une destination : la porte ne se propose pas comme destinataire d'elle-même", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);

  // Un bureau NEUF : la porte y inscrit sa propre fiche, et c'est la seule.
  const seul = await pairsReels(base, cookie);
  assert.deepEqual(seul.pairs.map((p) => p.nom), [MOI], "SONDE : sur un bureau neuf, l'opérateur est bien la seule fiche");
  const boitesNeuves = seul.pairs.map(normaliserBoite);
  assert.equal(
    choisirLaDestination(boitesNeuves, null, MOI),
    null,
    "aucune destination vaut mieux qu'une lettre adressée à soi-même"
  );

  registerPeer(db, { id: "bob-eternal", status: "active" });
  const deux = await pairsReels(base, cookie);
  const boites = deux.pairs.map(normaliserBoite);
  assert.equal(choisirLaDestination(boites, null, MOI), "bob-eternal");
  // Et le choix de l'humain survit à une repeinture du registre (A9).
  assert.equal(choisirLaDestination(boites, "bob-eternal", MOI), "bob-eternal");
  // Même désignée à la main, sa propre boîte n'est pas une destination.
  assert.equal(choisirLaDestination(boites, MOI, MOI), "bob-eternal");
});

/* ══ MINEUR 9 — la sous-marque porte les DEUX (dérive maquette) ═══════════ */

test("la sous-marque garde le nom ET la machine — et le chargement n'en écrase pas la moitié", () => {
  const html = fs.readFileSync(path.join(racine, "src", "web", "public", "index.html"), "utf8");
  const sous = html.match(/<span class="marque__sous"[\s\S]*?<\/span>\s*<\/div>/)?.[0];
  assert.ok(sous, "SONDE IMPOSSIBLE : la sous-marque n'est pas dans la page");
  assert.match(sous, /id="marque-sous"/, "le nom a sa propre prise…");
  assert.match(sous, /id="marque-machine"/, "…et la machine la sienne, sinon `moi` écrase les deux au chargement");
  assert.match(sous, /·/, "la maquette conserve les deux prises séparées");
  // Même remède qu'en surfaces.test.js : on ne NOMME plus, on découvre. Écrire
  // le prénom ici le publiait dans le dépôt, au nom d'une garde qui l'interdit.
  for (const { motif, quoi } of identitesDeCetteMachine()) {
    assert.doesNotMatch(sous, motif, `le HTML livré embarque ${quoi}`);
  }
  assert.match(sous, /id="marque-sous"><\/span>/, "l'opérateur attend la réponse de l'API");
  assert.match(sous, /id="marque-machine"><\/span>/, "la machine attend l'hôte qui sert réellement la page");

  // Le nom de la machine se lit sur l'hôte qui sert la page — jamais dans un
  // défaut du document. Une adresse nue reste honnêtement cette adresse.
  assert.equal(nomDeLaMachine("poste-bleu.exemple.invalid"), "poste-bleu");
  assert.equal(nomDeLaMachine("poste-bleu"), "poste-bleu");
  assert.equal(nomDeLaMachine("127.0.0.1"), "127.0.0.1");
  assert.equal(nomDeLaMachine("localhost"), "localhost");
  assert.equal(nomDeLaMachine(""), "");
});

/* ══════════════════════════════════════════════════════════════════════════
   RONDE FINALE (22/08) — ce que les relecteurs de la réparation ont trouvé.
   Même doctrine que le reste du fichier : aucune forme d'API écrite à la main.
   ══════════════════════════════════════════════════════════════════════════ */

/* ══ BLOQUANT 10 — le cri d'en-souffrance survivait au coup de tampon ═════ */

test("le coup de tampon EFFACE le cri : « Accusée » et « En souffrance » ne tiennent pas sur le même papier", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });

  const seuilInitial = process.env.CC2CC_SOUFFRANCE_AGE_MS;
  process.env.CC2CC_SOUFFRANCE_AGE_MS = String(3_600_000);
  t.after(() => {
    if (seuilInitial === undefined) delete process.env.CC2CC_SOUFFRANCE_AGE_MS;
    else process.env.CC2CC_SOUFFRANCE_AGE_MS = seuilInitial;
  });

  // Une DIFFUSION vieille de neuf heures : la relève la remet mais refuse de la
  // signer (`accuseImplicite` est faux sur `broadcast`), donc elle reste
  // « reçue » sans accusé — et le médecin crie dessus.
  const vieille = insertMessage(db, {
    sender: "bob-eternal",
    recipient: MOI,
    body: "la nuit s'est bien passée",
    msg_type: "broadcast",
    created_at: new Date(Date.now() - 9 * 3_600_000).toISOString()
  });

  const avant = (await filReel(base, cookie)).lettres.find((l) => l.msg_id === vieille.msg_id);
  assert.ok(avant, "SONDE IMPOSSIBLE : la lettre n'est pas au fil");
  assert.equal(normaliser(avant.etat), "reçue", "SONDE : la relève l'a remise sans la signer");
  assert.ok(avant.en_souffrance, "SONDE : neuf heures sans accusé, le médecin crie");
  assert.equal(avant.en_souffrance.depuis_h, 9);

  // LE GESTE DE OPERATEUR : il signe. C'est le seul geste terminal.
  const signe = await requete(base, "/api/accuser", { methode: "POST", cookie, corps: { msg_id: vieille.msg_id } });
  assert.equal(signe.statut, 200, `SONDE IMPOSSIBLE : l'accusé n'est pas passé (${JSON.stringify(signe.json)})`);

  const apres = (await filReel(base, cookie)).lettres.find((l) => l.msg_id === vieille.msg_id);
  assert.equal(normaliser(apres.etat), "accusée");
  // LA BASE, ELLE, NE SE CONTREDIT PAS : `enSouffrance` (format.js) rend `null`
  // dès que `acked_at` est posé. C'est le PRODUIT qui dit qu'une lettre accusée
  // n'est jamais en souffrance — et c'est ça que l'écran doit lire, au lieu de
  // garder son ancien état en mémoire.
  assert.equal(apres.en_souffrance, null, "SONDE : une lettre accusée n'est plus en souffrance");

  // ── LE PAPIER, POSÉ PUIS RELU APRÈS LE GESTE ────────────────────────────
  const local = { ...PLI_SAIN };
  const papier = papierDeTest(dessinerPli(normaliserLettre(avant), local));
  assert.match(papier.innerHTML, /pli__souffrance/, "SONDE : le cri est bien sur le papier AVANT l'accusé");

  // La page fusionne la ligne neuve dans le pli qu'elle tient déjà
  // (`accueillir`), puis donne le coup de tampon parce que l'état a bougé.
  const entree = { brut: { ...avant, ...apres }, element: papier, local };
  retamponner(entree);

  assert.match(papier.innerHTML, /cachet__mot">Acked</, "SONDE : le tampon est bien passé à « Acked »");
  assert.match(papier.innerHTML, /aria-label="Acknowledged at /, "et la voix dit le mot entier du README");
  assert.doesNotMatch(
    papier.innerHTML,
    /pli__souffrance/,
    "l'écran affichait « Accusée » ET « En souffrance depuis 9 h » sur la MÊME lettre : le coup de " +
      "tampon refaisait le cachet et le pied, et laissait le morceau qu'il n'avait pas nommé"
  );
  assert.ok(!papier.innerHTML.includes("Overdue"), `aucun morceau du cri ne doit rester (${papier.innerHTML})`);

  // CONTRÔLE POSITIF, ET C'EST LUI QUI FERME LA CLASSE : le papier retamponné
  // dit EXACTEMENT ce que le seul peintre du pli dirait. Ce n'est donc pas « le
  // cri a disparu » qu'on prouve, c'est « plus aucun morceau ne peut être
  // oublié » — le prochain morceau ajouté au pli sera couvert sans rien écrire.
  assert.equal(
    papier.innerHTML.replace(/ cachet--frappe/g, ""),
    dessinerPli(normaliserLettre({ ...avant, ...apres }), local),
    "après un coup de tampon, le papier doit être le dessin du pli neuf, à l'animation près"
  );
  // Et l'animation reste : le tampon se VOIT tomber, ce n'est pas un rechargement muet.
  assert.match(papier.innerHTML, /cachet--frappe/, "le coup de tampon garde sa frappe");
  assert.equal(papier.className, "pli", "et la classe du pli suit la lettre neuve");

  // ── LA MÊME LOI, DITE SANS PAPIER ───────────────────────────────────────
  // Deux marques qui ne peuvent pas être vraies ensemble ne se peignent pas
  // ensemble — même si une charge incohérente arrivait un jour par le flux.
  assert.equal(
    criDeLaLettre(normaliserLettre({ ...apres, en_souffrance: avant.en_souffrance })),
    "",
    "une lettre accusée ne crie pas, quoi qu'on lui accroche"
  );
  assert.equal(
    criDeLaLettre(normaliserLettre(avant)),
    ligneDeSouffrance(normaliserLettre(avant).en_souffrance),
    "et le cri d'une lettre non accusée reste celui du produit, mot pour mot"
  );
});

/* ══ IMPORTANT 11 — le front ne lisait RIEN de ce que /api/poster lui rend ═ */

test("le dépôt se RELIT : `msg_id`, `rejeu` et `clef_ecartee` — sans quoi une lettre se dédouble", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });
  registerPeer(db, { id: "claude-alice", status: "active" });

  async function poster(corps) {
    const r = await requete(base, "/api/poster", { methode: "POST", cookie, corps });
    assert.equal(r.statut, 200, `SONDE IMPOSSIBLE : le dépôt a échoué (${JSON.stringify(r.json)})`);
    return r.json;
  }

  // ── ① LE CAS SAIN : la clef de la page est acceptée, rien ne se dit ─────
  const clef = "msg-11111111-1111-4111-8111-111111111111";
  const neuve = await poster({ a: "bob-eternal", corps: "premiere", type: "message", msg_id: clef });
  assert.equal(neuve.msg_id, clef, "SONDE : la porte a bien déposé sous la clef demandée");
  const saine = suiteDuDepot(neuve, clef);
  assert.equal(saine.msgId, clef);
  assert.equal(saine.reclasser, false, "rien à reclasser quand la clef a été honorée");
  assert.equal(saine.note, null, "le silence des cas sains");
  assert.equal(saine.alerte, null);

  // ── ② LE REJEU : la même clef rejouée. C'est l'idempotence qui FONCTIONNE ─
  const rejouee = await poster({ a: "bob-eternal", corps: "premiere", type: "message", msg_id: clef });
  assert.ok(rejouee.rejeu, `SONDE : l'API doit annoncer le rejeu (${JSON.stringify(rejouee)})`);
  assert.equal(rejouee.msg_id, clef, "SONDE : un rejeu rend LA lettre, jamais une deuxième (R2)");
  assert.equal(rejouee.seq, neuve.seq, "SONDE : et c'est bien la même ligne");
  const suiteRejeu = suiteDuDepot(rejouee, clef);
  assert.equal(suiteRejeu.reclasser, false, "le rejeu garde la clef : rien ne se reclasse");
  assert.ok(suiteRejeu.note, "un rejeu se DIT : sinon l'opérateur ne sait pas si son renvoi a doublé sa lettre");
  assert.equal(suiteRejeu.alerte, null, "…mais calmement : rien n'a été perdu, c'est la loi qui a tenu");
  assert.doesNotMatch(
    suiteRejeu.note,
    /lost|lose|discard|another identifier/i,
    "un rejeu n'est pas une perte, et ne se dit pas comme une perte"
  );

  // ── ③ LA CLEF ÉCARTÉE : elle appartenait au courrier de deux TIERS ──────
  const tiers = insertMessage(db, { sender: "bob-eternal", recipient: "claude-alice", body: "entre eux" });
  const detournee = await poster({
    a: "bob-eternal",
    corps: "ce que je viens de taper",
    type: "message",
    msg_id: tiers.msg_id
  });
  assert.ok(detournee.clef_ecartee, `SONDE : l'API doit annoncer la clef écartée (${JSON.stringify(detournee)})`);
  assert.equal(detournee.clef_ecartee.demandee, tiers.msg_id);
  assert.notEqual(detournee.msg_id, tiers.msg_id, "SONDE : la lettre est partie sous une AUTRE clef");

  const suiteEcart = suiteDuDepot(detournee, tiers.msg_id);
  // ⚠️ LE CŒUR DE LA TROUVAILLE. Le pli restait classé sous la clef que la page
  // avait choisie ; le bureau, lui, connaît l'autre. L'écho du flux ne
  // retrouvait donc PAS le papier et en déposait un SECOND : la lettre se
  // dédoublait à l'écran, et la première moitié restait « en attente » à vie.
  assert.equal(
    suiteEcart.msgId,
    detournee.msg_id,
    "le msg_id de la RÉPONSE fait foi : sans ça, l'écho du flux dépose un second papier et la lettre se dédouble"
  );
  assert.equal(suiteEcart.reclasser, true, "et le pli doit changer de casier, pas seulement de nom");
  assert.ok(suiteEcart.alerte, "une clef écartée se dit FORT : ce n'est pas la loi qui tient, c'est un accident");
  assert.notEqual(suiteEcart.alerte, suiteRejeu.note, "rejeu et clef écartée ne sont pas la même nouvelle");

  // Ces deux-là ne se confondent JAMAIS : l'API a été écrite exprès pour les
  // distinguer (guichet.js ⑧), et une surface qui les refond perd l'information.
  assert.equal(suiteRejeu.alerte, null);
  assert.equal(suiteEcart.note, null);

  // ET LE TEXTE N'EST PAS PERDU — il est au bureau, sous la clef neuve. C'est
  // vérifié ici parce que c'est la seule raison pour laquelle on préfère un
  // doublon à une lettre perdue (A8) : le dire sans le mesurer serait une foi.
  const auBureau = getMessageById(db, detournee.msg_id);
  assert.equal(auBureau.body, "ce que je viens de taper");
  assert.equal(auBureau.sender, MOI);

  // LE CÂBLAGE, pas seulement le vocabulaire (même instrument que le plafond).
  const page = source("src", "web", "public", "app.js");
  assert.ok(
    page.split("suiteDuDepot").length - 1 >= 2,
    "savoir lire la réponse ne sert à rien si `envoyer` ne l'appelle pas"
  );
});

/* ══ IMPORTANT 12 — bureau neuf : aucune destination, et « Poster » se tait ═ */

test("un bureau sans aucune boîte EXPLIQUE son guichet fermé — un bouton qui ne fait rien est le pire état", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);

  // Un bureau NEUF : la porte y inscrit sa propre fiche, et c'est la seule —
  // donc aucune destination, donc « Poster » n'avait rien à faire, en silence.
  const seul = await pairsReels(base, cookie);
  assert.deepEqual(seul.pairs.map((p) => p.nom), [MOI], "SONDE : sur un bureau neuf, l'opérateur est bien la seule fiche");
  const neuves = seul.pairs.map(normaliserBoite);
  assert.equal(choisirLaDestination(neuves, null, MOI), null, "SONDE : il n'y a bien aucune destination");

  const ferme = etatDuGuichet(neuves, null, MOI);
  assert.equal(ferme.ouvert, false, "le bouton restait actif et ne faisait RIEN sous le doigt");
  assert.ok(ferme.raison, "un guichet fermé qui ne dit pas pourquoi est pire qu'un guichet fermé");
  // LE REGISTRE DE LA MAQUETTE : « une erreur n'accuse pas, n'excuse pas, dit
  // ce qui s'est passé et quoi faire ». Donc le fait, puis le geste.
  assert.match(ferme.raison, /mailbox|registry/i, "ce qui s'est passé : le registre ne porte aucune autre boîte");
  // `register` et pas `regist` : « registry » est déjà dans la première moitié.
  assert.match(ferme.raison, /\bregister\b/i, "et quoi faire : une session doit s'inscrire pour recevoir du courrier");
  assert.doesNotMatch(ferme.raison, /error|sorry|impossible|unable/i, "on n'accuse pas, on n'excuse pas");

  // ET LE CONTRÔLE POSITIF : dès qu'une boîte existe, le guichet rouvre et se tait.
  registerPeer(db, { id: "bob-eternal", status: "active" });
  const deux = (await pairsReels(base, cookie)).pairs.map(normaliserBoite);
  const ouvert = etatDuGuichet(deux, choisirLaDestination(deux, null, MOI), MOI);
  assert.equal(ouvert.ouvert, true, "une garde qui ne rouvre jamais est un mur, pas une garde");
  assert.equal(ouvert.raison, null, "le silence des cas sains");

  // Une boîte HORS SERVICE reste une destination : la lettre attendra (A9).
  // Le guichet ne se ferme donc pas pour elle — ce serait retirer un droit.
  unregisterPeer(db, "bob-eternal");
  const endormie = (await pairsReels(base, cookie)).pairs.map(normaliserBoite);
  assert.equal(
    etatDuGuichet(endormie, choisirLaDestination(endormie, null, MOI), MOI).ouvert,
    true,
    "écrire à une boîte endormie reste permis : la lettre attendra, elle ne se perdra pas"
  );

  // LE CÂBLAGE : la phrase doit être posée dans la page et habillée.
  const page = source("src", "web", "public", "app.js");
  assert.ok(page.split("etatDuGuichet").length - 1 >= 2, "la page doit APPELER l'état, pas seulement savoir le dire");
  // La phrase a besoin d'une PRISE dans la page et d'un habillage : sans les
  // deux, la page sait la dire et n'a nulle part où la poser.
  assert.match(page, /guichet-ferme/, "la page doit tenir la prise où la phrase se pose");
  assert.match(
    source("src", "web", "public", "index.html"),
    /id="guichet-ferme"[^>]*class=|class="guichet__ferme"[^>]*id="guichet-ferme"/,
    "et la prise doit exister dans le document, sous la classe de la maquette"
  );
  assert.match(source("src", "web", "public", "style.css"), /\.guichet__ferme/, "habillée au registre de la maquette");
});

/* ══ IMPORTANT 13 — l'écran se contredisait sur une fiche archivée ════════ */

test("une fiche retirée du service n'est pas « inconnue du registre » — l'avis dit ce que la base dit", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "claude-alice", status: "active" });
  unregisterPeer(db, "claude-alice"); // le geste réel : on range la chaise

  const pairs = await pairsReels(base, cookie);
  const fiche = pairs.pairs.find((p) => p.nom === "claude-alice");
  assert.ok(fiche, "SONDE IMPOSSIBLE : la fiche a disparu du registre (Camp B)");
  assert.equal(fiche.en_service, false);
  assert.equal(fiche.libelle, "retired from service", "SONDE : le produit sait très bien la nommer");

  const depot = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "claude-alice", corps: "tu es encore là ?", type: "message" }
  });
  assert.equal(depot.statut, 200, "SONDE : la lettre part quand même — elle attendra (A9)");
  assert.ok(depot.json.attente, `SONDE IMPOSSIBLE : aucun avis d'attente (${JSON.stringify(depot.json)})`);
  assert.equal(depot.json.attente.motif, "destinataire-inconnu", "SONDE : c'est bien CE motif que l'API rend");
  // T4b-b (18/10) : l'avis anglais dit ce que la base dit — personne EN
  // SERVICE ne répond — et ne prétend plus que le nom est inconnu du registre.
  assert.match(
    depot.json.attente.message,
    /^No peer in service answers to this name: /,
    "SONDE : l'avis du bureau, à côté d'une colonne qui dit « retired from service »"
  );
  assert.doesNotMatch(depot.json.attente.message, /unknown to the registry/, "l'API ne contredit plus la colonne");

  // T4b-c (18/10) : LA PAGE NE REDRESSE PLUS. Elle coupait l'avis français sur
  // « : » pour en remplacer le diagnostic ; l'avis anglais est VRAI de cette
  // fiche (personne en service ne répond), donc la page le pose tel quel. Ce
  // qu'on prouve ici est la même chose qu'avant : la colonne et l'avis, posés
  // côte à côte sur la même boîte, peuvent être vrais ensemble.
  const avis = depot.json.attente.message;
  const colonne = dessinerBoite(normaliserBoite(fiche), null);
  assert.ok(colonne.includes("retired from service"), `SONDE : la colonne dit le libellé du produit (${colonne})`);
  assert.doesNotMatch(
    avis,
    /unknown|inconnu/i,
    "la colonne dit « retired from service » : un avis qui dirait le nom inconnu la contredirait"
  );
  // LE REMÈDE DU BUREAU NE SE JETTE PAS : c'est lui qui dit quoi faire.
  assert.ok(avis.includes("valxos-chaise reexpedier"), `l'avis porte le remède du bureau, mot pour mot (${avis})`);

  // SANS FICHE AU REGISTRE, le même motif, et un avis tout aussi vrai : la page
  // n'a pas besoin de la colonne pour le rendre juste.
  const vraimentInconnu = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "personne-de-ce-nom", corps: "au hasard", type: "message" }
  });
  assert.equal(vraimentInconnu.statut, 200);
  assert.equal(vraimentInconnu.json.attente.motif, "destinataire-inconnu");
  assert.match(vraimentInconnu.json.attente.message, /^No peer in service answers to this name: /);

  // LE CÂBLAGE : la page pose l'avis du bureau TEL QUEL, sans le découper. Une
  // découpe sur la ponctuation d'une prose casse en silence au premier
  // changement de langue — c'est ce qui était arrivé à « : ».
  const page = source("src", "web", "public", "app.js");
  assert.doesNotMatch(page, /redresserLAvis/, "plus de redressement : l'avis du bureau est vrai de la fiche");
  assert.match(page, /poserAvis\(corps\.attente\.message\)/, "la page pose le message de l'API, mot pour mot");
});

/* ══ MINEUR 14 — `accuses_refuses` : l'API le rend, personne ne le lisait ══ */

test("un accusé que la relève n'a PAS pu signer se dit — ce qui est tu se lit « tout va bien »", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });

  // LE DÉCOR RÉEL : la fiche de l'opérateur est retirée du service pendant que
  // du courrier arrive. La relève remet la lettre mais `ackMessage` refuse de
  // la signer (`droitDAccuser` : « destinataire retiré du service »).
  unregisterPeer(db, MOI);
  const pli = insertMessage(db, { sender: "bob-eternal", recipient: MOI, body: "pendant que ta fiche dort" });

  const fil = await filReel(base, cookie);
  assert.ok(
    Array.isArray(fil.accuses_refuses) && fil.accuses_refuses.length > 0,
    `SONDE IMPOSSIBLE : l'API n'a rendu aucun refus (${JSON.stringify(fil.accuses_refuses)})`
  );
  const refus = fil.accuses_refuses.find((r) => r.msg_id === pli.msg_id);
  assert.ok(refus, "SONDE : le refus porte bien sur CETTE lettre");
  assert.equal(refus.raison, "recipient retired from service");

  const parPli = refusDesAccuses(fil);
  assert.ok(parPli instanceof Map, "la page range les refus par msg_id : un pli, un motif");
  assert.equal(
    parPli.get(pli.msg_id),
    refus.raison,
    "l'API le dit, la page l'ignorait — même doctrine que le plafond : ce qui est tu se lit « tout va bien »"
  );
  assert.equal(parPli.size, fil.accuses_refuses.length, "aucun refus ne se perd en chemin");

  // ET ÇA SE VOIT SUR LE PLI, par le canal qui existe déjà pour les refus.
  const lettre = normaliserLettre(fil.lettres.find((l) => l.msg_id === pli.msg_id));
  // ⚠️ SON PROPRE CHAMP. Un refus d'accusé signé À LA MAIN par l'opérateur vit
  // dans `local.refus` : partager le champ ferait que chaque relève efface son
  // motif — la même maladie dans l'autre sens.
  const html = pied(lettre, { ...PLI_SAIN, refusDeLaReleve: parPli.get(pli.msg_id) });
  assert.match(html, /pli__refus/, "le motif se pose là où les motifs se posent déjà");
  assert.ok(html.includes(refus.raison), `et c'est la raison du bureau, mot pour mot (${html})`);
  // Les deux refus tiennent ENSEMBLE sur un même pli, sans s'écraser.
  const lesDeux = pied(lettre, { ...PLI_SAIN, refus: "à la main", refusDeLaReleve: refus.raison });
  assert.ok(lesDeux.includes("à la main"), `le refus manuel survit à la relève (${lesDeux})`);
  assert.ok(lesDeux.includes(refus.raison), "et celui de la relève aussi");

  // Le silence des cas sains : une relève qui a tout signé ne rend pas la clef.
  registerPeer(db, { id: MOI, status: "active" });
  insertMessage(db, { sender: "bob-eternal", recipient: MOI, body: "et maintenant ça passe" });
  const sain = await filReel(base, cookie);
  assert.equal(sain.accuses_refuses, undefined, "SONDE : rien à dire quand rien n'a été refusé");
  assert.equal(refusDesAccuses(sain).size, 0, "et la page ne s'invente pas un refus");
  assert.equal(refusDesAccuses({}).size, 0);
  assert.equal(refusDesAccuses(null).size, 0);

  const page = source("src", "web", "public", "app.js");
  assert.ok(page.split("refusDesAccuses").length - 1 >= 2, "savoir les lire ne sert à rien si le fil ne les pose pas");
});

/* ══ MINEUR 15 — le cachet est le dessin de la maison, jusqu'à l'onglet ═══ */

test("la page porte son icône : plus de 404 `favicon.ico` dans la console d'une page qu'on va filmer", async (t) => {
  const html = source("src", "web", "public", "index.html");
  const lien = html.match(/<link[^>]*rel="icon"[^>]*>/);
  assert.ok(lien, `SONDE : aucune icône déclarée — chaque ouverture laissait une 404 dans la console (${html.slice(0, 200)})`);
  assert.match(lien[0], /href="data:image\/svg\+xml/, "en data: URI — la CSP l'autorise déjà, et ça n'ouvre pas une route de plus");

  // LA LISTE DES ROUTES EST FERMÉE (contrat, garde n°1). Une icône servie par
  // un chemin serait une route à ajouter au tableau ET au contrat ; embarquée
  // dans la page, elle n'en ajoute aucune. On le PROUVE plutôt que de le dire.
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });
  const perdue = await requete(base, "/favicon.ico", { cookie });
  assert.equal(perdue.statut, 404, "et /favicon.ico reste hors du tableau : la garde n°1 ne bouge pas d'un pouce");

  // ET C'EST LE DESSIN DE LA MAISON, pas un carré au hasard : le cachet de la
  // page (`dessinerCachet`) est fait de cercles concentriques et d'une barre.
  const icone = decodeURIComponent(lien[0].match(/href="([^"]*)"/)[1]);
  assert.match(icone, /<circle/, "le cachet, jusque dans l'onglet");
  // Les guillemets du SVG sont SIMPLES : il vit dans un attribut `href="…"`,
  // les doubles le fermeraient au premier attribut.
  assert.match(icone, /viewBox='0 0 46 46'/, "au même cadre que le cachet du pli");
  assert.match(icone, /<path/, "et sa barre d'oblitération, comme un cachet accusé");
});

/* ══ 5e PASSE, MINEUR — LE FIL VIDE NE CONTREDIT PLUS LE GUICHET ══════════ */

// Sur un bureau NEUF, la page tenait deux discours à dix centimètres l'un de
// l'autre : le fil disait « Écris la première » et le guichet, juste dessous,
// expliquait qu'il n'y a personne à qui écrire — bouton éteint, champ éteint.
// Deux messages qui se contredisent dans la même page valent moins que zéro
// message : le lecteur croit avoir mal fait quelque chose.
test("un fil vide dit la MÊME chose que le guichet — jamais « Écris la première » quand personne ne peut recevoir", async (t) => {
  const { base, cookie } = await porteOuverte(t);

  // LE BUREAU NEUF, RÉEL : la porte n'inscrit que la fiche de l'opérateur.
  const boites = (await pairsReels(base, cookie)).pairs.map(normaliserBoite);
  const ferme = etatDuGuichet(boites, null, MOI);
  assert.equal(ferme.ouvert, false, `SONDE IMPOSSIBLE : le guichet devrait être fermé (${JSON.stringify(boites)})`);

  const phraseFermee = phraseDuFilVide(ferme);
  assert.ok(
    !/Write the first one/.test(phraseFermee),
    `le fil invitait à écrire pendant que le guichet disait qu'il n'y a personne à qui écrire (« ${phraseFermee} »)`
  );
  // ET C'EST LE MOT DU GUICHET, pas une deuxième formulation : deux phrases
  // pour un seul fait finissent toujours par diverger.
  assert.ok(
    phraseFermee.includes(ferme.raison),
    `le fil doit reprendre la raison du guichet mot pour mot (« ${phraseFermee} » vs « ${ferme.raison} »)`
  );

  // ET L'INVITATION RESTE quand elle est vraie : un bureau où l'on PEUT écrire.
  const ouvert = etatDuGuichet(boites, "bob-eternal", MOI);
  assert.equal(ouvert.ouvert, true, "SONDE : avec une destination choisie, le guichet est ouvert");
  assert.match(
    phraseDuFilVide(ouvert),
    /Write the first one/,
    "quand écrire est possible, la page le propose — on ne répare pas une contradiction en devenant muet"
  );
});

/* ══ 5e PASSE, MINEUR — LE BOUTON D'ACCUSÉ NE SE REPROPOSE PAS POUR RIEN ═══ */

// `accuser` éteint son bouton, puis `rafraichirLePied` redessine le pied — et
// le bouton revenait RÉACTIVÉ, juste au-dessus du motif qui explique que le
// même clic recevra le même refus. C'est la loi déjà écrite pour « Réessayer »
// (`avarieDuRefus`), qui n'avait jamais été appliquée à l'accusé.
test("un accusé REFUSÉ par le bureau ne réoffre pas son bouton — la même loi que « Réessayer »", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });
  // UNE DIFFUSION : la relève la REMET mais refuse de la signer à la place de
  // l'opérateur (`accuseImplicite` : seul `message` en priorité ordinaire l'est).
  // C'est donc exactement le pli qui porte le bouton.
  const recue = insertMessage(db, {
    sender: "bob-eternal",
    recipient: MOI,
    body: "à signer",
    msg_type: "broadcast"
  });

  // La lettre passe par la VRAIE relève : c'est elle qui la met en « reçue ».
  const fil = await filReel(base, cookie);
  const lettre = normaliserLettre(fil.lettres.find((l) => l.msg_id === recue.msg_id));
  assert.equal(normaliser(lettre.etat), "reçue", `SONDE IMPOSSIBLE : l'état rendu est « ${lettre.etat} »`);
  assert.match(
    pied(lettre, { ...PLI_SAIN }),
    /data-accuser/,
    "SONDE : dans le cas sain le bouton est bien offert — sinon la suite ne prouverait rien"
  );

  // LE REFUS EST RÉEL : la fiche de l'opérateur dort, `droitDAccuser` refuse.
  unregisterPeer(db, MOI);
  const refuse = await requete(base, "/api/accuser", { methode: "POST", cookie, corps: { msg_id: recue.msg_id } });
  assert.ok(refuse.statut >= 400 && refuse.statut < 500, `SONDE : le bureau doit JUGER cette lettre-là (${refuse.statut})`);
  const avarie = avarieDuRefus(refuse.statut, refuse.json);
  assert.equal(avarie.rejouable, false, "SONDE : un 4xx est un jugement, pas une panne");

  // ── L'EFFET SUR LE PIED, qui est l'endroit où le bouton sort ────────────
  const apresRefus = pied(lettre, { ...PLI_SAIN, refus: avarie.motif, accuseRejouable: avarie.rejouable });
  assert.doesNotMatch(
    apresRefus,
    /data-accuser/,
    `le bouton invitait à refaire un geste que le bureau vient de refuser à l'identique (${apresRefus})`
  );
  // ET LE MOTIF RESTE — retirer le bouton sans dire pourquoi serait pire.
  assert.match(apresRefus, /pli__refus/, "le motif du bureau reste : c'est lui qui dit quoi faire à la place");
  assert.ok(apresRefus.includes(avarie.motif), `et c'est le mot du bureau (${apresRefus})`);

  // UNE PANNE, ELLE, SE REJOUE. Le bouton doit revenir : sinon un hoquet
  // réseau éteindrait l'accusé d'une lettre pour toujours.
  const panne = avarieDuRefus(0, null);
  assert.equal(panne.rejouable, true, "SONDE : sans réponse du tout, la reprise a un sens");
  assert.match(
    pied(lettre, { ...PLI_SAIN, refus: panne.motif, accuseRejouable: panne.rejouable }),
    /data-accuser/,
    "après une panne le bouton revient — la loi porte sur le JUGEMENT, pas sur l'échec"
  );
});

/* ══ 5e PASSE, MINEUR — UN SEUL DOSSIER PUBLIC : ANNONCÉ = SERVI ══════════ */

// `ROUTES` est un `const` de module : il énumère les polices depuis
// `RACINE_PUBLIQUE`. `servirLeFichier`, lui, lisait dans `contexte.racinePublique`.
// Une porte créée avec une autre racine annonçait donc les routes du dossier
// LIVRÉ et lisait dans le dossier SERVI. Défaut LATENT — personne ne passait le
// paramètre — mais la garde n°1 tout entière (`web-garde-spawn`,
// `web-repartiteur`, `web-chemin-ecrit`) est ancrée sur ce `ROUTES` de module :
// rendre la table PROPRE À CHAQUE PORTE aurait mis la table réellement servie
// hors de portée de la garde. On ferme donc dans l'autre sens — un seul
// dossier, celui du dépôt — et ce test le prouve par l'octet servi.
test("une porte ne peut PAS être servie depuis un autre dossier public — annoncé et servi sont le même", async (t) => {
  const faux = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-faux-public-"));
  t.after(() => fs.rmSync(faux, { recursive: true, force: true }));
  fs.writeFileSync(path.join(faux, "app.js"), "/* CECI N'EST PAS LA PAGE DU DÉPÔT */");
  fs.mkdirSync(path.join(faux, "polices"));
  fs.writeFileSync(path.join(faux, "polices", "intruse.woff2"), "pas une police");

  const db = bureauJetable(t);
  const ouverte = await porteDeTest(t, { db, racinePublique: faux });
  const { cookie } = await cookieDePremiereVisite(ouverte.base);

  // ① LE FICHIER SERVI EST CELUI DU DÉPÔT, à l'octet près.
  const servi = await requete(ouverte.base, "/app.js", { cookie });
  assert.equal(servi.statut, 200, `SONDE : /app.js est bien dans la table (${servi.texte})`);
  assert.equal(
    servi.texte,
    source("src", "web", "public", "app.js"),
    "la porte a servi le dossier qu'on lui a soufflé, pas celui dont elle annonce la table"
  );

  // ② ET LES POLICES ANNONCÉES EXISTENT VRAIMENT LÀ OÙ LA PORTE LIT. C'est le
  //    symptôme exact du défaut : la table nommait le dossier livré, la lecture
  //    allait ailleurs — chaque police annoncée répondait « fichier-absent ».
  const police = fs
    .readdirSync(path.join(racine, "src", "web", "public", "polices"))
    .filter((n) => n.endsWith(".woff2"))
    .sort()[0];
  assert.ok(police, "SONDE IMPOSSIBLE : aucune police au dépôt");
  const servieP = await requete(ouverte.base, `/polices/${police}`, { cookie });
  assert.equal(servieP.statut, 200, `une police ANNONCÉE par la table doit être SERVIE (${servieP.texte})`);

  // ③ ET LE DOSSIER SOUFFLÉ N'OUVRE AUCUNE ROUTE : la table reste fermée.
  const intruse = await requete(ouverte.base, "/polices/intruse.woff2", { cookie });
  assert.equal(intruse.statut, 404, "un fichier hors du dépôt n'entre pas dans la table par la fenêtre");

  // ④ ET LE CANAL DE DÉRIVE EST FERMÉ À LA SOURCE, pas seulement son symptôme :
  //    le contexte ne porte plus de racine à lui.
  assert.equal(
    "racinePublique" in ouverte.contexte,
    false,
    "tant que le contexte porte sa propre racine, les deux dossiers peuvent rediverger demain"
  );
});

/* ══ 5e PASSE, MINEUR — L'ICÔNE EST À L'ENCRE DE LA MAQUETTE ══════════════ */

// Le design est VALIDÉ : la palette est celle de la maquette, point. L'icône de
// l'onglet introduisait un rouge voisin (#C4553F) que `style.css` ne déclare
// nulle part, et son commentaire jurait que le dessin est « celui du cachet du
// pli ». Un commentaire qui jure le faux est pire que pas de commentaire.
test("l'icône de l'onglet n'invente aucune couleur — l'encre du cachet, celle de la palette", async () => {
  const css = source("src", "web", "public", "style.css");
  const cachet = css.match(/--cachet:\s*(#[0-9A-Fa-f]{6})/);
  assert.ok(cachet, "SONDE IMPOSSIBLE : la palette ne déclare pas `--cachet`");

  const html = source("src", "web", "public", "index.html");
  const icone = decodeURIComponent(html.match(/<link[^>]*rel="icon"[^>]*href="([^"]*)"/)[1]);
  const couleurs = [...new Set(icone.match(/#[0-9A-Fa-f]{6}/g) || [])];
  assert.ok(couleurs.length > 0, `SONDE IMPOSSIBLE : aucune couleur dans l'icône (${icone})`);
  for (const couleur of couleurs) {
    assert.equal(
      couleur.toUpperCase(),
      cachet[1].toUpperCase(),
      `l'icône peint « ${couleur} » : hors palette, et le commentaire dit le contraire`
    );
  }

  // ET LE COMMENTAIRE NE JURE PLUS À L'AVEUGLE : il NOMME l'encre, donc la
  // prochaine dérive se voit à la lecture au lieu de se cacher derrière
  // « c'est le dessin du cachet ».
  const note = html.match(/<!--[\s\S]*?-->\s*<link[^>]*rel="icon"/);
  assert.ok(note, "SONDE IMPOSSIBLE : l'icône n'a pas de commentaire");
  assert.ok(
    note[0].toUpperCase().includes(cachet[1].toUpperCase()),
    `le commentaire doit nommer l'encre qu'il promet (${note[0]})`
  );
});

/* ══ 5e PASSE — LE RECLASSEMENT, QUI N'ÉTAIT VERROUILLÉ NULLE PART ═════════ */

// `suiteDuDepot` est éprouvée plus haut : elle DIT « reclasse ». Mais le geste
// qui la justifie — le pli qui change de CASIER quand le bureau rend un autre
// msg_id — ne l'était nulle part. Or c'est LUI qui empêche le dédoublement :
// sans casier changé, l'écho du flux arrive sous la clef du bureau, ne trouve
// aucun papier, et `accueillir` en dépose un SECOND. Une décision sans son
// geste est une intention, pas un remède.
test("le pli CHANGE DE CASIER quand le bureau rend une autre clef — sinon l'écho du flux le dédouble", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });
  registerPeer(db, { id: "claude-alice", status: "active" });

  // LE DÉCOR EST RÉEL, comme partout dans ce fichier : la clef que la page
  // choisit est prise par du courrier entre deux TIERS, et c'est la porte qui
  // décide d'en poser une autre. Aucune réponse d'API n'est écrite à la main.
  const tiers = insertMessage(db, { sender: "bob-eternal", recipient: "claude-alice", body: "entre eux" });
  const clefLocale = tiers.msg_id;
  const depot = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "bob-eternal", corps: "ce que je viens de taper", type: "message", msg_id: clefLocale }
  });
  assert.equal(depot.statut, 200, `SONDE IMPOSSIBLE : le dépôt a échoué (${depot.texte})`);
  assert.notEqual(depot.json.msg_id, clefLocale, "SONDE : la porte a bien déposé sous une AUTRE clef");
  const suite = suiteDuDepot(depot.json, clefLocale);
  assert.equal(suite.reclasser, true, "SONDE : c'est bien le cas où la page doit reclasser");

  // LE CASIER, exactement celui que la page tient (`parId`) : msg_id → pli.
  const element = papierDeTest("");
  element.dataset.msgId = clefLocale;
  const entree = { brut: { msg_id: clefLocale }, element, local: { ...PLI_SAIN } };
  const casier = new Map([[clefLocale, entree]]);

  // ⚠️ CE QUE LE DÉDOUBLEMENT EXIGE, MESURÉ AVANT LE GESTE : sous la clef du
  // bureau, le casier ne connaît personne. C'est exactement l'état dans lequel
  // `accueillir` dépose un SECOND papier. Sans cette ligne, l'assertion
  // d'après pourrait être vraie sans que rien n'ait bougé.
  assert.equal(casier.get(depot.json.msg_id), undefined, "SONDE : avant le geste, la clef du bureau ne désigne rien");

  reclasserLePli(entree, clefLocale, suite.msgId, casier);

  // ① SOUS LA CLEF DU BUREAU, C'EST LE MÊME PAPIER — pas un deuxième.
  assert.equal(
    casier.get(depot.json.msg_id),
    entree,
    "l'écho du flux arrive sous la clef du BUREAU : s'il n'y trouve pas ce papier-ci, il en dépose un second"
  );
  // ② ET L'ANCIENNE CLEF NE DÉSIGNE PLUS RIEN. La laisser serait garder deux
  //    entrées pour un seul papier : le pli répondrait à deux noms, et le
  //    casier grossirait d'un fantôme à chaque clef écartée.
  assert.equal(casier.has(clefLocale), false, "la clef que la page avait choisie ne désigne plus rien");
  assert.equal(casier.size, 1, "un papier, un casier — jamais deux entrées pour le même pli");
  // ③ ET LE PAPIER LUI-MÊME PORTE LA CLEF DU BUREAU : « Réessayer » et
  //    « Accuser » lisent `data-msg-id` sur le pli cliqué, pas le casier.
  //    Renommer l'un sans l'autre rend le pli injoignable de l'autre côté.
  assert.equal(element.dataset.msgId, depot.json.msg_id, "le clic lit `data-msg-id` : il doit nommer la clef du bureau");

  // LE SILENCE DES CAS SAINS : la clef honorée ne reclasse rien, et surtout ne
  // vide pas le casier au passage.
  const saine = new Map([[clefLocale, entree]]);
  reclasserLePli(entree, clefLocale, clefLocale, saine);
  assert.equal(saine.get(clefLocale), entree, "une clef honorée ne déplace rien");
  reclasserLePli(entree, clefLocale, "", saine);
  assert.equal(saine.get(clefLocale), entree, "et une clef vide n'efface pas le pli du casier");
});

/* ══ 5e PASSE — LA POSE DES ACCUSÉS REFUSÉS : L'EFFET, PAS UN GREP ════════ */

// Le seul verrou de la POSE était `page.split("refusDesAccuses").length - 1 >= 2`
// (plus haut, MINEUR 14) : une recherche de texte dans la source. Un grep n'est
// pas un oracle — il reste vert si la fonction est appelée au mauvais moment,
// deux fois, ou jamais dans le vrai chemin. Ici on pose vraiment le dessin sur
// un papier et on le relit après le geste, avec l'instrument qui existe déjà
// (aide-dom.js) : c'est la même leçon que `retamponner`, dont le défaut n'était
// dans AUCUNE fonction pure.
test("l'accusé refusé se POSE sur le pli, et s'en RETIRE quand la cause s'éteint", async (t) => {
  const { db, base, cookie } = await porteOuverte(t);
  registerPeer(db, { id: "bob-eternal", status: "active" });

  // Le décor réel du MINEUR 14 : la fiche de l'opérateur dort, la relève remet
  // la lettre mais `ackMessage` refuse de signer à sa place.
  unregisterPeer(db, MOI);
  const pli = insertMessage(db, { sender: "bob-eternal", recipient: MOI, body: "pendant que ta fiche dort" });
  // LE CONTRÔLE NÉGATIF EST UNE LETTRE DE OPERATEUR : la relève ne signe que ce
  // qui lui EST ADRESSÉ, donc le bureau ne la nomme jamais dans
  // `accuses_refuses`. Un second pli reçu, lui, serait refusé pareil — il ne
  // prouverait rien du tout.
  const autre = insertMessage(db, { sender: MOI, recipient: "bob-eternal", body: "et celle-ci part de chez moi" });

  const fil = await filReel(base, cookie);
  const refus = (fil.accuses_refuses || []).find((r) => r.msg_id === pli.msg_id);
  assert.ok(refus, `SONDE IMPOSSIBLE : l'API n'a rendu aucun refus pour ce pli (${JSON.stringify(fil.accuses_refuses)})`);

  // DEUX PAPIERS, VRAIMENT POSÉS. Le second est le contrôle négatif : il ne
  // doit RIEN recevoir tant que le bureau ne le nomme pas.
  function papierDuPli(brut) {
    const l = normaliserLettre(brut);
    const local = { ...PLI_SAIN, refusDeLaReleve: null };
    const element = papierDeTest(dessinerPli(l, local));
    element.dataset.msgId = l.msg_id;
    return { brut, element, local };
  }
  const lettres = new Map(fil.lettres.map((l) => [l.msg_id, l]));
  const marque = papierDuPli(lettres.get(pli.msg_id));
  const temoin = papierDuPli(lettres.get(autre.msg_id));
  const casier = new Map([
    [pli.msg_id, marque],
    [autre.msg_id, temoin]
  ]);
  assert.doesNotMatch(marque.element.innerHTML, /pli__refus/, "SONDE : rien n'est encore posé sur le papier");

  // ── LE GESTE ────────────────────────────────────────────────────────────
  poserLesAccusesRefuses(fil, casier);

  assert.match(marque.element.innerHTML, /pli__refus/, "le motif du bureau doit ARRIVER sur le papier, pas seulement dans un objet");
  assert.ok(
    marque.element.innerHTML.includes(refus.raison),
    `et c'est la raison du bureau, mot pour mot (${marque.element.innerHTML})`
  );
  // LE CONTRÔLE NÉGATIF : un pli que le bureau n'a pas nommé reste vierge.
  // Sans lui, une pose qui marquerait TOUT le fil passerait pour un succès.
  assert.doesNotMatch(temoin.element.innerHTML, /Automatic acknowledgement refused/, "un pli non nommé ne reçoit rien");

  // ── DEUX FOIS DE SUITE NE POSE PAS DEUX FOIS ────────────────────────────
  // La relève repasse ici à CHAQUE arrivée tant que la cause dure : deux
  // motifs empilés se liraient comme deux refus distincts.
  const apresUnCoup = marque.element.innerHTML;
  poserLesAccusesRefuses(fil, casier);
  assert.equal(marque.element.innerHTML, apresUnCoup, "la relève repasse : le motif ne doit pas s'empiler");
  assert.equal(
    marque.element.innerHTML.split("Automatic acknowledgement refused").length - 1,
    1,
    "une seule fois sur le papier, quel que soit le nombre de relèves"
  );

  // ── ET LA MARQUE S'EN VA QUAND LA CAUSE S'ÉTEINT ────────────────────────
  // C'est la moitié qu'un grep ne pourra JAMAIS voir : un motif éteint qui
  // reste à l'écran est la même maladie dans l'autre sens.
  registerPeer(db, { id: MOI, status: "active" });
  const sain = await filReel(base, cookie);
  assert.equal(sain.accuses_refuses, undefined, "SONDE : la relève signe de nouveau, plus rien à refuser");
  poserLesAccusesRefuses(sain, casier);
  assert.doesNotMatch(
    marque.element.innerHTML,
    /Automatic acknowledgement refused/,
    `la cause est éteinte : la marque doit partir du papier (${marque.element.innerHTML})`
  );
});
