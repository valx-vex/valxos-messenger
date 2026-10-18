// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA PORTE WEB DU VALXOS MESSENGER — un GUICHET, pas une boîte aux lettres.
//
// Elle lit et écrit au bureau de poste par LES MÊMES fonctions que le CLI et le
// guichet MCP : `posterUneLettre` pour déposer, `listInbox`/`markDelivered`
// pour relever, `ackMessage` pour signer. Aucun chemin privilégié, aucune
// requête SQL qui doublerait une fonction du produit.
//
// Ce que la porte n'est pas : le Facteur ne lui remet rien. C'est le navigateur
// qui relève. Une lettre pour l'opérateur attend donc que la page s'ouvre —
// jamais perdue (A9 : aucun état MORTE, aucune suppression).
//
// ── GARDE N°1 — LA PORTE NE LANCE RIEN SUR ORDRE DU CLIENT ──────────────────
//
// ⚠️ LE TITRE A CHANGÉ LE 22/08, ET LES QUATRE MOTS AJOUTÉS SONT TOUTE LA
// VÉRITÉ. Ce paragraphe disait « aucun endpoint ne lance de processus » — et
// c'était FAUX depuis toujours : un seul `POST /api/poster` en lance DEUX (la
// sonde de vivacité, par serveur.js → guichet.js → round.js → postbox.js ;
// mesuré au mouchard de test/web-garde-*.test.js, qui exige d'en voir au moins
// deux, sans quoi il se déclare SONDE IMPOSSIBLE). Le produit lance, et il a
// raison de lancer. Ce qui est vrai, et qui est la clause du contrat :
//
//     RIEN DE CE QUE L'UTILISATEUR TAPE N'ATTEINT UNE LIGNE DE COMMANDE.
//
// La porte n'exécute aucun code chez un pair et ne démarre aucune session que
// l'utilisateur n'a pas choisie dans une liste fermée. Deux moitiés, et les
// deux se prouvent au test de la garde n°1 (test/web-garde-*.test.js — son nom
// porte un des mots interdits, et le détecteur ne fait pas de quartier : on ne
// l'écrit pas ici) :
//   ① la table `ROUTES` ci-dessous EST le routage, et `repartir` en est le
//     SEUL chemin : le gestionnaire ne décide plus rien, il demande un verdict
//     et l'exécute. Cette phrase était déjà écrite ici avant le 22/08, et elle
//     était FAUSSE — une ligne insérée avant la consultation de la table
//     servait `/api/console` sans faire rougir un seul des quatre tests de la
//     garde. Elle est maintenant tenue par un oracle qui porte sur le CHEMIN
//     QUELCONQUE (test/web-repartiteur.test.js), pas sur une liste de chemins
//     interdits — une liste n'a jamais fermé une classe.
//     (Et le détecteur ci-dessous ne fait toujours pas de quartier : ces mots
//     ne s'écrivent pas ici, pas même pour raconter la mutation. Cette
//     phrase-ci a fait rougir la garde en s'écrivant.)
//   ①-ter ET CETTE PHRASE-LÀ EST MAINTENANT TENUE AU RUNTIME, PAS PAR UNE
//     LECTURE. L'oracle qui lisait la source a été pris en défaut une fois de
//     plus le 22/08 : une porte dérobée dont le chemin est CALCULÉ
//     (`String.fromCharCode(…)`) n'est écrite nulle part, donc introuvable par
//     l'extraction des littéraux, et introuvable par un tirage. La fermeture
//     est donc devenue matérielle — RÉPONDRE PAR LES FONCTIONS DE RÉPONSE DE
//     CE FICHIER EXIGE UN VERDICT FRAPPÉ (voir « LA MARQUE DU RÉPARTITEUR »
//     plus bas) : une ligne qui appelle `repondreJson` en amont du répartiteur
//     n'a pas de verdict, et n'écrit RIEN. Chaque réponse porte la marque de sa
//     décision, et le décor des tests la vérifie sur toutes les requêtes de la
//     suite.
//     ⚠️ ET LE « SAUF » SE LIT ICI, PAS PLUS BAS : la marque garde les
//     FONCTIONS DE RÉPONSE DE CE FICHIER, pas le fil. TROIS chemins écrivent
//     sans jamais la croiser — ils étaient annoncés comme deux jusqu'au 22/08 :
//       · `res.end()` / `res.write()` NUS : ce sont les méthodes de node, elles
//         ne demandent la permission à personne ;
//       · un auditeur de serveur posé hors de `request` (`upgrade`,
//         `clientError`…), qui reçoit le fil NU ;
//       · LE TRANSPORT LUI-MÊME, celui que node accroche à `req`. Il le donne à
//         quiconque tient `req`, donc à des fonctions qui ne voient jamais
//         `res` : `verdictDeLaRequete` ici, `verdictDeLaPorte` dans auth.js.
//         Mesuré le 22/08 : une ligne dans l'une ou l'autre rend 200 sans
//         marque, corps « ouvert », et la suite reste à 607 pass / 0 fail. Le
//         dispositif de la marque lève bien ensuite — mais APRÈS : la réponse
//         est déjà partie.
//     Ces trois chemins-là sont tenus par TROIS AUTRES oracles, tous plus
//     faibles et nommés comme tels : la forme des cinq maillons (ⓕ), la liste
//     fermée des auditeurs (ⓔ + ⓔ-bis), et la lecture du transport (ⓖ) — tous
//     dans test/web-repartiteur.test.js. Le détail, avec ce que chacun laisse
//     ouvert, est à « CE QUE ÇA NE FERME PAS ».
//   ①-bis le chemin que le répartiteur JUGE est celui que le client a ÉCRIT.
//     L'oracle de classe ci-dessus ne fermait pas la réécriture : lui donner
//     un chemin pelé de son préfixe servait toute la porte sous `/x9/` sans
//     faire rougir une seule des trois voies. La cible est donc NOTÉE par le
//     premier auditeur de `request` et re-vérifiée à l'instant de servir
//     (`servirLaMemeCible`, test/web-chemin-ecrit.test.js) — une fermeture par
//     construction, sur la table ENTIÈRE, pas un échantillon de préfixes.
//   ② aucune source de ce répertoire ne contient de lanceur — le test LIT les
//     fichiers, il ne fait pas confiance à la revue de code, et son détecteur
//     a désormais SON banc d'essai : il était aveugle à trois alias courants
//     jusqu'au 22/08, chacun nommé au banc de web-garde-*.test.js.
//
// ── GARDE N°2 — LA PORTE NE LIT QUE SON COURRIER ────────────────────────────
// QUATRE surfaces touchent au courrier, pas trois : `/api/fil`, le flux,
// `/api/accuser` — et `/api/poster`, qu'on avait oubliée parce qu'elle ÉCRIT
// (elle rendait pourtant la ligne d'autrui sur un `msg_id` déjà pris, R2). Les
// quatre passent par `lettresDeLOperateur` ou `estMonCourrier`, et l'en-souffrance
// rendue par `/api/pairs` y passe aussi. La table `messages` porte la
// correspondance de toute la maison : sans ces deux fonctions, la porte la
// rendrait ENTIÈRE, corps compris — et sans elles jusqu'aux MÉTADONNÉES, la
// porte publiait le compte et l'âge du courrier des tiers.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seuilsDeSouffrance, validateAgentId } from "../lib/config.js";
import {
  ackMessage,
  getMessageById,
  history,
  lettresEnSouffrance,
  listInbox,
  listPeers,
  markDelivered,
  registerPeer
} from "../lib/database.js";
import { etatDeLaLettre } from "../lib/format.js";
import { posterSousUneClefASoi, posterUneLettre } from "../lib/guichet.js";
import { SEPARATEUR_INSTANCE, SEPARATEUR_SESSION, STATUTS_HORS_SERVICE, libelleStatut } from "../lib/registry.js";
import { cheminDemande, cookieDuJeton, originesDeCadrage, verdictDeLaPorte } from "./auth.js";

// UNE PORTE, UN OPÉRATEUR. Le nom est fixé au démarrage et vit dans le contexte
// immuable de cette porte. Il ne vient JAMAIS d'une requête : une porte qui
// pourrait changer de nom sur ordre d'un client ouvrirait la boîte d'un autre.

// La boucle locale, et rien d'autre. Toute exposition éventuelle se configure
// en amont — jamais par le bind.
export const HOTES_PERMIS = ["127.0.0.1", "::1"];

// Le fil d'un seul humain reste petit ; le plafond est là pour qu'une page
// ouverte sur dix ans de courrier ne se peigne pas en trente secondes. Il ne
// TRONQUE JAMAIS EN SILENCE : la réponse porte `plafond` et
// `au_dela_du_plafond` — une borne muette se lirait « tout est là ».
export const PLAFOND_DU_FIL = 500;
// Un pli de plus de 256 Kio n'est pas une lettre, c'est un incident.
export const PLAFOND_DU_CORPS = 256 * 1024;
// ⚠️ ET LE DRAINAGE A UNE FIN. On draine après dépassement parce qu'un refus
// que personne ne reçoit n'est pas un refus (couper la lecture bloque le client
// sur son écriture) — la raison est bonne, la BORNE manquait : mesuré le 22/08,
// 16 Mio envoyés après le plafond, tous avalés, la porte lisait toujours. Ce
// n'est ni une fuite ni un plantage (la mémoire, elle, est bornée) : c'est une
// connexion qu'un client maladroit peut tenir indéfiniment. Quatre fois le
// plafond laissent au refus tout le temps de partir ; au-delà, on raccroche.
export const PLAFOND_DU_DRAINAGE = 4 * PLAFOND_DU_CORPS;
// ⚠️ ET LE RACCROCHAGE A UNE COURTOISIE. Mesuré le 22/08 : le `req.destroy()`
// posé avec la borne ci-dessus courait DEVANT le refus — le client recevait un
// EPIPE et perdait le 413 déjà écrit dans son tampon. Un diagnostic faux (« la
// connexion a été coupée ») à la place du bon (« ton pli est trop gros »), et
// deux pannes qui ne se réparent pas de la même façon. La cause est en dessous
// de HTTP : une socket qu'on ferme alors que le pair écrit encore lui renvoie
// un RST, et un RST fait jeter au noyau ce qu'il avait déjà reçu. Le seul geste
// qui laisse le refus arriver est donc de CONTINUER À LIRE (en jetant) le temps
// que le client lise sa réponse. Ce temps est borné, et c'est lui la vraie
// borne : passé le délai, la connexion meurt, quoi que le client raconte.
export const DELAI_DE_COURTOISIE_MS = 500;
// Un humain, plusieurs appareils, deux onglets oubliés et une reconnexion en
// rafale : douze places suffisent. Elles se libèrent à la déconnexion — ET,
// depuis le 22/08, sans qu'aucun adieu ne soit dit (voir le battement
// ci-dessous) : la première moitié seule laissait la place prise pour de bon.
// Le risque n'est pas un attaquant — c'est l'onglet qu'on ne ferme jamais.
export const PLAFOND_DE_FLUX = 12;
// LE BATTEMENT ET L'EXPIRATION — ce qui fait qu'une place REVIENT vraiment.
// Douze places libérées « à chaque déconnexion » ne veut rien dire tant que
// rien ne provoque de déconnexion : un appareil qui se rendort ne dit pas au
// revoir, et la socket reste ouverte pour le processus jusqu'à ce que le
// système d'exploitation s'en aperçoive — un quart d'heure de retransmissions
// TCP, parfois jamais. Le seul signe qu'une socket morte donne, c'est qu'elle
// n'avale plus : on écrit donc régulièrement (le battement, un commentaire SSE
// que le navigateur ignore), et ce qui ne part pas au bout du silence toléré
// rend sa place. Trois battements de patience avant de conclure.
export const PERIODE_DU_BATTEMENT_MS = 15_000;
export const DELAI_DE_SILENCE_MS = 3 * PERIODE_DU_BATTEMENT_MS;

