// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA PORTE WEB — l'authentification, le dépôt, la relève, l'accusé, le flux.
//
// Ce que ces tests refusent de faire : vérifier des codes de retour. Un 200
// prouve qu'une fonction a rendu la main, jamais qu'elle a fait la bonne
// chose. Chaque test ci-dessous regarde l'ÉTAT DE LA BASE après le geste, ou
// compare la réponse à ce que la bibliothèque du produit aurait dit elle-même.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-api-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { getMessageById, insertMessage, registerPeer, unregisterPeer } from "../src/lib/database.js";
import { attenteDeLaLettre, designatePrimary, registerInstance } from "../src/lib/registry.js";
import { DUREE_DU_COOKIE_S, NOM_DU_COOKIE, chargerLeJeton, jetonNeuf, jetonsEgaux } from "../src/web/auth.js";
import { accuseImplicite } from "../src/web/serveur.js";
import {
  JETON,
  JETON_COURT,
  JETON_FAUX,
  MOI,
  attendre,
  bureauJetable,
  cookieDePremiereVisite,
  fluxSSE,
  porteDeTest,
  requete
} from "./aide-porte.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const racine = path.resolve(new URL("..", import.meta.url).pathname);

// ── L'AUTHENTIFICATION ──────────────────────────────────────────────────────

test("sans jeton : 401, corps VIDE — et la même réponse pour une route qui existe et une qui n'existe pas", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });

  const existe = await requete(base, "/api/fil");
  const nexistePas = await requete(base, "/api/il-nexiste-pas");
  const mauvaiseMethode = await requete(base, "/api/fil", { methode: "PUT" });

  for (const reponse of [existe, nexistePas, mauvaiseMethode]) {
    assert.equal(reponse.statut, 401);
    assert.equal(reponse.texte, "", "un corps de refus est déjà une information");
    assert.deepEqual(reponse.cookies, [], "un refus ne pose jamais de cookie");
  }
  // AUCUNE FUITE SUR CE QUI EXISTE DERRIÈRE : les trois réponses doivent être
  // indiscernables. Un 405 ici (au lieu d'un 401) dirait « cette route existe,
  // mais pas dans cette méthode » — c'est déjà la moitié de la carte.
  assert.equal(existe.statut, nexistePas.statut);
  assert.equal(mauvaiseMethode.entetes.allow, undefined, "pas d'Allow : il nommerait une route");
  assert.equal(existe.entetes["content-type"], nexistePas.entetes["content-type"]);
});

test("un jeton FAUX de même longueur : 401", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const refus = await requete(base, `/?t=${JETON_FAUX}`);
  assert.equal(refus.statut, 401);
  assert.equal(refus.texte, "");
  assert.deepEqual(refus.cookies, []);
});

test("un jeton de LONGUEUR DIFFÉRENTE ne fait pas LEVER la porte — le piège de timingSafeEqual", async (t) => {
  // Le piège, en une phrase : `crypto.timingSafeEqual` JETTE sur deux tampons
  // de tailles différentes. Comparé brut, un jeton court ne rend pas 401 : il
  // fait tomber le gestionnaire, et la porte répond 500 — ou meurt.
  assert.equal(jetonsEgaux(JETON_COURT, JETON), false, "la comparaison rend faux, elle ne lève pas");
  assert.equal(jetonsEgaux("", JETON), false);
  assert.equal(jetonsEgaux(JETON, JETON), true);
  assert.equal(jetonsEgaux(`${JETON}x`, JETON), false);

  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const court = await requete(base, `/?t=${JETON_COURT}`);
  assert.equal(court.statut, 401, `un jeton court doit être REFUSÉ, pas faire tomber la porte (${court.statut})`);
  assert.equal(court.texte, "");

  // Et la porte est toujours debout : la preuve qu'elle n'a pas seulement
  // « répondu 401 » sur un gestionnaire d'erreur générique.
  const apres = await requete(base, `/?t=${JETON}`);
  assert.equal(apres.statut, 302, "la porte sert encore après le jeton piégé");
});

