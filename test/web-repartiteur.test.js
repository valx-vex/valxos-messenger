// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// GARDE N°1, MOITIÉ ① — L'ORACLE DU RÉPARTITEUR, PAS DE LA DÉCLARATION.
//
// Ce que `web-garde-spawn.test.js` prouve : que la TABLE `ROUTES` est celle du
// contrat, et que QUINZE chemins nommés à la main répondent 404 (le compte se
// relit dans `const interdites` de ce fichier-là ; il disait « quatorze » et se
// trompait d'un — une phrase de plus qui n'avait jamais été recomptée). Ce
// qu'il ne prouve PAS, et la mutation l'a montré (22/08, deux lentilles
// adverses) :
//
//     if (chemin === "/api/console") { repondreJson(res, 200, {…}); return; }
//
// une ligne, insérée juste avant le `ROUTES.find` → 528 pass / 0 fail. La table
// n'a pas bougé, les quinze chemins non plus, et une porte dérobée servait.
// Un oracle de POINT ne ferme jamais une CLASSE : allonger la liste des chemins
// interdits ne l'aurait pas fermée non plus, quelle que soit sa longueur.
//
// L'oracle de ce fichier porte donc sur le CHEMIN QUELCONQUE, par trois voies
// qui ne se recouvrent pas :
//
//   ⓐ LES LITTÉRAUX DE LA SOURCE. Toute chaîne de caractères qui traîne dans
//     les fichiers de la porte devient un chemin candidat, et doit obéir à la
//     table. C'est la voie qui MORD sur la mutation : une porte dérobée qu'on
//     ne peut pas nommer n'est pas une porte dérobée, et son nom est dans la
//     source. On teste le littéral tel quel, ET avec un suffixe (un
//     `startsWith` se cacherait derrière un préfixe), ET précédé d'un segment
//     (un `endsWith` se cacherait derrière un suffixe).
//     ⚠️ « LES FICHIERS DE LA PORTE » a changé de sens le 22/08 : ce n'était
//     que trois fichiers écrits à la main, et il suffisait d'écrire le nom de
//     la porte dérobée UN FICHIER PLUS LOIN (dans `src/lib/config.js`) pour
//     que la suite entière reste verte avec une route servie hors table —
//     mesuré, 590 pass / 0 fail. Le vivier suit maintenant le graphe des
//     imports, comme le balayage de la garde n°1.
//   ⓑ LE TIRAGE, STRATIFIÉ. Il parcourt le produit complet ALPHABET × CLASSE DE
//     LONGUEUR (jusqu'à 400 caractères) × FORME × PROFONDEUR, et ne laisse au
//     hasard que le contenu (graine fixe : un échec doit se rejouer à
//     l'identique) ; plus les voisins structurels des vraies routes — casse,
//     barre finale, double barre, encodage, préfixe. La v1 plafonnait à 33
//     caractères sur un seul alphabet, et une porte dérobée par MOTIF passait
//     les sept gardes : un motif ne se devine pas plus qu'un nom, ce qui se
//     couvre ce sont les DIMENSIONS dans lesquelles il peut vivre.
//   ⓒ LE RÉPARTITEUR NU. `repartir` est une fonction PURE et exportée : on la
//     bombarde de dizaines de milliers de chemins et on exige qu'elle ne rende
//     JAMAIS une route qui ne soit pas une ligne de `ROUTES`.
//
// L'ORACLE, en une phrase, et il est le même pour les trois voies :
//     un chemin est SERVI si et seulement si (méthode, chemin) est une ligne
//     de la table. Tout le reste est 404, ou 405 sur un chemin connu.
//
// ── ⓓ LA MARQUE DU RÉPARTITEUR — L'ORACLE QUI N'A PLUS BESOIN DE DEVINER ────
//
// LES TROIS VOIES CI-DESSUS SONT DES ORACLES DE LECTURE, ET ELLES ONT ÉTÉ
// PRISES EN DÉFAUT (22/08, quatrième fois de la journée). La porte dérobée :
//
//     if (chemin === String.fromCharCode(47,116,114,111,117)) {
//       repondreJson(res, 200, { trou: true }); return undefined;
//     }
//
//   insérée dans le gestionnaire AVANT `repartir` : `GET /trou` répond 200, et
//   la suite ENTIÈRE reste verte — MESURÉ, 598 pass / 0 fail. Aucune des trois
//   voies ne pouvait la voir : ⓐ n'extrait que des LITTÉRAUX (ici ce sont des
//   nombres), ⓑ ne tire pas ce chemin parmi l'infini des chemins, ⓒ ne voit que
//   `repartir` — que la ligne court-circuite en rendant la main AVANT lui.
//
// Allonger le tirage, élargir l'extraction : même impasse que la liste des
// chemins interdits. UN ORACLE QUI LIT LA SOURCE NE FERMERA JAMAIS UNE CLASSE,
// parce qu'on peut toujours écrire la même chose autrement.
//
// LA FERMETURE EST DONC AU RUNTIME. Le gestionnaire HTTP n'a plus qu'UN SEUL
// chemin vers une réponse, et ça ne se lit pas dans la source, ça se PROUVE en
// faisant tourner la porte :
//   · répondre PAR `res` exige un VERDICT FRAPPÉ par une décision de la porte
//     (serveur.js) ; une ligne qui appelle une fonction de réponse en amont du
//     répartiteur n'en a pas, et n'écrit RIEN — elle lève, et la porte rend une
//     panne.
//     ⚠️ CE POINT DISAIT « ÉCRIRE UN OCTET SUR LA PORTE EXIGE UN VERDICT », ET
//     C'ÉTAIT FAUX DEUX FOIS. `res.end()` est la méthode NUE de node et n'exige
//     rien (ⓕ) ; et `req.socket` court-circuite `res` en entier, donc le
//     dispositif entier — une ligne dans `verdictDeLaRequete` (serveur.js) ou
//     dans `verdictDeLaPorte` (auth.js) rend 200 sans marque, avec 607 pass /
//     0 fail (mesuré, voir ⓖ). Ce que la marque exige, c'est de répondre PAR
//     `res` ; le fil, lui, est tenu par une lecture (ⓖ), plus faiblement ;
//   · chaque réponse autorisée porte la marque de son verdict en en-tête, et le
//     décor commun la vérifie sur les CENTAINES de requêtes de la suite entière
//     (test/aide-porte.js) : une réponse sans marque se fait voir par le premier
//     test qui touche son chemin, sans que personne ait eu à le deviner ;
//   · et la seule chose vraiment structurelle côté source : le gestionnaire
//     passé à `http.createServer` est une DÉLÉGATION NUE, dont la forme est
//     assertée ici — une décision écrite là change son texte, point.
//
// ⚠️ CE QUE CE FICHIER NE PRÉTEND PAS FERMER, ET IL FAUT QUE ÇA SOIT ÉCRIT.
// Ces oracles ferment l'introduction NON INTENTIONNELLE d'une route ou d'une
// réponse — la ligne qu'on ajoute sans voir ce qu'elle fait. Ils NE ferment PAS
// la porte dérobée délibérée d'un auteur du dépôt : celui-là peut frapper un
// verdict lui-même dans `serveur.js`, ou éditer ce fichier. La régression est
// infinie de ce côté-là, et elle se solde ailleurs — par la revue, par le
// contrôle des accès au dépôt, par le fait que rien ne part sans le mot de
// l'opérateur. Le raisonnement complet est en tête de `web-garde-spawn.test.js`.
//
// ── LES TROIS ENDROITS OÙ LA MUTATION A ÉTÉ REJOUÉE, ET CE QU'ELLE Y DEVIENT ─
//
// Mesuré le 22/08, la MÊME ligne posée à trois profondeurs :
//
//   ① dans le gestionnaire de `http.createServer`
//        → ROUGE (forme de la délégation nue), ET l'écriture est refusée.
//   ② dans `servirLaRequete`, avant la chaîne de promesses
//        → ROUGE (forme de `servirLaRequete`), ET l'écriture est refusée.
//   ③ dans `verdictDeLaRequete`, avant `repartir`
//        → la suite reste VERTE : 602 pass / 0 fail. Aucun test ne demande
//          `/trou`, et aucun test ne peut le demander sans l'avoir deviné.
//          MAIS CETTE POSE-LÀ, ÉCRITE COMME ÇA, est INERTE : elle appelle
//          `repondreJson(res, …)`, et `res` n'existe pas à cet endroit — la
//          ligne lève, et `GET /trou` rend 500 « panne-de-la-porte », marqué
//          « panne », jamais 200, jamais `{trou:true}`.
//
// Il faut lire ③ pour ce qu'il est, sans l'arrondir : LA GARDE NE DÉTECTE PAS
// CETTE POSE-LÀ, ELLE LA REND SANS EFFET. Détecter une porte dérobée sur un
// chemin qu'on n'a pas deviné demanderait de visiter ce chemin — c'est-à-dire
// de le deviner. C'est précisément l'impasse qui a fait perdre la journée du
// 22/08 ; on en sort en fermant par CONSTRUCTION, pas en allongeant un tirage.
//
// ⚠️ ET LE « SANS EFFET » DE ③ NE TIENT QU'À LA FORME DE CETTE LIGNE-LÀ. La
// généralisation qu'on en avait tirée — « une fonction qui ne tient pas la
// réponse ne peut pas répondre » — est FAUSSE, et c'est la dernière trouvaille
// du run. `verdictDeLaRequete` tient `req`, et node accroche le TRANSPORT à
// `req` : une ligne qui écrit une réponse HTTP brute sur `req.socket`, au même
// endroit, rend 200 avec le corps voulu et AUCUNE marque, en laissant la suite
// à 607 pass / 0 fail. Mesuré deux fois — ici et dans `verdictDeLaPorte`
// (auth.js). C'est ⓖ, en bas de ce fichier, qui tient ce chemin — par une
// LECTURE, donc plus faiblement que tout ce qui précède.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-repart-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import http from "node:http";
import {
  EN_TETE_DE_LA_MARQUE,
  MARQUES,
  ROUTES,
  estUnVerdict,
  noterLaLigne,
  repartir,
  repondreJson,
  servirLaPanne,
  servirLaRequete,
  servirLeVerdict
} from "../src/web/serveur.js";
import { ANCRES_DU_GRAPHE, grapheCharge } from "./aide-graphe.js";
import { bureauJetable, cookieDePremiereVisite, porteDeTest, requete } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