// ── LES EN-TÊTES DE SÉCURITÉ ────────────────────────────────────────────────
//
// Rien n'est exploitable AUJOURD'HUI : l'échappement du front tient, et
// `SameSite=Strict` neutralise le cadre hostile. Mais la page rend du courrier
// ARBITRAIRE, écrit par des tiers, dans du `innerHTML` — le jour où une
// interpolation oublie d'échapper, il n'y a pas de deuxième ligne. Ces
// en-têtes SONT la deuxième ligne, et ils ne coûtent rien.
//
// ⚠️ PLUS UN SEUL HÔTE TIERS, et ce n'est pas une coquetterie. La page chargeait
// ses trois familles chez Google : le navigateur appelait donc un tiers à
// CHAQUE ouverture de la boîte aux lettres, en lui remettant des métadonnées
// de navigation — contradiction directe avec la souveraineté du courrier.
// Les polices sont donc servies localement (src/web/public/polices/, SIL OFL 1.1).
// La CSP est donc `default-src 'none'` + `'self'`, point.
// CES DEUX LIGNES ET `index.html` TOMBENT ENSEMBLE : rouvrir l'une sans l'autre
// donne soit une page sans polices, soit une promesse que la CSP ne tient plus.
// `style-src 'self'` sans `unsafe-inline` tient parce que la maquette n'a plus
// une seule règle en ligne (tout est sorti dans style.css) ; `champ.style.height`
// passe par le CSSOM, qu'aucune CSP ne gouverne.
export function entetesDeSecurite(cadreAutorise = []) {
  const origines = originesDeCadrage(cadreAutorise);
  const entetes = {
    "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${origines.length ? origines.join(" ") : "'none'"}`
    ].join("; "),
    // Le fichier est ce que son type dit, jamais ce que le navigateur devine.
    "x-content-type-options": "nosniff"
  };
  // Le vieux verrou ne sait exprimer aucune liste moderne. Il reste donc au
  // défaut fermé, et disparaît seulement quand la CSP porte une liste valide.
  if (origines.length === 0) entetes["x-frame-options"] = "DENY";
  // L'URL de la porte porte parfois le jeton (`?t=`) : elle ne part nulle part.
  entetes["referrer-policy"] = "no-referrer";
  return entetes;
}

// Compatibilité exacte pour tous les appels et tests qui lisent le verrou par
// défaut. Une porte sans configuration reste celle d'avant, octet pour octet.
export const ENTETES_DE_SECURITE = entetesDeSecurite();

// ── LE TYPE DU PLI ──────────────────────────────────────────────────────────
// La DERNIÈRE ligne après le cookie : `SameSite=Strict` empêche déjà un site
// hostile d'envoyer le cookie, mais un formulaire HTML ne sait poser que trois
// types (`text/plain`, `application/x-www-form-urlencoded`,
// `multipart/form-data`) — et aucun n'est celui-ci. Exiger le vrai type ferme
// la classe entière des envois par formulaire, quoi qu'il arrive au cookie.
export function typeDuPliAccepte(entete) {
  return String(entete || "").split(";")[0].trim().toLowerCase() === "application/json";
}

// `fileURLToPath`, JAMAIS `.pathname` : un chemin avec espace (`~/My Projects/…`,
// `~/Library/Application Support/…`) y devient `My%20Projects` — la porte démarrait
// et ne servait aucun fichier (revue sécurité F3, 18/10 ; même règle que config.js).
const RACINE_PUBLIQUE = path.resolve(fileURLToPath(new URL("./public/", import.meta.url)));

const TYPES_DE_FICHIER = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2"
};

// ── LA LOI DE L'ACCUSÉ (C=B) ────────────────────────────────────────────────
// Lire son courrier ordinaire, c'est l'accuser : la relève signe pour lui.
// Mais l'accusé est le SEUL geste terminal du dépôt — une fois posé, la lettre
// ne revient plus. On ne le signe donc à la place de l'humain que là où il ne
// coûte rien : une lettre ordinaire, en priorité ordinaire.
//
// ⚠️ LECTURE STRICTE, ASSUMÉE : `broadcast`, `response` et `status` exigent eux
// aussi le geste, faute d'avoir été nommés dans la loi. Le prix d'une erreur
// n'est pas symétrique — une lettre qui attend un clic reste vivante (A9), une
// lettre accusée par erreur est éteinte pour toujours.
export const TYPE_ACCUSE_IMPLICITE = "message";
export const PRIORITES_A_GESTE_HUMAIN = ["high", "critical"];

export function accuseImplicite(row) {
  if (!row) return false;
  if (PRIORITES_A_GESTE_HUMAIN.includes(row.priority)) return false;
  return row.msg_type === TYPE_ACCUSE_IMPLICITE;
}

// GARDE N°2, la question en une ligne : « cette lettre est-elle la sienne ? »
export function estMonCourrier(row, operateur) {
  return Boolean(row) && (row.sender === operateur || row.recipient === operateur);
}

export function verifierLHote(hote) {
  const nom = String(hote ?? "");
  if (HOTES_PERMIS.includes(nom)) return nom;
  throw new Error(
    `the door listens only on the loopback interface (${HOTES_PERMIS.join(", ")}): "${nom}" would expose ` +
      "the operator's mailbox to the network. Any exposure is configured upstream, never through the listening address."
  );
}

// ── LA MARQUE DU RÉPARTITEUR — UN SEUL CHEMIN VERS UNE RÉPONSE ──────────────
//
// CE QUE CE DISPOSITIF REMPLACE, ET POURQUOI. La garde n°1 disait « la table
// EST le routage » et la prouvait en LISANT la source : les littéraux de la
// porte devenaient des chemins candidats. Un oracle de LECTURE ne ferme pas une
// classe — on peut toujours écrire la même chose autrement. Mesuré le 22/08 :
//
//     if (chemin === String.fromCharCode(47,116,114,111,117)) {
//       repondreJson(res, 200, { trou: true }); return undefined;
//     }
//
//   posée dans le gestionnaire AVANT `repartir` → `GET /trou` répond 200, et la
//   suite ENTIÈRE reste verte (598 pass / 0 fail, mesuré). Aucune des trois
//   voies de l'oracle ne pouvait la voir : le chemin n'est pas un littéral (ce
//   sont des nombres), aucun tirage ne le devine, et le répartiteur nu n'est
//   jamais consulté puisque la ligne rend la main AVANT lui.
//
// LA FERMETURE EST DONC AU RUNTIME, PAS DANS LA LECTURE : ÉCRIRE SUR LA PORTE
// EXIGE UN VERDICT, ET SEULES LES DÉCISIONS DE LA PORTE EN FRAPPENT UN. Trois
// verrous, et ils sont indissociables :
//   ① `verdict()` est la SEULE frappe, et chaque verdict frappé est inscrit
//      dans un registre d'identité (`WeakSet`) : un objet qui RESSEMBLE à un
//      verdict n'en est pas un, et rien ne le rend fabricable de l'extérieur.
//   ② `autoriserLaReponse` est la seule ouverture : elle exige un verdict
//      INSCRIT, marque la réponse, et pose du même geste les en-têtes de
//      sécurité et l'en-tête de la marque — la marque est donc LISIBLE DE
//      L'EXTÉRIEUR sur chaque réponse, et le décor commun des tests la vérifie
//      sur les centaines de requêtes de la suite (test/aide-porte.js).
//   ③ TOUTE FONCTION QUI *OUVRE* UNE RÉPONSE EST DERRIÈRE LA MARQUE. Elles
//      sont six, et on les nomme plutôt que d'écrire « toutes » :
//        · QUATRE ont `exigerLaMarque(res)` pour PREMIÈRE instruction —
//          `repondreJson`, `refuserLEntree`, `servirLeFichier`,
//          `ecrireEvenement` ;
//        · la cinquième, `servirLesEvenements`, ne l'a PAS en premier : le
//          refus du plafond de flux la précède. Ce refus passe lui-même par
//          `repondreJson`, donc par la marque — mais « les cinq commencent par
//          `exigerLaMarque` » était écrit ici, et c'était faux d'une fonction ;
//        · la sixième EST celle qui marque : `servirLeVerdict` écrit la
//          redirection du marque-page en `res.writeHead`/`res.end` nus, mais sa
//          PREMIÈRE instruction est `autoriserLaReponse`.
//      Une porte dérobée qui appellerait `repondreJson` en amont du répartiteur
//      n'écrit donc RIEN : elle lève, la panne est servie, et `GET /trou` ne
//      rend jamais 200.
//
//      ⚠️ « OUVRE » N'EST PAS « ÉCRIT », ET LA NUANCE EST RÉELLE. Une fois la
//      réponse ouverte, on continue d'écrire dessus SANS repasser par la
//      marque. ELLES SONT TROIS, et l'encadré n'en comptait que deux :
//        · le battement (`res.write(": battement\n\n")`, dans `tourDeFlux`) ;
//        · la fermeture des flux (`flux.res.end()`, dans `fermer`) ;
//        · `servirLaPanne`, branche `res.headersSent` : un `res.end()` nu, sur
//          une réponse qu'une autre décision avait ouverte. Elle manquait à la
//          liste, et c'est la même classe exactement.
//      Ce n'est pas un trou — ces trois-là n'ont d'objet à écrire que parce
//      qu'un verdict a ouvert la réponse, et aucune n'ouvre rien elle-même —
//      mais écrire « toute fonction qui écrit un octet commence par
//      `exigerLaMarque` » serait faux, et ça l'était.
//      (Les trois se comptent en lisant les appels à `res.write` / `res.end` /
//      `res.writeHead` de ce fichier, commentaires exclus : TREIZE sites, dix
//      derrière la marque, trois après ouverture. Recompter avant de toucher
//      cette liste — c'est le compte qui a manqué, pas la bonne volonté.)
//
// ⚠️ CE QUE ÇA NE FERME PAS, ET IL FAUT LE LIRE ICI AUTANT QU'AU TEST.
//
//   (a) `res.end()` ET `res.write()` NUS. Ce sont les méthodes de node, pas les
//       nôtres : elles ne demandent la permission à personne, et rien
//       n'empêche une ligne de ce fichier de les appeler directement. La
//       phrase « toute fonction qui écrit un octet commence par
//       `exigerLaMarque` » était écrite ici, et elle était FAUSSE — c'est
//       exactement le genre de phrase verte qui a coûté la journée du 22/08.
//       Ce chemin-là n'est PAS fermé par la marque. Il est tenu autrement, et
//       plus faiblement : par la FORME des cinq maillons de la chaîne, assertée
//       au runtime (ⓕ, test/web-repartiteur.test.js). L'insertion se VOIT ;
//       l'écriture, elle, resterait possible si l'assertion sautait.
//
//   (b) LA SOCKET, HORS DE L'ÉVÉNEMENT `request`. Un auditeur `upgrade`,
//       `clientError` ou `connect` reçoit la socket NUE et répond sans jamais
//       traverser ce dispositif. La marque ne le verrait pas — elle ne
//       s'installe que sur le chemin qu'il évite. Ce qui le tient est la liste
//       FERMÉE des auditeurs réellement posés sur le serveur, comparée à un
//       `http.Server` nu (ⓔ, test/web-repartiteur.test.js).
//       ⚠️ ET ⓔ NE MESURE QUE LA PORTE QUE LE TEST CONSTRUIT. `ouvrirLaPorte`
//       rend `{ serveur, … }` au lanceur (`src/bin/valxos-web.js`), qu'aucun
//       test ne fait tourner : une ligne posée là est vue par ⓔ-bis, qui LIT
//       la source, pas par ⓔ. Mesuré le 22/08 — un auditeur de `clientError`
//       posé sur `porte.serveur` dans le lanceur → ⓔ vert, ⓔ-bis rouge ; la
//       même pose sous un autre nom de variable et sur l'événement de
//       connexion → LES DEUX VERTS. Cette fermeture-là est donc à moitié
//       structurelle et à moitié un filet à mailles connues.
//       (Le détail des deux mutations est au test ; il ne se recopie pas ici,
//       les oracles ⓔ-bis et ⓖ mordant sur leur propre énoncé.)
//
//   (b-bis) LE TRANSPORT, DANS L'ÉVÉNEMENT `request` — la propriété que node
//       accroche à `req` et qui EST le fil. C'est la trouvaille du 22/08 au
//       soir, et c'est la plus large des trois : node remet ce fil à QUICONQUE
//       tient `req`, y compris aux fonctions qui ne voient jamais `res` et
//       qu'on croyait donc incapables de répondre (`verdictDeLaRequete` ici,
//       `verdictDeLaPorte` dans auth.js). Mesuré : une seule ligne dans l'une
//       ou l'autre, qui écrit une réponse HTTP brute sur ce fil → 200, corps
//       « ouvert », AUCUNE marque, et 607 pass / 0 fail. Le dispositif lève
//       après coup ; la réponse est déjà partie.
//       Ce n'est PAS fermable ici : envelopper `req` casserait le keep-alive et
//       la scrutation du flux SSE, qui lisent l'objet réel. C'est tenu par une
//       LECTURE (ⓖ, test/web-repartiteur.test.js) qui refuse toute écriture sur
//       le fil, et toute PRISE du fil, hors d'une liste fermée. Elle ferme
//       l'ajout ordinaire, pas l'obscurcissement.
//       ⚠️ ET C'EST POUR ÇA QUE CE PARAGRAPHE NE NOMME PAS LA PROPRIÉTÉ : ⓖ lit
//       ce fichier en entier, commentaires compris, et mordrait sur son propre
//       énoncé — exactement comme le détecteur de lanceurs plus haut. Le prix
//       est réel (on ne peut pas écrire ce mot ici) et il est voulu : un
//       oracle qui excepte les commentaires excepte un endroit où se cacher.
//
//   (c) L'AUTEUR DU DÉPÔT. Qui a le droit d'écrire dans CE fichier peut appeler
//       `verdict()` lui-même, ou retirer l'assertion qui le gêne. Ce dispositif
//       ferme l'introduction NON INTENTIONNELLE (la ligne ajoutée sans voir ce
//       qu'elle fait), pas la porte dérobée délibérée — celle-là se ferme par
//       la revue et le contrôle des accès, jamais par un test.
export const EN_TETE_DE_LA_MARQUE = "x-porte-verdict";

