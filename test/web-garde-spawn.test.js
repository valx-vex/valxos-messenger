// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// GARDE N°1 — LA PORTE NE LANCE RIEN SUR ORDRE DU CLIENT. Anti-spawning,
// jamais anti-connexion.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ CE QUE CETTE GARDE VOUS PERMET DE CROIRE — le seul bloc à lire si vous   ║
// ║ n'en lisez qu'un. Écrit le 22/08/2026 à la clôture du run des six passes ║
// ║ adverses, et vérifié ligne à ligne au moment de l'écrire.                ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// La règle de lecture, et elle vient d'une journée entière payée pour :
// UN TROU CONNU ET ÉCRIT EST GÉRABLE ; UN TROU COUVERT PAR UNE PROMESSE VERTE
// NE L'EST PAS. Quatre fois le 22/08, une phrase d'en-tête a promis plus que ce
// que la garde tenait, et elle est restée verte. Si vous lisez ce bloc et que
// vous vous trompez ensuite sur ce que la garde protège, c'est CE BLOC qui aura
// échoué — pas vous.
//
// ── ① CE QUI EST FERMÉ STRUCTURELLEMENT ─────────────────────────────────────
// « Structurel » veut dire une chose précise : l'oracle DEMANDE la réponse à
// celui qui sait (node, la table, le registre des verdicts) au lieu de
// l'interpréter. Il n'y a rien à tenir à jour, et une orthographe nouvelle ne
// le contourne pas.
//
//   1. LE VIVIER DES FICHIERS DE LA PORTE. Il vient du journal d'un crochet
//      `resolve` officiel (`module.register`), dans un sous-processus qui
//      importe la porte pour de vrai, PLUS la descente de `src/web/`. Un module
//      chargé par la porte est dans le vivier quelle que soit l'orthographe de
//      son import — c'est le remède de la regex qui exigeait un point littéral
//      (① plus bas, `test/aide-graphe.js`).
//   2. LE ROUTAGE. `repartir` est pur et exporté ; il est bombardé de 4 800
//      chemins tirés × 10 méthodes (48 000 appels — le compte se recalcule :
//      5 alphabets × 5 classes de longueur × 8 formes × 6 profondeurs × 4) et
//      ne rend jamais une route hors table (ⓒ). Et le chemin JUGÉ est celui que
//      le client a ÉCRIT, re-vérifié à l'instant de servir (`servirLaMemeCible`,
//      web-chemin-ecrit.test.js) : un chemin réécrit entre l'analyseur et la
//      table ne sert plus rien.
//   3. RÉPONDRE PAR `res` EXIGE UN VERDICT FRAPPÉ. Les verdicts vivent dans un
//      `WeakSet` privé : un objet qui RESSEMBLE à un verdict n'en est pas un, et
//      rien ne le rend fabricable de l'extérieur. Chaque réponse autorisée porte
//      sa marque en en-tête, et le décor commun la vérifie sur toutes les
//      requêtes de la suite (`test/aide-porte.js`) — une réponse écrite en amont
//      du répartiteur par une fonction de réponse LÈVE, et la porte rend 500.
//   4. LES AUDITEURS DU SERVEUR QUE LE TEST CONSTRUIT. Comparés par IDENTITÉ de
//      fonction à un `http.Server` nu du même node, avant ET après trafic (ⓔ).
//      ⚠️ Cette fermeture-là ne vaut QUE pour la porte que le test construit —
//      la moitié qui manque est en ② et en ③.
//   5. LA FRONTIÈRE SOURCE / DONNÉE. Une donnée prouve son type par ses octets
//      magiques ; renommer une source en `.woff2` ne la soustrait pas au
//      balayage.
//   6. L'ADRESSE D'ÉCOUTE. `verifierLHote` refuse tout ce qui n'est pas la
//      boucle locale, et le test passe par `ouvrirLaPorte` comme le vrai
//      lanceur : la garde est sur le chemin réel, sans raccourci de décor.
//
// ── ② CE QUI EST FERMÉ PAR UNE LISTE — donc à tenir à jour ──────────────────
// Ces fermetures marchent tant que la liste dit la vérité. Le jour où elle
// vieillit, la garde reste verte et devient fausse. C'est arrivé quatre fois.
//
//   1. `LANCEURS` — DIX-NEUF motifs. LE VIVIER EST STRUCTUREL, LE DÉTECTEUR NE
//      L'EST PAS : trois primitives réelles (`process.dlopen`, `node:repl`,
//      `WebAssembly.instantiate`) ont été mesurées AVEUGLES au banc le 22/08 et
//      ont valu les sept derniers motifs de la liste. Le banc prouve chaque
//      motif présent ; il ne peut rien dire d'un motif qu'on n'a pas écrit.
//   2. `EXCEPTIONS` — un fichier, ses lanceurs NOMMÉS, et le COMPTE de ses sites
//      d'appel. Une entrée aujourd'hui : la sonde de vivacité.
//   3. `CONTRAT` — les dix-sept routes, POLICES COMPRISES, recopiées à la main.
//      Ajouter une police coûte une ligne ici, et c'est le prix voulu : une
//      route servie est une décision, et une décision s'écrit.
//   4. `MARQUES` — la liste fermée des décisions de la porte (serveur.js).
//   5. `EVENEMENTS_PROPRES_AU_SERVEUR` et `POSE_SUR_LE_SERVEUR` (ⓔ-bis) — un
//      nom d'ÉVÉNEMENT et un nom de VARIABLE. C'est la plus faible des listes.
//   6. `PRISES_PERMISES` / `ECRITURES_PERMISES` (ⓖ) — l'accès au transport.
//      DEUX prises permises (deux champs d'un objet de chemins, aucun n'est un
//      fil) et ZÉRO écriture permise.
//   7. `MAILLONS` (ⓕ) — les CINQ fonctions qui tiennent `res` : trois avec leur
//      TEXTE attendu écrit là, deux tenues par ⓓ. Reformater l'une d'elles fait
//      rougir la garde ; c'est le prix, et il est voulu.
//   8. `SOURCES` / `DONNEES` — les extensions connues du balayage.
//
// ── ③ CE QUI N'EST PAS FERMÉ — le scénario, et la raison ────────────────────
//
//   1. LA PORTE DÉROBÉE DÉLIBÉRÉE ET OBSCURCIE, POSÉE PAR QUI A LE DROIT
//      D'ÉCRIRE DANS LE DÉPÔT. Il peut aussi éditer CE fichier. Régression
//      infinie : le test est écrit dans le même dépôt que l'attaque. Se ferme
//      par la revue, le contrôle des accès, et le mot de l'opérateur — jamais ici.
//   2. LE TRANSPORT, PRIS AUTREMENT QUE PAR UN POINT. `const { socket } = req`
//      ou `req["soc" + "ket"]` échappent à ⓖ. La forme ÉCRITE NORMALEMENT
//      (`req.socket.end(…)`, `const fil = req.socket`) est fermée ; celle-là ne
//      l'est pas, et ne le sera pas sans envelopper `req` — voir ⓖ pour ce que
//      ça coûterait.
//   3. UN AUDITEUR DE SERVEUR POSÉ HORS DE LA PORTE QUE LE TEST CONSTRUIT.
//      MESURÉ le 22/08, dans le lanceur : `porte.serveur.on("clientError", …)`
//      → ⓔ vert, ⓔ-bis rouge ; mais `const guichet = porte.serveur;` suivi de
//      `guichet.on("connection", …)` → LES DEUX VERTS. Renommer la variable et
//      choisir un événement hors liste suffit.
//   4. UN IMPORT DYNAMIQUE DONT LE NOM SE CALCULE À L'EXÉCUTION. Le crochet ne
//      voit que ce que la sonde a fait charger ; c'est le motif
//      `import-dynamique` qui garde cette porte, donc une liste.
//   5. UN LANCEUR HORS DE `src/web/` ET HORS DU GRAPHE. Personne ne le voit —
//      mais il n'est alors pas non plus dans la porte.
//   6. DANS UN FICHIER EXCEPTÉ, UN LANCEMENT RANGÉ SOUS UN AUTRE NOM. Le compte
//      des sites d'appel ferme l'ajout ordinaire, pas
//      `const f = childProcess.execFileSync; f(…)`.
//   7. L'ÉCRITURE SUR `res` PAR LES MÉTHODES NUES DE NODE. ⓕ rend l'insertion
//      VISIBLE (le texte des cinq maillons change) ; il ne l'EMPÊCHE pas. Si
//      l'assertion de forme saute, `res.end()` marche toujours.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ CONTRE QUI CETTE GARDE PROTÈGE-T-ELLE ? — à lire AVANT de la renforcer.  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Cette garde a été prise en défaut SIX fois en une seule journée (22/08), et
// chaque fois par une variante plus tordue que la précédente : une route
// nommée, puis un nom écrit un fichier plus loin, puis un chemin par MOTIF,
// puis un préfixe réécrit, puis un import écrit en échappement unicode et une
// route dont le chemin est CALCULÉ — et enfin, au soir, une réponse écrite
// directement sur le TRANSPORT par une fonction qui ne tient pas `res`.
//
// LA LEÇON DE CE RUN N'EST PAS QU'IL Y AVAIT DES TROUS. C'est que quatre fois,
// une phrase écrite pour rassurer était fausse ET RESTAIT VERTE :
//   « aucun endpoint ne spawn un process, period »       — fausse 12 heures ;
//   « pas de verdict, donc pas de marque, donc pas d'écriture » — fausse ;
//   « toute fonction qui écrit un octet commence par exigerLaMarque » — fausse ;
//   « une fonction qui ne tient pas la réponse ne peut pas répondre » — fausse,
//   et c'est la dernière, prouvée deux fois (serveur.js et auth.js).
// C'est ce mensonge-là qui a coûté le plus cher, pas les trous. D'où la règle
// de ce fichier depuis la clôture : UNE PHRASE NE SE RECOPIE PAS D'UNE RONDE À
// L'AUTRE, ELLE SE RE-VÉRIFIE. Ce qui suit a été relu ligne à ligne le 22/08 au
// soir, chaque compte recompté et chaque « c'est fermé » confronté à une
// mutation.
//
// ── CE QUE LA GARDE FERME, ET COMMENT ELLE LE FERME ─────────────────────────
//
// L'INTRODUCTION NON INTENTIONNELLE : quelqu'un travaille sur ce code et ajoute
// un lanceur, une route, une réécriture, un module — sans voir ce qu'il fait.
// C'est la classe qui ARRIVE VRAIMENT, et c'est celle qui est fermée. LES CINQ
// FERMETURES, CHACUNE AVEC LA FORCE QU'ELLE A VRAIMENT :
//   ① un lanceur dans un fichier que la porte charge → le VIVIER vient du
//     RÉSOLVEUR DE NODE, pas d'une expression régulière (① plus bas).
//     ⚠️ Le vivier est structurel, LE DÉTECTEUR NE L'EST PAS : `LANCEURS` est
//     une liste de dix-neuf motifs, dont sept ajoutés le 22/08 après que trois
//     primitives réelles ont été mesurées AVEUGLES. Elle est à tenir à jour ;
//   ② un lanceur dans un fichier posé sous `src/web/` mais pas encore importé →
//     la descente de répertoire le voit quand même. Même détecteur, même
//     réserve ;
//   ③ une route hors table → la table est DÉRIVÉE du serveur et comparée à un
//     contrat écrit À LA MAIN, polices comprises (elles étaient énumérées
//     depuis le dossier DES DEUX CÔTÉS jusqu'au 22/08 : l'oracle se comparait
//     à lui-même sur huit routes sur dix-sept). Le côté « produit » est donc
//     structurel, le côté « référence » est une LISTE — et c'est voulu : le
//     contrat est la LOI, il ne se dérive de rien ;
//   ④ une réponse OUVERTE par une fonction de réponse de la porte — elles sont
//     SIX : `repondreJson`, `refuserLEntree`, `servirLeFichier`,
//     `ecrireEvenement`, `servirLesEvenements`, et `servirLeVerdict` qui EST
//     celle qui marque — hors du chemin du répartiteur → elle n'a pas de
//     verdict, donc pas de marque, donc pas d'écriture. Celle-là est
//     STRUCTURELLE de bout en bout : le registre des verdicts est un `WeakSet`
//     privé (test/web-repartiteur.test.js, ⓓ) ;
//   ⑤ un auditeur de serveur qui répondrait hors de l'événement `request` —
//     `upgrade`, `clientError`, `connect`, `checkContinue`… → la liste des
//     auditeurs RÉELLEMENT POSÉS est fermée, et comparée à un `http.Server`
//     nu du même node (ⓔ).
//     ⚠️ ET C'EST LA PLUS FAIBLE DES CINQ, ce qui ne se lisait pas ici. ⓔ ne
//     mesure QUE la porte que le test construit ; partout ailleurs — le
//     lanceur en premier — c'est ⓔ-bis qui prend, et ⓔ-bis lit la source avec
//     une liste de noms d'ÉVÉNEMENTS et une liste de noms de VARIABLES.
//     Mesuré le 22/08 : un auditeur de `clientError` sur `porte.serveur` dans
//     le lanceur → ⓔ vert, ⓔ-bis rouge ; le même auditeur sur l'événement
//     `connection`, avec le serveur rangé sous un autre nom → LES DEUX VERTS.
//
// LA PHRASE QUI ÉTAIT ÉCRITE ICI — « aucune de ces cinq fermetures ne repose
// sur une liste de mots ou de chemins à deviner » — ÉTAIT FAUSSE, et de trois
// fermetures sur cinq : ① et ② reposent sur `LANCEURS`, ⑤ sur deux listes de
// noms. Ce qui est vrai : ③ et ④ sont structurelles du côté du produit, et le
// VIVIER de ① et ② l'est aussi. Le reste est un filet à mailles connues.
//
// ⚠️ ET LA QUATRIÈME DE CES CINQ EST PLUS ÉTROITE QU'ELLE N'EN A L'AIR — le
// « sauf » est ici, à l'endroit où on la lit, et pas en note plus bas.
// (Ce renvoi disait « LA DEUXIÈME » et pointait à côté : celui qui comptait les
// puces tombait sur la descente de répertoire.) Elle dit « pas de verdict, donc
// pas d'écriture » POUR LES FONCTIONS DE RÉPONSE DE LA PORTE, dont quatre ont
// `exigerLaMarque` pour première instruction, `servirLesEvenements` l'ayant
// après une branche de refus qui passe elle-même par la marque, et
// `servirLeVerdict` ouvrant lui-même. Elle ne dit RIEN de :
//   · un `res.end()` NU — méthode de node, elle écrit sans demander la
//     permission à personne. Tenue par la FORME des cinq maillons (ⓕ) :
//     l'insertion se VOIT, l'écriture n'est pas EMPÊCHÉE ;
//   · LE TRANSPORT, que node accroche à `req` — et c'est la trouvaille du
//     22/08 au soir. Une fonction qui ne tient PAS `res` peut répondre quand
//     même : une ligne dans `verdictDeLaRequete` (serveur.js) ou dans
//     `verdictDeLaPorte` (auth.js) qui écrit une réponse HTTP brute sur
//     `req.socket` rend 200, corps « ouvert », AUCUNE marque — et la suite
//     reste à 607 pass / 0 fail. Mesuré deux fois. Tenu par une LECTURE (ⓖ),
//     plus faible encore : voir ⓖ pour ce que fermer vraiment coûterait.
// Les trois sont vraies en même temps, et ce sont les deux dernières qu'il faut
// avoir en tête avant d'ajouter une ligne dans `src/web/serveur.js`.
//
// ── CE QUE LA GARDE NE FERME PAS, ET NE PEUT PAS FERMER ─────────────────────
//
// LA PORTE DÉROBÉE DÉLIBÉRÉE ET OBSCURCIE, POSÉE PAR QUELQU'UN QUI A LE DROIT
// D'ÉCRIRE DANS LE DÉPÔT. Celui-là peut aussi éditer CE fichier : il peut
// ajouter une entrée à EXCEPTIONS, élargir un motif, inscrire son verdict à la
// frappe, ou simplement retirer l'assertion qui le gêne. Chercher à le fermer
// par un test est une régression infinie — on finit avec un test trois fois
// plus gros que le produit, et il reste un trou, parce que le test est écrit
// dans le même dépôt que l'attaque.
//
// CETTE CLASSE-LÀ SE FERME AILLEURS, ET AILLEURS SEULEMENT : par la revue, par
// le contrôle des accès au dépôt, et par le fait que rien ne part sans le mot
// de l'opérateur. Un test qui laisserait croire qu'il la couvre serait exactement
// le défaut d'origine, avec un nom plus long.
//
// Ce qui reste ouvert, dit sans détour (la liste complète, avec les scénarios,
// est au bloc « CE QUE CETTE GARDE VOUS PERMET DE CROIRE », en tête) :
//   · un import DYNAMIQUE dont le nom se calcule à l'exécution n'est résolu que
//     s'il tourne — le crochet de ① ne voit que ce que la sonde a fait charger ;
//     le motif `import-dynamique` du détecteur reste donc nécessaire, et c'est
//     lui qui garde cette porte, pas le crochet ;
//   · un lanceur posé hors de `src/web/` ET hors du graphe chargé n'est vu par
//     personne — mais il n'est alors pas non plus dans la porte ;
//   · un auteur du dépôt peut frapper un verdict lui-même (voir serveur.js) ;
//   · le TRANSPORT pris autrement que par un point — `const { socket } = req`,
//     `req["soc" + "ket"]` — échappe à ⓖ. La forme écrite normalement, elle,
//     est fermée ;
//   · un auditeur de serveur posé hors de la porte que le test construit, sous
//     un nom de variable que ⓔ-bis ne connaît pas : MESURÉ vert des deux côtés.
//
// ── LA GARDE, MAINTENANT ────────────────────────────────────────────────────
//
// La garde est une CLASSE, pas un point, et elle se ferme des DEUX côtés :
//   (a) la liste des routes servies est FERMÉE. Le test la DÉRIVE du serveur
//       (`ROUTES`) au lieu de la recopier : une route ajoutée demain se voit
//       ici le jour où elle naît, pas le jour de l'incident. Le tableau de
//       référence, lui, vient du CONTRAT (2026-08-22) : celui-là se recopie
//       exprès, parce que c'est la LOI, pas le code.
//       ⚠️ « LA SEULE CHOSE QU'ON RECOPIE » ÉTAIT ÉCRIT ICI, ET C'EST FAUX.
//       Ce fichier recopie aussi `LANCEURS`, `PRIMITIVES_APPELEES`, les deux
//       bancs d'essai, `SOURCES`/`DONNEES` et les lanceurs nommés d'`EXCEPTIONS`
//       — et le fichier voisin recopie le TEXTE des cinq maillons, les poses
//       d'auditeurs permises et les prises du transport. Le compte honnête est
//       au bloc « CE QUE CETTE GARDE VOUS PERMET DE CROIRE », liste ②.
//   (b) les sources de la porte ne contiennent aucun lanceur HORS DE LA LISTE
//       FERMÉE DES EXCEPTIONS. Le test LIT les fichiers : une revue de code
//       n'est pas un instrument, elle est une opinion, et la garde d'une
//       classe se pose là où la donnée sort.
//
//       « Les sources de la porte », depuis le 22/08, ce n'est plus SEULEMENT
//       le répertoire `src/web/` : c'est ce que la porte CHARGE (imports
//       suivis) EN PLUS de ce que ce répertoire contient — les deux ensembles
//       s'additionnent, ils ne se remplacent pas, et `fichiersDeLaPorte` plus
//       bas fait littéralement les deux.
//       Et la seule exception est la sonde de vivacité du produit, qui paie sa
//       place par le test d'argv de ce fichier. Les deux moitiés — ① le
//       balayage qui suit les imports, ② l'exception qui se paie — sont
//       écrites plus bas, chacune à côté de ce qu'elle gouverne.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js pour le pourquoi (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
// ⚠️ OUI, CE FICHIER IMPORTE LE MODULE QUE LA GARDE INTERDIT AILLEURS, ET
// C'EST LE POINT : le mouchard du test « RIEN DE CE QUE L'UTILISATEUR TAPE… »
// remplace les lanceurs sur CET objet — le même que `src/lib/postbox.js` lit à
// chaque appel. Le balayage, lui, ne lit que `src/` : un test qui surveille un
// lanceur n'est pas un produit qui en pose un.
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-garde-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { ROUTES, ouvrirLaPorte, verifierLHote } from "../src/web/serveur.js";
import { ANCRES_DU_GRAPHE, grapheCharge } from "./aide-graphe.js";
import { bureauJetable, cookieDePremiereVisite, porteDeTest, requete } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