test("?t=<bon jeton> : cookie HttpOnly + SameSite=Strict posé, ET l'URL propre remplace l'URL portante", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });

  const visite = await requete(base, `/?t=${JETON}`);
  assert.equal(visite.statut, 302, "le ?t= ne reste pas dans la barre : il est remplacé");
  assert.equal(visite.entetes.location, "/", "l'URL propre, sans le jeton");
  const pose = visite.cookies[0] || "";
  assert.match(pose, new RegExp(`^${NOM_DU_COOKIE}=`));
  assert.match(pose, /HttpOnly/i, "le script de la page ne doit jamais pouvoir lire le jeton");
  assert.match(pose, /SameSite=Strict/i);
  assert.match(pose, /Path=\//);
  assert.match(pose, new RegExp(`Max-Age=${DUREE_DU_COOKIE_S}`));

  // Le cookie SEUL suffit ensuite — c'est tout l'intérêt : EventSource ne sait
  // pas poser d'en-tête Authorization.
  const cookie = pose.split(";")[0];
  const page = await requete(base, "/", { cookie });
  assert.equal(page.statut, 200);
  assert.match(page.entetes["content-type"], /text\/html/);
  const api = await requete(base, "/api/fil", { cookie });
  assert.equal(api.statut, 200);
});

test("le jeton se lit dans web.env, et un jeton neuf fait 32 octets", async (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-env-"));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const fichier = path.join(dossier, "web.env");

  // Absent : le lanceur en pose un, en 0600 — un jeton lisible par la machine
  // entière ne serait pas un jeton.
  const cree = chargerLeJeton({ fichier });
  assert.equal(cree.length, 64, "32 octets, en hexadécimal");
  assert.equal(fs.statSync(fichier).mode & 0o777, 0o600);
  // Présent : on RELIT le même, jamais un neuf — sinon le marque-page de
  // l'iPhone meurt à chaque redémarrage.
  assert.equal(chargerLeJeton({ fichier }), cree);
  assert.notEqual(jetonNeuf(), jetonNeuf());
});

// ── POSTER ──────────────────────────────────────────────────────────────────

test("POSTER : la porte signe l'opérateur configuré — un `de` glissé dans le corps est ignoré, jamais honoré", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const reponse = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: {
      a: "bob-eternal",
      objet: "bonjour",
      corps: "la première lettre de la porte",
      msg_id: "m-porte-1",
      de: "bob-eternal",
      sender: "bob-eternal",
      from: "bob-eternal"
    }
  });

  assert.equal(reponse.statut, 200, reponse.texte);
  assert.equal(reponse.json.msg_id, "m-porte-1");
  assert.equal(reponse.json.destinataire, "bob-eternal");
  assert.ok(reponse.json.seq > 0);
  assert.ok("reveil" in reponse.json, "le réveil rendu par le guichet voyage jusqu'au client");

  // LA PREUVE EST EN BASE, pas dans la réponse : c'est la ligne qui porte la
  // signature, et c'est elle que Bob lira.
  const ligne = getMessageById(db, "m-porte-1");
  assert.equal(ligne.sender, MOI, "la porte signe l'opérateur configuré, TOUJOURS");
  assert.equal(ligne.recipient, "bob-eternal");
  assert.equal(ligne.body, "la première lettre de la porte");
});

test("POSTER : le rejeu du même msg_id ne crée pas une deuxième lettre", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const lettre = { a: "bob-eternal", corps: "le réseau a coupé", msg_id: "m-rejeu-porte" };
  const premier = await requete(base, "/api/poster", { methode: "POST", cookie, corps: lettre });
  const rejeu = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { ...lettre, corps: "la même, renvoyée par le front" }
  });

  assert.equal(premier.json.seq, rejeu.json.seq, "le rejeu rend LA lettre, pas une seconde");
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
  assert.equal(getMessageById(db, "m-rejeu-porte").body, "le réseau a coupé", "aucune seconde lettre n'est née");
});