// LA LISTE FERMÉE DES MARQUES — une par façon dont la porte peut décider de
// répondre, et rien d'autre. Elle se compare au CONTRAT au test de la garde,
// exactement comme `ROUTES` : une marque de plus est une décision de plus, et
// une décision de plus se voit le jour où elle naît.
export const MARQUES = [
  "serrure",
  "marque-page",
  "route",
  "route-inconnue",
  "methode-refusee",
  "cible-reecrite",
  "panne"
];

// Le registre d'IDENTITÉ des verdicts. Un `WeakSet` — pas un champ, pas un
// symbole exporté : un champ se recopie, un symbole exporté se relit. Ce qui
// n'est pas passé par `verdict()` n'y est pas, et ne pourra jamais y entrer.
const VERDICTS = new WeakSet();
// Quelles réponses ont reçu leur autorisation, et sous quelle marque.
const REPONSES_MARQUEES = new WeakMap();

function verdict(marque, valeur = {}) {
  // Un verdict d'une marque hors liste n'est pas un verdict : la liste fermée
  // se tient ICI, à la frappe, pas seulement au test.
  if (!MARQUES.includes(marque)) throw new Error(`mark outside the closed list: "${marque}"`);
  const frappe = { marque, ...valeur };
  VERDICTS.add(frappe);
  return frappe;
}

// « Cet objet est-il un verdict de CETTE porte ? » — exporté pour que le test
// puisse prouver qu'un verdict FABRIQUÉ n'en est pas un.
export function estUnVerdict(valeur) {
  return VERDICTS.has(valeur);
}

// LA SEULE OUVERTURE. Elle refuse un verdict qui n'a pas été frappé, et c'est
// tout le dispositif : sans elle, aucune écriture n'est possible sur `res`.
export function autoriserLaReponse(res, rendu) {
  if (!VERDICTS.has(rendu)) {
    const erreur = new Error(
      "UNMINTED VERDICT: only a decision of the door (lock, bookmark, dispatcher, target, failure) " +
        "can authorize a response. An object that looks like a verdict is not one."
    );
    erreur.code = "verdict_non_frappe";
    throw erreur;
  }
  REPONSES_MARQUEES.set(res, rendu.marque);
  // LES EN-TÊTES DE SÉCURITÉ VOYAGENT AVEC LA MARQUE — même geste, même
  // instant. Ils étaient posés en tête du gestionnaire ; les attacher à
  // l'autorisation les rend impossibles à oublier sur une réponse future, et
  // impossibles à obtenir sans verdict.
  const entetesDeLaReponse = rendu.entetesDeSecurite || ENTETES_DE_SECURITE;
  for (const [nom, valeur] of Object.entries(entetesDeLaReponse)) res.setHeader(nom, valeur);
  res.setHeader(EN_TETE_DE_LA_MARQUE, rendu.marque);
}

// ⚠️ CHAQUE FONCTION QUI ÉCRIT COMMENCE PAR ELLE. C'est la ligne qui transforme
// « la table est le routage » d'une PHRASE en un FAIT : une réponse écrite sans
// verdict n'existe pas, elle lève.
function exigerLaMarque(res) {
  if (REPONSES_MARQUEES.has(res)) return;
  const erreur = new Error(
    "WRITE WITHOUT A VERDICT: the door has one path to a response, a verdict minted by a " +
      "decision of the door, then `autoriserLaReponse`. A line that answers upstream of the dispatcher " +
      "is not a route: it is a back door, and it will write nothing."
  );
  erreur.code = "ecriture_sans_verdict";
  throw erreur;
}

// ── CE QUE LA PORTE REND ────────────────────────────────────────────────────

// ⚠️ EXPORTÉE POUR ÊTRE MISE À L'ÉPREUVE, jamais pour être appelée d'ailleurs :
// le test de la garde lui donne une réponse SANS marque et exige qu'elle refuse
// d'écrire. C'est le contrôle positif du dispositif — sans lui, le silence de la
// marque ne prouverait rien.
export function repondreJson(res, statut, valeur, entetes = {}) {
  exigerLaMarque(res);
  const corps = `${JSON.stringify(valeur)}\n`;
  res.writeHead(statut, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(corps),
    "cache-control": "no-store",
    ...entetes
  });
  res.end(corps);
}

// Le refus d'authentification ne dit RIEN : pas de corps, pas d'en-tête qui
// nomme une route, pas de cookie. Un 405 ici (« cette route existe, mais pas
// dans cette méthode ») serait déjà la moitié de la carte du produit — c'est
// pour ça que la serrure passe AVANT le routage.
function refuserLEntree(res) {
  exigerLaMarque(res);
  res.writeHead(401, { "cache-control": "no-store", "content-length": 0 });
  res.end();
}

// ── LE COURRIER DE L'OPÉRATEUR ──────────────────────────────────────────────

// GARDE N°2. `history` (database.js) borne TOUJOURS sa requête sur `self` :
// c'est ICI que la porte cesse de voir la correspondance des autres, et c'est
// la seule porte d'entrée du courrier dans ce fichier.
export function lettresDeLOperateur(db, operateur, { plafond = PLAFOND_DU_FIL } = {}) {
  // `history` rend les plus RÉCENTES d'abord (c'est ce qu'un plafond doit
  // garder) ; le fil, lui, se lit dans le sens du temps.
  return history(db, { self: operateur, limit: plafond }).reverse();
}

function compterMonCourrier(db, operateur) {
  return db
    .prepare("SELECT count(*) AS n FROM messages WHERE sender = ? OR recipient = ?")
    .get(operateur, operateur).n;
}

// Le nom de la BOÎTE derrière une adresse : `alice#sess` et `alice@atelier`
// mènent tous les deux à la boîte `alice`. Sans ça, une lettre adressée
// nominativement crierait dans le vide — sa souffrance ne se rattacherait à
// aucune fiche du registre.
function nomDeBoite(adresse) {
  return String(adresse || "")
    .split(SEPARATEUR_INSTANCE)[0]
    .split(SEPARATEUR_SESSION)[0];
}

function heures(ms) {
  return Number.isFinite(ms) ? Math.floor(ms / 3_600_000) : null;
}

// L'en-souffrance (H2) : un VERDICT dérivé, jamais un état stocké. Le calcul
// est celui du médecin (`lettresEnSouffrance`), pas une deuxième définition.
function crisDuCourrier(db, operateur, { maintenant = Date.now(), seuils = seuilsDeSouffrance() } = {}) {
  const parLettre = new Map();
  const parBoite = new Map();
  for (const row of lettresEnSouffrance(db, { maintenant, seuils })) {
    // GARDE N°2 — ET ELLE MANQUAIT ICI. `lettresEnSouffrance` balaie la table
    // ENTIÈRE : c'est son travail, il est celui du médecin de la maison. La
    // porte, elle, n'a droit qu'au courrier de son opérateur. Sans cette ligne,
    // `/api/pairs` publiait pour un pair tiers le volume, l'âge et la
    // raison d'échec d'une correspondance entre deux TIERS — mesuré le 22/08
    // dans un décor où l'opérateur n'avait STRICTEMENT AUCUN courrier :
    // `{"lettres":3,"depuis_h":30,"tentatives":1,"motif":"boite-endormie"}`.
    // La loi de la maison ne dit pas « on ne lit pas le CORPS des autres »,
    // elle dit « le courrier des autres ne se lit pas » : un compte et une
    // échéance sont du courrier.
    if (!estMonCourrier(row, operateur)) continue;
    parLettre.set(row.msg_id, {
      depuis_h: heures(row.depuis_ms),
      tentatives: Number(row.tentatives || 0),
      motif: row.dernier_motif || null
    });
    const boite = nomDeBoite(row.recipient);
    const compte = parBoite.get(boite) || { lettres: 0, depuis_h: 0, tentatives: 0, motif: null };
    compte.lettres += 1;
    compte.depuis_h = Math.max(compte.depuis_h, heures(row.depuis_ms) || 0);
    compte.tentatives = Math.max(compte.tentatives, Number(row.tentatives || 0));
    if (row.dernier_motif) compte.motif = row.dernier_motif;
    parBoite.set(boite, compte);
  }
  return { parLettre, parBoite };
}