const racine = path.resolve(new URL("..", import.meta.url).pathname);

// ── LE TABLEAU DU CONTRAT ───────────────────────────────────────────────────
//
// Mot pour mot (CONTRAT_PORTE_WEB_20260822.md, « Les routes — LISTE FERMÉE »).
// Il ne se dérive de rien : c'est la référence.
//
// ⚠️ LES POLICES ÉTAIENT L'EXCEPTION, ET L'EXCEPTION ÉTAIT UN ORACLE QUI SE
// COMPARAIT À LUI-MÊME. Ce tableau les ÉNUMÉRAIT DEPUIS LE DOSSIER —
// `fs.readdirSync(src/web/public/polices)` — pendant que `ROUTES`
// (serveur.js, `routesDesPolices`) les énumère depuis LE MÊME DOSSIER. Les
// deux côtés de l'égalité lisaient donc la même source : sur huit des
// dix-sept routes, le test ne comparait le produit à RIEN. Un `.woff2` déposé
// dans ce dossier devenait servi par la porte sans que personne l'ait décidé,
// et la garde restait verte — le fichier prouvait bien ses octets magiques à
// la descente de répertoire, mais PROUVER SON TYPE N'EST PAS ÊTRE AU CONTRAT.
//
// LES NOMS SONT DONC ÉCRITS ICI, À LA MAIN, comme les neuf autres. Ce que ça
// coûte : ajouter une police demande une ligne de plus dans ce tableau. C'est
// exactement le prix qu'on veut payer — une route servie est une DÉCISION, et
// une décision s'écrit. Ce que ça achète : le fichier déposé sans décision
// rougit le jour où il est déposé.
const POLICES_DU_CONTRAT = [
  "archivo-400-800-latin-ext.woff2",
  "archivo-400-800-latin.woff2",
  "dm-mono-400-latin-ext.woff2",
  "dm-mono-400-latin.woff2",
  "dm-mono-500-latin-ext.woff2",
  "dm-mono-500-latin.woff2",
  "literata-400-600-latin-ext.woff2",
  "literata-400-600-latin.woff2"
];