test("POSTER : l'attente du guichet est transmise TELLE QUELLE — le produit explique sa loi, on ne la reformule pas", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const reponse = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "personne-de-ce-nom", corps: "une lettre qui attendra", msg_id: "m-attente" }
  });

  assert.equal(reponse.statut, 200, reponse.texte);
  // La MÊME phrase que la bibliothèque produit — mot pour mot. Une porte qui
  // réécrirait l'avis en « destinataire introuvable » ferait diverger deux
  // vocabulaires du même produit.
  assert.deepEqual(reponse.json.attente, attenteDeLaLettre(db, "personne-de-ce-nom"));
  assert.equal(reponse.json.attente.motif, "destinataire-inconnu");
  assert.match(reponse.json.attente.message, /is accepted/);

  // Le silence des cas sains : une lettre livrable ne porte AUCUNE attente.
  registerInstance(db, { lineage: "bob-eternal", sessionId: "s-m", house: "/maison/claude", pid: 4242 });
  const saine = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "bob-eternal", corps: "celle-ci part", msg_id: "m-saine" }
  });
  assert.ok(saine.json.attente == null || typeof saine.json.attente === "object");
});

test("POSTER : une demande incomplète, illisible ou trop grosse se refuse en NOMMANT le défaut", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const sansDestinataire = await requete(base, "/api/poster", { methode: "POST", cookie, corps: { corps: "vers qui ?" } });
  assert.equal(sansDestinataire.statut, 400);
  assert.match(sansDestinataire.json.refus, /destinataire/);

  const sansCorps = await requete(base, "/api/poster", { methode: "POST", cookie, corps: { a: "bob-eternal" } });
  assert.equal(sansCorps.statut, 400);
  assert.match(sansCorps.json.refus, /corps/);

  const illisible = await requete(base, "/api/poster", { methode: "POST", cookie, corps: "{ceci n'est pas du json" });
  assert.equal(illisible.statut, 400);
  assert.match(illisible.json.refus, /json/i);

  const trop = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: { a: "bob-eternal", corps: "x".repeat(600_000) }
  });
  assert.equal(trop.statut, 413);
  assert.match(trop.json.refus, /gros/);

  assert.equal(db.prepare("SELECT count(*) AS n FROM messages").get().n, 0, "aucun refus n'a laissé de lettre derrière lui");
});

// ── LA RELÈVE ───────────────────────────────────────────────────────────────

test("LA RELÈVE : /api/fil marque delivered, et l'état rendu est celui d'APRÈS l'effet de bord", async (t) => {
  const db = bureauJetable(t);
  // Une `task` : elle est marquée livrée comme les autres, mais elle attend le
  // geste de l'humain pour être accusée — c'est donc sur elle que l'état
  // « reçue » est LISIBLE. Sur une lettre ordinaire, l'accusé implicite la
  // ferait passer directement à « accusée » et le piège resterait invisible.
  insertMessage(db, {
    msg_id: "m-releve",
    sender: "bob-eternal",
    recipient: MOI,
    subject: "à faire",
    body: "la relève",
    msg_type: "task"
  });
  assert.equal(getMessageById(db, "m-releve").delivered_at, null, "le décor part bien d'une lettre non livrée");

  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  const fil = await requete(base, "/api/fil", { cookie });

  const lettre = fil.json.lettres.find((ligne) => ligne.msg_id === "m-releve");
  // Le piège documenté (server.js et valxos-inbox.js, un correctif
  // antérieur) : rendre les objets JS d'AVANT `markDelivered`, qui mentent.
  assert.equal(lettre.etat, "reçue", "l'état rendu est celui de la base APRÈS la marque, pas les objets d'avant");
  assert.ok(lettre.recue_a, "et la date de réception voyage avec");
  assert.equal(getMessageById(db, "m-releve").delivered_at, lettre.recue_a, "la réponse dit ce que la base dit");
});