// Les quatre mots de l'état viennent de `etatDeLaLettre` — JAMAIS recalculés
// ici : deux définitions du même mot divergeraient un jour sans bruit.
export function vueDeLaLettre(row, operateur, cris = new Map()) {
  // `injected_at` (poussée par la sonnette) et `delivered_at` (tirage par la
  // relève) disent la MÊME chose — la lettre a atteint son lecteur — et
  // l'affichage refuse de les classer (doctrine de format.js). On rend la
  // PREMIÈRE des deux : la question du lecteur est « quand est-elle arrivée ».
  //
  // ⚠️ ET PRENDRE LA PREMIÈRE DE DEUX VALEURS NE FIGE RIEN QUAND L'UNE DES DEUX
  // AVANCE. `injected_at` est figée (COALESCE) ; `delivered_at`, elle, est une
  // horloge de re-service que `markDelivered` ré-écrit SEC à chaque service —
  // délibérément, côté Facteur. Cette ligne était donc juste d'intention et
  // fausse en pratique : le cachet avançait à chaque chargement de page
  // (mesuré le 22/08 : 19:40:13.034Z → .066Z → .097Z, acked_at nul du début à
  // la fin). Ce qui fige le cachet n'est PAS ici — c'est `releverLeCourrier`,
  // qui ne re-marque plus une lettre déjà arrivée. La vue ne peut pas réparer
  // seule ce que l'écriture défait : elle n'a pas de source immobile à lire.
  const arrivees = [row.injected_at, row.delivered_at].filter(Boolean).sort();
  return {
    seq: row.seq,
    msg_id: row.msg_id,
    de: row.sender,
    a: row.recipient,
    objet: row.subject,
    corps: row.body,
    type: row.msg_type,
    priorite: row.priority,
    etat: etatDeLaLettre(row),
    mien: row.sender === operateur,
    // De quoi peindre le bouton : cette lettre-là attend-elle le geste de
    // l'humain, ou la relève l'a-t-elle déjà signée ?
    geste_humain: !accuseImplicite(row),
    postee_a: row.created_at,
    guichet_a: row.carried_at || null,
    recue_a: arrivees[0] || null,
    accusee_a: row.acked_at || null,
    en_souffrance: cris.get(row.msg_id) || null
  };
}

// ── LA RELÈVE ───────────────────────────────────────────────────────────────
//
// Le même geste que `cc2cc-inbox` et que le guichet MCP : `listInbox` puis
// `markDelivered`. La porte n'invente pas sa propre marque.
//
// ── LA MARQUE NE SE REPOSE PAS SUR UNE LETTRE DÉJÀ ARRIVÉE ─────────────────
//
// LE DÉFAUT (22/08, spécimen `msg-tache-deux`) : `/api/fil` re-marquait TOUTES
// les non-accusées à CHAQUE appel — donc à chaque chargement de page, à chaque
// reprise après coupure, à chaque lettre qui tombe. `markDelivered` écrivant
// SEC, `delivered_at` avançait sans que rien ne soit arrivé à la lettre, et le
// cachet de l'écran avec lui : « Reçue à 21:22 » se re-datait tout seul.
//
// POURQUOI LE REMÈDE EST ICI ET PAS DANS `markDelivered`. Les deux lectures de
// `delivered_at` sont vraies en même temps, et elles ne s'arbitrent pas :
//   · pour un PORTEUR (les hooks, le canal de repli), la marque est une horloge
//     de re-service — elle DOIT avancer, sinon la fenêtre de
//     `getPendingForContext` ne borne plus rien et une lettre jamais accusée
//     revient à chaque appel d'outil, pour toujours. Y poser un COALESCE
//     casserait A8. On n'y touche pas.
//   · pour le LECTEUR, « reçue » est un ÉVÉNEMENT : il a eu lieu une fois.
// Ce qui se corrige, ce n'est donc pas la marque : c'est QUI on marque. Un
// chargement de page sur une lettre déjà livrée ne remet rien sous les yeux de
// personne — elle y est déjà, et la page l'affiche depuis hier soir. La porte
// ne marque plus que ce qu'elle FAIT VRAIMENT arriver.
//
// CE N'EST PAS UN CHANGEMENT DE CONTRAT, C'EST LE CONTRAT ENFIN TENU : le front
// l'écrit déjà noir sur blanc (`public/app.js` — « CETTE ROUTE RELÈVE (contrat :
// markDelivered sur les non-livrées) », et `releveDue` refuse de relever une
// lettre « reçue » PARCE QUE « la marque est posée, /api/fil ne la reposerait
// pas »). Le serveur disait le contraire, en silence.
//
// CE QUE ÇA COÛTE, ET C'EST DIT :
//   ① le journal perd la trace « la porte a re-servi cette lettre » — elle n'en
//      était pas une : c'était une trace de coup d'œil, et elle grossissait
//      d'un événement PAR LETTRE NON ACCUSÉE ET PAR CHARGEMENT.
//   ② `delivered_at` cesse d'être repoussé par les visites de l'opérateur, donc la
//      fenêtre de re-service du Facteur court enfin pour son courrier. C'est un
//      RETOUR à la règle, pas une brèche : rien dans la porte ne devrait tenir
//      l'horloge d'un autre canal ouverte. Et A9 n'en souffre pas — seul
//      `acked_at` éteint une lettre, et lui ne bouge pas d'un iota ici.
//   ③ la limite assumée : si un jour un autre canal relève la même boîte
//      par le CLI ou le guichet MCP, CE porteur-là avancera `delivered_at` et
//      le cachet bougera d'autant. La porte est aujourd'hui le seul lecteur de
//      cette boîte (en-tête de ce fichier) ; le jour où ce ne sera plus vrai,
//      il faudra une source d'arrivée qui ne bouge JAMAIS, pas un filtre.
// Le verrou d'arrêt n'entre pas dans le calcul : la porte n'appelle
// `resetStopGuard` nulle part — vérifié sur tout `src/web/`, la seule
// occurrence du nom dans ce répertoire est cette phrase-ci. Le verrou vit sur
// le chemin des sessions (hooks, CLI, guichet MCP), pas sur celui du navigateur.
export function releverLeCourrier(db, operateur) {
  const aRelever = listInbox(db, operateur, { limit: PLAFOND_DU_FIL, includeInjected: true });
  const accusees = [];
  const refuses = [];
  if (aRelever.length === 0) return { relevees: 0, deja_recues: 0, accusees, refuses };

  // Déjà arrivée = déjà marquée par un canal quelconque (`injected_at` par la
  // sonnette, `delivered_at` par une relève précédente) : exactement la
  // frontière que `etatDeLaLettre` appelle « reçue ». Deux définitions du même
  // mot divergeraient un jour sans bruit — on lit donc la sienne.
  const nouvelles = aRelever.filter((row) => etatDeLaLettre(row) !== "reçue");
  if (nouvelles.length > 0) markDelivered(db, nouvelles, operateur, "porte_web_relevee");

  // L'ACCUSÉ IMPLICITE, LUI, RESTE SUR TOUTE LA PILE — et ce n'est pas une
  // inattention. Il ne dépend pas de la marque de livraison mais de la LOI C=B
  // (type et priorité) : une lettre ordinaire arrivée par la sonnette, ou
  // qu'un accusé refusé a laissée non signée, doit se faire signer au
  // chargement suivant. La filtrer ici la laisserait vivante pour toujours.
  for (const row of aRelever) {
    if (!accuseImplicite(row)) continue;
    try {
      ackMessage(db, row.msg_id, operateur);
      accusees.push(row.msg_id);
    } catch (erreur) {
      // Un accusé refusé ne casse JAMAIS la relève (A9 : la lettre reste
      // intacte, elle reviendra) — mais il ne se tait pas non plus : un refus
      // muet est un état que personne ne saura jamais nommer.
      if (erreur?.code !== "accuse_refuse") throw erreur;
      refuses.push({ msg_id: row.msg_id, raison: erreur.raison });
    }
  }
  // `relevees` compte ce que son nom dit — les lettres RÉELLEMENT livrées par
  // ce passage, jamais celles qu'on a simplement relues (doctrine de
  // `markCarried` : un compte qui ne compte pas ce que son nom dit ment).
  // `deja_recues` est la moitié qu'il faut voir pour sonder le filtre : sans
  // elle, « 0 livrée » ne se distingue pas d'« une boîte vide ».
  return { relevees: nouvelles.length, deja_recues: aRelever.length - nouvelles.length, accusees, refuses };
}

// ── LES BOÎTES ──────────────────────────────────────────────────────────────

function enService(statut) {
  return !STATUTS_HORS_SERVICE.includes(statut);
}

// La vue rendue par `/api/pairs` ET par le premier événement du flux : UNE
// fonction, pour que « la page se peint sans deuxième requête » reste vrai.
export function vueDesPairs(db, operateur, options = {}) {
  const { parBoite } = crisDuCourrier(db, operateur, options);
  const boites = new Map();
  for (const fiche of listPeers(db, { includeDead: true })) {
    const nom = fiche.lineage || fiche.id;
    const boite = boites.get(nom) || {
      nom,
      chaises: 0,
      en_service: false,
      libelle: null,
      designee: null,
      en_souffrance: null
    };
    if (fiche.instance_session_id) boite.chaises += 1;
    if (enService(fiche.status)) boite.en_service = true;
    else if (!boite.libelle) boite.libelle = libelleStatut(fiche.status);
    if (Number(fiche.is_primary) === 1) boite.designee = fiche.instance_session_id || fiche.id;
    boites.set(nom, boite);
  }
  const pairs = [...boites.values()]
    .map((boite) => ({
      ...boite,
      libelle: boite.en_service ? "in service" : boite.libelle || libelleStatut("dead"),
      en_souffrance: parBoite.get(boite.nom) || null
    }))
    .sort((a, b) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0));
  return { pairs };
}

// ── LE CORPS D'UNE DEMANDE ──────────────────────────────────────────────────
//
// On DRAINE la requête même trop grosse : couper la lecture en cours de route
// bloque le client sur son écriture et il ne lit jamais le refus. Un refus que
// personne ne reçoit n'est pas un refus.
//
// MAIS LE DRAINAGE A UNE FIN. La raison ci-dessus vaut pour un pli un peu trop
// gros — le temps que le 413 parte. Elle ne vaut plus pour un client qui
// pousse seize mégaoctets : là, ce n'est plus un refus qu'on lui rend, c'est
// une connexion qu'il tient. Au-delà de `plafondDuDrainage` on rend donc la
// main tout de suite — le refus part — et la connexion meurt
// `delaiDeCourtoisieMs` plus tard, le temps que le client ait pu le LIRE. Ce
// délai n'est pas une politesse : sans lui, le raccrochage jette le refus.
export function lireLeCorps(
  req,
  {
    plafond = PLAFOND_DU_CORPS,
    plafondDuDrainage = PLAFOND_DU_DRAINAGE,
    delaiDeCourtoisieMs = DELAI_DE_COURTOISIE_MS
  } = {}
) {
  return new Promise((resolve, reject) => {
    let taille = 0;
    let trop = false;
    let rendu = false;
    const morceaux = [];
    const rendre = (valeur) => {
      if (rendu) return;
      rendu = true;
      resolve(valeur);
    };
    req.on("data", (bloc) => {
      taille += bloc.length;
      if (taille > plafond) {
        trop = true;
        morceaux.length = 0;
      } else {
        morceaux.push(bloc);
      }
      if (!rendu && taille > plafondDuDrainage) {
        // ⚠️ LE REFUS PART D'ABORD, LE RACCROCHAGE VIENT APRÈS. Le
        // `req.destroy()` qui était ici courait devant la réponse : elle se
        // rédige au tour de boucle suivant, la connexion était déjà morte, et
        // l'humain recevait « la connexion a été coupée » au lieu de « ton pli
        // est trop gros ». Ni couper la lecture ni la mettre en pause ne
        // suffisent — les deux mènent au même RST, et un RST fait jeter au
        // noyau du client le refus qu'il avait déjà reçu (mesuré : 0 sur 8
        // réponses lues, contre 8 sur 8 avec la courtoisie ci-dessous).
        // On rend donc la main tout de suite (la réponse part), on continue de
        // LIRE EN JETANT — rien ne s'accumule, `morceaux` est vidé à chaque
        // bloc — et un couperet ferme la connexion au bout du délai. La borne
        // n'est plus en octets mais en TEMPS, et c'était de toute façon la
        // bonne unité : le défaut de départ était une connexion qu'un client
        // maladroit pouvait tenir INDÉFINIMENT.
        rendre({ trop: true, texte: "" });
        const couperet = setTimeout(() => req.destroy(), delaiDeCourtoisieMs);
        req.on("close", () => clearTimeout(couperet));
      }
    });
    req.on("end", () => rendre({ trop, texte: Buffer.concat(morceaux).toString("utf8") }));
    // Une coupure APRÈS qu'on a rendu la main n'est pas une panne : c'est le
    // raccrochage qu'on vient de décider.
    req.on("error", (erreur) => {
      if (!rendu) reject(erreur);
    });
  });
}