// ── LA SONDE ET SA CONNEXION — POURQUOI UN AGENT, ET POURQUOI ON DRAINE ─────
//
// ⚠️ POURQUOI PAS `requete()` DU DÉCOR COMMUN : il construit son URL par
// `new URL(chemin, base)`, et `new URL("//sonde/x", …)` lit « //sonde » comme
// un HÔTE, pas comme un chemin — la sonde partait résoudre un nom de domaine
// au lieu d'interroger la porte. Un oracle sur le chemin QUELCONQUE doit
// pouvoir envoyer les chemins tordus TELS QUELS, `//` compris : on parle donc
// à la porte en ligne de requête brute.
//
// ⚠️ LA SUITE S'EMPOISONNAIT ELLE-MÊME, ET C'EST CE FICHIER QUI LA POISONNAIT.
// La sonde faisait `res.destroy(); req.destroy()` sur CHAQUE réponse : une
// connexion tuée à la main est un port éphémère qui part en TIME_WAIT, et cet
// oracle en tire des milliers. MESURÉ le 22/08, delta de sockets TIME_WAIT
// par fichier de la suite :
//
//     4423  test/garde-bureau.test.js   ← il REJOUE la suite, donc ce fichier-ci
//     4377  test/web-repartiteur.test.js
//       21  test/web-api.test.js
//       19  test/web-front.test.js
//        …  tout le reste ≤ 4
//
//   → 8 905 sockets en TIME_WAIT avant, 16 344 après UN passage, et la suite
//     relancée dans la foulée tombait sur `connect EADDRNOTAVAIL 127.0.0.1` :
//     la plage éphémère de macOS (16 384 ports) était vide. C'est plus grave
//     qu'une lenteur — TOUTE vérification de cette journée est « je relance la
//     suite et je regarde », et une suite qu'on ne peut pas relancer deux fois
//     rend chaque verdict fragile.
//
// LE REMÈDE : on ne tue plus, on DRAINE. Une réponse lue jusqu'au bout rend sa
// connexion à l'agent, qui la REJOUE pour la sonde suivante — des milliers de
// sondes tiennent alors dans une poignée de sockets. Le `keepAlive` est
// explicite et l'agent est à NOUS : `http.globalAgent` est partagé avec le
// reste de la suite, et on ne veut pas que la fermeture de nos portes de test
// aille couper les connexions d'un autre fichier.
const AGENT = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 8 });
after(() => AGENT.destroy());

// Ce qu'on laisse à une réponse pour finir avant de la couper. Une seule route
// de la table ne finit JAMAIS (`/api/evenements`, c'est un flux) : elle est la
// seule sonde qui coûte encore une socket, et c'est le bon prix.
const LAISSE_DU_FLUX_MS = 250;

function sonder(base, chemin, { methode = "GET", cookie, corps = null } = {}) {
  const url = new URL(base);
  const charge = corps === null ? null : JSON.stringify(corps);
  const entetes = { cookie };
  if (charge !== null) entetes["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: chemin, method: methode, headers: entetes, agent: AGENT },
      (res) => {
        // Ce qu'on mesure tient tout entier dans la ligne de statut — et,
        // depuis le remède ⓓ, dans la MARQUE que la réponse porte. Le corps ne
        // nous intéresse pas ; on le lit quand même, parce que le lire est ce
        // qui REND la connexion au lieu de la brûler.
        clearTimeout(couperet);
        const verdict = { statut: res.statusCode, marque: res.headers[EN_TETE_DE_LA_MARQUE] ?? null };
        res.resume();
        // Le garde-fou du flux : si la réponse ne finit pas, on coupe. Sans
        // lui, `/api/evenements` ferait PENDRE la sonde au lieu de la rendre —
        // c'est l'ancien `destroy()` inconditionnel, réduit au seul cas qui
        // l'exigeait.
        const laisse = setTimeout(() => {
          res.destroy();
          req.destroy();
          resolve(verdict);
        }, LAISSE_DU_FLUX_MS);
        const rendre = () => {
          clearTimeout(laisse);
          resolve(verdict);
        };
        res.once("end", rendre);
        res.once("error", rendre);
      }
    );
    // ⚠️ UN COUPERET PAR SONDE. Sans lui, un chemin auquel la porte ne répond
    // jamais fait PENDRE la suite au lieu de la faire rougir — et un test qui
    // pend est un test qu'on cesse de croire. Le couperet nomme le chemin.
    const couperet = setTimeout(() => {
      req.destroy();
      reject(new Error(`${methode} ${chemin} : la porte n'a jamais répondu (5 s)`));
    }, 5000);
    req.on("error", (erreur) => {
      clearTimeout(couperet);
      reject(erreur);
    });
    req.end(charge === null ? undefined : charge);
  });
}

const racine = path.resolve(new URL("..", import.meta.url).pathname);

// ── « LA SOURCE DE LA PORTE », ET POURQUOI CE N'EST PLUS TROIS FICHIERS ──────
//
// Ce vivier était écrit à la main : serveur.js, auth.js, valxos-web.js. La même
// myopie que le balayage de la garde n°1 avait (test/web-garde-spawn.test.js,
// ①) — on nommait un répertoire au lieu de suivre ce que la porte CHARGE. Ce
// que ça coûtait, MESURÉ le 22/08 en trois lignes :
//
//     src/lib/config.js :  export const CHEMIN_TECHNIQUE = "/api/trappe-vaudou";
//     src/web/serveur.js:  if (chemin === CHEMIN_TECHNIQUE) { repondreJson(res, 200, …); return; }
//
//   → GET /api/trappe-vaudou répond 200, et la suite ENTIÈRE reste verte :
//     590 pass / 0 fail. ⓐ ne trouvait pas le nom (il n'est pas dans les trois
//     fichiers), ⓑ ne pouvait pas le deviner, ⓒ ne voit que `repartir` — que
//     la porte dérobée court-circuite. Le nom d'une porte dérobée est TOUJOURS
//     écrit quelque part ; il suffisait de le mettre un fichier plus loin.
//
// Le vivier suit donc le graphe des imports RELATIFS du dépôt, exactement
// comme le balayage de la garde n°1.
//
// ⚠️ TROISIÈME MYOPIE, ET LA COPIE EST MORTE AVEC ELLE. Ce parcours était écrit
// DEUX FOIS dans la suite (ici et dans `web-garde-spawn.test.js`), à la main,
// avec la même expression régulière — donc avec le même angle mort : elle exige
// un POINT LITTÉRAL après le guillemet, et `import { d } from
// "../lib/derob.js"` lui échappe alors que node le résout parfaitement.
// Mesuré le 22/08 : un module d'exécution de commande chargé dans le processus
// de la porte, 598 pass / 0 fail.
//
// Le vivier vient donc du RÉSOLVEUR DE NODE, pas d'une lecture de source, et il
// est écrit UNE fois dans `test/aide-graphe.js` — un fichier qui ne porte aucun
// test, comme `aide-porte.js`. La dette de la copie est soldée par le même
// geste que le trou : le seul instrument qui sait ce que la porte charge est
// celui qui la charge.
function fichiersDeLaPorte() {
  const graphe = grapheCharge(racine);
  // TROIS ISSUES, JAMAIS DEUX : une sonde qui n'a pas pu tourner n'est pas un
  // vivier vide, et son silence ne prouverait rien.
  assert.equal(
    graphe.probleme,
    null,
    `SONDE IMPOSSIBLE : la sonde de graphe n'a pas tourné (${graphe.probleme}) — stderr : ${graphe.stderr}`
  );
  return graphe.fichiers;
}

// ── L'ORACLE ────────────────────────────────────────────────────────────────
// Il se DÉRIVE de la table, il ne la recopie pas : une route ajoutée demain
// change l'oracle le jour où elle naît.
function verdictAttendu(chemin, methode) {
  const servie = ROUTES.some((ligne) => ligne.chemin === chemin && ligne.methode === methode);
  if (servie) return "servie";
  return ROUTES.some((ligne) => ligne.chemin === chemin) ? 405 : 404;
}

// « Servie » ne veut pas dire 200 : `POST /api/poster` sans destinataire rend
// un 400, et c'est bien un service rendu. Ce qu'on mesure, c'est le PASSAGE
// par la table — donc « ni 404 ni 405 ».
function conforme(reponse, attendu) {
  if (attendu === "servie") return reponse.statut !== 404 && reponse.statut !== 405;
  return reponse.statut === attendu;
}