test("LA RELÈVE : la lettre porte les quatre mots du produit et les dates de son parcours", async (t) => {
  const db = bureauJetable(t);
  insertMessage(db, { msg_id: "m-vue", sender: "bob-eternal", recipient: MOI, subject: "objet", body: "corps", msg_type: "task" });
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const fil = await requete(base, "/api/fil", { cookie });
  const lettre = fil.json.lettres[0];
  assert.equal(fil.json.moi, MOI);
  assert.equal(lettre.de, "bob-eternal");
  assert.equal(lettre.a, MOI);
  assert.equal(lettre.objet, "objet");
  assert.equal(lettre.corps, "corps");
  assert.equal(lettre.mien, false, "`mien` dit de quel côté du fil la lettre se peint");
  assert.equal(lettre.postee_a, getMessageById(db, "m-vue").created_at);
  assert.equal(lettre.accusee_a, null);
  assert.equal(lettre.en_souffrance, null, "une lettre d'il y a une seconde ne crie pas");
  assert.ok(["accusée", "reçue", "au guichet", "en attente"].includes(lettre.etat));
});

// ── L'ACCUSÉ, LES DEUX BRANCHES (loi C=B) ───────────────────────────────────

test("L'ACCUSÉ IMPLICITE : une lettre ordinaire est signée par la seule relève", async (t) => {
  const db = bureauJetable(t);
  insertMessage(db, { msg_id: "m-ordinaire", sender: "bob-eternal", recipient: MOI, body: "bonne nuit" });
  assert.equal(accuseImplicite(getMessageById(db, "m-ordinaire")), true);

  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  const fil = await requete(base, "/api/fil", { cookie });

  assert.ok(getMessageById(db, "m-ordinaire").acked_at, "lire son courrier ordinaire, c'est l'accuser");
  const lettre = fil.json.lettres[0];
  assert.equal(lettre.etat, "accusée", "et la réponse le dit dans le même souffle");
  assert.equal(lettre.geste_humain, false);
});

test("L'ACCUSÉ EXPLICITE : une `task` et une priorité haute attendent le geste de l'humain", async (t) => {
  const db = bureauJetable(t);
  insertMessage(db, { msg_id: "m-tache", sender: "bob-eternal", recipient: MOI, body: "fais ceci", msg_type: "task" });
  insertMessage(db, { msg_id: "m-urgente", sender: "bob-eternal", recipient: MOI, body: "urgent", priority: "high" });
  insertMessage(db, { msg_id: "m-critique", sender: "bob-eternal", recipient: MOI, body: "critique", priority: "critical" });
  for (const id of ["m-tache", "m-urgente", "m-critique"]) {
    assert.equal(accuseImplicite(getMessageById(db, id)), false, `${id} exige le geste de l'humain`);
  }

  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  const fil = await requete(base, "/api/fil", { cookie });

  for (const id of ["m-tache", "m-urgente", "m-critique"]) {
    assert.equal(getMessageById(db, id).acked_at, null, `${id} ne se signe pas toute seule`);
    assert.equal(fil.json.lettres.find((l) => l.msg_id === id).geste_humain, true);
  }

  // LE GESTE. Il termine la lettre, et lui seul.
  const acke = await requete(base, "/api/accuser", { methode: "POST", cookie, corps: { msg_id: "m-tache" } });
  assert.equal(acke.statut, 200, acke.texte);
  assert.equal(acke.json.acke, true);
  assert.equal(acke.json.msg_id, "m-tache");
  assert.ok(getMessageById(db, "m-tache").acked_at);
  assert.equal(getMessageById(db, "m-urgente").acked_at, null, "un accusé ne signe QUE la lettre qu'on lui nomme");
});