async function corpsJson(req) {
  const { trop, texte } = await lireLeCorps(req);
  if (trop) {
    // Le refus est le MÊME que le pli soit un peu trop gros ou franchement
    // absurde : c'est la même faute, et la surface n'a rien à décider de plus.
    // Le raccrochage du cas absurde est déjà posé par `lireLeCorps`, où il a le
    // seul contexte qui compte — la lecture.
    return { statut: 413, refus: "pli-trop-gros", motif: `the letter exceeds ${PLAFOND_DU_CORPS} bytes` };
  }
  // LE TYPE SE VÉRIFIE APRÈS LE DRAINAGE, jamais avant : refuser sans lire
  // laisserait le client bloqué sur son écriture, exactement le défaut que le
  // drainage existe pour éviter. Un seul chemin, une seule borne.
  if (!typeDuPliAccepte(req.headers?.["content-type"])) {
    return {
      statut: 415,
      refus: "type-refuse",
      motif: "the door accepts only application/json; a form cannot send it"
    };
  }
  if (!texte.trim()) return { valeur: {} };
  try {
    return { valeur: JSON.parse(texte) };
  } catch {
    return { statut: 400, refus: "json-illisible", motif: "the request body is not JSON" };
  }
}

// ── LES SURFACES ────────────────────────────────────────────────────────────

function servirLeFichier(contexte, req, res, route) {
  // Le nom du fichier vient de LA ROUTE, jamais de l'URL : il n'y a donc aucun
  // chemin à assainir, et « ../ » n'est pas une question qu'on se pose. Une
  // porte qui dérive son fichier de l'URL est une porte qui sert un jour
  // `/etc/passwd`.
  // ⚠️ ET LA RACINE EST CELLE DE LA TABLE, pas une racine que le contexte
  // porterait à part (5e passe adverse). `ROUTES` énumère les polices depuis
  // `RACINE_PUBLIQUE` ; lire ailleurs, c'est annoncer un dossier et en servir
  // un autre. Voir la note de `creerLaPorte` pour pourquoi on ferme dans ce
  // sens-là plutôt qu'en rendant la table propre à chaque porte.
  exigerLaMarque(res);
  const fichier = path.join(RACINE_PUBLIQUE, route.fichier);
  let contenu;
  try {
    contenu = fs.readFileSync(fichier);
  } catch {
    // Le front n'est pas encore posé : la route EXISTE (elle est au contrat),
    // le fichier pas. On le dit sans rien inventer.
    repondreJson(res, 404, { refus: "fichier-absent", fichier: route.fichier });
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES_DE_FICHIER[path.extname(route.fichier)] || "application/octet-stream",
    "content-length": contenu.length,
    "cache-control": "no-store"
  });
  res.end(contenu);
}

function servirLesPairs(contexte, req, res) {
  repondreJson(res, 200, vueDesPairs(contexte.db, contexte.operateur));
}

function servirLeFil(contexte, req, res) {
  const releve = releverLeCourrier(contexte.db, contexte.operateur);
  // ⚠️ LA RELÈVE VIENT DE POSER `delivered_at` EN BASE : les objets JS d'avant
  // la marque MENTIRAIENT (même piège que server.js et valxos-inbox.js). On
  // relit APRÈS l'effet de bord — l'état rendu est celui de la
  // base, pas celui d'avant le geste qu'on vient de faire.
  const { parLettre } = crisDuCourrier(contexte.db, contexte.operateur);
  const lettres = lettresDeLOperateur(contexte.db, contexte.operateur)
    .map((row) => vueDeLaLettre(row, contexte.operateur, parLettre));
  const total = compterMonCourrier(contexte.db, contexte.operateur);
  repondreJson(res, 200, {
    moi: contexte.operateur,
    lettres,
    plafond: PLAFOND_DU_FIL,
    au_dela_du_plafond: Math.max(0, total - lettres.length),
    // Un accusé implicite refusé (fiche de l'opérateur retirée du service) se DIT :
    // sinon la page afficherait « accusée » pour une lettre qui ne l'est pas.
    ...(releve.refuses.length > 0 ? { accuses_refuses: releve.refuses } : {})
  });
}

// ── LE DÉPÔT — LA QUATRIÈME SURFACE DU COURRIER (garde n°2) ─────────────────
//
// Ce qu'il a coûté de l'oublier (trois lentilles adverses, 22/08) : le `msg_id`
// est ENTIÈREMENT choisi par le client (le contrat le veut — c'est la clef
// d'idempotence du front), et `posterUneLettre` rend LA LIGNE EXISTANTE quand
// la clef est déjà prise (remède R2). Poster sous la clef d'une lettre entre
// deux TIERS rendait donc, d'un seul geste : le destinataire d'autrui dans la
// réponse, un coup de sonnette chez lui pour SA lettre, et le texte que
// l'opérateur venait de taper nulle part. Une fuite de métadonnée ET une lettre
// perdue, par le même chemin.
//
// La règle, en une phrase : LA PORTE NE DÉPOSE QUE SOUS UNE CLEF QUI EST À
// ELLE. Une clef prise par le courrier d'un tiers est ÉCARTÉE — jamais suivie,
// jamais commentée — et la lettre part quand même, sous une clef que le
// guichet génère. A8 arbitre : on préfère un doublon à une lettre perdue.
//
// ⚠️ CE QUE CE REMÈDE NE FERME PAS, DIT À VOIX HAUTE : `clef_ecartee` apprend
// au client que la clef qu'il a proposée est prise par du courrier qui n'est
// pas le sien — un bit d'existence. Il est le prix du contrat actuel (le front
// GÉNÈRE la clef et la garde comme identité locale du pli). La fermeture
// complète est de dériver la clef stockée dans un espace de noms qui
// n'appartient qu'à la porte ; elle exige que le front adopte le `msg_id`
// rendu par la réponse, donc un geste des deux côtés. Un bit contre une
// lettre : le bit se paie.
export async function deposerPourLOperateur(db, operateur, entree, clefDemandee, deps = {}) {
  // La règle vit au guichet depuis F12 (28/09) : les trois portes (web, MCP,
  // CLI) la partagent, jamais trois copies. Le message d'échec reste celui de
  // la porte.
  try {
    return await posterSousUneClefASoi(db, { ...entree, msg_id: clefDemandee || undefined }, {
      estAMoi: (row) => estMonCourrier(row, operateur),
      chercher: deps.chercher || getMessageById,
      poster: deps.poster || posterUneLettre
    });
  } catch (erreur) {
    if (erreur?.code === "clef_indisponible") {
      erreur.message = "the door could not post the letter under a key that belongs to it";
    }
    throw erreur;
  }
}

async function servirPoster(contexte, req, res) {
  const demande = await corpsJson(req);
  if (demande.refus) {
    repondreJson(res, demande.statut, { refus: demande.refus, motif: demande.motif });
    return;
  }
  const a = String(demande.valeur.a ?? "").trim();
  if (!a) {
    repondreJson(res, 400, { refus: "destinataire-manquant", motif: "a letter without a recipient is not a letter" });
    return;
  }
  const corps = String(demande.valeur.corps ?? "");
  if (!corps.trim()) {
    repondreJson(res, 400, { refus: "corps-manquant", motif: "an empty letter does not leave" });
    return;
  }

  // `msg_id` est la clef d'idempotence du front : rejouée, elle rend LA lettre,
  // jamais une seconde (la loi vit au guichet, remède R2). Elle passe par
  // `deposerPourLOperateur`, qui refuse de déposer sous la clef d'un autre.
  const clefDemandee = String(demande.valeur.msg_id ?? "").trim();

  const { row, wake, attente, rejeu, clefEcartee } = await deposerPourLOperateur(
    contexte.db,
    contexte.operateur,
    {
      // ⚠️ LA PORTE SIGNE L'OPÉRATEUR FIXÉ AU DÉMARRAGE, TOUJOURS. `de` n'est
      // pas un paramètre : un client qui en glisse un dans le corps est ignoré,
      // jamais honoré. Écrire « de la part de » quelqu'un est exactement ce que
      // cette porte ne fait jamais.
      sender: contexte.operateur,
      recipient: a,
      subject: demande.valeur.objet ?? null,
      body: corps,
      thread_id: demande.valeur.thread_id ?? null,
      priority: demande.valeur.priorite,
      msg_type: demande.valeur.type,
      // L'opérateur est un humain : aucun modèle à estampiller. Inconnu se dit nul.
      sender_model: null
    },
    clefDemandee
  );

  repondreJson(res, 200, {
    msg_id: row.msg_id,
    seq: row.seq,
    // `destinataire` vient de LA LIGNE, pas du `a` qu'on vient de lire : sur un
    // rejeu, la ligne existante est la vérité (R2). La ligne est GARANTIE être
    // du courrier de l'opérateur par `deposerPourLOperateur` — sans cette garantie,
    // ce champ rendait le destinataire du courrier de deux tiers.
    destinataire: row.recipient,
    reveil: wake,
    // L'avis 2-bis voyage TEL QUEL — c'est le produit qui explique sa loi, et
    // une porte qui le reformulerait ferait diverger deux vocabulaires.
    ...(attente ? { attente } : {}),
    // LE REJEU SE DIT. Le guichet rend le FAIT (« le `a` que tu as tapé a été
    // écarté, la ligne existante l'emporte ») et chaque surface le met en
    // forme — le commentaire ④ de guichet.js prévoyait que la porte web serait
    // « la première à l'oublier ». Elle l'avait oublié.
    ...(rejeu ? { rejeu } : {}),
    // Et la clef écartée : la lettre est partie, mais pas sous la clef
    // demandée. Le taire, c'est laisser le front croire qu'il tient le pli.
    ...(clefEcartee ? { clef_ecartee: { demandee: clefEcartee, motif: "clef-deja-prise" } } : {})
  });
}