// ── ⓐ LES LITTÉRAUX DE LA SOURCE ────────────────────────────────────────────
// Les chaînes simples (sans échappement ni interpolation) des trois fichiers.
// Volontairement grossier : mieux vaut cent candidats absurdes (`/utf8`,
// `/content-type`) qu'un chemin dérobé qu'on n'aurait pas pensé à écrire.
function litterauxDe(source) {
  const trouves = new Set();
  for (const trouve of source.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\$\n]*)`/g)) {
    const valeur = trouve[1] ?? trouve[2] ?? trouve[3] ?? "";
    if (valeur.length === 0 || valeur.length > 120) continue;
    // Un chemin d'URL, et rien d'autre : ce qui ne peut pas s'écrire dans une
    // barre d'adresse ne peut pas être un chemin servi.
    if (!/^[A-Za-z0-9_./%~-]+$/.test(valeur)) continue;
    trouves.add(valeur);
  }
  return trouves;
}

function cheminsCandidats(litteraux) {
  const chemins = new Set();
  for (const brut of litteraux) {
    const enChemin = brut.startsWith("/") ? brut : `/${brut}`;
    chemins.add(enChemin);
    // Le préfixe (`chemin.startsWith(…)`) et le suffixe (`chemin.endsWith(…)`)
    // sont les deux façons d'écrire une porte dérobée sans écrire son chemin
    // entier. Les deux se sondent.
    chemins.add(`${enChemin}/sonde`);
    chemins.add(`/sonde${enChemin}`);
  }
  return [...chemins];
}

// ── ⓑ LE TIRAGE ─────────────────────────────────────────────────────────────
// Graine FIXE : un échec doit se rejouer à l'identique. Un fuzz qui ne se
// rejoue pas n'est pas une sonde, c'est une anecdote.
function tirage(graine) {
  let etat = graine >>> 0;
  return () => {
    etat = (etat * 1_664_525 + 1_013_904_223) >>> 0;
    return etat / 4_294_967_296;
  };
}

// ⚠️ CE TIRAGE PLAFONNAIT À 33 CARACTÈRES — trois segments de dix au plus, un
// seul alphabet. Une porte dérobée par MOTIF passait donc les SEPT gardes, et
// c'est mesuré (22/08, une ligne dans le gestionnaire) :
//
//     if (/^\/[a-z]{40,}$/.test(chemin)) { repondreJson(res, 200, …); return; }
//
// Rien à trouver pour ⓐ (le chemin n'est pas un littéral, c'est une expression
// régulière), et pas un chemin de quarante lettres dans tout le tirage : sept
// gardes vertes, une porte ouverte. Un motif ne se devine pas plus qu'un nom —
// ce qui se couvre, ce sont les DIMENSIONS dans lesquelles il peut vivre.
//
// LE TIRAGE EST DONC STRATIFIÉ, pas seulement long : il parcourt le produit
// complet ALPHABET × CLASSE DE LONGUEUR × FORME × NOMBRE DE SEGMENTS, et ne
// laisse le hasard décider que du CONTENU. Un tirage purement aléatoire
// visiterait « une seule lettre, quatre cents caractères, sans déformation »
// une fois sur six cents ; celui-ci le visite à coup sûr, et il se rejoue à
// l'identique.
const ALPHABETS = [
  // Le mot nu — la forme la plus banale d'un chemin, et celle que l'ancien
  // tirage ne savait pas allonger.
  "abcdefghijklmnopqrstuvwxyz",
  // L'ancien alphabet, gardé tel quel : un tirage qui rétrécit n'est pas un
  // tirage élargi.
  "abcdefghijklmnopqrstuvwxyz0123456789-_.",
  // La casse mêlée : un répartiteur qui replie la casse se trahit ici.
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  "0123456789",
  // Les signes qu'une URL porte SANS encodage — ceux qui font trébucher les
  // découpes écrites à la main.
  "-_.~!$&'()*+,;=:@"
];

// De « une lettre » à « quatre cents » : le plafond de 33 caractères était le
// vrai trou, et il ne se rebouche pas avec dix de plus.
const CLASSES_DE_LONGUEUR = [
  [1, 3],
  [4, 12],
  [13, 40],
  [41, 120],
  [121, 400]
];

// Les FORMES : ce qu'on fait du chemin une fois tiré. Une porte dérobée se
// cache aussi bien derrière une extension ou une vraie route enrobée que
// derrière une longueur.
const FORMES = 8;

function deformer(chemin, forme, route) {
  if (forme === 1) return `${chemin}/`;
  if (forme === 2) return `${chemin}.json`;
  if (forme === 3) return chemin.toUpperCase();
  if (forme === 4) return chemin.replace("/", "//");
  if (forme === 5) return `${chemin}%2e%2e`;
  // Une VRAIE route enrobée : en suffixe (un `startsWith` trop généreux) et en
  // préfixe (un `endsWith`, ou une réécriture qui pèle un préfixe).
  if (forme === 6) return `${chemin}${route}`;
  if (forme === 7) return `${route}${chemin}`;
  return chemin;
}

function cheminsTires(combien, graine = 20_260_822) {
  const dé = tirage(graine);
  const entier = (max) => Math.floor(dé() * max);
  const routes = ROUTES.map((ligne) => ligne.chemin);
  const chemins = [];
  for (let i = 0; i < combien; i += 1) {
    // LES STRATES SE PARCOURENT, ELLES NE SE TIRENT PAS : chaque combinaison
    // est visitée, dans un ordre fixe, quel que soit le hasard du contenu.
    const alphabet = ALPHABETS[i % ALPHABETS.length];
    const [bas, haut] = CLASSES_DE_LONGUEUR[Math.floor(i / ALPHABETS.length) % CLASSES_DE_LONGUEUR.length];
    const forme = Math.floor(i / (ALPHABETS.length * CLASSES_DE_LONGUEUR.length)) % FORMES;
    const segments =
      1 + (Math.floor(i / (ALPHABETS.length * CLASSES_DE_LONGUEUR.length * FORMES)) % 6);
    const morceaux = [];
    for (let s = 0; s < segments; s += 1) {
      const longueur = bas + entier(haut - bas + 1);
      let mot = "";
      for (let c = 0; c < longueur; c += 1) mot += alphabet[entier(alphabet.length)];
      morceaux.push(mot);
    }
    chemins.push(deformer(`/${morceaux.join("/")}`, forme, routes[entier(routes.length)]));
  }
  return chemins;
}

// Le nombre de chemins qui visite CHAQUE strate exactement une fois. On le
// calcule, on ne l'écrit pas : ajouter un alphabet ou une forme demain élargit
// le tirage tout seul.
const STRATES = ALPHABETS.length * CLASSES_DE_LONGUEUR.length * FORMES * 6;

// L'INSTRUMENT DOIT POUVOIR VOIR SA CIBLE. Un tirage qui rétrécirait sans que
// rien ne rougisse serait pire que pas de tirage du tout : on exige donc de
// lui, noir sur blanc, les propriétés qui ont manqué le 22/08.
function verifierLePouvoirDuTirage(echantillon) {
  const plusLong = echantillon.reduce((max, chemin) => Math.max(max, chemin.length), 0);
  assert.ok(plusLong >= 300, `SONDE IMPOSSIBLE : le plus long chemin tiré fait ${plusLong} caractères`);
  assert.ok(
    echantillon.some((chemin) => /^\/[a-z]{40,}$/.test(chemin)),
    "SONDE IMPOSSIBLE : aucun chemin d'un seul mot de quarante lettres minuscules — c'est EXACTEMENT le motif qui est passé le 22/08"
  );
  assert.ok(
    echantillon.some((chemin) => /[A-Z]/.test(chemin)),
    "SONDE IMPOSSIBLE : le tirage n'a produit aucune majuscule"
  );
  assert.ok(
    echantillon.some((chemin) => (chemin.match(/\//g) || []).length >= 6),
    "SONDE IMPOSSIBLE : le tirage n'a produit aucun chemin profond"
  );
}

// Les voisins structurels des vraies routes : c'est là que dorment les
// répartiteurs trop généreux (une comparaison insensible à la casse, un
// `startsWith` au lieu d'un `===`, une barre finale tolérée).
function voisinsDesRoutes() {
  const voisins = new Set();
  for (const { chemin } of ROUTES) {
    voisins.add(`${chemin}/`);
    voisins.add(`${chemin}//`);
    voisins.add(`//${chemin}`);
    voisins.add(`${chemin}/..`);
    voisins.add(`${chemin}/sonde`);
    voisins.add(`${chemin}.json`);
    voisins.add(`${chemin}%20`);
    voisins.add(chemin.toUpperCase());
    voisins.add(`/sonde${chemin}`);
  }
  voisins.delete("/");
  return [...voisins].filter((chemin) => !ROUTES.some((ligne) => ligne.chemin === chemin));
}

test("ⓐ AUCUN LITTÉRAL DE LA SOURCE N'EST UN CHEMIN SERVI HORS TABLE — la porte dérobée se nomme dans son propre code", async (t) => {
  const fichiers = fichiersDeLaPorte();
  // L'INSTRUMENT DOIT POUVOIR VOIR SA CIBLE. Un graphe qui se réduirait aux
  // trois graines ramènerait ce test à l'état où la porte dérobée du 22/08
  // passait — et il le ferait EN SILENCE.
  for (const ancre of ANCRES_DU_GRAPHE) {
    assert.ok(fichiers.includes(ancre), `SONDE IMPOSSIBLE : ${ancre} est hors du vivier (vus : ${fichiers.join(", ")})`);
  }

  const litteraux = new Set();
  for (const relatif of fichiers) {
    for (const valeur of litterauxDe(fs.readFileSync(path.join(racine, relatif), "utf8"))) litteraux.add(valeur);
  }

  // TROIS ISSUES, JAMAIS DEUX. L'instrument doit POUVOIR voir sa cible : s'il
  // ne retrouve même pas les chemins des vraies routes dans la source, c'est
  // qu'il ne lit rien — et son silence ne prouverait rien du tout.
  //
  // ⚠️ UNE FAMILLE DE ROUTES N'EST PAS ÉCRITE EN LITTÉRAL, ET C'EST VOULU : les
  // polices sont ÉNUMÉRÉES depuis le dossier au chargement (une entrée par
  // fichier, jamais un préfixe — voir serveur.js). Leur chemin n'existe donc
  // nulle part dans la source, et l'auto-contrôle a rougi à leur arrivée. Il
  // aurait été facile de le relâcher ; on l'a plutôt DÉDOUBLÉ, parce que la
  // question « l'instrument voit-il sa cible ? » reste la même :
  //   • une route écrite à la main doit se retrouver en littéral ;
  //   • une route énumérée doit se retrouver SUR LE DISQUE, et son préfixe
  //     doit, lui, être un littéral de la source — sinon la famille entière
  //     serait née d'un nom que le test n'a jamais vu.
  const PREFIXE_POLICES = "/polices/";
  const policesSurDisque = new Set(
    fs.readdirSync(path.join(racine, "src", "web", "public", "polices"))
      .filter((n) => n.endsWith(".woff2"))
      .map((n) => `${PREFIXE_POLICES}${n}`)
  );
  const routesEnumerees = ROUTES.filter(({ chemin }) => chemin.startsWith(PREFIXE_POLICES));
  if (routesEnumerees.length > 0) {
    // On interroge la source BRUTE, pas la liste des littéraux : l'extracteur
    // refuse (à raison) les gabarits interpolés — `` `/polices/${nom}` `` n'est
    // pas un chemin, c'est une recette. La question posée ici est plus simple
    // et c'est la bonne : « ce préfixe est-il écrit quelque part dans le code
    // que ce test lit ? » Si non, la famille vient d'ailleurs et le test ne
    // saurait pas d'où.
    assert.ok(
      fichiers.some((f) => fs.readFileSync(path.join(racine, f), "utf8").includes(PREFIXE_POLICES)),
      `SONDE IMPOSSIBLE : « ${PREFIXE_POLICES} » n'apparaît dans aucune source lue — la famille énumérée vient d'un nom que ce test n'a jamais vu`
    );
  }
  for (const { chemin } of ROUTES) {
    if (chemin.startsWith(PREFIXE_POLICES)) {
      assert.ok(
        policesSurDisque.has(chemin),
        `SONDE IMPOSSIBLE : « ${chemin} » est servi mais n'existe pas sur le disque`
      );
      // La route énumérée rejoint le vivier : ses VOISINS seront sondés comme
      // ceux de n'importe quelle autre route.
      litteraux.add(chemin);
      continue;
    }
    assert.ok(
      litteraux.has(chemin),
      `SONDE IMPOSSIBLE : l'extraction ne retrouve pas « ${chemin} » dans la source (${litteraux.size} littéraux vus)`
    );
  }

  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  const candidats = cheminsCandidats(litteraux);
  assert.ok(candidats.length >= 30, `SONDE IMPOSSIBLE : ${candidats.length} candidats seulement`);

  for (const chemin of candidats) {
    for (const methode of ["GET", "POST"]) {
      const attendu = verdictAttendu(chemin, methode);
      const reponse = await sonder(base, chemin, { methode, cookie, corps: methode === "POST" ? {} : null });
      assert.ok(
        conforme(reponse, attendu),
        `${methode} ${chemin} → ${reponse.statut} (attendu ${attendu}) — un chemin servi hors de la table est une porte dérobée`
      );
    }
  }
});

test("ⓑ UN CHEMIN QUELCONQUE N'EST JAMAIS SERVI — tirage à graine fixe et voisins des vraies routes", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie } = await cookieDePremiereVisite(base);

  // Une strate visitée une fois chacune, plus les voisins des vraies routes.
  // On ÔTE ce qui serait, par accident, une vraie route : l'assertion ci-dessous
  // est « 404, sans exception », et une route servie la ferait rougir à tort.
  const echantillon = [...cheminsTires(STRATES), ...voisinsDesRoutes()].filter(
    (chemin) => !ROUTES.some((ligne) => ligne.chemin === chemin)
  );
  verifierLePouvoirDuTirage(echantillon);
  for (const chemin of echantillon) {
    const reponse = await sonder(base, encodeURI(chemin), { methode: "GET", cookie });
    assert.equal(
      reponse.statut,
      404,
      `GET ${chemin} → ${reponse.statut} : hors table, donc 404, sans exception`
    );
  }

  // CONTRÔLE POSITIF, et il n'est pas décoratif : sans lui, une porte qui
  // répondrait 404 à TOUT passerait ce test en triomphe.
  for (const { chemin, methode } of ROUTES) {
    const reponse = await sonder(base, chemin, { methode, cookie, corps: methode === "POST" ? {} : null });
    assert.ok(
      conforme(reponse, "servie"),
      `${methode} ${chemin} → ${reponse.statut} : la table doit être SERVIE, sinon la garde est un mur`
    );
  }
});

test("ⓒ LE RÉPARTITEUR NU ne rend jamais une route hors de sa table — des dizaines de milliers de chemins", () => {
  assert.equal(typeof repartir, "function", "le répartiteur doit être une fonction PURE et exportée, pas un bloc noyé dans le gestionnaire");

  const dansLaTable = new Set(ROUTES.map((ligne) => `${ligne.methode} ${ligne.chemin}`));
  const methodes = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "TRACE", "", undefined];
  let servies = 0;

  const tires = cheminsTires(STRATES * 4, 42);
  verifierLePouvoirDuTirage(tires);
  for (const chemin of [...tires, ...voisinsDesRoutes(), ...ROUTES.map((l) => l.chemin)]) {
    for (const methode of methodes) {
      const issue = repartir(chemin, methode);
      const attendu = verdictAttendu(chemin, methode);
      if (issue.route) {
        servies += 1;
        assert.ok(
          ROUTES.includes(issue.route),
          `le répartiteur a rendu une route étrangère à la table pour ${methode} ${chemin}`
        );
        assert.equal(issue.route.chemin, chemin);
        assert.equal(issue.route.methode, methode);
        assert.equal(attendu, "servie");
      } else {
        assert.notEqual(attendu, "servie", `${methode} ${chemin} devait être servie et ne l'est pas`);
        assert.equal(issue.refus, attendu, `${methode} ${chemin} → refus ${issue.refus}, attendu ${attendu}`);
      }
    }
  }

  // L'instrument a-t-il seulement vu une route servie ? Un répartiteur qui
  // refuse tout satisferait toutes les assertions ci-dessus.
  assert.equal(servies, ROUTES.length, "SONDE IMPOSSIBLE : le tirage n'a pas vu la table entière être servie");
});