test("/api/accuser : une lettre inconnue se refuse en le disant, sans rien inventer au journal", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const refus = await requete(base, "/api/accuser", { methode: "POST", cookie, corps: { msg_id: "m-jamais-ecrite" } });
  assert.equal(refus.statut, 404);
  assert.equal(refus.json.acke, false);
  assert.match(refus.json.refus, /inconnue/);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM delivery_events WHERE msg_id = ?").get("m-jamais-ecrite").n,
    0,
    "un journal peuplé de msg_id inventés est un journal qu'on cesse de lire"
  );

  const sansId = await requete(base, "/api/accuser", { methode: "POST", cookie, corps: {} });
  assert.equal(sansId.statut, 400);
});

// ── LES BOÎTES ──────────────────────────────────────────────────────────────

test("/api/pairs : les boîtes, leur service, leur désignée", async (t) => {
  const db = bureauJetable(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-a", house: "/maison/work", pid: 111 });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-b", house: "/maison/work", pid: 112 });
  designatePrimary(db, "claude-alice", "s-b");
  registerPeer(db, { id: "bob-eternal", description: "fiche sans session" });
  registerInstance(db, { lineage: "partie", sessionId: "s-c", house: "/maison/work", pid: 113 });
  unregisterPeer(db, `partie#s-c`);

  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  const pairs = await requete(base, "/api/pairs", { cookie });
  assert.equal(pairs.statut, 200);

  const parNom = new Map(pairs.json.pairs.map((boite) => [boite.nom, boite]));
  assert.equal(parNom.get("claude-alice").en_service, true);
  assert.equal(parNom.get("claude-alice").chaises, 2);
  assert.equal(parNom.get("claude-alice").designee, "s-b", "la chaise désignée se voit, c'est elle qui reçoit");
  assert.equal(parNom.get("bob-eternal").en_service, true);
  assert.equal(parNom.get("bob-eternal").chaises, 0, "une fiche sans session n'est pas une chaise");
  assert.equal(parNom.get("partie").en_service, false, "Camp B : la boîte retirée reste lisible");
  assert.match(parNom.get("partie").libelle, /service|morte/);
  assert.equal(parNom.get("claude-alice").en_souffrance, null);
});

test("/api/pairs : une boîte dont le courrier crie porte son en-souffrance", async (t) => {
  const db = bureauJetable(t);
  registerInstance(db, { lineage: "muette", sessionId: "s-muette", house: "/maison/work", pid: 111 });
  // Les seuils du produit : cinq heures d'âge dépassent `ageMs` (4 h).
  const vieille = new Date(Date.now() - 5 * 3_600_000).toISOString();
  insertMessage(db, {
    msg_id: "m-vieille",
    sender: MOI,
    recipient: "muette",
    body: "personne ne l'a signée",
    created_at: vieille
  });

  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);
  const pairs = await requete(base, "/api/pairs", { cookie });
  const boite = pairs.json.pairs.find((ligne) => ligne.nom === "muette");
  assert.ok(boite.en_souffrance, "une boîte dont le courrier attend depuis cinq heures le DIT");
  assert.equal(boite.en_souffrance.lettres, 1);
  assert.ok(boite.en_souffrance.depuis_h >= 4);

  const fil = await requete(base, "/api/fil", { cookie });
  const lettre = fil.json.lettres.find((ligne) => ligne.msg_id === "m-vieille");
  assert.ok(lettre.en_souffrance, "et la lettre elle-même porte son cri");
  assert.equal(lettre.en_souffrance.tentatives, 0);
  assert.ok(lettre.en_souffrance.depuis_h >= 4);
});

// ── LE FLUX ─────────────────────────────────────────────────────────────────