async function servirAccuser(contexte, req, res) {
  const demande = await corpsJson(req);
  if (demande.refus) {
    repondreJson(res, demande.statut, { acke: false, refus: demande.refus, motif: demande.motif });
    return;
  }
  const msgId = String(demande.valeur.msg_id ?? "").trim();
  if (!msgId) {
    repondreJson(res, 400, { acke: false, refus: "msg_id-manquant", motif: "a letter cannot be signed without naming it" });
    return;
  }
  // L'EXISTENCE AVANT TOUT : on ne journalise jamais un refus sur un msg_id qui
  // n'a jamais été une lettre (même loi que le guichet MCP — un journal peuplé
  // de msg_id inventés est un journal qu'on cesse de lire).
  //
  // ⚠️ DÉFAUT CONNU, NON CORRIGÉ, ASSUMÉ (trouvaille ⑤ du 22/08, et il faut un
  // arbitrage pour le fermer). Les deux refus ci-dessous sont DISTINGUABLES de
  // l'extérieur — 404 « lettre-inconnue » contre 403 « pas-mon-courrier » —
  // donc qui atteint la porte peut demander « ce msg_id existe-t-il dans le
  // bureau ? » et lire la réponse dans le code de retour, pour du courrier
  // auquel il n'a aucun droit.
  //
  // Pourquoi ça reste : les deux motifs sont ÉCRITS DANS DEUX TESTS EXISTANTS
  // qui se contredisent une fois fusionnés — `web-api.test.js` exige
  // 404 + /inconnue/, `web-son-courrier.test.js` exige 403 +
  // « pas-mon-courrier », et ce dernier explique noir sur blanc pourquoi il
  // exige LE MOTIF : c'est ce qui prouve que c'est CETTE garde qui a mordu et
  // pas `ackMessage`. Fermer la trouvaille demande donc de retoucher un test
  // existant, ce que le mandat de ce chantier interdit — et à raison.
  //
  // L'arbitrage tient en une ligne, et il appartient à la maison : fusionner
  // les deux réponses sur 403 « pas-mon-courrier » (jamais l'inverse — le 404
  // effacerait le dispositif anti-mutant de web-son-courrier), puis remplacer
  // dans `web-api.test.js` les deux assertions du test « une lettre inconnue
  // se refuse en le disant » ; le reste de ce test (« rien d'inventé au
  // journal ») tient tel quel. Ce qui pèse dans l'autre sens : la porte est
  // mono-utilisateur, en boucle locale, derrière un jeton de 32 octets, et les
  // msg_id sont des UUID — l'oracle ne confirme donc l'existence que
  // d'identifiants que l'appelant possède déjà, et l'appelant est l'opérateur.
  const ligne = getMessageById(contexte.db, msgId);
  if (!ligne) {
    repondreJson(res, 404, { acke: false, refus: "lettre-inconnue", msg_id: msgId });
    return;
  }
  // GARDE N°2 — et elle refuse AVANT d'ouvrir la lettre. `ackMessage` refuserait
  // aussi, mais après avoir lu la ligne et écrit un reçu au journal : la porte
  // n'a rien à faire dans le courrier d'un autre, pas même le regarder.
  if (!estMonCourrier(ligne, contexte.operateur)) {
    repondreJson(res, 403, {
      acke: false,
      refus: "pas-mon-courrier",
      motif: "the door signs only its operator's mail",
      msg_id: msgId
    });
    return;
  }
  try {
    const row = ackMessage(contexte.db, msgId, contexte.operateur);
    repondreJson(res, 200, { acke: true, msg_id: msgId, etat: etatDeLaLettre(row), accusee_a: row.acked_at });
  } catch (erreur) {
    if (erreur?.code !== "accuse_refuse") throw erreur;
    // Le refus PAR LETTRE du dépôt (une lettre que l'opérateur a ÉCRITE : il n'en
    // est pas le destinataire, il ne la signe donc pas). Vocabulaire distinct
    // de la garde ci-dessus — deux gardes, deux motifs.
    repondreJson(res, 403, {
      acke: false,
      refus: "accuse-refuse-lettre",
      msg_id: msgId,
      destinataire: erreur.destinataire,
      raison: erreur.raison
    });
  }
}

function ecrireEvenement(res, type, donnees) {
  exigerLaMarque(res);
  res.write(`event: ${type}\ndata: ${JSON.stringify(donnees)}\n\n`);
}

// CE QUE LE FLUX SURVEILLE POUR UNE LETTRE — et il y a DEUX choses, pas une.
//
// Les quatre états répondent « où en est cette lettre ? » ; l'en-souffrance
// répond « faut-il qu'un humain s'en mêle ? ». Les deux questions sont
// ORTHOGONALES (doctrine de format.js) : une lettre « en attente » qui se met à
// crier reste « en attente ». Le tour ne comparait que l'état — donc rien ne
// changeait, donc rien ne partait, et la lettre qui basculait en souffrance
// PENDANT que la page était ouverte restait muette jusqu'au rechargement. La
// boîte, elle, criait (`vueDesPairs` porte l'en-souffrance par boîte) : l'écran
// disait « il y a un cri quelque part » sans jamais dire lequel.
//
// La signature porte donc les deux, et le mot « changement » redevient vrai.
function signatureDeLaLettre(row, cri) {
  return `${etatDeLaLettre(row)}\0${cri ? JSON.stringify(cri) : ""}`;
}

// ── LE BATTEMENT ET LA MOISSON — CE QUI REND VRAIMENT UNE PLACE ─────────────
//
// Le plafond de flux se libérait « à chaque déconnexion », et c'était vrai :
// `res.on("close")` retire le flux. Ce qui manquait, c'est que RIEN ne provoque
// de déconnexion. Un appareil qui se rendort, un onglet qui perd le réseau : le
// client ne dit jamais au revoir, la socket reste ouverte pour le processus, et
// la place reste prise jusqu'à ce que le système d'exploitation s'en aperçoive
// — un quart d'heure de retransmissions TCP, parfois jamais. Au treizième
// réveil, l'opérateur ne peut plus ouvrir sa porte, et le 503 lui demande de
// fermer des onglets qui n'existent plus.
//
// LE SEUL SIGNE QU'UNE SOCKET MORTE DONNE, C'EST QU'ELLE N'AVALE PLUS. D'où les
// deux gestes, et ils sont indissociables : sans le BATTEMENT, un flux calme
// n'écrit rien et l'expiration ne verrait jamais rien ; sans l'EXPIRATION, le
// battement s'entasserait dans un tampon que personne ne vide.
function battreEtMoissonner(contexte, flux) {
  const res = flux.res;
  const maintenant = contexte.horloge();

  // ① CE QUI EST DÉJÀ MORT NE S'ATTEND PAS. `close` peut ne jamais venir (une
  //    socket lâchée par le noyau, une fermeture venue d'ailleurs) : le compte
  //    ne doit pas dépendre d'un événement qu'on espère.
  if (res.destroyed || res.writableEnded) {
    flux.fermer();
    return;
  }

  // ② LE BATTEMENT — un COMMENTAIRE SSE, pas un événement. `EventSource`
  //    l'ignore sans le remonter à la page : le front n'a pas un mot de plus à
  //    connaître, et la porte a de quoi savoir si sa socket avale encore.
  if (maintenant - flux.dernierBattement >= contexte.periodeDuBattementMs) {
    flux.dernierBattement = maintenant;
    try {
      res.write(": battement\n\n");
    } catch {
      // Écrire sur une socket morte n'est pas une panne de la porte : c'est le
      // départ qu'on cherchait à constater.
      flux.fermer();
      return;
    }
  }

  // ③ L'EXPIRATION. Un tampon de sortie qui ne se vide pas EST l'adieu qu'on
  //    n'a pas reçu. On laisse trois battements de patience — un réseau lent
  //    n'est pas un réseau mort — puis la place se rend, et la socket avec.
  if (Number(res.writableLength || 0) === 0) {
    flux.bouchonDepuis = null;
    return;
  }
  flux.bouchonDepuis ??= maintenant;
  if (maintenant - flux.bouchonDepuis >= contexte.delaiDeSilenceMs) {
    flux.fermer();
    res.destroy();
  }
}

function tourDeFlux(contexte, flux) {
  try {
    const lettres = lettresDeLOperateur(contexte.db, contexte.operateur);
    // ⚠️ LES CRIS SE CALCULENT À CHAQUE TOUR, ET C'EST LE PRIX DU CHANTIER H2.
    // Ils étaient calculés PARESSEUSEMENT (« un tour qui ne trouve rien ne doit
    // pas coûter un balayage de la table ») — mais pour savoir si un cri vient
    // de naître, il faut justement l'avoir regardé. L'économie n'était pas une
    // économie : c'était la raison pour laquelle le cri n'arrivait jamais.
    const cris = crisDuCourrier(contexte.db, contexte.operateur).parLettre;
    for (const row of lettres) {
      const cri = cris.get(row.msg_id) || null;
      const signature = signatureDeLaLettre(row, cri);
      const connue = flux.etats.get(row.msg_id);
      if (connue === signature) continue;
      flux.etats.set(row.msg_id, signature);
      ecrireEvenement(
        flux.res,
        connue === undefined ? "lettre" : "etat",
        vueDeLaLettre(row, contexte.operateur, cris)
      );
    }
    const vue = vueDesPairs(contexte.db, contexte.operateur);
    const signature = JSON.stringify(vue);
    if (signature !== flux.signature) {
      flux.signature = signature;
      ecrireEvenement(flux.res, "pairs", vue);
    }
  } catch {
    // Un tour qui tombe (base fermée pendant l'arrêt, client déjà parti) ne
    // doit emporter ni la porte ni les autres flux. Le tour suivant réessaie.
  }
  // ⚠️ HORS DU FILET CI-DESSUS, ET DÉLIBÉRÉMENT : un tour qui tombe ne doit pas
  // empêcher une place morte de se rendre. C'est même le cas où elle compte le
  // plus — un flux dont la base ne répond plus est un flux qu'on va garder
  // longtemps.
  battreEtMoissonner(contexte, flux);
}

function servirLesEvenements(contexte, req, res) {
  // LE PLAFOND DE FLUX. Le risque n'est pas un attaquant : c'est le client qui
  // reprend, l'onglet oublié, la reconnexion en rafale — chaque flux rejoue
  // jusqu'à 500 lignes, un `vueDesPairs` et un `JSON.stringify` complet par
  // seconde. Mesuré le 22/08 : soixante `EventSource` d'un coup, tous acceptés.
  // Au-delà du plafond on refuse PROPREMENT (un refus muet ferait boucler la
  // reconnexion sans jamais dire pourquoi), et la place se libère dès qu'un
  // onglet se ferme — la déconnexion propre est déjà prouvée par le test des
  // intervalles orphelins. Et quand personne ne dit au revoir (l'appareil qui se
  // rendort), c'est `battreEtMoissonner` qui rend la place : sans lui, ce
  // plafond n'était pas un plafond, c'était un compte à rebours.
  if (contexte.flux.size >= contexte.plafondDeFlux) {
    repondreJson(res, 503, {
      refus: "trop-de-flux",
      plafond: contexte.plafondDeFlux,
      motif: "too many open streams on the door: close a tab and the slot comes back at once"
    });
    return;
  }
  exigerLaMarque(res);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive"
  });

  // LE PREMIER ÉVÉNEMENT EST UN `pairs` COMPLET — pour que la page se peigne
  // sans deuxième requête (contrat).
  const vue = vueDesPairs(contexte.db, contexte.operateur);
  ecrireEvenement(res, "pairs", vue);

  const flux = {
    res,
    signature: JSON.stringify(vue),
    // Le premier événement compte comme un battement : on vient d'écrire.
    dernierBattement: contexte.horloge(),
    // Depuis quand le tampon de sortie ne se vide plus. Nul = il se vide.
    bouchonDepuis: null,
    // L'état de départ : ce qui existe déjà n'est pas une nouvelle. La page a
    // `/api/fil` pour son état initial ; le flux ne porte que les CHANGEMENTS.
    // ⚠️ LA MÊME SIGNATURE QU'AU TOUR, cri compris : une lettre DÉJÀ en
    // souffrance à l'ouverture ne doit pas se faire annoncer comme une nouvelle
    // au premier tour. Deux façons de résumer une lettre feraient bégayer le
    // flux d'un côté ou taire un cri de l'autre.
    etats: new Map(
      (() => {
        const cris = crisDuCourrier(contexte.db, contexte.operateur).parLettre;
        return lettresDeLOperateur(contexte.db, contexte.operateur).map((row) => [
          row.msg_id,
          signatureDeLaLettre(row, cris.get(row.msg_id) || null)
        ]);
      })()
    )
  };
  const minuteur = contexte.poserIntervalle(() => tourDeFlux(contexte, flux), contexte.periodeMs);
  // Le filet du dernier recours : la porte GARDE la liste de ses minuteurs, et
  // les retire tous à sa fermeture. Sans lui, un jour où le retrait ci-dessous
  // se perdrait, la scrutation survivrait au serveur et le processus ne
  // rendrait jamais la main — un test qui PEND au lieu d'échouer est un test
  // qu'on cesse de croire.
  contexte.minuteurs.add(minuteur);

  // ⚠️ UNE DÉCONNEXION NE DOIT RIEN LAISSER DERRIÈRE ELLE. Un onglet qu'on
  // ferme, un appareil qui s'endort : sans ce retrait, la porte scruterait la
  // base pour un client parti, à jamais, une fois par onglet fermé.
  // `fermer` est IDEMPOTENT : `close` peut arriver deux fois (réponse et
  // requête), et un double retrait ferait mentir le compte.
  let ferme = false;
  flux.fermer = () => {
    if (ferme) return;
    ferme = true;
    contexte.retirerIntervalle(minuteur);
    contexte.minuteurs.delete(minuteur);
    contexte.flux.delete(flux);
  };
  res.on("close", flux.fermer);
  contexte.flux.add(flux);
}