const CONTRAT = [
  "GET /",
  "GET /app.js",
  "GET /style.css",
  "GET /polices.css",
  "GET /api/pairs",
  "GET /api/fil",
  "POST /api/poster",
  "POST /api/accuser",
  "GET /api/evenements",
  ...POLICES_DU_CONTRAT.map((nom) => `GET /polices/${nom}`)
];

test("la liste des routes est FERMÉE — dérivée du SERVEUR, comparée au contrat", () => {
  // L'instrument doit POUVOIR voir sa cible : une table vide rendrait ce test
  // vert pour la pire des raisons.
  assert.ok(Array.isArray(ROUTES) && ROUTES.length > 0, "le serveur doit EXPOSER sa table de routes");
  const servies = ROUTES.map((route) => `${route.methode} ${route.chemin}`);
  assert.equal(new Set(servies).size, servies.length, "aucune route en double dans la table");
  // Les deux sens : une route de trop est une porte ouverte, une route qui
  // manque est un produit qui ment sur ce qu'il livre.
  assert.deepEqual([...servies].sort(), [...CONTRAT].sort());
});

test("le routage NE PEUT PAS servir autre chose que sa table — tout le reste est 404, toute autre méthode 405", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  // Les noms qu'on ne veut jamais voir répondre. Ils sont là pour le lecteur
  // autant que pour la machine : c'est la liste de ce que la porte REFUSE
  // d'être.
  const interdites = [
    "/debug",
    "/exec",
    "/spawn",
    "/api/exec",
    "/api/spawn",
    "/api/debug",
    "/api/lancer",
    "/api/session",
    "/api/pairs/bob-eternal",
    "/api",
    "/api/",
    "/index.html",
    "/serveur.js",
    "/../src/web/serveur.js",
    "/public/app.js"
  ];
  for (const chemin of interdites) {
    for (const methode of ["GET", "POST"]) {
      const reponse = await requete(base, chemin, { methode, cookie, corps: methode === "POST" ? {} : null });
      assert.equal(
        reponse.statut,
        404,
        `${methode} ${chemin} répond ${reponse.statut} — la porte n'a que les routes du contrat`
      );
    }
  }

  // Sur un chemin CONNU, une méthode hors table est un 405 qui NOMME ce qui
  // est permis : un 404 ferait croire que le chemin n'existe pas.
  for (const ligne of CONTRAT) {
    const [methodeServie, chemin] = ligne.split(" ");
    for (const methode of ["PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", methodeServie === "GET" ? "POST" : "GET"]) {
      // Un corps sur HEAD/DELETE/OPTIONS fait refuser la requête par node
      // lui-même (400, avant tout gestionnaire) : ce serait mesurer le
      // parseur, pas la porte. On n'en envoie qu'aux méthodes qui en portent.
      const porteUnCorps = ["POST", "PUT", "PATCH"].includes(methode);
      const reponse = await requete(base, chemin, { methode, cookie, corps: porteUnCorps ? {} : null });
      assert.equal(reponse.statut, 405, `${methode} ${chemin} doit être 405, pas ${reponse.statut}`);
      assert.equal(reponse.entetes.allow, methodeServie, `le 405 dit ce qui est permis sur ${chemin}`);
    }
  }
});