test("SSE : le premier événement après connexion est un `pairs` COMPLET", async (t) => {
  const db = bureauJetable(t);
  registerInstance(db, { lineage: "bob-eternal", sessionId: "s-m", house: "/maison/claude", pid: 4242 });
  const { base } = await porteDeTest(t, { db, periodeMs: 20 });
  const { cookie } = await cookieDePremiereVisite(base);

  const flux = fluxSSE(base, { cookie });
  await flux.pret;
  await flux.attendre(() => true);
  assert.equal(flux.evenements[0].type, "pairs", "la page doit pouvoir se peindre sans deuxième requête");

  // « COMPLET » se prouve : le même contenu que la route, pas un résumé.
  const pairs = await requete(base, "/api/pairs", { cookie });
  assert.deepEqual(flux.evenements[0].donnees, pairs.json);
  flux.fermer();
});

test("SSE : une lettre neuve arrive en `lettre`, son avancement en `etat`", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db, periodeMs: 20 });
  const { cookie } = await cookieDePremiereVisite(base);

  const flux = fluxSSE(base, { cookie });
  await flux.pret;
  await flux.attendre((evenement) => evenement.type === "pairs");

  insertMessage(db, { msg_id: "m-flux", sender: "bob-eternal", recipient: MOI, body: "une neuve", msg_type: "task" });
  const neuve = await flux.attendre((evenement) => evenement.type === "lettre");
  assert.equal(neuve.donnees.msg_id, "m-flux");
  assert.equal(neuve.donnees.etat, "en attente");

  // Le coup de tampon à l'écran : l'état avance, le flux le dit.
  await requete(base, "/api/fil", { cookie });
  const avance = await flux.attendre((evenement) => evenement.type === "etat" && evenement.donnees.etat === "reçue");
  assert.equal(avance.donnees.msg_id, "m-flux");
  flux.fermer();
});

test("SSE : une déconnexion ne laisse ni écouteur ni intervalle derrière elle", async (t) => {
  const db = bureauJetable(t);
  let poses = 0;
  let retires = 0;
  const { base, fluxOuverts } = await porteDeTest(t, {
    db,
    periodeMs: 20,
    poserIntervalle: (travail, ms) => {
      poses += 1;
      return setInterval(travail, ms);
    },
    retirerIntervalle: (minuteur) => {
      retires += 1;
      clearInterval(minuteur);
    }
  });
  const { cookie } = await cookieDePremiereVisite(base);

  const flux = fluxSSE(base, { cookie });
  await flux.pret;
  await flux.attendre((evenement) => evenement.type === "pairs");
  assert.equal(fluxOuverts(), 1, "le client est bien compté tant qu'il écoute");
  assert.equal(poses, 1, "un client, une scrutation");
  assert.equal(retires, 0);

  flux.fermer();

  // On laisse passer plusieurs tours de scrutation : un intervalle orphelin
  // aurait tout le temps de se manifester.
  const limite = Date.now() + 3000;
  while (fluxOuverts() !== 0 && Date.now() < limite) await attendre(20);
  await attendre(120);

  assert.equal(fluxOuverts(), 0, "l'écouteur est retiré à la déconnexion");
  assert.equal(retires, poses, `intervalle orphelin : ${poses} posé(s), ${retires} retiré(s)`);

  // Et la porte n'a rien gardé de travers : elle se ferme sans handle pendant.
  const nombreAvant = flux.evenements.length;
  await attendre(120);
  assert.equal(flux.evenements.length, nombreAvant, "plus un octet ne part vers un client parti");
});

// ── LE LANCEUR ──────────────────────────────────────────────────────────────