// ════════════════════════════════════════════════════════════════════════════
// ⓓ LA MARQUE DU RÉPARTITEUR — L'ORACLE DE RUNTIME
//
// Les trois voies ci-dessus LISENT la source. Celles qui suivent FONT TOURNER
// la porte et regardent ce qui en sort. C'est la différence entre « je n'ai pas
// trouvé de porte dérobée » et « une porte dérobée n'écrirait rien ».
// ════════════════════════════════════════════════════════════════════════════

// La forme d'une fonction, débarrassée de sa mise en page. On compare des
// TOKENS collés : reformater ne fait pas rougir, ajouter une instruction si.
const nu = (texte) => String(texte).replace(/\s+/g, "");

// Une réponse jouet : elle retient ce qu'on lui écrit, et rien de plus. Elle
// n'a JAMAIS reçu d'autorisation — c'est tout l'intérêt.
function fausseReponse() {
  const etat = { statut: null, corps: "", entetes: {}, envoyes: false };
  return {
    etat,
    get headersSent() {
      return etat.envoyes;
    },
    setHeader(nom, valeur) {
      etat.entetes[String(nom).toLowerCase()] = valeur;
    },
    writeHead(statut, entetes = {}) {
      etat.statut = statut;
      etat.envoyes = true;
      for (const [nom, valeur] of Object.entries(entetes || {})) etat.entetes[String(nom).toLowerCase()] = valeur;
      return this;
    },
    write(bloc) {
      etat.corps += String(bloc);
      return true;
    },
    end(bloc) {
      if (bloc !== undefined) etat.corps += String(bloc);
    },
    on() {
      return this;
    },
    destroy() {}
  };
}

// LA LISTE FERMÉE DES MARQUES, recopiée du CONTRAT — la seule chose qu'on
// recopie, parce que c'est la LOI et pas le code. Une marque de plus est une
// façon de plus, pour la porte, de décider de répondre : ça ne s'ajoute pas
// sans que quelqu'un l'écrive ici.
const CONTRAT_DES_MARQUES = [
  // la serrure a dit non
  "serrure",
  // le jeton portant est arrivé par l'URL : on pose le cookie et on redirige
  "marque-page",
  // la table sert
  "route",
  // la table ne connaît pas ce chemin
  "route-inconnue",
  // la table connaît ce chemin, mais pas dans cette méthode
  "methode-refusee",
  // le chemin jugé n'est pas le chemin écrit (garde ①-bis)
  "cible-reecrite",
  // ça a cassé, et ça se dit
  "panne"
];

test("ⓓ LA LISTE DES MARQUES EST FERMÉE — une décision de plus se déclare", () => {
  assert.ok(Array.isArray(MARQUES) && MARQUES.length > 0, "la porte doit EXPOSER ses marques");
  assert.equal(new Set(MARQUES).size, MARQUES.length, "aucune marque en double");
  // Les deux sens : une marque de trop est une décision qu'on n'a pas vue
  // naître, une marque qui manque est un produit qui ment sur ses issues.
  assert.deepEqual([...MARQUES].sort(), [...CONTRAT_DES_MARQUES].sort());
});

test("ⓓ LE GESTIONNAIRE EST UNE DÉLÉGATION NUE — sa FORME est assertée, pas sa bonne volonté", async (t) => {
  const db = bureauJetable(t);
  const { serveur } = await porteDeTest(t, { db });

  const auditeurs = serveur.listeners("request");
  // Deux auditeurs, exactement : le témoin de la cible, puis la délégation. Un
  // troisième serait un endroit de plus où répondre, et personne ne l'aurait vu.
  assert.equal(
    auditeurs.length,
    2,
    `${auditeurs.length} auditeurs de requête — la porte en a DEUX : le témoin de la cible, et la délégation nue`
  );

  // ⚠️ CE QUE CETTE ASSERTION MESURE, ET POURQUOI CE N'EST PAS « LIRE LA
  // SOURCE ». Elle interroge la fonction RÉELLEMENT INSTALLÉE sur le serveur
  // qui tourne — pas un fichier du disque qu'un chargement pourrait ne jamais
  // lire. C'est la seule chose vraiment structurelle qu'on puisse dire côté
  // source : le gestionnaire ne DÉCIDE rien, il délègue, et son texte le
  // prouve. La porte dérobée du 22/08 était une ligne insérée ICI ; elle change
  // ce texte, et ce test la voit sans avoir eu à deviner quel chemin elle sert.
  assert.equal(
    nu(auditeurs[1].toString()),
    nu("(req, res) => servirLaRequete(contexte, req, res)"),
    "le gestionnaire passé à http.createServer doit être une DÉLÉGATION NUE — une décision écrite ici est une porte dérobée qu'aucun tirage ne devine"
  );

  // Et la fonction qu'il délègue : trois expressions, aucune décision. Décider,
  // servir, ou tomber.
  assert.equal(
    nu(servirLaRequete.toString()),
    nu(
      "function servirLaRequete(contexte, req, res) {" +
        "  return Promise.resolve()" +
        "    .then(() => servirLeVerdict(contexte, req, res, verdictDeLaRequete(contexte, req)))" +
        "    .catch((erreur) => servirLaPanne(res, erreur));" +
        "}"
    ),
    "servirLaRequete ne décide rien : elle demande un verdict, elle le sert, elle rattrape la panne. Une instruction de plus ici est une décision de plus, et une décision de plus doit se voir."
  );
});

test("ⓓ AUCUNE ÉCRITURE SANS VERDICT — la fonction qui écrit refuse, et rien ne part", () => {
  // ① LE CAS EXACT DE LA MUTATION. `repondreJson(res, 200, { trou: true })`
  //    posé en amont du répartiteur : la réponse n'a jamais été autorisée.
  const res = fausseReponse();
  assert.throws(
    () => repondreJson(res, 200, { trou: true }),
    /WRITE WITHOUT A VERDICT/,
    "une réponse sans verdict doit être REFUSÉE — sinon la marque est décorative"
  );
  // Et le refus n'est pas cosmétique : PAS UN OCTET n'est parti.
  assert.equal(res.etat.statut, null, "rien n'a été écrit");
  assert.equal(res.etat.corps, "", "pas un octet de corps");

  // ② ET ON NE FABRIQUE PAS UN VERDICT. Un objet qui RESSEMBLE au verdict du
  //    répartiteur n'en est pas un : l'identité est tenue dans un registre que
  //    seule la frappe alimente.
  const faux = { marque: "route", route: ROUTES[0] };
  assert.equal(estUnVerdict(faux), false, "un objet fabriqué n'est pas un verdict");
  const autre = fausseReponse();
  assert.throws(
    () => servirLeVerdict({}, {}, autre, faux),
    /UNMINTED VERDICT/,
    "servir un verdict fabriqué doit être refusé"
  );
  assert.equal(autre.etat.statut, null, "et là non plus, rien n'est parti");

  // ③ CONTRÔLE POSITIF — sans lui, une porte qui refuserait TOUT passerait ce
  //    test en triomphe. Le vrai verdict du répartiteur, lui, EN EST un.
  assert.equal(estUnVerdict(repartir("/api/fil", "GET")), true, "le verdict du répartiteur en est un");
  assert.equal(estUnVerdict(repartir("/rien-du-tout", "GET")), true, "son refus aussi");
});