// ── LES POLICES — UNE ENTRÉE PAR FICHIER, JAMAIS UN PRÉFIXE ─────────────────
//
// Les trois familles de la maquette sont servies par la porte elle-même depuis
// le 22/08 : la page appelait Google à chaque ouverture, et remettait à un
// tiers des métadonnées de navigation de la boîte aux lettres — pour un
// produit dont la thèse entière est la souveraineté du courrier.
//
// UNE RÈGLE DE PRÉFIXE (`GET /polices/*`) AURAIT ÉTÉ LE CHEMIN FACILE ET C'EST
// EXACTEMENT CE QU'IL NE FAUT PAS FAIRE : elle rouvrirait la porte que la garde
// n°1 ferme — servir un chemin que la table ne nomme pas. On énumère donc le
// dossier au chargement, une ligne par fichier. La table reste DÉRIVÉE et
// FERMÉE : un fichier ajouté demain y entre tout seul, et la garde le voit.
// Un dossier absent ne casse rien — la porte sert alors une page sans polices
// plutôt que de refuser de démarrer.
//
// ⚠️ AUCUN PARAMÈTRE, ET C'EST LE REMÈDE DE LA 5e PASSE. Cette fonction
// prenait une racine (`racine = RACINE_PUBLIQUE`) que personne ne passait,
// pendant que `servirLeFichier` lisait `contexte.racinePublique` : une porte
// créée avec une autre racine annonçait les routes du dossier LIVRÉ et lisait
// dans le dossier SERVI. Défaut latent, mais le contrat exige une table
// DÉRIVÉE du dossier — deux dossiers, c'est une table dérivée de rien.
function routesDesPolices() {
  let noms;
  try {
    noms = fs.readdirSync(path.join(RACINE_PUBLIQUE, "polices")).filter((n) => n.endsWith(".woff2"));
  } catch {
    return [];
  }
  return noms.sort().map((nom) => ({
    methode: "GET",
    chemin: `/polices/${nom}`,
    servir: servirLeFichier,
    fichier: path.join("polices", nom)
  }));
}

// ── LA TABLE — LISTE FERMÉE (garde n°1) ─────────────────────────────────────
// Elle EST le routage : il n'existe pas d'autre chemin vers une réponse. Toute
// ligne ajoutée ici se voit immédiatement au test de la garde n°1, qui la
// compare au tableau du contrat.
export const ROUTES = [
  ...routesDesPolices(),
  { methode: "GET", chemin: "/", servir: servirLeFichier, fichier: "index.html" },
  { methode: "GET", chemin: "/app.js", servir: servirLeFichier, fichier: "app.js" },
  { methode: "GET", chemin: "/style.css", servir: servirLeFichier, fichier: "style.css" },
  { methode: "GET", chemin: "/polices.css", servir: servirLeFichier, fichier: "polices.css" },
  { methode: "GET", chemin: "/api/pairs", servir: servirLesPairs },
  { methode: "GET", chemin: "/api/fil", servir: servirLeFil },
  { methode: "POST", chemin: "/api/poster", servir: servirPoster },
  { methode: "POST", chemin: "/api/accuser", servir: servirAccuser },
  { methode: "GET", chemin: "/api/evenements", servir: servirLesEvenements }
];

// ── LE RÉPARTITEUR — LE SEUL CHEMIN VERS UNE RÉPONSE ────────────────────────
//
// Il était INLINE dans le gestionnaire, et c'est ce qui l'a rendu invérifiable :
// une ligne insérée juste avant le `ROUTES.find` (mutation exécutée le 22/08 —
// `if (chemin === "/api/console") { repondreJson(res, 200, …); return; }`)
// servait une porte dérobée, et les quatre tests de la garde n°1 restaient
// verts. Ils comparaient une DÉCLARATION (la table) au contrat, puis sondaient
// quatorze chemins nommés à la main : un oracle de POINT, jamais de CLASSE.
//
// D'où cette fonction : PURE, exportée, sans `res`, sans `db`, sans effet. Le
// gestionnaire ne décide plus rien — il lui demande un verdict et l'exécute.
// Ce qu'on gagne : l'oracle peut la bombarder de dizaines de milliers de
// chemins quelconques et exiger « servi ⟺ dans la table »
// (test/web-repartiteur.test.js, voie ⓒ), ce qu'aucune liste de chemins
// interdits ne pourra jamais prouver, quelle que soit sa longueur.
//
// ⚠️ ET CE QU'IL REND EST UN VERDICT FRAPPÉ, pas un objet ordinaire. C'est la
// deuxième moitié du remède du 22/08 : le répartiteur ne se contente plus de
// DIRE ce qu'il faut servir, il est la seule source d'autorisation d'écrire
// pour tout ce qui vient de la table. Une ligne qui répondrait sans passer par
// lui n'a pas de verdict, donc pas de marque, donc pas d'écriture.
export function repartir(chemin, methode) {
  const route = ROUTES.find((ligne) => ligne.chemin === chemin && ligne.methode === methode);
  if (route) return verdict("route", { route });
  // Sur un chemin CONNU, une méthode hors table est un 405 qui NOMME ce qui est
  // permis : un 404 ferait croire que le chemin n'existe pas.
  const permises = ROUTES.filter((ligne) => ligne.chemin === chemin).map((ligne) => ligne.methode);
  if (permises.length === 0) return verdict("route-inconnue", { refus: 404, corps: { refus: "route-inconnue" } });
  return verdict("methode-refusee", {
    refus: 405,
    corps: { refus: "methode-refusee", permis: permises },
    entetes: { allow: permises.join(", ") }
  });
}

// ── GARDE N°1 ①-bis — LE CHEMIN JUGÉ EST LE CHEMIN ÉCRIT ────────────────────
//
// Ce que l'oracle de CLASSE du répartiteur ne fermait pas, et une sonde du
// 22/08 l'a montré en une ligne :
//
//     const chemin = cheminDemande(req.url).replace(/^\/x9\//, "/");
//
// TOUTE la porte servie sous un préfixe jetable, et les trois voies de
// `web-repartiteur.test.js` restent vertes — le préfixe n'est écrit nulle part
// en littéral (c'est une expression régulière), et aucun tirage ne le devine.
// Le répartiteur juge parfaitement bien : on lui donne simplement autre chose
// que ce que le client a demandé. Allonger le tirage ne ferme pas ça non plus,
// pas plus qu'une liste de chemins interdits ne fermait la classe précédente.
//
// LA FERMETURE EST STRUCTURELLE, PAS STATISTIQUE : la porte NOTE la cible que
// l'analyseur HTTP a lue, et refuse de servir une route qui ne serait pas
// exactement celle-là. Une réécriture — expression régulière, découpe,
// table de correspondance, `req.url = …` — ne peut plus produire un service :
// elle produit un 404, pour n'importe quel chemin, sans que personne ait eu à
// deviner lequel.
//
// POURQUOI UN AUDITEUR SÉPARÉ, ET POURQUOI LE PREMIER. `noterLaLigne` est
// posé sur `request` AVANT le gestionnaire : les auditeurs se déclenchent dans
// l'ordre où on les pose, donc rien de ce qui s'écrirait dans le gestionnaire
// ne peut teindre la référence — pas même une réassignation de `req.url`. Que
// le témoin soit bien le PREMIER est lui-même un fait vérifiable de
// l'extérieur (`serveur.listeners("request")[0]`), et il est vérifié.
//
// La cible notée est le CHEMIN, jamais la ligne brute : `?t=<jeton>` ne doit
// pas se retrouver rangé dans un coin de mémoire du processus.
const CIBLES_ECRITES = new WeakMap();

export function noterLaLigne(req) {
  CIBLES_ECRITES.set(req, { chemin: cheminDemande(req.url), methode: String(req.method ?? "") });
}

export function cibleEcrite(req) {
  return CIBLES_ECRITES.get(req) || null;
}

// « La route qu'on s'apprête à servir est-elle celle que le client a écrite ? »
// Sans témoin, la réponse est NON : une requête qui n'est pas passée par le
// premier auditeur n'a pas de référence, et on ne sert pas sans référence.
export function servirLaMemeCible(req, route) {
  const ecrite = cibleEcrite(req);
  if (!ecrite || !route) return false;
  return route.chemin === ecrite.chemin && route.methode === ecrite.methode;
}