// ── (b) LES SOURCES ELLES-MÊMES ─────────────────────────────────────────────
//
// Les primitives qui lancent quelque chose. La v1 était une liste de MOTS
// cherchés en « mot entier », et le banc d'essai ci-dessous l'a prise en
// défaut (22/08, lentille adverse — chaque ligne AVEUGLE a été MESURÉE) :
//
//   MORD     import { spawn } from "node:child_process"
//   MORD     await import("node:child_process")
//   AVEUGLE  new Function("return process")()
//   AVEUGLE  ({}).constructor.constructor("return 1")()
//   AVEUGLE  process.binding("spawn_sync").spawnSync("sh")   ← « spawn_sync »
//            n'a pas de frontière de mot après « spawn » : `_` est un
//            caractère de mot, donc l'ancienne recherche ne mordait pas.
//   AVEUGLE  new Worker("./x.js")
//
// La v2 nomme donc des MOTIFS, pas des mots — chacun avec la raison qui le
// rend nécessaire, et chacun prouvé au banc. Le refus des faux positifs est
// gardé au même endroit : « anti-spawning » est le nom de la garde et a le
// droit d'être écrit, et `function` (minuscule) est la moitié de ce fichier.
const LANCEURS = [
  { nom: "child_process", motif: /\bchild_process\b/ },
  // `spawn`, `spawnSync`, `spawn_sync` — mais jamais « spawning ».
  { nom: "spawn", motif: /\bspawn(?!ing\b)/ },
  // `exec`, `execSync`, `execFile`, `execFileSync`, `execve`, `execPath`.
  //
  // ⚠️ CE MOTIF A ÉTÉ RESSERRÉ LE 22/08, ET C'EST UNE PRÉCISION, PAS UN
  // RELÂCHEMENT. Il était `/\bexec[A-Za-z_]*/` — un mot, sans regarder ce qui
  // le précède. Tant que le balayage s'arrêtait à `src/web/`, personne ne l'a
  // vu ; le jour où il a suivi les imports, il a mordu sur `db.exec(...)`
  // (better-sqlite3, `src/lib/database.js` et `src/lib/migrations.js`), qui
  // n'a jamais lancé un processus de sa vie. Deux façons de s'en sortir, et
  // une seule est honnête : mettre ces deux fichiers en exception aurait
  // acheté le vert en élargissant la liste des fichiers autorisés à lancer —
  // exactement ce qu'il ne faut pas faire. On corrige donc l'INSTRUMENT, et
  // les deux lignes RÉELLES du dépôt entrent au banc des faux positifs.
  //
  // La frontière est celle-ci, et elle est vérifiable à l'œil :
  //   · un `exec` NU suivi d'un appel — `execFileSync(…)`, `exec(…)` sorti
  //     d'un import déstructuré — mord ;
  //   · un `exec` PRÉCÉDÉ D'UN POINT ne mord pas, SAUF s'il porte un des
  //     suffixes de `node:child_process`, qui ne veulent rien dire d'autre :
  //     `cp.execSync`, `cp.execFile`, `process.execPath`.
  // Ce qui reste hors de portée — `require("child_process").exec("ls")` — est
  // pris par les motifs `require` et `child_process` de la même liste : aucun
  // chemin vers un lancement ne se ferme d'un seul motif.
  { nom: "exec", motif: /(?<![.\w$])exec[A-Za-z_]*\s*\(|\bexec(?:Sync|File|FileSync|ve|vp|Path)\b/ },
  { nom: "fork", motif: /\bfork\b/ },
  { nom: "vm", motif: /\bvm\b/ },
  { nom: "eval", motif: /\beval\b/ },
  // Le compilateur du pauvre : `new Function(…)` construit du code depuis une
  // chaîne, exactement comme `eval`.
  { nom: "Function", motif: /\bFunction\s*\(|\bnew\s+Function\b/ },
  // Et son chemin détourné : `({}).constructor.constructor` EST `Function`.
  //
  // ⚠️ RESSERRÉ LE 22/08, MÊME RAISON QUE `exec`. Le motif était le mot nu, et
  // il mordait sur la DÉCLARATION d'un membre de classe — `constructor(msgId,
  // agentId, …)` dans `src/lib/database.js`, qui ne construit aucune fonction
  // depuis une chaîne. L'attaque, elle, est toujours un ACCÈS : on lit la
  // propriété `constructor` de quelque chose, par le point ou par les
  // crochets. Une déclaration n'est jamais précédée d'un point. Les deux
  // formes de l'accès mordent, la déclaration ne mord plus, et la ligne réelle
  // du dépôt est au banc des faux positifs.
  { nom: "constructor", motif: /\.\s*constructor\b|\[\s*["']constructor["']\s*\]/ },
  // Les internes de node : `process.binding("spawn_sync")` rend un lanceur que
  // plus aucun nom de module ne trahit.
  { nom: "binding", motif: /\bbinding\b|\b_linkedBinding\b/ },
  // Un fil d'exécution est un processus pour ce qui nous occupe : il exécute.
  { nom: "worker", motif: /\bworker_threads\b|\bnew\s+Worker\b/ },
  // Le pont CommonJS : `require("child_process")`, et `createRequire` qui le
  // rouvre depuis un module ES.
  { nom: "require", motif: /\brequire\s*\(|\bcreateRequire\b/ },
  // L'import DYNAMIQUE : le seul qui puisse prendre un nom de module calculé.
  { nom: "import-dynamique", motif: /\bimport\s*\(/ },

  // ── ③ LES PRIMITIVES QUE LES DOUZE PREMIERS MOTIFS MANQUAIENT ─────────────
  //
  // Les douze ci-dessus ferment deux familles : lancer un PROCESSUS, et
  // compiler une CHAÎNE. Node en a d'autres, et trois d'entre elles ont été
  // mesurées AVEUGLES au banc le 22/08 (`process.dlopen`, `node:repl`,
  // `WebAssembly.instantiate`) alors que le contrôle positif
  // `import { spawn } from "node:child_process"` mordait bien. Les autres de
  // cette liste sont de la même famille : on ne referme pas trois trous
  // nommés en laissant leurs frères ouverts.
  //
  // Ce que le lecteur doit retenir : la garde n'interdit pas « child_process »,
  // elle interdit DE FAIRE TOURNER DU CODE QUE LA PORTE N'A PAS COMPILÉ. Un
  // processus est la façon la plus visible de le faire, pas la seule.

  // Le code natif. `process.dlopen(module, "…node")` charge une bibliothèque et
  // lui donne la main DANS notre processus — aucun enfant, aucune trace dans
  // `ps`, et tout le pouvoir.
  { nom: "dlopen", motif: /\bdlopen\b/ },
  // Le REPL est un évaluateur complet livré avec node.
  { nom: "repl", motif: /\bnode:repl\b|\brepl\.start\b/ },
  // WebAssembly compile et exécute des octets arbitraires, sans passer par
  // aucun des noms ci-dessus.
  { nom: "wasm", motif: /\bWebAssembly\b/ },
  // L'inspecteur : une session, un `Runtime.evaluate`, et c'est `eval` par la
  // porte de service.
  { nom: "inspector", motif: /\bnode:inspector\b|\binspector\.Session\b|\binspector\.open\b/ },
  // `cluster.fork()` lance un processus sans jamais écrire « child_process ».
  { nom: "cluster", motif: /\bnode:cluster\b|\bcluster\.fork\b/ },
  // Les internes du chargeur : `Module._load` rouvre tout module par son nom,
  // `Module._compile` exécute une source. Les deux contournent la lecture des
  // noms de modules qu'on fait plus haut.
  { nom: "module-interne", motif: /\bnode:module\b|\bModule\._(?:load|compile)\b/ },
  // Les cousines de `Function`, obtenues par le prototype d'une fonction async
  // ou génératrice : même compilation depuis une chaîne, autre nom.
  { nom: "fonction-dynamique", motif: /\bAsyncFunction\b|\bGeneratorFunction\b/ }
];

function lanceursDe(source) {
  return LANCEURS.filter(({ motif }) => motif.test(source)).map(({ nom }) => nom);
}

// ── COMPTER LES SITES D'APPEL, PAS SEULEMENT LES NOMS ───────────────────────
//
// ⚠️ CE QUE L'EXCEPTION NE FERMAIT PAS, ET C'EST TOUT SON OBJET. `lanceursDe`
// rend des NOMS : « ce fichier parle de `exec` ». Une exception bâtie là-dessus
// est granulaire au NOM, donc à rien — un lancement SUPPLÉMENTAIRE ajouté dans
// le fichier excepté passe tant qu'il porte un nom déjà inscrit :
//
//     execFileSync("/bin/sh", ["-c", ceQueLUtilisateurATape]);   ← `exec` est
//                                                                  déjà permis
//
// Or l'exception a été accordée pour LA SONDE DE VIVACITÉ — deux lancements,
// nommés et justifiés — pas pour tout ce que ce fichier contiendra demain.
//
// On compte donc les SITES D'APPEL. La liste ci-dessous est délibérément plus
// ÉTROITE que `LANCEURS` : celle-là demande « ce fichier parle-t-il de
// lancer ? » et doit ratisser large (un mot dans un commentaire suffit à faire
// rougir, et c'est voulu) ; celle-ci demande « combien de fois lance-t-il ? »
// et ne doit compter que des invocations — sinon renommer un commentaire
// changerait le compte, et un compte qui bouge pour rien est un compte qu'on
// finit par desserrer.
const PRIMITIVES_APPELEES = [
  "execFileSync",
  "execFile",
  "execSync",
  "exec",
  "spawnSync",
  "spawn",
  "fork",
  "require",
  "createRequire",
  "eval",
  "Function"
];
const APPEL_DE_LANCEUR = new RegExp(
  `(?<![.\\w$])(${PRIMITIVES_APPELEES.join("|")})\\s*\\(|\\.\\s*(${PRIMITIVES_APPELEES.join("|")})\\s*\\(`,
  "g"
);

// « Combien de fois ce fichier lance-t-il, et par quoi ? » — un objet nu, pour
// que la déclaration de l'exception se lise comme ce qu'elle est : un compte.
function appelsDe(source) {
  const compte = {};
  for (const trouve of source.matchAll(APPEL_DE_LANCEUR)) {
    const nom = trouve[1] ?? trouve[2];
    compte[nom] = (compte[nom] ?? 0) + 1;
  }
  return compte;
}

// ── ② LA LISTE FERMÉE DES EXCEPTIONS ────────────────────────────────────────
//
// La phrase de la garde n°1 était « aucun endpoint ne lance un processus,
// period ». Elle était FAUSSE, et elle l'était depuis toujours : le produit
// lance, et il a raison de lancer. Le contrat du 22/08 l'a donc réécrite, et
// c'est la TROISIÈME clause qui porte tout le poids :
//
//     « La porte ne démarre aucune session que l'utilisateur n'a pas
//       explicitement choisie dans une liste fermée. Elle n'exécute aucun code
//       chez un pair. Et RIEN DE CE QUE L'UTILISATEUR TAPE N'ATTEINT UNE LIGNE
//       DE COMMANDE. »
//
// Une exception, ici, c'est UN FICHIER, LES NOMS EXACTS de ce qu'il a le droit
// de contenir, POURQUOI, et LE TEST QUI LA PAIE. Les quatre, ou rien : une
// autorisation sans contrepartie n'est pas une exception, c'est un trou avec
// un commentaire poli devant.
//
// ⚠️ À QUI VIENDRA POSER « LE BUREAU D'EMBAUCHE » (décidé par l'opérateur le
// 22/08 : la porte saura ouvrir des chaises depuis le navigateur, dans une
// LISTE FERMÉE, jamais une commande libre). Ta capacité entre ICI, en ajoutant
// une entrée — pas en desserrant un motif, pas en retirant un fichier du
// graphe, pas en enveloppant un lancement dans un module que personne
// n'importe. Et elle entre avec SON test d'argv, comme celui-ci : le jour où
// le lanceur arrive sans son entrée, la garde rougit, et c'est le
// comportement voulu.
const EXCEPTIONS = new Map([
  [
    "src/lib/postbox.js",
    {
      lanceurs: ["child_process", "exec", "fork", "require"],
      // ⚠️ LE COMPTE EXACT DES SITES D'APPEL — c'est LUI l'exception, la liste
      // de noms ci-dessus n'en est que le grillage large. Deux `execFileSync`
      // (procStartOf → `/bin/ps`, sonderLaBoite → `node -e`), et le `require`
      // qui vit DANS la source de la sonde (`SOURCE_SONDE`, une constante de
      // cinq lignes exécutée par ce `node -e`). Un lancement de plus dans ce
      // fichier — même sous un nom déjà permis — fait rougir la garde.
      //
      // CE QUE CE COMPTE NE FERME PAS, et il faut le lire ici : un auteur du
      // dépôt qui range `childProcess.execFileSync` dans une variable et
      // l'appelle par ce nouveau nom n'est pas compté. C'est la classe
      // DÉLIBÉRÉE-OBSCURCIE, celle que ce fichier dit en tête ne pas fermer et
      // ne pas pouvoir fermer. Ce compte-ci ferme l'AJOUT ORDINAIRE — le
      // lancement écrit normalement, par quelqu'un qui ne voyait pas qu'il
      // élargissait une exception.
      sites: { execFileSync: 2, require: 1 },
      pourquoi:
        "LA SONDE DE VIVACITÉ DU PRODUIT, et rien d'autre. C'est elle qui permet de dire " +
        "« cette boîte est vivante » — donc de rendre l'avis 2-bis. Deux lancements, tous " +
        "les deux des QUESTIONS POSÉES AU SYSTÈME sur des processus locaux : `node -e " +
        "<constante de cinq lignes>` qui frappe à un socket lu au REGISTRE (sonderLaBoite), " +
        "et `/bin/ps -o lstart= -p <pid>` qui lit l'heure de démarrage d'un numéro validé " +
        "(procStartOf). Elle est partagée avec `cc2cc-send` et le guichet MCP, elle est " +
        "ANTÉRIEURE à la porte web, et la porte n'y a aucun chemin privilégié : elle la " +
        "traverse par serveur.js → guichet.js → round.js → postbox.js, comme tout le monde. " +
        "Le mot `fork` et le `require(` de cette liste ne sont d'ailleurs pas des lancements " +
        "de plus : l'un est dans un commentaire, l'autre dans la source de la sonde.",
      prouvee_par:
        "test « RIEN DE CE QUE L'UTILISATEUR TAPE N'ATTEINT UNE LIGNE DE COMMANDE » (ce fichier)"
    }
  ]
]);

// LE BANC D'ESSAI DU DÉTECTEUR — il est le test du TEST. Chaque ligne est un
// alias RÉEL d'un lanceur ; une ligne qui cesserait de mordre rendrait la
// garde silencieuse sans que rien ne rougisse ailleurs.
const BANC_QUI_DOIT_MORDRE = [
  ['import { spawn } from "node:child_process";', ["child_process", "spawn"]],
  ['const cp = await import("node:child_process");', ["child_process", "import-dynamique"]],
  ['const { execSync } = require("node:child_process");', ["child_process", "exec", "require"]],
  ['execFileSync("/bin/sh", []);', ["exec"]],
  ['new Function("return process")();', ["Function"]],
  // Le mot « Function » n'apparaît nulle part dans cette ligne — c'est tout
  // l'intérêt du détour, et c'est pour ça que `constructor` a sa propre entrée.
  ['({}).constructor.constructor("return 1")();', ["constructor"]],
  ['process.binding("spawn_sync").spawnSync("sh");', ["spawn", "binding"]],
  ['const { Worker } = require("node:worker_threads");', ["require", "worker"]],
  ['new Worker("./ailleurs.js");', ["worker"]],
  ['eval("1+1");', ["eval"]],
  ['const machine = await import("node:vm");', ["vm", "import-dynamique"]],
  ['fork("./enfant.js");', ["fork"]],
  // ── ③ CE QUE LE DÉTECTEUR NE VOYAIT PAS ───────────────────────────────────
  // Les douze motifs ci-dessus couvraient le lancement d'un PROCESSUS et la
  // compilation d'une CHAÎNE. Ils ne couvraient pas les autres façons qu'a
  // node de faire tourner du code qu'il n'a pas compilé lui-même. Les trois
  // premières ont été mesurées AVEUGLES au banc le 22/08, dans le décor exact
  // de la garde ; les suivantes sont de la même famille et entrent avec elles.
  //
  // Le code natif : `dlopen` charge un `.node` et lui donne la main. Aucun
  // processus n'est lancé — et c'est bien pire, le code s'exécute DANS le
  // nôtre.
  ['process.dlopen(mod, "/tmp/x.node");', ["dlopen"]],
  // Le REPL est un évaluateur complet livré avec node : `repl.start()` et
  // n'importe quelle entrée devient du code.
  ['import repl from "node:repl";', ["repl"]],
  ['repl.start({ prompt: "> " });', ["repl"]],
  // WebAssembly compile et exécute des octets arbitraires.
  ["await WebAssembly.instantiate(octets);", ["wasm"]],
  ['const wasm = new WebAssembly.Module(octets);', ["wasm"]],
  // L'inspecteur : une session ouverte, et `Runtime.evaluate` fait le reste.
  ['import inspector from "node:inspector";', ["inspector"]],
  ["const session = new inspector.Session();", ["inspector"]],
  // `cluster.fork()` est un lancement de processus qui ne dit jamais
  // « child_process » nulle part.
  ['import cluster from "node:cluster";', ["cluster"]],
  ["cluster.fork();", ["cluster", "fork"]],
  // Les internes du chargeur de modules : `Module._load` rouvre TOUT, y
  // compris ce que les motifs de nom de module croyaient avoir fermé.
  ['import { createRequire } from "node:module";', ["module-interne", "require"]],
  ['Module._load("child_process", null, false);', ["module-interne", "child_process"]],
  ['Module._compile(source, "faux.js");', ["module-interne"]],
  // Les deux cousines de `Function` — même compilation depuis une chaîne, un
  // nom que le motif `Function` ne voit pas.
  ['const AF = Object.getPrototypeOf(async () => {}).constructor;', ["constructor"]],
  ['new AsyncFunction("return 1")();', ["fonction-dynamique"]],
  ['new GeneratorFunction("yield 1")();', ["fonction-dynamique"]]
];

// Et ce qu'il ne doit JAMAIS mordre : une garde qui crie sur son propre nom
// est une garde qu'on finit par désarmer.
const BANC_QUI_NE_DOIT_PAS_MORDRE = [
  "// la garde anti-spawning, et l'exécution reste interdite",
  "function servirLeFil(contexte, req, res) { return null; }",
  "// on ne redirige que les GET : une redirection sur un POST perdrait la lettre",
  "export const PLAFOND_DU_FIL = 500;",
  // LES TROIS LIGNES QUE LE BALAYAGE PAR IMPORTS A FAIT REMONTER LE 22/08.
  // Elles ne sont pas inventées pour l'occasion : les deux premières sont
  // copiées telles quelles de `src/lib/migrations.js` et `src/lib/database.js`.
  // Un faux positif qu'on rencontre pour de vrai et qu'on n'épingle pas
  // revient sous forme d'exception de fichier — et une exception de fichier
  // autorise TOUT ce que le fichier contiendra demain.
  "        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);",
  "  constructor(msgId, agentId, destinataire, raison) {",
  // Et le troisième `.exec` du monde JavaScript, qu'on croisera tôt ou tard.
  "const trouve = /^\\d+$/.exec(chaine);"
];

// ── SOURCE OU DONNÉE : LA FRONTIÈRE SE PROUVE, ELLE NE SE DÉCLARE PAS ───────
//
// Le balayage lisait TOUT ce qui vit sous src/web. Les polices locales sont
// arrivées le 22/08 et la garde a rougi : les `.woff2` sont des binaires
// compressés, et trois d'entre eux portent par hasard la séquence « vm » entre
// deux frontières de mot. Collision d'intégration pure — ni la branche des
// polices ni celle de la garde ne pouvait la voir seule.
//
// LE PIÈGE À NE PAS TOMBER DEDANS : exclure les binaires « parce que ce sont
// des données » rouvre la porte en grand — il suffirait alors de renommer une
// source en `.woff2` pour la soustraire à la garde. La frontière doit donc
// être PROUVÉE, sur trois verrous :
//   ① la liste des extensions est FERMÉE : un fichier dont l'extension n'est ni
//      source ni donnée fait échouer le test. Un type neuf ne se glisse pas.
//   ② une DONNÉE doit prouver qu'elle en est, par ses octets magiques — un
//      fichier JavaScript renommé `.woff2` n'est pas un woff2 et se fait voir.
//   ③ une SOURCE est balayée, sans exception.
const SOURCES = new Set([".js", ".mjs", ".html", ".css", ".json", ".md"]);
// Chaque donnée porte la signature qui prouve son type. `wOF2` est l'en-tête
// du format Web Open Font Format 2 (RFC 8081, §4.1).
const DONNEES = new Map([[".woff2", Buffer.from("wOF2", "ascii")]]);

// ── ① LE VIVIER VIENT DU RÉSOLVEUR DE NODE, PAS D'UNE EXPRESSION RÉGULIÈRE ──
//
// PREMIÈRE MYOPIE (22/08, matin). Le balayage descendait dans `src/web/`,
// ajoutait `src/bin/valxos-web.js`, et S'ARRÊTAIT. Aucune arête d'import n'était
// suivie. Ce que ça a coûté, MESURÉ par une passe adverse le même jour :
//
//     un seul POST /api/poster lance DEUX processus
//       node -e '<la sonde de connexion>'      (postbox.js, sonderLaBoite)
//       /bin/ps -o lstart= -p <pid>            (postbox.js, procStartOf)
//     par le chemin serveur.js → guichet.js → round.js → postbox.js
//
//   et pendant ce temps la garde restait VERTE. Une garde qui affirme une
//   propriété fausse en restant verte n'est pas une garde : c'est une
//   récitation.
//
// DEUXIÈME MYOPIE (22/08, soir) — et c'est elle qui a imposé le remède
// d'aujourd'hui. Le balayage suivait bien les imports, mais il les suivait avec
// une expression régulière :
//
//     /(?:from|import|require)\s*\(?\s*["'](\.[^"'\n]+)["']/g
//
// Elle exige un POINT LITTÉRAL après le guillemet. Or node ne lit pas des
// guillemets, il lit une CHAÎNE :
//
//     import { d } from "../lib/derob.js";     ← résolu comme "../lib/derob.js"
//
//   Le module entre dans le processus de la porte avec son
//   `execFileSync("/bin/sh", …)`, la regex ne voit rien, le fichier n'entre
//   jamais dans le vivier, et la suite reste verte : 598 pass / 0 fail, mesuré.
//
// ALLONGER LA REGEX N'AURAIT RIEN FERMÉ. Ce qui l'a contournée une fois la
// contournera autrement — concaténation, casse du chemin, indirection par le
// manifeste. Une liste de motifs ne ferme jamais une classe.
//
// LA DOCTRINE DU REMÈDE : ON CESSE DE DEVINER CE QUE LE CODE VEUT DIRE, ON
// DEMANDE À CELUI QUI SAIT. Un import que node RÉSOUT est un import que node a
// VU, quelle que soit l'orthographe du spécificateur. Le vivier est donc le
// journal d'un crochet `resolve` officiel (`module.register`), tenu dans un
// sous-processus qui importe la porte pour de vrai — voir `aide-graphe.js`,
// `sonde-graphe.mjs`, `crochet-graphe.mjs`.
//
// ⚠️ ET LA DESCENTE DE RÉPERTOIRE RESTE, EN PLUS. Les deux ensembles
// S'ADDITIONNENT, ils ne se remplacent pas : un fichier posé sous `src/web/` et
// pas encore importé doit être vu quand même (une source écrite hier, branchée
// demain), et la page, le style, les polices ne sont importés par personne et
// se servent pourtant.
function fichiersDeLaPorte() {
  const trouves = new Set();
  const descendre = (dossier) => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const chemin = path.join(dossier, entree.name);
      if (entree.isDirectory()) descendre(chemin);
      else trouves.add(chemin);
    }
  };
  // ⓐ LE RÉPERTOIRE, EN ENTIER.
  descendre(path.join(racine, "src", "web"));
  // ⓑ ET TOUT CE QUE NODE A VRAIMENT CHARGÉ.
  const graphe = grapheCharge(racine);
  // TROIS ISSUES, JAMAIS DEUX : un crochet qui n'a pas pu tourner n'est pas un
  // graphe vide, c'est une sonde impossible — et elle se dit avec la sortie de
  // la commande, pas avec un silence.
  assert.equal(
    graphe.probleme,
    null,
    `SONDE IMPOSSIBLE : la sonde de graphe n'a pas tourné (${graphe.probleme}) — stderr : ${graphe.stderr}`
  );
  for (const ancre of ANCRES_DU_GRAPHE) {
    assert.ok(
      graphe.fichiers.includes(ancre),
      `SONDE IMPOSSIBLE : « ${ancre} » n'est pas dans le journal du crochet de résolution. ` +
        `Un journal amputé rendrait la garde verte pour la pire des raisons. ` +
        `Vus : ${graphe.fichiers.join(", ")} — stderr de la sonde : ${graphe.stderr}`
    );
  }
  for (const relatif of graphe.fichiers) trouves.add(path.join(racine, relatif));
  return [...trouves];
}

test("aucune source de la porte ne sait lancer quoi que ce soit — les FICHIERS sont lus, pas la revue de code", () => {
  const fichiers = fichiersDeLaPorte();

  // TROIS ISSUES, JAMAIS DEUX. Un balayage qui ne trouve pas ses fichiers
  // n'est pas un balayage propre : c'est une sonde qui n'a pas tourné.
  //
  // Les trois DERNIERS noms de cette liste sont le chemin EXACT que la passe
  // adverse du 22/08 a mesuré (serveur → guichet → round → postbox) : si le
  // graphe cessait de les rendre, la garde redeviendrait verte pour la pire
  // des raisons — celle-là même qui l'a rendue muette pendant tout le chantier.
  const noms = fichiers.map((f) => path.relative(racine, f));
  for (const attendu of [
    "src/web/serveur.js",
    "src/web/auth.js",
    "src/bin/valxos-web.js",
    "src/lib/guichet.js",
    "src/facteur/round.js",
    "src/lib/postbox.js"
  ]) {
    assert.ok(noms.includes(attendu), `SONDE IMPOSSIBLE : ${attendu} est hors du balayage (vus : ${noms.join(", ")})`);
  }

  // L'instrument prouve d'abord qu'il MORD, sur CHAQUE alias : un détecteur
  // qui ne détecte rien rendrait ce test vert quoi qu'on écrive dans src/web.
  for (const [source, attendus] of BANC_QUI_DOIT_MORDRE) {
    const vus = lanceursDe(source);
    for (const attendu of attendus) {
      assert.ok(vus.includes(attendu), `le détecteur est AVEUGLE à « ${attendu} » dans : ${source} (vus : ${vus})`);
    }
  }
  for (const source of BANC_QUI_NE_DOIT_PAS_MORDRE) {
    assert.deepEqual(lanceursDe(source), [], `FAUX POSITIF sur : ${source}`);
  }

  let balayes = 0;
  const excepteesVues = new Set();
  for (const fichier of fichiers) {
    const nom = path.relative(racine, fichier);
    const ext = path.extname(fichier);

    // ① LA LISTE EST FERMÉE. Un fichier d'un type qu'on n'a pas prévu n'est pas
    // « probablement inoffensif » : c'est un trou dans le balayage, et il se dit.
    assert.ok(
      SOURCES.has(ext) || DONNEES.has(ext),
      `${nom} : extension « ${ext} » hors de la liste FERMÉE — ni source à balayer, ni donnée à prouver. Décide, ne devine pas.`
    );

    if (DONNEES.has(ext)) {
      // ② UNE DONNÉE PROUVE QU'ELLE EN EST. Sans ce verrou, se soustraire à la
      // garde ne coûterait qu'un `mv porte-derobee.js polices/innocent.woff2`.
      const magie = DONNEES.get(ext);
      const tete = Buffer.alloc(magie.length);
      const fd = fs.openSync(fichier, "r");
      try { fs.readSync(fd, tete, 0, magie.length, 0); } finally { fs.closeSync(fd); }
      assert.ok(
        tete.equals(magie),
        `${nom} porte l'extension « ${ext} » mais pas sa signature (${JSON.stringify(magie.toString())}) — une donnée qui ne prouve pas son type est une source qui se cache.`
      );
      continue;
    }

    // ③ UNE SOURCE EST BALAYÉE, SANS EXCEPTION — et ce qu'elle contient se
    // confronte à la LISTE FERMÉE des exceptions, jamais à zéro tout court.
    balayes += 1;
    const vus = lanceursDe(fs.readFileSync(fichier, "utf8"));
    const permis = EXCEPTIONS.get(nom);
    if (!permis) {
      assert.deepEqual(
        vus,
        [],
        `${nom} contient un lanceur — la porte ne lance RIEN, sauf l'exception NOMMÉE (garde n°1). Si c'est délibéré, inscris le fichier dans EXCEPTIONS avec sa justification ET le test qui prouve que rien de ce que l'utilisateur tape n'atteint son argv.`
      );
      continue;
    }
    // ⚠️ ON NE COMPTE L'EXCEPTION COMME SERVIE QUE SI ELLE A SERVI. Écrit
    // d'abord `excepteesVues.add(nom)` sans condition, le contrôle
    // « EXCEPTION MORTE » plus bas naissait VERT : une entrée pointant un
    // fichier du graphe SANS aucun lanceur passait pour vivante. Mesuré en
    // ajoutant une entrée bidon sur `src/lib/format.js` — 4 pass, 0 fail.
    if (vus.length > 0) excepteesVues.add(nom);
    // Une exception porte sur des lanceurs NOMMÉS, pas sur un fichier en
    // blanc-seing : un lanceur de plus dans un fichier excepté rougit comme
    // partout ailleurs.
    const horsListe = vus.filter((lanceur) => !permis.lanceurs.includes(lanceur));
    assert.deepEqual(
      horsListe,
      [],
      `${nom} est excepté pour ${permis.lanceurs.join(", ")} — ${horsListe.join(", ")} n'y est pas et ne s'y glisse pas`
    );
    // ── ET L'EXCEPTION EST GRANULAIRE À L'APPEL, PAS AU NOM ─────────────────
    // La ligne ci-dessus laissait passer un lancement de PLUS sous un nom déjà
    // inscrit — l'exception avait été accordée pour la sonde de vivacité, pas
    // pour tout ce que ce fichier contiendra demain. On compare donc le COMPTE.
    assert.deepEqual(
      appelsDe(fs.readFileSync(fichier, "utf8")),
      permis.sites,
      `${nom} : le nombre de SITES D'APPEL a changé. Une exception porte sur des lancements PROUVÉS et COMPTÉS, pas sur un nom en blanc-seing — un lancement de plus dans un fichier excepté est un lancement de plus, quel que soit son nom.`
    );
  }

  // ── L'EXCEPTION SE PAIE AUSSI DANS L'AUTRE SENS ───────────────────────────
  // Une exception qu'aucun fichier ne justifie plus est une porte laissée
  // entrouverte pour rien : le jour où la sonde de vivacité changera de
  // maison, cette ligne rougira et forcera à rouvrir la question au lieu de
  // laisser l'autorisation traîner.
  for (const [nom, permis] of EXCEPTIONS) {
    assert.ok(
      excepteesVues.has(nom),
      `EXCEPTION MORTE : ${nom} est autorisé à lancer mais n'a rien été trouvé à lancer (ou n'est plus dans le graphe) — retire l'exception au lieu de la garder au chaud`
    );
    assert.ok(
      typeof permis.pourquoi === "string" && permis.pourquoi.length > 40,
      `${nom} : une exception sans justification écrite n'est pas une exception, c'est un trou`
    );
    assert.ok(
      typeof permis.prouvee_par === "string" && permis.prouvee_par.length > 10,
      `${nom} : une exception qui ne nomme pas le test qui la paie n'est pas payée`
    );
    // TROISIÈME ISSUE, ENCORE : une exception SANS compte de sites n'est pas
    // une exception resserrée, c'est l'ancienne — celle qui se contentait d'un
    // nom. Un `sites: {}` oublié rendrait la comparaison ci-dessus vraie pour
    // un fichier qui ne lance rien, et muette pour un fichier qui lance.
    assert.ok(
      permis.sites && Object.keys(permis.sites).length > 0,
      `${nom} : une exception doit COMPTER ses sites d'appel (sites: { … }) — sans compte, elle est granulaire au nom, donc à rien`
    );
  }

  // TROISIÈME ISSUE, ENCORE : un balayage qui n'a balayé personne n'est pas un
  // balayage vert, c'est une sonde qui n'a pas tourné. Le plancher monte avec
  // le graphe — quatre fichiers suffisaient quand la garde ne voyait que
  // `src/web/` ; elle en voit maintenant le double.
  assert.ok(balayes >= 12, `SONDE IMPOSSIBLE : ${balayes} source(s) balayée(s), on en attend au moins douze`);
});

// ── ② L'EXCEPTION PAIE SON EXCEPTION ────────────────────────────────────────
//
// La sonde de vivacité a le droit de lancer. Ce droit ne s'obtient PAS parce
// qu'elle est ancienne, ni parce qu'elle est partagée avec le CLI : il
// s'obtient parce que la troisième clause de la garde n°1 tient, et elle ne
// tient que si on la MESURE —
//
//     « RIEN DE CE QUE L'UTILISATEUR TAPE N'ATTEINT UNE LIGNE DE COMMANDE »
//
// C'est la clause qui porte aujourd'hui (la sonde ne reçoit qu'un chemin de
// socket lu au REGISTRE local et un entier validé) et c'est la MÊME qui
// portera le jour où la porte saura embaucher une chaise : on choisit dans une
// liste, jamais on n'écrit une commande.
//
// Ce que ce test refuse de faire, et qui serait la façon facile de le rendre
// vert : mesurer la sonde en isolation avec des dépendances injectées. Le
// chemin qu'on veut prouver est le chemin RÉEL — un vrai POST sur la vraie
// porte, un vrai guichet, une vraie tournée — et le mouchard est posé sur
// `node:child_process` lui-même, là où la donnée SORT.

// Tout ce qui, dans node, met des octets sur une ligne de commande.
const LANCEURS_ESPIONNES = ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"];

// Le mouchard remplace les vrais lanceurs sur l'OBJET du module — le même que
// `postbox.js` lit à chaque appel (`{ execFileSync = childProcess.execFileSync }`
// est un défaut de paramètre, évalué à l'appel, jamais figé à l'import). Rien
// ne part donc pour de vrai pendant ce test, et tout est noté.
function poserLeMouchard(t) {
  const journal = [];
  const originaux = new Map();
  for (const nom of LANCEURS_ESPIONNES) {
    originaux.set(nom, childProcess[nom]);
    childProcess[nom] = (...args) => {
      journal.push({ nom, args });
      // Une sortie vide : `procStartOf` la lira comme « pas d'heure » et
      // `sonderLaBoite` comme « pas d'erreur ». Aucun des deux ne casse.
      return Buffer.alloc(0);
    };
  }
  t.after(() => {
    for (const [nom, fonction] of originaux) childProcess[nom] = fonction;
  });
  return journal;
}

// Tout ce qu'un lancement emporte, aplati en un seul texte : le programme, son
// argv, et TOUTES les valeurs des options — `env` comprise. Une charge qui
// voyagerait par une variable d'environnement atteindrait le programme aussi
// sûrement que par argv ; ne regarder que l'argv serait fermer la moitié de la
// porte et appeler ça une garde.
function texteDuLancement({ nom, args }) {
  const morceaux = [nom];
  const avaler = (valeur, profondeur = 0) => {
    if (valeur === null || valeur === undefined || profondeur > 5) return;
    if (typeof valeur === "string") morceaux.push(valeur);
    else if (typeof valeur === "number" || typeof valeur === "boolean") morceaux.push(String(valeur));
    else if (Buffer.isBuffer(valeur)) morceaux.push(valeur.toString("utf8"));
    else if (Array.isArray(valeur)) for (const element of valeur) avaler(element, profondeur + 1);
    else if (typeof valeur === "object") {
      for (const [clef, sous] of Object.entries(valeur)) {
        morceaux.push(clef);
        avaler(sous, profondeur + 1);
      }
    }
  };
  avaler(args);
  // `\0` : un séparateur qu'aucune charge ne contient, pour qu'aucune
  // frontière ne fabrique un faux négatif par recollage.
  return morceaux.join("\0");
}

// LES CHARGES. Une par champ que le CLIENT contrôle sur `POST /api/poster`,
// chacune reconnaissable à l'œil, et chacune HOSTILE : un point-virgule et un
// shell, une substitution de commande, des guillemets des deux sortes, un
// retour à la ligne, de l'UTF-8 hors ASCII. Si l'une d'elles atteignait un
// jour une ligne de commande, ce n'est pas « une chaîne bizarre » qui
// arriverait au bout, c'est un shell.
const SUFFIXE = "X7Q2";
const CHARGES = {
  a: `MOUCHARD-DESTINATAIRE-${SUFFIXE}; /bin/sh -c "$(id)"`,
  objet: `MOUCHARD-OBJET-${SUFFIXE} \`id\` 'apostrophe' "guillemet"`,
  corps: `MOUCHARD-CORPS-${SUFFIXE}\n$(id)\n; rm -rf /\névidemment-Ω-日本語`,
  type: `MOUCHARD-TYPE-${SUFFIXE}|id`,
  msg_id: `MOUCHARD-MSGID-${SUFFIXE}$(id)`,
  thread_id: `MOUCHARD-THREAD-${SUFFIXE}; id`,
  priorite: `MOUCHARD-PRIORITE-${SUFFIXE}&&id`,
  // `de` n'est pas un paramètre de la porte (elle signe l'opérateur, toujours) —
  // raison de plus pour vérifier qu'un client qui en glisse un n'atteint rien.
  de: `MOUCHARD-DE-${SUFFIXE}; id`
};

// Une maison jetable avec DEUX fiches de boîte, taillées pour que la tournée
// prenne SES DEUX chemins de lancement — c'est le décor qui rend le mouchard
// capable de voir quelque chose :
//   · une fiche SANS heure de démarrage → `sonderLaBoite` (le `node -e`) ;
//   · une fiche AVEC heure de démarrage → `procStartOf` (le `/bin/ps`).
// Les deux numéros sont VIVANTS (le nôtre et celui de notre parent), sans quoi
// `isProcessAlive` écarterait la fiche avant tout lancement.
function maisonAvecDeuxBoites(t) {
  const maison = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-maison-"));
  const registre = path.join(maison, "sessions");
  fs.mkdirSync(registre, { recursive: true });
  fs.writeFileSync(
    path.join(registre, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: "boite-sans-heure",
      messagingSocketPath: path.join(maison, "sans-heure.sock")
    })
  );
  fs.writeFileSync(
    path.join(registre, `${process.ppid}.json`),
    JSON.stringify({
      pid: process.ppid,
      sessionId: "boite-avec-heure",
      messagingSocketPath: path.join(maison, "avec-heure.sock"),
      procStart: "Sat Aug 22 09:00:00 2026"
    })
  );
  const maisonsInitiales = process.env.CC2CC_MAISONS;
  process.env.CC2CC_MAISONS = maison;
  t.after(() => {
    if (maisonsInitiales === undefined) delete process.env.CC2CC_MAISONS;
    else process.env.CC2CC_MAISONS = maisonsInitiales;
    fs.rmSync(maison, { recursive: true, force: true });
  });
  return maison;
}

test("RIEN DE CE QUE L'UTILISATEUR TAPE N'ATTEINT UNE LIGNE DE COMMANDE — la clause qui paie l'exception de la sonde", async (t) => {
  const db = bureauJetable(t);
  maisonAvecDeuxBoites(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const journal = poserLeMouchard(t);

  // ── CONTRÔLE POSITIF ①, LE MOUCHARD EST BIEN POSÉ ─────────────────────────
  // Avant que son silence ne vaille quoi que ce soit, il doit MORDRE. On lui
  // donne un lancement à voir, avec une charge, et on exige de le retrouver.
  childProcess.execFileSync("/bin/echo", [`CONTROLE-POSITIF-${SUFFIXE}`]);
  assert.equal(journal.length, 1, "le mouchard n'a pas remplacé execFileSync — son silence ne prouverait RIEN");
  assert.ok(
    texteDuLancement(journal[0]).includes(`CONTROLE-POSITIF-${SUFFIXE}`),
    "le mouchard ne relit pas ce qu'il note — il ne saurait pas reconnaître une charge s'il en voyait une"
  );
  journal.length = 0;

  // ── LE VRAI GESTE ─────────────────────────────────────────────────────────
  const reponse = await requete(base, "/api/poster", {
    methode: "POST",
    cookie,
    corps: CHARGES
  });
  assert.equal(reponse.statut, 200, `la lettre doit PARTIR (reçu : ${reponse.statut} ${reponse.texte})`);

  // ── CONTRÔLE POSITIF ②, LE MOUCHARD EST SUR LE CHEMIN RÉEL ────────────────
  // Un POST qui ne lancerait rien rendrait ce test vert sans rien prouver — et
  // c'est précisément l'état dans lequel la garde a vécu jusqu'au 22/08. On
  // exige donc de VOIR les lancements que la passe adverse a mesurés.
  assert.ok(
    journal.length >= 2,
    `SONDE IMPOSSIBLE : POST /api/poster n'a lancé que ${journal.length} processus — le décor ne fait plus passer la tournée par la sonde de vivacité, et le silence du mouchard ne prouve plus rien`
  );

  // ── CONTRÔLE POSITIF ③, LES CHARGES ONT VRAIMENT TRAVERSÉ LE PRODUIT ──────
  // Sans lui, une porte qui jetterait tout ce qu'on lui tape passerait ce test
  // en triomphe : « rien n'atteint argv » est trivial quand rien n'atteint
  // rien. On relève la boîte et on exige d'y retrouver ce qu'on a tapé.
  const fil = await requete(base, "/api/fil", { cookie });
  assert.equal(fil.statut, 200);
  const lettre = fil.json.lettres.find((l) => l.corps.includes(`MOUCHARD-CORPS-${SUFFIXE}`));
  assert.ok(lettre, "la charge du corps n'est pas arrivée jusqu'à la boîte — le test ne mesurerait qu'un refus");
  assert.ok(lettre.objet.includes(`MOUCHARD-OBJET-${SUFFIXE}`), "la charge de l'objet n'a pas traversé");
  assert.equal(lettre.a, CHARGES.a, "la charge du destinataire n'a pas traversé");

  // ── LA CLAUSE ─────────────────────────────────────────────────────────────
  const lancements = journal.map(texteDuLancement);
  for (const [champ, charge] of Object.entries(CHARGES)) {
    // On cherche le MARQUEUR, pas la charge entière : une charge tronquée,
    // échappée ou recollée autrement resterait une charge arrivée à
    // destination, et c'est elle qu'on veut voir.
    const marqueur = `MOUCHARD-${champ === "a" ? "DESTINATAIRE" : champ.toUpperCase()}-${SUFFIXE}`;
    for (let i = 0; i < lancements.length; i += 1) {
      assert.ok(
        !lancements[i].includes(marqueur),
        `LE CHAMP « ${champ} » A ATTEINT UNE LIGNE DE COMMANDE (lancement ${journal[i].nom}) : ${lancements[i]}`
      );
    }
  }

  // Et la même exigence sans passer par les noms de champs : aucun octet de ce
  // que le client a tapé, pas même un fragment reconnaissable, dans un argv.
  for (const lancement of lancements) {
    assert.ok(!lancement.includes("MOUCHARD-"), `une charge du client a atteint un lancement : ${lancement}`);
    assert.ok(!lancement.includes("$(id)"), `une substitution de commande du client a atteint un lancement : ${lancement}`);
    assert.ok(!lancement.includes("/bin/sh"), `un shell tapé par le client a atteint un lancement : ${lancement}`);
  }

  // CE QUE LA SONDE REÇOIT VRAIMENT, dit une fois pour le lecteur : le chemin
  // de socket vient du REGISTRE (une fiche du disque, jamais du client) et le
  // numéro est un entier déjà validé. C'est ça, et rien d'autre, qui justifie
  // l'exception de `src/lib/postbox.js`.
  const cheminsDuRegistre = lancements.filter((texte) => texte.includes("cc2cc-porte-maison-"));
  assert.ok(
    cheminsDuRegistre.length > 0,
    "SONDE IMPOSSIBLE : aucun lancement ne porte un chemin du registre — on ne mesure pas la sonde de vivacité"
  );
});

test("la porte n'écoute que la boucle locale — 0.0.0.0 et le LAN sont refusés, et rien n'écoute après le refus", async (t) => {
  const db = bureauJetable(t);

  for (const hote of ["0.0.0.0", "192.168.1.42", "::", "10.0.0.42", ""]) {
    assert.throws(
      () => verifierLHote(hote),
      /loopback interface \(127\.0\.0\.1/,
      `l'hôte ${JSON.stringify(hote)} doit être refusé, et le refus doit se NOMMER`
    );
    // ⚠️ Le jour où cette garde tombe, ce test ne doit pas LAISSER une porte
    // ouverte sur 0.0.0.0 derrière lui : un mutant se referme, il ne se fuit
    // pas. (Sans ce `finally`, le rouge de la mutation laissait un serveur en
    // écoute et le runner ne rendait jamais la main.)
    let fuite = null;
    try {
      await assert.rejects(
        async () => {
          fuite = await ouvrirLaPorte({ db, jeton: "x".repeat(64), operateur: "alice", hote, port: 0 });
        },
        /loopback interface \(127\.0\.0\.1/,
        `ouvrirLaPorte doit refuser ${JSON.stringify(hote)} — la garde est sur le chemin réel`
      );
    } finally {
      if (fuite) await fuite.fermer();
    }
  }

  // Contrôle positif : la garde reste une garde, pas un mur.
  const ouverte = await ouvrirLaPorte({
    db,
    jeton: "x".repeat(64),
    operateur: "alice",
    hote: "127.0.0.1",
    port: 0
  });
  assert.equal(ouverte.adresse.address, "127.0.0.1");
  await ouverte.fermer();
});

// ── LES POLICES : TROIS SOURCES QUI DOIVENT DIRE LA MÊME CHOSE ──────────────
//
// Le contrat dit ce que la porte a le droit de servir. Mais un tableau écrit à
// la main peut aussi DÉRIVER de la réalité sans que personne s'en aperçoive —
// on l'aurait recopié une fois, et il vieillirait en silence. On confronte donc
// TROIS sources indépendantes, et il en faut trois parce que chacune ment
// autrement :
//
//   ① LE CONTRAT       (`POLICES_DU_CONTRAT`, écrit à la main ci-dessus)
//                      → ce qu'on a DÉCIDÉ de servir.
//   ② LE DOSSIER       (`src/web/public/polices/`, ce que `ROUTES` énumère)
//                      → ce que la porte servirait EFFECTIVEMENT.
//   ③ LA FEUILLE       (`polices.css`, ses `url('polices/…')`)
//                      → ce que la PAGE demande réellement au navigateur.
//
// Les trois écarts, et ce que chacun veut dire :
//   ②\① un fichier déposé dans le dossier sans passer par une décision — la
//       classe que ce remède ferme. La porte le servirait.
//   ①\② une police au contrat qui n'est plus livrée — la page tomberait sur
//       sa pile de secours, en silence, et personne ne saurait pourquoi.
//   ③\② la feuille demande une police absente — un 404 à chaque ouverture.
//   ②\③ une police livrée et servie que RIEN ne demande — du poids mort dans
//       un dépôt public, et une surface de plus pour rien.
//
// C'est le remède de l'oracle qui se comparait à lui-même : aucune de ces
// trois lignes ne peut plus être vraie « par construction ».
test("les polices servies sont EXACTEMENT celles du contrat, du dossier ET de la feuille — trois sources, pas une lue deux fois", () => {
  const dossier = path.join(racine, "src", "web", "public", "polices");

  const auDossier = fs
    .readdirSync(dossier)
    .filter((nom) => nom.endsWith(".woff2"))
    .sort();

  const feuille = fs.readFileSync(path.join(racine, "src", "web", "public", "polices.css"), "utf8");
  const demandees = [...feuille.matchAll(/url\(['"]polices\/([^'"]+)['"]\)/g)].map((m) => m[1]).sort();

  // TROIS ISSUES, JAMAIS DEUX. Un dossier vide, une feuille qui ne demande
  // rien, un contrat vide : chacun rendrait les trois égalités ci-dessous
  // vraies pour la pire des raisons.
  assert.ok(POLICES_DU_CONTRAT.length >= 8, `SONDE IMPOSSIBLE : ${POLICES_DU_CONTRAT.length} police(s) au contrat`);
  assert.ok(auDossier.length >= 8, `SONDE IMPOSSIBLE : ${auDossier.length} .woff2 dans ${dossier}`);
  assert.ok(demandees.length >= 8, `SONDE IMPOSSIBLE : ${demandees.length} url('polices/…') dans polices.css`);

  assert.deepEqual(
    auDossier,
    [...POLICES_DU_CONTRAT].sort(),
    "le dossier des polices ne dit pas la même chose que le contrat — un fichier déposé là devient SERVI par la porte, et déposer n'est pas décider. Inscris-le au contrat, ou retire-le du dossier."
  );
  assert.deepEqual(
    demandees,
    auDossier,
    "la feuille `polices.css` et le dossier ne s'accordent pas — soit la page demande une police qu'on ne livre pas (404 à chaque ouverture), soit on livre et on SERT une police que rien ne demande"
  );

  // Et le nom d'un fichier ne dit rien de son contenu : chaque police prouve
  // ses octets (`wOF2`). La descente de répertoire l'exige déjà pour TOUT
  // `.woff2` du dépôt ; on le redit ici sur les fichiers réellement SERVIS,
  // parce que c'est ici qu'on affirme qu'ils sont des polices.
  for (const nom of auDossier) {
    const tete = Buffer.alloc(4);
    const fd = fs.openSync(path.join(dossier, nom), "r");
    try {
      fs.readSync(fd, tete, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(tete.toString("ascii"), "wOF2", `${nom} est servi comme une police mais n'en porte pas la signature`);
  }
});