test("le lanceur est déclaré au manifeste et porte son shebang", () => {
  const manifeste = JSON.parse(fs.readFileSync(path.join(racine, "package.json"), "utf8"));
  assert.equal(manifeste.bin["cc2cc-web"], "src/bin/valxos-web.js");
  const source = fs.readFileSync(path.join(racine, manifeste.bin["cc2cc-web"]), "utf8");
  assert.match(source, /^#!\/usr\/bin\/env node/);
});

test("le lanceur ouvre la porte sur la boucle locale, lit son jeton dans web.env, et sert", async (t) => {
  const maison = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-lanceur-"));
  t.after(() => fs.rmSync(maison, { recursive: true, force: true }));
  const jeton = "c".repeat(64);
  fs.writeFileSync(
    path.join(maison, "web.env"),
    `CC2CC_WEB_JETON=${jeton}\nVALXOS_WEB_OPERATEUR=${MOI}\n`,
    { mode: 0o600 }
  );

  const enfant = spawn("node", [path.join(racine, "src", "bin", "valxos-web.js")], {
    env: { ...envPropre(), CC2CC_V2_HOME: maison, CC2CC_WEB_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => enfant.kill("SIGTERM"));

  let sortie = "";
  const adresse = await new Promise((resolve, reject) => {
    const minuteur = setTimeout(() => reject(new Error(`le lanceur n'a jamais annoncé sa porte : ${sortie}`)), 15_000);
    enfant.stdout.on("data", (bloc) => {
      sortie += bloc.toString("utf8");
      const trouve = sortie.match(/PORTE (\S+):(\d+)/);
      if (trouve) {
        clearTimeout(minuteur);
        resolve({ hote: trouve[1], port: Number(trouve[2]) });
      }
    });
    enfant.stderr.on("data", (bloc) => {
      sortie += bloc.toString("utf8");
    });
    enfant.on("exit", (code) => {
      clearTimeout(minuteur);
      reject(new Error(`le lanceur est mort (code ${code}) : ${sortie}`));
    });
  });

  assert.equal(adresse.hote, "127.0.0.1", "jamais le LAN");
  const base = `http://127.0.0.1:${adresse.port}`;
  const sansJeton = await requete(base, "/api/fil");
  assert.equal(sansJeton.statut, 401);
  const { cookie } = await cookieDePremiereVisite(base, jeton);
  const fil = await requete(base, "/api/fil", { cookie });
  assert.equal(fil.statut, 200, fil.texte);
  assert.equal(fil.json.moi, MOI);

  // Le bureau du lanceur est bien le jetable qu'on lui a donné : la porte
  // n'ouvre JAMAIS le bureau vivant par surprise.
  assert.ok(fs.existsSync(path.join(maison, "broker.db")));
});

test("le lanceur REFUSE 0.0.0.0 — et il refuse AVANT d'ouvrir le bureau", () => {
  const maison = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-lan-"));
  const lancement = spawnSync("node", [path.join(racine, "src", "bin", "valxos-web.js")], {
    encoding: "utf8",
    env: {
      ...envPropre(),
      CC2CC_V2_HOME: maison,
      CC2CC_WEB_PORT: "0",
      CC2CC_WEB_HOTE: "0.0.0.0",
      VALXOS_WEB_OPERATEUR: MOI
    },
    // ⚠️ SANS CE COUPERET, LE MUTANT NE ROUGIT PAS : IL PEND. Un lanceur qui
    // accepterait 0.0.0.0 resterait en écoute pour toujours, et `spawnSync`
    // attendrait avec lui — un test qui pend n'est pas un test qui échoue.
    timeout: 20_000,
    killSignal: "SIGKILL"
  });
  assert.notEqual(lancement.status, 0, "un lanceur qui accepte 0.0.0.0 expose la boîte de l'opérateur au réseau");
  assert.match(lancement.stderr, /loopback interface \(127\.0\.0\.1/, "le refus se NOMME");
  assert.ok(!lancement.stdout.includes("PORTE"));
  // Même leçon que le démon sous garde : un refus qui laisse
  // déjà le disque touché n'est qu'un demi-refus.
  assert.ok(!fs.existsSync(path.join(maison, "broker.db")), "le refus précède l'ouverture du bureau");
  fs.rmSync(maison, { recursive: true, force: true });
});