// ── LE PIPELINE — TROIS FONCTIONS, ET AUCUNE NE FAIT LE TRAVAIL D'UNE AUTRE ──
//
// ⚠️ LA FORME DE `servirLeVerdict` ET DE `servirLaPanne` EST ASSERTÉE AU TEST,
// comme celle de `servirLaRequete` et du gestionnaire. Ce sont deux des CINQ
// MAILLONS de la chaîne qui va de l'événement `request` à la réponse, et ils
// sont comptés là-bas (ⓕ, test/web-repartiteur.test.js) — les cinq, avec la
// raison pour laquelle il n'y en a pas six. Reformater l'une de ces fonctions
// fait rougir la garde : c'est le prix d'une insertion visible, et il est voulu.
//
// ⚠️ LA DÉCISION NE TIENT JAMAIS LA RÉPONSE. `verdictDeLaRequete` reçoit `req`
// et `contexte`, JAMAIS `res` — et ce n'est pas de l'élégance, c'est la garde
// elle-même : une fonction qui ne tient pas la réponse ne peut pas répondre. La
// porte dérobée du 22/08 (`repondreJson(res, 200, …)` glissé avant `repartir`)
// n'a, ici, plus d'objet où écrire ; recopiée telle quelle, elle ne s'exécute
// même pas en ce point du fichier.
//
// Elle rend LE PREMIER verdict qui s'applique, dans l'ordre où la porte décide :
// la serrure, le marque-page, la table, la cible écrite.
export function verdictDeLaRequete(contexte, req) {
  // ① LA SERRURE, AVANT LE ROUTAGE : le refus doit être identique pour une
  //    route qui existe et une qui n'existe pas.
  const serrure = verdictDeLaPorte(req, contexte.jeton);
  if (!serrure.autorise) return verdict("serrure", { entetesDeSecurite: contexte.entetesDeSecurite });

  // ② L'URL PORTANTE NE RESTE PAS DANS LA BARRE. On ne redirige que les GET :
  //    une redirection sur un POST perdrait la lettre.
  if (serrure.origine === "query" && req.method === "GET") {
    return verdict("marque-page", {
      location: serrure.urlPropre || "/",
      cookie: cookieDuJeton(contexte.jeton),
      entetesDeSecurite: contexte.entetesDeSecurite
    });
  }

  // ③ LE ROUTAGE — LA TABLE, ET RIEN D'AUTRE. Le chemin est pris TEL QUEL
  //    (`cheminDemande`, auth.js) : ni normalisé, ni relu comme une URL.
  //    `new URL("//sonde/x", base)` lisait « //sonde » comme un HÔTE et rendait
  //    « /x » — `GET //sonde` servait donc la page entière depuis un chemin qui
  //    n'est dans aucune table, et `GET //%` faisait carrément lever la porte
  //    (500). Deux défauts trouvés par l'oracle du répartiteur, aucun des deux
  //    n'aurait pu figurer dans une liste de chemins interdits.
  const issue = repartir(cheminDemande(req.url), req.method);
  issue.entetesDeSecurite = contexte.entetesDeSecurite;
  if (!issue.route) return issue;

  // ③-bis ET LA ROUTE SERVIE EST CELLE QUE LE CLIENT A ÉCRITE. La comparaison
  //    ne porte pas sur le chemin lu ci-dessus (il serait juge et partie) mais
  //    sur ce que le PREMIER auditeur a noté de la ligne de requête. Un chemin
  //    réécrit entre l'analyseur HTTP et cette ligne ne sert donc plus rien : le
  //    client reçoit le 404 de tout le monde — même refus, même mot, aucune
  //    carte du produit.
  if (!servirLaMemeCible(req, issue.route)) {
    return verdict("cible-reecrite", {
      refus: 404,
      corps: { refus: "route-inconnue" },
      entetesDeSecurite: contexte.entetesDeSecurite
    });
  }
  // Le cookie sur une route SERVIE avec `?t=` (donc jamais un GET, redirigé
  // plus haut) : le marque-page se pose aussi sur un POST.
  if (serrure.origine === "query") issue.cookie = cookieDuJeton(contexte.jeton);
  return issue;
}

// L'EXÉCUTION. Elle ouvre la réponse (donc elle exige le verdict), puis elle
// exécute — elle ne décide rien.
export // ── LE MARQUE-PAGE, ET POURQUOI SA REDIRECTION PORTE UN TYPE ──────────────
//
// Un navigateur peut traiter une redirection sans `content-type` comme un
// fichier à télécharger lorsque `x-content-type-options: nosniff` lui interdit
// d'en deviner le type. Le `200 text/html` placé derrière ne répare rien : le
// navigateur ne l'atteint pas s'il interprète mal la première réponse.
//
// L'enseignement dépasse un navigateur précis : une réponse sans corps n'est
// pas une réponse sans type. Le verrou vérifie donc le `Location`, le cookie,
// le code ET le type réellement servi par la redirection.
function servirLeVerdict(contexte, req, res, rendu) {
  autoriserLaReponse(res, rendu);
  if (rendu.marque === "serrure") {
    refuserLEntree(res);
    return undefined;
  }
  if (rendu.marque === "marque-page") {
    // UN TYPE, MÊME SUR UNE REDIRECTION — l'encadré au-dessus dit pourquoi.
    const cible = /^\/[A-Za-z0-9_./-]*$/.test(String(rendu.location || ""))
      ? String(rendu.location)
      : "/";
    const corps = Buffer.from(
      "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">"
        + "<title>VALXOS Messenger</title>"
        + `<p>The door is open. <a href="${cible}">Enter</a>.</p>`,
      "utf8"
    );
    res.writeHead(302, {
      location: rendu.location,
      "set-cookie": rendu.cookie,
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-length": corps.length
    });
    res.end(corps);
    return undefined;
  }
  if (rendu.refus) {
    repondreJson(res, rendu.refus, rendu.corps, rendu.entetes);
    return undefined;
  }
  if (rendu.cookie) res.setHeader("set-cookie", rendu.cookie);
  return rendu.route.servir(contexte, req, res, rendu.route);
}

// La panne se dit, elle ne se déguise pas en 200 vide. Le message reste côté
// serveur : le client n'a pas à lire la trace d'une base. Et elle passe par un
// verdict comme tout le reste — une réponse sans marque n'existe pas, pas même
// celle-là.
export function servirLaPanne(res, erreur) {
  process.stderr.write(`web door: ${erreur?.stack || erreur}\n`);
  if (res.headersSent) {
    res.end();
    return undefined;
  }
  servirLeVerdict(null, null, res, verdict("panne", { refus: 500, corps: { refus: "panne-de-la-porte" } }));
  return undefined;
}

// ⚠️ SA FORME EST ASSERTÉE AU TEST DE LA GARDE, ET C'EST DÉLIBÉRÉ. Trois
// expressions, aucune décision : décider, servir, ou tomber. Une ligne ajoutée
// ici — la porte dérobée du 22/08 était exactement ça — change son texte, et le
// test la voit sans avoir eu à deviner quel chemin elle sert. Reformater cette
// fonction fait donc rougir la garde : c'est le prix, et il est voulu. Le
// gestionnaire posé sur `http.createServer` est, lui, une délégation NUE vers
// elle, et sa forme est assertée pour la même raison.
export function servirLaRequete(contexte, req, res) {
  return Promise.resolve()
    .then(() => servirLeVerdict(contexte, req, res, verdictDeLaRequete(contexte, req)))
    .catch((erreur) => servirLaPanne(res, erreur));
}

// Une boîte qui n'est pas au registre est une adresse que personne ne peut
// écrire : la fiche de l'opérateur est une lignée sans session, puisqu'il n'y
// a pas de harnais derrière.
function assurerLaBoiteDeLOperateur(db, operateur) {
  registerPeer(db, {
    id: operateur,
    description: "the web door: one door, one human",
    status: "active"
  });
}

// ⚠️ IL N'Y A QU'UN DOSSIER PUBLIC, ET IL N'EST PAS UN PARAMÈTRE (5e passe
// adverse). La porte prenait un `racinePublique` que personne ne passait,
// pendant que `ROUTES` — un `const` de module — énumérait les polices depuis
// `RACINE_PUBLIQUE` : annoncer un dossier, en servir un autre.
//
// LA FERMETURE VA DANS CE SENS-LÀ, ET C'EST UN CHOIX. L'autre voie (construire
// la table ici, depuis la racine reçue) rendrait la table PROPRE À CHAQUE
// PORTE — or toute la garde n°1 est ancrée sur ce `ROUTES` de module : ses
// trois fichiers de test (celui de la garde, celui du répartiteur, celui du
// chemin écrit) le lisent directement. La table réellement servie passerait
// donc hors de portée de la garde : on échangerait un défaut latent contre un
// vrai trou, et c'est exactement l'écart déclaration/effet qui a déjà coûté
// une mutation ici. Un second dossier public n'a par ailleurs aucune raison
// produit — il y a une page, livrée avec le code.
export function creerLaPorte({
  db,
  jeton,
  operateur,
  periodeMs = 1000,
  poserIntervalle = setInterval,
  retirerIntervalle = clearInterval,
  plafondDeFlux = PLAFOND_DE_FLUX,
  // L'horloge est un PARAMÈTRE pour la même raison que le poseur d'intervalle :
  // un test qui attendrait vraiment trois battements est un test qu'on saute.
  horloge = Date.now,
  periodeDuBattementMs = PERIODE_DU_BATTEMENT_MS,
  delaiDeSilenceMs = DELAI_DE_SILENCE_MS,
  cadreAutorise = []
} = {}) {
  if (!db) throw new Error("the web door requires a post office that is already open (db)");
  if (!jeton) throw new Error("the web door requires a token: without a lock there is no door");
  if (!validateAgentId(operateur)) {
    throw new Error("the web door requires a valid operator name, set at startup");
  }
  assurerLaBoiteDeLOperateur(db, operateur);

  const contexte = {
    db,
    jeton,
    operateur,
    periodeMs,
    poserIntervalle,
    retirerIntervalle,
    plafondDeFlux,
    horloge,
    periodeDuBattementMs,
    delaiDeSilenceMs,
    entetesDeSecurite: entetesDeSecurite(cadreAutorise),
    flux: new Set(),
    minuteurs: new Set()
  };

  const serveur = http.createServer();

  // ⚠️ ON NE POSE AUCUN AUTRE AUDITEUR SUR CE SERVEUR, ET C'EST UNE RÈGLE.
  // `upgrade`, `clientError`, `connect`, `checkContinue`, `checkExpectation`,
  // `dropRequest` : chacun remet au gestionnaire de quoi ÉCRIRE — une réponse
  // ou la socket nue — SANS passer par le répartiteur. Un `clientError` ajouté
  // pour taire un bruit de log est le réflexe le plus ordinaire du monde, et
  // c'est une deuxième porte. La liste des auditeurs réellement posés est
  // fermée et comparée à un `http.Server` nu au test (ⓔ) : le jour où on en
  // ajoute un, il rougit.
  //
  // ⚠️ LE TÉMOIN DE LA CIBLE EST LE PREMIER AUDITEUR, ET C'EST TOUTE LA GARDE
  // ①-bis : il note ce que l'analyseur HTTP a lu avant qu'une seule ligne du
  // gestionnaire ne s'exécute. Poser le gestionnaire d'abord rendrait la
  // référence teignable, et la garde décorative.
  serveur.on("request", noterLaLigne);

  // ⚠️ LE GESTIONNAIRE EST UNE DÉLÉGATION NUE, ET SA FORME EST ASSERTÉE AU TEST
  // DE LA GARDE. Ce n'était pas le cas jusqu'au 22/08 : il portait soixante
  // lignes de décisions, et une ligne de plus au bon endroit servait une porte
  // dérobée sans faire rougir aucun des sept tests (mesuré, 598 pass / 0 fail).
  // Il ne décide plus rien, il ne peut plus rien décider, et le jour où on
  // écrira une décision ici, la garde le dira — sans avoir eu à deviner
  // laquelle.
  serveur.on("request", (req, res) => servirLaRequete(contexte, req, res));

  async function fermer() {
    // Les flux ouverts tiennent la connexion : sans ce geste, `close()`
    // attendrait un onglet qui ne se fermera jamais.
    for (const flux of [...contexte.flux]) {
      flux.fermer();
      flux.res.end();
    }
    // Et ceux que personne n'a retirés (une fermeture qu'on aurait manquée) :
    // aucune scrutation ne survit à la porte.
    for (const minuteur of [...contexte.minuteurs]) {
      contexte.retirerIntervalle(minuteur);
      contexte.minuteurs.delete(minuteur);
    }
    await new Promise((resolve) => {
      serveur.close(resolve);
      serveur.closeAllConnections?.();
    });
  }

  return { serveur, contexte, fluxOuverts: () => contexte.flux.size, fermer };
}

export async function ouvrirLaPorte({ hote = "127.0.0.1", port = 8790, ...reste } = {}) {
  // ⚠️ L'HÔTE SE VÉRIFIE AVANT TOUT LE RESTE — avant même d'ouvrir le bureau.
  // Même leçon que le démon sous garde : un refus qui laisse
  // le disque déjà touché n'est qu'un demi-refus.
  verifierLHote(hote);
  const porte = creerLaPorte(reste);
  await new Promise((resolve, reject) => {
    const echec = (erreur) => reject(erreur);
    porte.serveur.once("error", echec);
    porte.serveur.listen(port, hote, () => {
      porte.serveur.off("error", echec);
      resolve();
    });
  });
  return { ...porte, adresse: porte.serveur.address() };
}