test("ⓓ TOUTE RÉPONSE PORTE LA MARQUE DE SON VERDICT — la table entière, les refus, la serrure", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });
  const { cookie, visite } = await cookieDePremiereVisite(base);

  // ① LA SERRURE. Sans cookie, la porte refuse — et son refus est marqué comme
  //    tout le reste : une réponse non marquée n'existe pas, pas même celle-là.
  const sansJeton = await requete(base, "/api/fil");
  assert.equal(sansJeton.statut, 401);
  assert.equal(sansJeton.entetes[EN_TETE_DE_LA_MARQUE], "serrure");

  // ② LE MARQUE-PAGE. La première visite `?t=` redirige et pose le cookie.
  assert.equal(visite.statut, 302);
  assert.equal(visite.entetes[EN_TETE_DE_LA_MARQUE], "marque-page");

  // ③ LA TABLE ENTIÈRE, une route après l'autre — servies, donc marquées
  //    « route ». `/api/evenements` passe par la sonde brute : c'est un flux, il
  //    ne finit jamais, et l'attendre ferait PENDRE le test.
  for (const { chemin, methode } of ROUTES) {
    const reponse =
      chemin === "/api/evenements"
        ? await sonder(base, chemin, { methode, cookie })
        : await requete(base, chemin, { methode, cookie, corps: methode === "POST" ? {} : null });
    const marque = reponse.marque ?? reponse.entetes[EN_TETE_DE_LA_MARQUE];
    assert.equal(marque, "route", `${methode} ${chemin} → marque ${JSON.stringify(marque)}, attendu « route »`);
  }

  // ④ LES REFUS DE LA TABLE. Chacun porte SA marque : un 404 et un 405 ne
  //    sortent pas du même verdict, et confondre les deux masquerait le jour où
  //    l'un se mettrait à répondre à la place de l'autre.
  const inconnu = await requete(base, "/api/console", { cookie });
  assert.equal(inconnu.statut, 404);
  assert.equal(inconnu.entetes[EN_TETE_DE_LA_MARQUE], "route-inconnue");

  const mauvaiseMethode = await requete(base, "/api/fil", { methode: "POST", cookie, corps: {} });
  assert.equal(mauvaiseMethode.statut, 405);
  assert.equal(mauvaiseMethode.entetes[EN_TETE_DE_LA_MARQUE], "methode-refusee");

  // ⑤ ET L'ORACLE, DÉRIVÉ : sur un échantillon de chemins quelconques, la
  //    marque rendue est EXACTEMENT celle que le répartiteur aurait frappée. Ce
  //    n'est plus « la réponse porte une marque » mais « la réponse porte LA
  //    marque de la décision qui aurait dû la produire » — une porte dérobée
  //    qui répondrait sur un de ces chemins n'aurait ni l'une ni l'autre.
  const echantillon = [...cheminsTires(40, 7), ...voisinsDesRoutes()].filter(
    (chemin) => !ROUTES.some((ligne) => ligne.chemin === chemin)
  );
  assert.ok(echantillon.length >= 30, `SONDE IMPOSSIBLE : ${echantillon.length} chemins seulement`);
  for (const chemin of echantillon) {
    const reponse = await sonder(base, encodeURI(chemin), { methode: "GET", cookie });
    assert.equal(reponse.marque, repartir(chemin, "GET").marque, `GET ${chemin} : marque inattendue`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ⓔ LA PORTE N'A AUCUN AUDITEUR DE SERVEUR QUI ÉCRIVE, HORS `request`
//
// CE QUE ⓓ NE VOYAIT PAS, ET C'EST UNE CLASSE ENTIÈRE. Toute la garde ①
// (`la table EST le routage`, la marque du répartiteur, la forme du
// gestionnaire) est ancrée sur UN SEUL événement : `request`. Or un
// `http.Server` en émet une douzaine, et cinq d'entre eux remettent au
// gestionnaire de quoi ÉCRIRE — une réponse ou, pire, la socket nue :
//
//     serveur.on("upgrade",     (req, socket) => socket.end("…"));
//     serveur.on("clientError", (err, socket) => socket.end("HTTP/1.1 400 …"));
//
// Ces deux lignes-là répondent au client SANS JAMAIS PASSER PAR LE
// RÉPARTITEUR : pas de verdict, donc pas de marque — et la marque ne les voit
// pas non plus, puisqu'elle ne s'installe que sur le chemin qu'elles évitent.
// La table ne les concerne pas ; `exigerLaMarque` non plus ; le tirage sur le
// chemin QUELCONQUE encore moins, puisqu'ils ne sont pas des chemins.
//
// ET C'EST DE LA CLASSE NON INTENTIONNELLE, celle qui arrive vraiment :
// ajouter un gestionnaire `clientError` pour taire un bruit de log est un
// réflexe absolument ordinaire, et personne ne le lirait comme « j'ouvre une
// deuxième porte ».
//
// ── L'ORACLE EST DIFFÉRENTIEL, ET C'EST CE QUI LE REND FERMÉ ────────────────
//
// La façon facile — écrire à la main la liste des auditeurs attendus — est
// FAUSSE, et la mesure le dit : un `http.createServer()` À NU porte DÉJÀ deux
// auditeurs, et ils sont à node, pas à nous (mesuré le 22/08, node v26.7.0) :
//
//     A/ createServer() nu       : ["connection","listening"]
//        connection[0] = function connectionListener(socket) {…}   (_http_server.js)
//        listening[0]  = function setupConnectionsTracking() {…}   (net.js)
//     D/ la porte                : ["connection","listening","request"]
//
// Une liste écrite à la main devrait donc recopier les internes de node, et
// mentirait à la première version qui en change. On compare donc la porte à un
// TÉMOIN NU du même node : ce que la porte AJOUTE au témoin est la seule chose
// qui la regarde, et cette liste-là est fermée à une entrée.
//
// La comparaison porte sur l'IDENTITÉ des fonctions, jamais sur leur nombre :
// `removeAllListeners("connection")` suivi d'un auditeur à soi laisserait le
// COMPTE à 1 tout en ayant remplacé la mécanique de node. Le témoin et la
// porte partagent les mêmes objets-fonction (`memesRefs=true`, mesuré), donc
// l'égalité par référence est exigible.
//
// La liste des événements d'un `http.Server` ci-dessous a été recopiée de la
// doc node (nodejs.org/api/http.html, « Class: http.Server », et
// nodejs.org/api/net.html, « Class: net.Server » dont il hérite) le
// 22/08/2026. ⚠️ SON EXHAUSTIVITÉ N'EST MESURÉE PAR RIEN, et elle n'a pas
// besoin de l'être : c'est un SECOND filet, là pour se lire. Le premier filet
// (le différentiel) est déjà exhaustif par construction, puisque `eventNames()`
// rend TOUT événement qui porte un auditeur — y compris un que cette liste ne
// nommerait pas, et y compris un que node ajouterait demain. Si un jour ces
// deux lignes se contredisent, c'est le différentiel qui a raison.
//
// ⚠️ CE QUE ⓔ NE VOIT PAS, ET LE « SAUF » SE LIT ICI. Il mesure LA PORTE QUE CE
// TEST CONSTRUIT. Or `ouvrirLaPorte` rend `{ serveur, … }` au LANCEUR
// (`src/bin/valxos-web.js`) : une ligne posée là-bas ouvrirait la même deuxième
// porte, et ⓔ resterait vert — aucun test ne fait tourner le lanceur. Deux
// mesures, rejouées le 22/08 sur cette branche :
//   F  `porte.serveur.on("clientError", (err, socket) => socket.end("…"))`
//      dans le lanceur                            → ⓔ VERT, ⓔ-bis ROUGE.
//   F2 `const guichet = porte.serveur;` puis
//      `guichet.on("connection", …)` dans le lanceur → ⓔ VERT, ⓔ-bis VERT.
// F2 échappe aux deux bouts de ⓔ-bis : le nom d'événement n'est pas dans
// `EVENEMENTS_PROPRES_AU_SERVEUR` (⒜) et le récepteur ne s'appelle ni
// `serveur` ni `server` (⒝). CETTE FERMETURE EST DONC À MOITIÉ STRUCTURELLE ET
// À MOITIÉ UN FILET À MAILLES CONNUES — c'est la plus faible des cinq annoncées
// en tête de `web-garde-spawn.test.js`, et elle y est maintenant écrite comme
// telle. La moitié qui manque est ⓔ-bis, plus bas, et elle LIT la source.
// ════════════════════════════════════════════════════════════════════════════

// Ce que la porte a le droit d'ajouter au témoin nu. UNE entrée, et c'est tout
// le contrat : le témoin de la cible, puis la délégation nue (voir ⓓ). Un
// auditeur posé demain — sur `request` ou sur n'importe quel autre événement —
// rougit ICI le jour où il naît, sans que personne ait eu à deviner lequel.
const AUDITEURS_AJOUTES_PAR_LA_PORTE = new Map([["request", 2]]);

// Les événements d'un `http.Server`, recopiés de la doc node. La colonne qui
// compte est la dernière : ce que l'auditeur reçoit et sur quoi il peut écrire.
const EVENEMENTS_DU_SERVEUR = [
  // ── ceux qui remettent de quoi RÉPONDRE — la classe que ⓔ ferme ──────────
  { nom: "request", ecrit: "la réponse (res)" },
  { nom: "checkContinue", ecrit: "la réponse (res)" },
  { nom: "checkExpectation", ecrit: "la réponse (res)" },
  { nom: "connect", ecrit: "la socket NUE" },
  { nom: "upgrade", ecrit: "la socket NUE" },
  { nom: "clientError", ecrit: "la socket NUE" },
  { nom: "dropRequest", ecrit: "la socket NUE" },
  { nom: "connection", ecrit: "la socket NUE" },
  // ── ceux qui ne remettent rien d'inscriptible, listés quand même : un
  //    auditeur y est un endroit de plus où du code tourne ────────────────────
  { nom: "close", ecrit: "rien" },
  { nom: "error", ecrit: "rien" },
  { nom: "listening", ecrit: "rien" },
  { nom: "drop", ecrit: "rien" }
];

// « Qu'est-ce que CE serveur porte, au-delà de ce que node pose tout seul ? »
// Rend une Map { evenement → nombre d'auditeurs AJOUTÉS }, et lève si l'un des
// auditeurs de node a été remplacé au lieu d'être complété.
function auditeursAjoutes(serveur, temoin) {
  const ajoutes = new Map();
  const noms = new Set([...temoin.eventNames(), ...serveur.eventNames()].map(String));
  for (const nom of noms) {
    const socles = temoin.listeners(nom);
    const poses = serveur.listeners(nom);
    // Les auditeurs de node viennent EN TÊTE et n'ont pas bougé : mêmes
    // objets-fonction, même ordre. Sinon ce n'est pas un ajout, c'est une
    // substitution — et une substitution se dit avec ses mots.
    assert.ok(
      poses.length >= socles.length,
      `« ${nom} » : la porte a RETIRÉ un auditeur de node (${poses.length} < ${socles.length}) — la mécanique du serveur ne se démonte pas en silence`
    );
    for (let i = 0; i < socles.length; i += 1) {
      assert.equal(
        poses[i],
        socles[i],
        `« ${nom} » : l'auditeur n°${i} de node a été REMPLACÉ — le compte serait resté juste, la mécanique non`
      );
    }
    const surplus = poses.length - socles.length;
    if (surplus > 0) ajoutes.set(nom, surplus);
  }
  return ajoutes;
}

test("ⓔ AUCUN AUDITEUR DE SERVEUR NE RÉPOND HORS `request` — la liste des auditeurs POSÉS est fermée", async (t) => {
  const db = bureauJetable(t);
  const { serveur, base } = await porteDeTest(t, { db });

  // LE TÉMOIN : le même `http.Server` que le nôtre, sans une ligne de nous. Il
  // n'écoute jamais — il ne sert qu'à savoir ce que node pose de lui-même.
  const temoin = http.createServer();

  // TROIS ISSUES, JAMAIS DEUX. Un témoin qui ne porterait AUCUN auditeur
  // voudrait dire que l'instrument ne voit pas ce qu'il croit voir : le
  // différentiel deviendrait un absolu, et ce test se remettrait à mesurer les
  // internes de node au lieu de notre code.
  assert.ok(
    temoin.eventNames().length > 0,
    `SONDE IMPOSSIBLE : un http.Server nu ne porte aucun auditeur — le différentiel ne mesure plus rien`
  );

  // ① LA LISTE FERMÉE, AVANT TOUT TRAFIC.
  assert.deepEqual(
    [...auditeursAjoutes(serveur, temoin).entries()].sort(),
    [...AUDITEURS_AJOUTES_PAR_LA_PORTE.entries()].sort(),
    "la porte n'ajoute au serveur QUE ses deux auditeurs de `request` — un auditeur sur `upgrade`, `clientError`, `connect`, `checkContinue`… écrirait sur le client SANS passer par le répartiteur, donc sans verdict et sans marque"
  );

  // ② LE SECOND FILET, NOMMÉ ÉVÉNEMENT PAR ÉVÉNEMENT. Redondant avec ①, et
  //    délibérément : il se lit, lui. Le lecteur voit ce qui est interdit sans
  //    avoir à dérouler un différentiel dans sa tête.
  for (const { nom, ecrit } of EVENEMENTS_DU_SERVEUR) {
    if (nom === "request") continue;
    assert.equal(
      serveur.listenerCount(nom) - temoin.listenerCount(nom),
      0,
      `la porte a posé un auditeur sur « ${nom} » (il reçoit ${ecrit}) — il répondrait hors du répartiteur, et ni la table ni la marque ne le verraient`
    );
  }

  // ③ ET APRÈS DU VRAI TRAFIC. Un auditeur installé PARESSEUSEMENT — à la
  //    première connexion, à la première requête — passerait les deux
  //    contrôles ci-dessus en triomphe. On refait donc la mesure une fois la
  //    porte réellement traversée.
  const { cookie, visite } = await cookieDePremiereVisite(base);
  assert.equal(visite.statut, 302, "SONDE IMPOSSIBLE : la première visite n'a pas eu lieu");
  const servie = await requete(base, "/api/fil", { cookie });
  assert.equal(servie.statut, 200, "SONDE IMPOSSIBLE : la porte n'a pas été traversée, on ne mesure rien");

  assert.deepEqual(
    [...auditeursAjoutes(serveur, temoin).entries()].sort(),
    [...AUDITEURS_AJOUTES_PAR_LA_PORTE.entries()].sort(),
    "un auditeur est apparu APRÈS le premier trafic — un auditeur paresseux est un auditeur quand même"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ⓕ LA CHAÎNE ENTIÈRE — LES CINQ MAILLONS, ET ON LES A COMPTÉS
//
// ⓓ assertait la FORME de deux fonctions. La question que personne n'avait
// posée : deux sur COMBIEN ? On l'a comptée, et la réponse est CINQ. Le critère
// n'est pas « les fonctions importantes » — c'est vérifiable et fermé :
//
//     EST UN MAILLON toute fonction qui TIENT `res` sur le chemin qui va de
//     l'événement `request` jusqu'à la décision de servir.
//
// ⚠️ CE CRITÈRE DISAIT « QUI TIENT `res` (OU LA SOCKET) », ET LES TROIS MOTS
// ENTRE PARENTHÈSES RENDAIENT LE COMPTE DE CINQ FAUX. Tenir la socket, ce n'est
// pas une propriété rare : node l'accroche à `req`, donc TOUTE fonction qui
// reçoit `req` la tient — `verdictDeLaRequete`, `verdictDeLaPorte`,
// `cheminDemande`, `servirLaMemeCible`… Pris à la lettre, le vivier n'était pas
// de cinq mais de tout ce qui voit une requête. Le critère est donc ramené à ce
// qu'il mesure vraiment (`res`), et LA SOCKET DEVIENT UNE CLASSE À PART, tenue
// par ⓖ et par rien d'autre. Les cinq maillons ci-dessous sont exacts POUR
// `res` ; ils ne disent rien du fil.
//
// Le vivier, obtenu en suivant qui reçoit `res` dans `src/web/serveur.js` :
//
//   ① `noterLaLigne`        auditeur n°0 de `request`. Node l'appelle avec
//                           (req, res) — sa SIGNATURE ne prend que `req`, mais
//                           une signature se réécrit. Son IDENTITÉ était déjà
//                           assertée (web-chemin-ecrit.test.js) ; son CORPS ne
//                           l'était pas, et une identité ne dit rien du corps.
//   ② la délégation nue     auditeur n°1 de `request`.        ✔ ⓓ, déjà fermé
//   ③ `servirLaRequete`                                        ✔ ⓓ, déjà fermé
//   ④ `servirLeVerdict`     LE MAILLON NOMMÉ, ET LE SEUL SANS ASSERTION.
//   ⑤ `servirLaPanne`       LE MAILLON QUE PERSONNE N'AVAIT NOMMÉ.
//
// NE SONT PAS DES MAILLONS, et il faut dire pourquoi pour que la liste soit
// fermée et pas seulement longue :
//   · `verdictDeLaRequete` et `repartir` ne reçoivent JAMAIS `res`.
//     ⚠️ ON EN CONCLUAIT « UNE FONCTION QUI NE TIENT PAS LA RÉPONSE NE PEUT PAS
//     RÉPONDRE ». C'EST FAUX, ET C'EST MESURÉ (voir ⓖ, en bas de ce fichier) :
//     `verdictDeLaRequete` tient `req`, donc le transport, et une ligne qui
//     écrit une réponse HTTP brute dessus rend 200 sans marque avec 607 pass /
//     0 fail. Elles ne sont pas des maillons de `res` — c'est tout ce que cette
//     ligne dit, et c'est tout ce qu'elle a le droit de dire ;
//   · `servirLeFil`, `servirLeFichier`, `servirPoster`… sont les DESTINATIONS,
//     pas des maillons : on n'y arrive qu'avec un verdict déjà frappé, et
//     chacune passe par `exigerLaMarque` (en première instruction, ou via
//     `repondreJson` — `servirLesEvenements` a une branche de refus avant).
//     Une ligne ajoutée là répond sur une route qui existe déjà — ce n'est pas
//     une porte dérobée, c'est un défaut de cette route ;
//   · `autoriserLaReponse`, `repondreJson`, `refuserLEntree` sont derrière la
//     marque, par construction.
//
// ── CE QUE ④ COÛTAIT, MESURÉ ────────────────────────────────────────────────
//
//     export function servirLeVerdict(contexte, req, res, rendu) {
//       if (req?.headers?.["x-clef"] === "…") { res.end("ouvert\n"); return undefined; }
//       autoriserLaReponse(res, rendu);
//       …
//
//   `res.end()` est la méthode NUE de node : elle ne passe ni par
//   `repondreJson` ni par `refuserLEntree`, donc jamais par `exigerLaMarque`.
//   La réponse part, et la suite reste verte — c'est la mutation B du 22/08.
//   Voilà pourquoi la phrase « elle ferme l'introduction non intentionnelle »
//   était sur-vendue : elle la fermait à deux maillons sur cinq.
//
// ── POURQUOI LA FORME, ET PAS MIEUX ─────────────────────────────────────────
//
// On aimerait un verrou matériel (comme la marque) plutôt qu'une comparaison
// de texte. Il n'y en a pas : `res` est un objet de node, et rien n'empêche
// d'appeler `res.end()` dessus depuis n'importe où dans ce fichier. Ce qu'on
// peut faire — et c'est ce que ⓓ faisait déjà pour ② et ③ — c'est rendre
// l'INSERTION visible : une instruction de plus change le texte, et le texte
// est asserté. Reformater ces fonctions fait donc rougir la garde. C'est le
// prix, il est voulu, et il est le même pour les cinq maillons.
// ════════════════════════════════════════════════════════════════════════════

// LES CINQ MAILLONS, ET LEUR TEXTE ATTENDU. La liste est ici pour être
// COMPTÉE : le test refuse de tourner si elle n'a pas cinq entrées, et ② et ③
// y figurent alors même que ⓓ les assertait déjà — un vivier qui laisse ses
// éléments déjà couverts dehors n'est plus un vivier, c'est un reste.
const MAILLONS = [
  {
    rang: "①",
    nom: "noterLaLigne",
    quoi: "le témoin de la cible — auditeur n°0 de `request`",
    fonction: noterLaLigne,
    texte:
      "function noterLaLigne(req) {" +
      '  CIBLES_ECRITES.set(req, { chemin: cheminDemande(req.url), methode: String(req.method ?? "") });' +
      "}"
  },
  // ② la délégation nue n'est pas une fonction NOMMÉE : elle se lit sur le
  //    serveur qui tourne, et c'est le test ⓓ qui la tient. Elle est comptée
  //    ici, et son texte est vérifié là-bas — la liste dit donc CINQ, et le
  //    lecteur sait où va chacun.
  { rang: "②", nom: "(la délégation nue)", quoi: "auditeur n°1 de `request`", tenuAilleurs: "ⓓ (ce fichier)" },
  {
    rang: "③",
    nom: "servirLaRequete",
    quoi: "décider, servir, ou tomber",
    tenuAilleurs: "ⓓ (ce fichier)"
  },
  {
    rang: "④",
    nom: "servirLeVerdict",
    quoi: "l'exécution — elle ouvre la réponse, puis elle exécute",
    fonction: servirLeVerdict,
    texte:
      "function servirLeVerdict(contexte, req, res, rendu) {" +
      "  autoriserLaReponse(res, rendu);" +
      '  if (rendu.marque === "serrure") {' +
      "    refuserLEntree(res);" +
      "    return undefined;" +
      "  }" +
      '  if (rendu.marque === "marque-page") {' +
      // ⚠️ EMPREINTE MISE À JOUR DÉLIBÉRÉMENT, ET VOICI POURQUOI.
      // Cette assertion a fait EXACTEMENT son travail : elle a arrêté une main
      // qui modifiait un maillon de la chaîne et l'a forcée à se justifier.
      // La justification : un navigateur TÉLÉCHARGEAIT cette redirection au
      // lieu de la suivre, parce qu'elle partait sans `content-type` sous
      // `nosniff`. La réponse porte donc son type et un corps de secours.
      // Ce qui n'a PAS changé, et qui est ce que le maillon garde : la fonction
      // ouvre toujours par `autoriserLaReponse`, et toute écriture reste
      // derrière ce verdict. Verrouillé par test/web-marque-page-safari.test.js.
      // Mise à jour du 18/10 (T4b-b) : le corps de secours parle anglais, comme
      // tout ce que le Messenger dit ; ni l'ordre ni le verdict ne bougent.
      "    // UN TYPE, MÊME SUR UNE REDIRECTION — l'encadré au-dessus dit pourquoi." +
      '    const cible = /^\\/[A-Za-z0-9_./-]*$/.test(String(rendu.location || ""))' +
      "      ? String(rendu.location)" +
      '      : "/";' +
      "    const corps = Buffer.from(" +
      '      "<!doctype html><html lang=\\"en\\"><meta charset=\\"utf-8\\">"' +
      '        + "<title>VALXOS Messenger</title>"' +
      '        + `<p>The door is open. <a href="${cible}">Enter</a>.</p>`,' +
      '      "utf8"' +
      "    );" +
      "    res.writeHead(302, {" +
      "      location: rendu.location," +
      '      "set-cookie": rendu.cookie,' +
      '      "cache-control": "no-store",' +
      '      "content-type": "text/html; charset=utf-8",' +
      '      "content-length": corps.length' +
      "    });" +
      "    res.end(corps);" +
      "    return undefined;" +
      "  }" +
      "  if (rendu.refus) {" +
      "    repondreJson(res, rendu.refus, rendu.corps, rendu.entetes);" +
      "    return undefined;" +
      "  }" +
      '  if (rendu.cookie) res.setHeader("set-cookie", rendu.cookie);' +
      "  return rendu.route.servir(contexte, req, res, rendu.route);" +
      "}"
  },
  {
    rang: "⑤",
    nom: "servirLaPanne",
    quoi: "la panne se dit — et elle passe par un verdict comme tout le reste",
    fonction: servirLaPanne,
    texte:
      "function servirLaPanne(res, erreur) {" +
      "  process.stderr.write(`web door: ${erreur?.stack || erreur}\\n`);" +
      "  if (res.headersSent) {" +
      "    res.end();" +
      "    return undefined;" +
      "  }" +
      '  servirLeVerdict(null, null, res, verdict("panne", { refus: 500, corps: { refus: "panne-de-la-porte" } }));' +
      "  return undefined;" +
      "}"
  }
];

test("ⓕ LES CINQ MAILLONS DE LA CHAÎNE SONT COMPTÉS — et chacun est tenu quelque part", () => {
  // Le compte AVANT les formes : c'est lui qui a manqué pendant douze heures.
  // Le jour où un sixième maillon apparaît, on veut être forcé de l'inscrire —
  // et de dire où il est tenu.
  assert.equal(MAILLONS.length, 5, "la chaîne a CINQ maillons — recompte avant de toucher cette liste");
  assert.equal(
    MAILLONS.filter((m) => m.tenuAilleurs).length,
    2,
    "deux maillons sont tenus par ⓓ (la délégation nue, servirLaRequete) — les trois autres le sont ici"
  );

  for (const maillon of MAILLONS) {
    if (maillon.tenuAilleurs) continue;
    // TROIS ISSUES : un maillon dont on n'a pas la fonction n'est pas un
    // maillon vert, c'est un maillon qu'on n'a pas mesuré.
    assert.equal(
      typeof maillon.fonction,
      "function",
      `SONDE IMPOSSIBLE : ${maillon.rang} ${maillon.nom} n'est pas une fonction — l'oracle ne mesure rien`
    );
    assert.equal(
      nu(maillon.fonction.toString()),
      nu(maillon.texte),
      `${maillon.rang} ${maillon.nom} (${maillon.quoi}) a changé de FORME. Une instruction de plus dans un maillon est une réponse de plus, écrite hors du répartiteur — et la marque ne la verrait pas, « res.end() » étant la méthode NUE de node.`
    );
  }
});

test("ⓕ ④ servirLeVerdict N'ÉCRIT RIEN AVANT D'AVOIR OUVERT — le contrôle positif du maillon", () => {
  // La forme ci-dessus dit « le texte n'a pas bougé ». Celui-ci dit ce que le
  // texte VAUT : la première instruction est l'autorisation, donc un verdict
  // fabriqué n'obtient pas un octet. Sans ce contrôle, l'assertion de forme
  // serait une empreinte sans signification.
  const res = fausseReponse();
  assert.throws(
    () => servirLeVerdict({}, {}, res, { marque: "route", route: ROUTES[0] }),
    /UNMINTED VERDICT/,
    "servirLeVerdict doit ouvrir AVANT d'exécuter — sinon l'ordre de ses lignes ne veut rien dire"
  );
  assert.equal(res.etat.statut, null, "pas un statut");
  assert.equal(res.etat.corps, "", "pas un octet de corps");
});

// ── ⓔ-bis LA MOITIÉ QUE LE RUNTIME NE PEUT PAS VOIR ─────────────────────────
//
// ⓔ mesure la porte que LE TEST construit. Or ce n'est pas la seule qui existe :
// `ouvrirLaPorte` rend `{ serveur, … }` au LANCEUR (`src/bin/valxos-web.js`), et
// une ligne posée là — `porte.serveur.on("clientError", …)` — ouvrirait la
// même deuxième porte sans qu'aucun oracle de runtime ne la croise, puisque
// aucun test ne fait tourner le lanceur.
//
// Ce filet-ci LIT donc la source, et il est FAIBLE pour cette raison même : ce
// qui l'écrit peut l'écrire autrement (nom d'événement calculé, indirection).
// Il ne prétend pas fermer la classe — ⓔ la ferme là où on peut mesurer, et
// celui-ci rattrape LE CAS ORDINAIRE partout ailleurs dans le code de la porte.
//
// IL LIT DEUX FOIS, PAR DEUX BOUTS, PARCE QUE CHAQUE BOUT EST AVEUGLE À CE QUE
// L'AUTRE VOIT :
//   ⒜ PAR L'ÉVÉNEMENT — toute pose dont le NOM D'ÉVÉNEMENT est propre à un
//      serveur HTTP, quel que soit l'objet qui la reçoit. Voit
//      `const s = porte.serveur; s.on("clientError", …)`. Aveugle à un nom
//      d'événement calculé.
//   ⒝ PAR LE RÉCEPTEUR — toute pose sur un objet qui S'APPELLE `serveur`,
//      `porte.serveur` ou `server`, quel que soit l'événement. Voit
//      `serveur.on(NOM_CALCULE, …)` et couvre `connect`/`connection`. Aveugle à
//      un objet serveur rangé sous un autre nom.
//
// ⚠️ ⒝ REPOSE SUR UN NOM DE VARIABLE, ET C'EST FAIBLE — il faut le dire ici et
// pas ailleurs. Un nom se change. Ce n'est pas une fermeture, c'est un filet à
// mailles connues : il attrape la ligne écrite normalement, par quelqu'un qui
// ne voyait pas qu'il ouvrait une deuxième porte.
//
// ⚠️ ET ⒜ NE COUVRE PAS `connect` NI `connection`, DÉLIBÉRÉMENT. Ces deux noms
// ne sont pas propres au serveur : une socket cliente émet `connect`, et le
// dépôt en a deux usages parfaitement légitimes (`src/lib/courier.js`,
// `src/lib/postbox.js`). Les inscrire dans ⒜ rendrait l'oracle bruyant, et un
// oracle bruyant finit desserré — c'est ⒝ qui les prend.
const EVENEMENTS_PROPRES_AU_SERVEUR = [
  "request",
  "checkContinue",
  "checkExpectation",
  "upgrade",
  "clientError",
  "dropRequest"
];

const POSE_DAUDITEUR = new RegExp(
  `\\.\\s*(?:on|once|addListener|prependListener|prependOnceListener)\\s*\\(\\s*["'](${EVENEMENTS_PROPRES_AU_SERVEUR.join("|")})["']`,
  "g"
);

// ⒝ Le RÉCEPTEUR : l'objet serveur tel qu'il se nomme dans ce dépôt.
const POSE_SUR_LE_SERVEUR =
  /(?:^|[^.\w$])(?:(?:porte\s*\.\s*)?serveur|server)\s*\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\s*\(\s*([^,)]*)/g;

// LES POSES PERMISES, écrites comme une liste fermée. Trois, et pas une de
// plus : les deux auditeurs de `request` de `creerLaPorte`, et le guetteur
// d'`error` d'`ouvrirLaPorte` — celui-ci est RETIRÉ (`off`) dès que la porte
// écoute, ce que ⓔ confirme au runtime en ne voyant aucun `error` posé.
//
// ⚠️ LE TITRE DU TEST CI-DESSOUS DIT « LES DEUX `request` … ET RIEN D'AUTRE »
// ET IL EN OUBLIE UN : la liste en compte TROIS, le guetteur d'`error` compris.
// Le titre n'est pas retouché ici (on ne touche pas aux tests d'un autre), mais
// c'est la liste qui fait foi, pas lui — et le jour où quelqu'un le relit en
// comptant, il doit trouver ce paragraphe avant de trouver la contradiction.
const POSES_PERMISES = [
  { fichier: "src/web/serveur.js", pose: "request" },
  { fichier: "src/web/serveur.js", pose: "request" },
  { fichier: "src/web/serveur.js", pose: "error" }
];

test("ⓔ-bis AUCUN FICHIER DE LA PORTE NE POSE D'AUDITEUR DE SERVEUR — les deux `request` de creerLaPorte, et rien d'autre", () => {
  const fichiers = fichiersDeLaPorte();
  // TROIS ISSUES : un vivier vide rendrait ce test vert sans avoir rien lu.
  assert.ok(fichiers.length >= 5, `SONDE IMPOSSIBLE : ${fichiers.length} fichier(s) dans le vivier de la porte`);
  // Et le LANCEUR doit en faire partie — c'est lui le trou que ce test bouche.
  assert.ok(
    fichiers.some((f) => path.relative(racine, f) === path.join("src", "bin", "valxos-web.js")),
    "SONDE IMPOSSIBLE : le lanceur n'est pas dans le vivier — or c'est LUI qui reçoit `porte.serveur`"
  );

  // Les deux lectures versent dans le MÊME panier, dédoublonné par position :
  // une pose vue par les deux bouts (les `serveur.on("request", …)`) ne compte
  // qu'une fois, et une pose vue par un seul bout compte quand même.
  const vues = new Map();
  for (const fichier of fichiers) {
    const nom = path.relative(racine, fichier).split(path.sep).join("/");
    const source = fs.readFileSync(fichier, "utf8");
    for (const filtre of [POSE_DAUDITEUR, POSE_SUR_LE_SERVEUR]) {
      for (const trouve of source.matchAll(filtre)) {
        // La clef est la LIGNE, pas la position : les deux filtres accrochent
        // la même pose à des offsets différents (l'un sur `.on(`, l'autre sur
        // le récepteur), et c'est la ligne qui les fait se reconnaître.
        const ligne = source.slice(0, trouve.index).split("\n").length;
        // Et la valeur est NORMALISÉE — ⒜ rend le nom d'événement, ⒝ rend
        // l'argument brut : on compare des choses comparables.
        const pose = trouve[1].trim().replace(/^["'`]|["'`]$/g, "");
        vues.set(`${nom}:${ligne}`, { fichier: nom, pose });
      }
    }
  }
  const posees = [...vues.values()];

  assert.deepEqual(
    posees,
    POSES_PERMISES,
    "un auditeur est posé sur le SERVEUR quelque part dans le code de la porte. S'il répond (`upgrade`, `clientError`, `checkContinue`, `connection`…), il répond hors du répartiteur : pas de verdict, pas de marque, et la table ne le concerne pas."
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ⓖ LE TRANSPORT LUI-MÊME — `req.socket`, ET LA DERNIÈRE PHRASE VERTE ET FAUSSE
//
// LA PHRASE QUI EST TOMBÉE. ⓕ écrivait, pour justifier que `verdictDeLaRequete`
// et `repartir` ne soient pas des maillons : « une fonction qui ne tient pas la
// réponse ne peut pas répondre ». Elle est FAUSSE. Mesuré sur cette branche,
// deux fois, sur node v26.7.0 :
//
//   M1 — première ligne de `verdictDeLaRequete` (src/web/serveur.js), une
//        fonction qui ne reçoit QUE `(contexte, req)` :
//          if (req?.headers?.["x-clef"] === "M1") {
//            req.socket.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nouvert");
//            return undefined;
//          }
//        → `GET /` avec l'en-tête `x-clef: M1` rend {"statut":200,
//          "marque":null,"corps":"ouvert"}, et la suite ENTIÈRE reste verte :
//          607 pass / 0 fail. Le dispositif de la marque LÈVE bien ensuite
//          (« VERDICT NON FRAPPÉ », vu sur stderr) — mais il lève APRÈS : la
//          réponse est déjà partie sur le fil.
//
//   M2 — la même ligne dans `verdictDeLaPorte` (src/web/auth.js), qui ne reçoit
//        que `(req, jetonAttendu)` : même résultat, 200 sans marque, corps
//        « ouvert », 607 pass / 0 fail.
//
//   M3 — le DÉTOUR, pour mesurer ⒝ : `const fil = req.socket;` puis
//        `fil.end("HTTP/1.1 200 OK…")`. Répond pareil, 200 sans marque.
//
// (Les « 607 pass » sont le compte de la suite AVANT ce test. Avec ⓖ en place,
// les trois mutations rougissent : M1 et M2 par ⒜, M3 par ⒝ — c'est la seule
// chose que ce bloc affirme sans l'avoir vue tourner rouge d'abord.)
//
// POURQUOI AUCUN VERROU EXISTANT NE PEUT LES VOIR, et c'est structurel :
// `req.socket` EST le transport. Node le donne à quiconque tient `req`, et
// `req.connection` en est l'alias vivant (vérifié le 22/08 sur node v26.7.0 :
// `req.connection === req.socket` rend `true`). Écrire dessus court-circuite
// `res` en entier — ni `autoriserLaReponse`, ni `exigerLaMarque`, ni le
// répartiteur, ni la table ne sont sur ce chemin. La marque ne peut pas s'y
// installer, puisque la marque vit sur `res`.
//
// ── POURQUOI ON NE LE FERME PAS PAR CONSTRUCTION ────────────────────────────
//
// Le seul verrou matériel serait d'envelopper `req` (un `Proxy`, ou un objet de
// façade) avant de le passer plus loin, pour que `.socket` ne soit plus
// atteignable. On ne le fait pas, et le prix se dit :
//   · le flux SSE et le keep-alive s'appuient sur l'objet RÉEL — la scrutation
//     lit `res.destroyed`, `res.writableEnded`, `res.writableLength`
//     (serveur.js, `tourDeFlux`), et node lui-même relit `req.socket` dans son
//     analyseur. Une façade qui ment sur ces champs casse le départ silencieux
//     du navigateur, qui est la seule chose qui rend une place ;
//   · un `Proxy` par requête est un coût par requête et une surface de bogues
//     neuve, pour fermer une classe que la revue ferme déjà ;
//   · et il ne fermerait PAS l'auteur qui écrit sa ligne AVANT l'enveloppe.
// CE QUI LE FERMERAIT VRAIMENT, si on le voulait un jour : ne jamais laisser
// `req` traverser la porte — un objet de requête à nous (méthode, chemin,
// en-têtes, corps déjà lu), fabriqué dans le gestionnaire, `req` et `res` ne
// sortant plus des cinq maillons. C'est une réécriture du contrat interne de
// toutes les fonctions `servir*`, et ça vaudra le jour où la porte accueillera
// du code qu'on n'a pas écrit — pas avant.
//
// ── CE QU'ON POSE À LA PLACE, ET POURQUOI ÇA VAUT LE COUP ───────────────────
//
// La classe DÉLIBÉRÉE-OBSCURCIE reste ouverte (elle l'est partout ailleurs dans
// cette garde, pour la même raison). Mais la classe NON INTENTIONNELLE — la
// ligne écrite normalement, par quelqu'un qui ne voyait pas qu'il répondait
// hors du répartiteur — se ferme pour trois lignes de lecture : les deux
// mutations l'écrivent en toutes lettres, `req.socket.end(`. Une limite qu'on
// pouvait fermer pour trois lignes n'est pas une limite, c'est une paresse.
//
// ⚠️ ET CE N'EST PAS UN `grep` DE SHELL, POUR UNE RAISON MESURÉE.
// `src/web/serveur.js` porte UN OCTET NUL : le séparateur de la constante que
// rend `signatureDeLaLettre`. Il se retrouve en une ligne, et l'offset ne se
// recopie pas parce qu'il bouge à chaque édition :
//     node -e 'const b=require("fs").readFileSync("src/web/serveur.js");
//              for(let i=0;i<b.length;i++) if(b[i]===0) console.log(i);'
// BSD grep classe donc le fichier comme BINAIRE et se tait : avec M1 en place,
// `grep -rnE '\.socket\.(end|write)' src/` rend zéro ligne et un code de retour
// 1 — indiscernable de « rien trouvé » ; il faut `grep -a` pour la voir
// (mesuré le 22/08, les deux commandes, l'une muette et l'autre parlante). Un
// oracle de shell serait donc NÉ VERT ET FAUX sur le fichier le plus important
// de la porte, ce qui est exactement la faute que ce run a payée quatre fois.
// Il est donc écrit en node, qui lit ces octets comme du texte.
//
// LES DEUX FILETS, et chacun dit ce qu'il ne voit pas :
//   ⒜ L'ÉCRITURE SUR LE TRANSPORT — `X.socket.end(`, `X.connection.write(`,
//      `X.stream.destroy(`… Il MORD sur les deux mutations telles quelles.
//      Aveugle à `const s = req.socket; s.end(…)`, que ⒝ prend.
//   ⒝ LA PRISE DU TRANSPORT — toute lecture de la propriété `.socket`,
//      `.connection`, `.stream` ou `._handle`, quel qu'en soit l'usage. C'est
//      le goulot : pour écrire sur le transport, il faut d'abord l'obtenir.
//      Aveugle à `const { socket } = req` et à `req["soc" + "ket"]` — la classe
//      délibérée-obscurcie, celle que cette garde dit partout ne pas fermer.
// ════════════════════════════════════════════════════════════════════════════

// ⒜ Les receveurs qui SONT le transport, et les méthodes qui y mettent des
// octets (ou coupent le fil, ce qui est une réponse aussi : un RST se lit).
const ECRITURE_SUR_LE_TRANSPORT =
  /\.\s*(?:socket|connection|stream|_handle)\s*\.\s*(?:end|write|writev|cork|uncork|destroy|destroySoon)\s*\(/g;

// ⒝ La PRISE du transport. La garde négative `(?![A-Za-z0-9_$])` est ce qui
// distingue `.socket` de `.socketPath` (une chaîne, pas un fil) et
// `.connection` de `.closeAllConnections` — les deux existent dans le vivier.
const PRISE_DU_TRANSPORT = /\.\s*(?:socket|connection|stream|_handle)(?![A-Za-z0-9_$])/g;

// LES PRISES PERMISES — liste FERMÉE, comparée par (fichier, ligne exacte).
// Aucune des deux n'est un fil : ce sont deux champs d'un objet de CHEMINS. Le
// jour où l'une change de texte, elle rougit et on rouvre la question — c'est
// le prix, et il est le même que celui des cinq maillons.
const PRISES_PERMISES = [
  { fichier: "src/lib/config.js", texte: "paths.socket = path.join(paths.run, `${safe}.sock`);" },
  { fichier: "src/lib/socket.js", texte: "const socketPath = runtimePaths(agentId).socket;" }
];

// ET LES ÉCRITURES PERMISES : AUCUNE. La liste est vide et c'est le contrat —
// la porte ne répond que par `res`, et `res` ne s'ouvre qu'avec un verdict.
const ECRITURES_PERMISES = [];

// LE BANC D'ESSAI DES DEUX FILETS. Il est le test du test : un filet qui
// cesserait de mordre rendrait ⓖ silencieux sans que rien ne rougisse ailleurs.
// Les deux premières lignes sont les mutations RÉELLES, copiées telles quelles.
const BANC_TRANSPORT_QUI_MORD = [
  'if (req?.headers?.["x-clef"] === "M1") { req.socket.end("HTTP/1.1 200 OK\\r\\n\\r\\nouvert"); return undefined; }',
  'if (req?.headers?.["x-clef"] === "M2") { req.socket.end("HTTP/1.1 200 OK\\r\\n\\r\\nouvert"); }',
  'res.socket.write("HTTP/1.1 200 OK\\r\\n\\r\\n");',
  'req.connection.end("HTTP/1.1 403 Interdit\\r\\n\\r\\n");',
  "res.stream.destroy();",
  "req._handle.writev(morceaux);",
  // L'espacement ne sauve pas : node accepte les blancs autour du point.
  'req . socket . end("ouvert");'
];

// Et ce que les filets ne doivent JAMAIS mordre. Les trois premières lignes
// sont copiées du vivier RÉEL (socket.js, round.js, serveur.js) : un faux
// positif qu'on rencontre pour de vrai et qu'on n'épingle pas revient sous
// forme d'exception de fichier — et une exception de fichier autorise TOUT ce
// que le fichier contiendra demain.
const BANC_TRANSPORT_QUI_NE_MORD_PAS = [
  "      boite.socketPath,",
  "      serveur.closeAllConnections?.();",
  '    connection: "keep-alive"',
  '    "content-type": "text/event-stream; charset=utf-8",',
  "  res.end(corps);",
  '      res.write(": battement\\n\\n");',
  "      flux.res.end();"
];

// « Qu'est-ce que ce fichier fait au transport, et à quelle ligne ? » — on rend
// la LIGNE ENTIÈRE, parce que c'est elle qu'on montre au lecteur quand ça casse.
function prisesDuTransport(source, filtre, fichier) {
  const vues = [];
  for (const trouve of source.matchAll(filtre)) {
    const avant = source.slice(0, trouve.index);
    const debut = avant.lastIndexOf("\n") + 1;
    const fin = source.indexOf("\n", trouve.index);
    vues.push({
      fichier,
      ligne: avant.split("\n").length,
      texte: source.slice(debut, fin === -1 ? undefined : fin).trim()
    });
  }
  return vues;
}

test("ⓖ AUCUNE FONCTION DE LA PORTE NE RÉPOND SUR LE TRANSPORT — `req.socket` est un fil, pas une réponse", () => {
  // Le vivier est celui du GRAPHE, sans la descente de répertoire : un fichier
  // que la porte ne charge pas ne tourne pas, donc ne répond à personne. Le
  // jour où il est importé, il entre ici tout seul.
  const fichiers = fichiersDeLaPorte();
  assert.ok(fichiers.length >= 10, `SONDE IMPOSSIBLE : ${fichiers.length} fichier(s) dans le vivier de la porte`);
  for (const ancre of ["src/web/serveur.js", "src/web/auth.js"]) {
    assert.ok(
      fichiers.includes(ancre),
      `SONDE IMPOSSIBLE : ${ancre} est hors du vivier — or c'est là que les deux mutations ont été mesurées`
    );
  }

  // ── L'INSTRUMENT PROUVE D'ABORD QU'IL MORD ────────────────────────────────
  for (const source of BANC_TRANSPORT_QUI_MORD) {
    assert.ok(
      prisesDuTransport(source, ECRITURE_SUR_LE_TRANSPORT, "banc").length > 0,
      `⒜ est AVEUGLE à une écriture sur le transport : ${source}`
    );
    assert.ok(
      prisesDuTransport(source, PRISE_DU_TRANSPORT, "banc").length > 0,
      `⒝ est AVEUGLE à une prise du transport : ${source}`
    );
  }
  // Et ⒝ seul doit mordre là où ⒜ ne peut pas — c'est toute sa raison d'être.
  const detour = "const s = req.socket;\ns.end('ouvert');";
  assert.equal(
    prisesDuTransport(detour, ECRITURE_SUR_LE_TRANSPORT, "banc").length,
    0,
    "⒜ n'est pas censé voir le détour — si ça change, c'est ⒝ qui devient inutile, pas l'inverse"
  );
  assert.equal(
    prisesDuTransport(detour, PRISE_DU_TRANSPORT, "banc").length,
    1,
    "⒝ doit voir la PRISE, même quand aucune écriture ne la suit"
  );

  for (const source of BANC_TRANSPORT_QUI_NE_MORD_PAS) {
    assert.deepEqual(prisesDuTransport(source, ECRITURE_SUR_LE_TRANSPORT, "banc"), [], `FAUX POSITIF ⒜ : ${source}`);
    assert.deepEqual(prisesDuTransport(source, PRISE_DU_TRANSPORT, "banc"), [], `FAUX POSITIF ⒝ : ${source}`);
  }

  // ── LE VIVIER RÉEL ────────────────────────────────────────────────────────
  // Les fichiers du graphe sont tous des sources JavaScript ; on le VÉRIFIE au
  // lieu de le supposer — un fichier d'un autre type lu en utf8 rendrait ce
  // test bavard ou muet pour une raison qui n'a rien à voir avec le transport.
  const ecritures = [];
  const prises = [];
  let lus = 0;
  for (const relatif of fichiers) {
    assert.match(relatif, /\.(?:js|mjs)$/, `${relatif} n'est pas une source JavaScript — décide, ne devine pas`);
    // `fs.readFileSync` en utf8, JAMAIS un grep de shell : serveur.js porte un
    // octet NUL, et un grep le classe binaire donc se tait (mesuré).
    const source = fs.readFileSync(path.join(racine, relatif), "utf8");
    lus += 1;
    ecritures.push(...prisesDuTransport(source, ECRITURE_SUR_LE_TRANSPORT, relatif));
    prises.push(...prisesDuTransport(source, PRISE_DU_TRANSPORT, relatif));
  }
  assert.ok(lus >= 10, `SONDE IMPOSSIBLE : ${lus} source(s) lue(s)`);

  // ⒜ — AUCUNE écriture, jamais, nulle part.
  assert.deepEqual(
    ecritures.map(({ fichier, ligne, texte }) => `${fichier}:${ligne} ${texte}`),
    ECRITURES_PERMISES,
    "une fonction de la porte écrit sur le TRANSPORT (`req.socket`, `res.connection`…). Elle répond sans `res` : donc sans verdict, sans marque, hors du répartiteur — et la réponse part AVANT que le dispositif de la marque n'ait pu lever. C'est la mutation M1/M2 du 22/08, mesurée à 200 sans marque avec 607 pass / 0 fail."
  );

  // ⒝ — et la PRISE elle-même est une liste fermée.
  assert.deepEqual(
    prises.map(({ fichier, texte }) => ({ fichier, texte })),
    PRISES_PERMISES,
    "une fonction de la porte PREND le transport (`.socket`, `.connection`, `.stream`, `._handle`). Aucune n'en a besoin : la porte répond par `res`, et `res` ne s'ouvre qu'avec un verdict frappé. Si c'est délibéré, inscris la ligne dans PRISES_PERMISES avec ce qu'elle en fait — et relis ⓖ avant."
  );
});
