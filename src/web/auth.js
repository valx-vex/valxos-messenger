// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA SERRURE DE LA PORTE WEB — le jeton, la comparaison, le cookie.
//
// Pourquoi un COOKIE et pas un en-tête : `EventSource` (le SSE du navigateur)
// ne sait pas poser d'en-tête `Authorization`. Sans cookie, il n'y a pas de
// flux authentifié du tout. Ce n'est pas un choix de confort.
//
// Pourquoi le jeton passe une PREMIÈRE fois dans l'URL (`?t=`) : le marque-page
// doit pouvoir amorcer une session sans écran de mot de passe. Le prix
// est réel — l'URL entre dans l'historique du navigateur. Les atténuations
// retenues au contrat : la porte n'écoute que la boucle locale (personne
// d'autre ne peut l'atteindre), le jeton ne sert QU'à cette porte, et le
// serveur REDIRIGE vers l'URL propre dès que le cookie est posé, pour que
// l'URL portante ne reste pas dans la barre.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { baseDir, validateAgentId } from "../lib/config.js";

export const NOM_DU_COOKIE = "cc2cc_porte";
// Trente jours : le marque-page ne doit pas mourir entre deux semaines sans
// courrier. Le contrat le fixe, il ne se devine pas ici.
export const DUREE_DU_COOKIE_S = 30 * 24 * 3600;
export const CLEF_DU_JETON = "VALXOS_WEB_JETON";
export const CLEF_HISTORIQUE_DU_JETON = "CC2CC_WEB_JETON";
export const NOM_DU_FICHIER = "web.env";

export function jetonNeuf() {
  return crypto.randomBytes(32).toString("hex");
}

// ── LA COMPARAISON ──────────────────────────────────────────────────────────
//
// ⚠️ LE PIÈGE CLASSIQUE, ET IL EST ICI : `crypto.timingSafeEqual` LÈVE sur deux
// tampons de tailles différentes. Un jeton plus court que le vrai ne rend donc
// pas « faux » quand on compare brut — il fait tomber le gestionnaire, et la
// porte répond 500 (ou meurt) là où elle devait répondre 401. Un attaquant
// distingue alors « mauvaise longueur » de « mauvais jeton » rien qu'au code
// de retour, ce qui est exactement la fuite que la comparaison à temps
// constant existe pour fermer.
//
// La normalisation de longueur passe par une empreinte : deux SHA-256 font
// toujours 32 octets, quelle que soit la longueur des jetons. Elle normalise
// ET ne laisse rien filtrer de la taille du jeton proposé.
export function jetonsEgaux(propose, attendu) {
  const attenduTexte = String(attendu ?? "");
  // Une porte sans serrure n'est pas une porte ouverte : sans jeton attendu,
  // rien ne passe. Sinon un `web.env` vide rendrait la boîte de l'opérateur
  // lisible par n'importe quelle requête.
  if (attenduTexte.length === 0) return false;
  const empreinte = (valeur) => crypto.createHash("sha256").update(String(valeur ?? ""), "utf8").digest();
  return crypto.timingSafeEqual(empreinte(propose), empreinte(attenduTexte));
}

// Pas de `Secure` : la porte est servie en clair sur la boucle locale. Poser
// `Secure` ferait SILENCIEUSEMENT tomber le cookie lorsqu'un accès local sert
// en http — un cookie qu'on croit posé et qui ne l'est pas est pire qu'un
// cookie qu'on sait absent.
export function cookieDuJeton(jeton) {
  return `${NOM_DU_COOKIE}=${jeton}; Path=/; Max-Age=${DUREE_DU_COOKIE_S}; HttpOnly; SameSite=Strict`;
}

export function lireLeCookie(entete, nom = NOM_DU_COOKIE) {
  for (const morceau of String(entete || "").split(";")) {
    const coupe = morceau.indexOf("=");
    if (coupe < 0) continue;
    if (morceau.slice(0, coupe).trim() === nom) return morceau.slice(coupe + 1).trim();
  }
  return null;
}

// Le verdict, et de quoi rédiger la réponse : `origine` dit par où le jeton est
// arrivé (c'est ce qui décide de poser le cookie), `urlPropre` est l'URL sans
// le paramètre portant.
//
// Un `?t=` FAUX ne condamne pas une session déjà ouverte : on retombe sur le
// cookie. Un vieux marque-page (jeton tourné) ne doit pas déconnecter la page
// qui fonctionne.
// LA CIBLE DE LA REQUÊTE, DÉCOUPÉE SANS PIÈGE (trouvé par l'oracle du
// répartiteur, 22/08 — deux défauts d'un coup, aucun n'était dans une liste) :
//   • `new URL("//sonde/x", base)` lit « //sonde » comme un HÔTE et rend le
//     chemin « /x » : `GET //sonde` était donc servi comme `/`, la page
//     entière, sur un chemin qui n'est dans aucune table ;
//   • `new URL("//%", base)` JETTE, et la porte répondait 500 à une ligne de
//     requête tordue — une panne là où il fallait un 404.
// La forme ABSOLUE (l'hôte collé devant, jamais une base) ferme les deux : le
// chemin reste ce que le client a écrit, `//` compris.
export function cibleDeLaRequete(brut) {
  const ecrit = String(brut || "/");
  try {
    return new URL(`http://porte.invalide${ecrit.startsWith("/") ? ecrit : `/${ecrit}`}`);
  } catch {
    // Une cible qu'on ne sait pas lire n'est pas une panne : c'est une requête
    // qui n'ira nulle part. On rend une cible morte, le routage fera un 404.
    return new URL("http://porte.invalide/");
  }
}

// LE CHEMIN QUE LE ROUTAGE COMPARE À SA TABLE — pris TEL QUEL dans la ligne de
// requête, jamais normalisé. `URL` sait replier `//..` en `/` (c'est la norme,
// et c'est le travail du NAVIGATEUR avant l'envoi) : la porte, elle, n'a pas à
// deviner ce qu'un client voulait dire. `GET //..` servait la page entière sur
// un chemin absent de toute table ; il fait maintenant 404, comme tout le
// reste. Ce que la table dit, mot pour mot, et rien d'autre.
export function cheminDemande(brut) {
  const ecrit = String(brut || "/");
  const coupe = ecrit.search(/[?#]/);
  return coupe < 0 ? ecrit : ecrit.slice(0, coupe);
}

export function verdictDeLaPorte(req, jetonAttendu) {
  // L'hôte est factice : on ne se sert de `URL` que pour découper le chemin et
  // la requête, jamais pour joindre quoi que ce soit.
  const url = cibleDeLaRequete(req.url);
  const duQuery = url.searchParams.get("t");
  if (duQuery !== null && jetonsEgaux(duQuery, jetonAttendu)) {
    url.searchParams.delete("t");
    // ⚠️ UN `Location` QUI COMMENCE PAR `//` EST UNE REDIRECTION VERS UN AUTRE
    // HÔTE, pas vers une page de la porte (`//evil.tld` est une URL entière
    // pour un navigateur). Le chemin est rendu TEL QUEL par le découpage
    // ci-dessus — c'est bien ce qu'on veut pour le routage, et c'est
    // exactement ce qu'il ne faut pas renvoyer dans un en-tête de redirection.
    const propre = url.pathname.startsWith("//") ? "/" : url.pathname;
    return { autorise: true, origine: "query", urlPropre: `${propre}${url.search}` };
  }
  const duCookie = lireLeCookie(req.headers?.cookie);
  if (duCookie !== null && jetonsEgaux(duCookie, jetonAttendu)) {
    return { autorise: true, origine: "cookie", urlPropre: null };
  }
  return { autorise: false, origine: null, urlPropre: null };
}

export function fichierDuJeton() {
  return path.join(baseDir(), NOM_DU_FICHIER);
}

function lireWebEnv(fichier) {
  let texte;
  try {
    texte = fs.readFileSync(fichier, "utf8");
  } catch {
    // Absent, illisible : ce n'est pas une panne, c'est une première fois.
    return {};
  }
  const valeurs = {};
  for (const ligne of texte.split("\n")) {
    const propre = ligne.trim();
    if (!propre || propre.startsWith("#")) continue;
    const coupe = propre.indexOf("=");
    if (coupe < 0) continue;
    valeurs[propre.slice(0, coupe).trim()] = propre.slice(coupe + 1).trim();
  }
  return valeurs;
}

function jetonDuFichier(fichier) {
  const valeurs = lireWebEnv(fichier);
  const clefLue = Object.hasOwn(valeurs, CLEF_DU_JETON) ? CLEF_DU_JETON : CLEF_HISTORIQUE_DU_JETON;
  return String(valeurs[clefLue] || "").trim();
}

// ── LE MINT : SÉRIALISÉ, ATOMIQUE, ET IL REND CE QUI EST PERSISTÉ ───────────
//
// Re-verdict de la revue adverse sur rc2 (29/08) : la fusion était juste, l'écriture ne
// l'était pas. Un `writeFileSync` nu tronque `web.env` si le processus meurt
// à mi-course — le fichier même que la fusion venait d'apprendre à ne pas
// effacer — et deux mints concurrents sur un fichier frais rendaient deux
// jetons, dont un que le fichier ne connaissait pas (24/40 à la revue adverse). Trois
// gestes ferment ça, et ils se lisent dans l'ordre :
//   ① un VERROU (`web.env.lock`, ouvert en `wx`) sérialise les mints. Il
//      porte le pid de son tenant : un verrou dont le tenant est mort, ou
//      trop vieux, est balayé — jamais attendu pour toujours. L'attente est
//      bornée, et son dépassement se NOMME plutôt que de deviner un jeton.
//   ② l'écriture passe par un fichier temporaire du même dossier (0600),
//      fsync, puis `rename` : `web.env` est toujours l'ancien ou le nouveau
//      en entier, jamais un morceau.
//   ③ le mint RELIT le fichier après le rename et rend ce qu'il y trouve :
//      un appelant ne reçoit jamais un jeton que le fichier ne connaît pas.
//
// ⚠️ LE VOL D'UN VERROU PÉRIMÉ EST LUI-MÊME UNE COURSE (rev-t7, 29/08, HAUT).
// Deux attendeurs jugent le même verrou périmé ; le premier le renomme, le
// balaie et en prend un NEUF ; le second, déjà sorti de son verdict, renomme
// CE verrou neuf, le balaie et prend le sien : les deux mintent ensemble, et
// à sa sortie le premier efface le verrou du second, qui à sa sortie efface
// celui du suivant — la cascade mesurée à 24/40. Le remède : le vol se fait
// SOUS un second verrou (`web.env.lock.vol`), le verdict de péremption se
// REVÉRIFIE sous lui, et la reprise du verrou principal se fait encore sous
// lui. Un attendeur qui n'a pas le verrou de vol ne renomme rien.
//
// Ce qui RESTE ouvert, et il faut le dire — deux familles, nommées :
//   • le verrou de vol se vole, lui, sans sérialisation (il n'y a pas de
//     troisième étage). Il faut pour ça qu'un voleur soit mort DANS sa section
//     (des microsecondes), puis que deux voleurs se disputent son verrou
//     orphelin dans la même fenêtre ;
//   • un tenant VIVANT mais SUSPENDU plus de VERROU_PERIME_MS (SIGSTOP, un
//     débogueur, la machine en veille) : son verrou est jugé périmé par l'âge
//     et balayé — `balayerLeVerrou` renomme sans comparer l'inode jugé périmé,
//     et comparer ne changerait rien, c'est la règle de l'âge qui tranche. Le
//     tenant reprend et finit son mint sur un verrou qui n'est plus le sien,
//     en même temps qu'un voleur légitime. Sa remise n'efface rien (l'inode,
//     ci-dessous), chaque écriture reste entière (temporaire + rename), et
//     chacun rend ce que le fichier porte À SON instant — mais l'un des deux
//     appelants tient alors un jeton que le fichier a remplacé.
// Ni l'un ni l'autre n'est fermé ; ils sont nommés.
export const ATTENTE_DU_VERROU_MS = 5000;
// Un mint dure des millisecondes : un verrou plus vieux que ça n'a plus de
// tenant, quoi qu'en dise son pid (un numéro se recycle).
const VERROU_PERIME_MS = 30_000;
// Le vol dure des microsecondes : quatre ordres de grandeur de marge.
const VOL_PERIME_MS = 10_000;

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Périmé = tenant mort (ESRCH), ou plus vieux que `perimeMs` quoi qu'en dise
// son pid. Un verrou disparu entre-temps n'est pas périmé : on réessaie.
function verrouPerime(verrou, perimeMs) {
  let pid = NaN;
  let age = 0;
  try {
    pid = Number(fs.readFileSync(verrou, "utf8").trim());
    age = Date.now() - fs.statSync(verrou).mtimeMs;
  } catch {
    return false;
  }
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(pid, 0);
      return age > perimeMs; // vivant : périmé seulement par l'âge
    } catch (e) {
      if (e.code === "EPERM") return age > perimeMs; // vivant, mais pas à nous
      return true; // ESRCH : le tenant est mort
    }
  }
  // Pas de pid lisible (verrou en cours de pose, ou abîmé) : par l'âge seul.
  return age > perimeMs;
}

// Un essai de prise : le fichier naît en `wx` (atomique), porte notre pid, et
// on retient son inode — c'est lui qui prouvera, à la remise, que le verrou
// est toujours le nôtre. Une exception entre la naissance et l'écriture du pid
// efface ce qu'on vient de créer : un verrou vide et orphelin ferait attendre
// tout le monde jusqu'à sa péremption par l'âge.
function tenterLeVerrou(chemin) {
  let fd;
  try {
    fd = fs.openSync(chemin, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST") return null;
    throw e;
  }
  try {
    fs.writeSync(fd, `${process.pid}\n`);
    const { ino } = fs.fstatSync(fd);
    fs.closeSync(fd);
    return { ino };
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* déjà fermé */ }
    try { fs.unlinkSync(chemin); } catch { /* déjà parti */ }
    throw e;
  }
}

// La remise est CONDITIONNELLE : on n'efface que le verrou dont l'inode est
// celui qu'on a créé. Si le nôtre a été jugé périmé et volé (nous aurions
// tenu plus de VERROU_PERIME_MS), ce qui porte ce nom est celui d'un voleur
// légitime, et l'effacer relancerait la cascade.
function rendreLeVerrou(chemin, ino) {
  try {
    if (fs.statSync(chemin).ino === ino) fs.unlinkSync(chemin);
  } catch { /* déjà parti */ }
}

// Balayer un verrou jugé périmé : rename vers un nom unique, puis unlink. Le
// rename ne se fait JAMAIS hors du verrou de vol pour le verrou principal.
// Il ne compare pas l'inode jugé périmé à celui qu'il renomme : sous le
// verrou de vol, seul un tenant VIVANT et SUSPENDU (voir « ce qui reste
// ouvert », en tête) pourrait encore réclamer ce fichier, et c'est la règle
// de l'âge qui l'a déjà tranché — comparer ne l'aurait pas sauvé.
function balayerLeVerrou(chemin) {
  const ecarte = `${chemin}.perime.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(chemin, ecarte);
    fs.unlinkSync(ecarte);
  } catch { /* déjà balayé, ou rendu par son tenant */ }
}

function prendreLeVerrouDuMint(fichier, attenteMaxMs) {
  const verrou = `${fichier}.lock`;
  const vol = `${verrou}.vol`;
  const limite = Date.now() + attenteMaxMs;
  for (;;) {
    const pris = tenterLeVerrou(verrou);
    if (pris) return () => rendreLeVerrou(verrou, pris.ino);

    if (verrouPerime(verrou, VERROU_PERIME_MS)) {
      const prisLeVol = tenterLeVerrou(vol);
      if (prisLeVol) {
        try {
          // Sous le verrou de vol, le verdict se REVÉRIFIE : entre notre
          // premier regard et celui-ci, un autre voleur a pu balayer le
          // verrou périmé et en poser un neuf, bien vivant.
          if (verrouPerime(verrou, VERROU_PERIME_MS)) balayerLeVerrou(verrou);
          const repris = tenterLeVerrou(verrou);
          if (repris) return () => rendreLeVerrou(verrou, repris.ino);
        } finally {
          rendreLeVerrou(vol, prisLeVol.ino);
        }
      } else if (verrouPerime(vol, VOL_PERIME_MS)) {
        balayerLeVerrou(vol); // le voleur est mort dans sa section : on réessaie
        continue;
      }
      // Sinon un autre voleur est à l'œuvre : on attend son verdict.
    }
    if (Date.now() >= limite) {
      throw new Error(
        `the mint lock (${verrou}) has been held for more than ${attenteMaxMs} ms: ` +
          "the door does not guess a token, it refuses."
      );
    }
    dormir(10);
  }
}

function ecrireDUnSeulCoup(fichier, contenu) {
  const temporaire = path.join(
    path.dirname(fichier),
    `.${path.basename(fichier)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  const fd = fs.openSync(temporaire, "wx", 0o600);
  try {
    fs.writeSync(fd, contenu);
    // `openSync({mode})` ne s'applique qu'à la CRÉATION et subit l'umask : le
    // fchmod derrière n'est pas une redondance, c'est ce qui garantit 0600.
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(temporaire, fichier);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* déjà fermé */ }
    try { fs.unlinkSync(temporaire); } catch { /* déjà renommé ou jamais posé */ }
    throw e;
  }
}

// `web.env` peut être un LIEN — un opérateur qui garde les réglages de la
// porte ailleurs. Le verrou, le temporaire et le rename visent la cible
// RÉELLE : un rename sur le lien le remplaçait par un fichier ordinaire, et
// les réglages gardés ailleurs sortaient du champ de la porte au lancement
// suivant (rev-t7, B7). Un lien PENDANT (la cible n'existe pas encore, une
// installation fraîche) est suivi à la main : le fichier naît au bout.
function cibleReelle(fichier) {
  try {
    return fs.realpathSync(fichier);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let chemin = fichier;
  for (let saut = 0; saut < 8; saut += 1) {
    let etat;
    try {
      etat = fs.lstatSync(chemin);
    } catch {
      break; // absent : c'est ici qu'il naîtra
    }
    if (!etat.isSymbolicLink()) break;
    chemin = path.resolve(path.dirname(chemin), fs.readlinkSync(chemin));
  }
  let parent = path.dirname(chemin);
  try {
    parent = fs.realpathSync(parent);
  } catch { /* le parent naîtra avec le mkdir */ }
  return path.join(parent, path.basename(chemin));
}

// UN `web.env` QUI PORTE LE JETON NE SE LIT PAS PAR UN AUTRE COMPTE (J3, jury, 18/10).
// Le mint écrit 0600 ; un `web.env` fait À LA MAIN (le README en fait l'endroit du nom de
// l'opérateur) naît 0644 sous l'umask, et le jeton — le seul secret de la porte — était
// rendu tel quel, lisible par tout compte local. À la lecture d'un fichier qui porte un
// jeton, un mode qui accorde le MOINDRE bit de groupe ou d'autre est ramené à 0600, et UNE
// ligne sur stderr le dit — une fois, puisque la lecture suivante trouve 0600. Elle ne
// montre jamais le jeton. Un chmod qui échoue (fichier d'un autre compte, système de
// fichiers sans modes) ne ferme pas la porte : la ligne dit qu'elle n'a pas pu, et pourquoi.
// `statSync` et `chmodSync` suivent un lien : c'est le fichier RÉEL qui est resserré.
function resserrerLeFichierDuJeton(fichier) {
  if (process.platform === "win32") return; // pas de modes POSIX
  let mode;
  try {
    mode = fs.statSync(fichier).mode & 0o777;
  } catch {
    return; // lu avec succès l'instant d'avant : rien de fiable à resserrer
  }
  if ((mode & 0o077) === 0) return;
  const avant = mode.toString(8);
  try {
    fs.chmodSync(fichier, 0o600);
    process.stderr.write(
      `VALXOS Messenger: ${fichier} holds the web door token and was readable by other accounts (mode ${avant}); changed to 600.\n`
    );
  } catch (erreur) {
    process.stderr.write(
      `VALXOS Messenger: ${fichier} holds the web door token and is readable by other accounts (mode ${avant}); ` +
        `it could not be changed to 600 (${erreur?.code || erreur?.message}).\n`
    );
  }
}

// Le jeton du lanceur. L'ordre compte : l'ENV d'abord (le geste d'opérateur
// délibéré, et ce qui permet de tourner le jeton sans toucher au fichier),
// puis `web.env`, et sinon on en pose un — sous verrou, d'un seul coup, et on
// rend ce que le fichier porte.
export function chargerLeJeton({ fichier = fichierDuJeton(), env = process.env, attenteMaxMs = ATTENTE_DU_VERROU_MS } = {}) {
  const clefDeclaree = Object.hasOwn(env, CLEF_DU_JETON) ? CLEF_DU_JETON : CLEF_HISTORIQUE_DU_JETON;
  const declare = String(env[clefDeclaree] || "").trim();
  if (declare) return declare;
  const lu = jetonDuFichier(fichier);
  if (lu) {
    resserrerLeFichierDuJeton(fichier);
    return lu;
  }
  const reel = cibleReelle(fichier);
  fs.mkdirSync(path.dirname(reel), { recursive: true, mode: 0o700 });
  const rendreLeVerrou = prendreLeVerrouDuMint(reel, attenteMaxMs);
  try {
    // Sous le verrou, on RELIT : un mint concurrent a pu poser un jeton
    // pendant l'attente, et c'est le sien que le fichier connaît.
    const poseEntreTemps = jetonDuFichier(reel);
    if (poseEntreTemps) return poseEntreTemps;
    const neuf = jetonNeuf();
    // Minting MERGES into web.env, it never truncates it: the same file carries
    // the mandatory operator and the frame list. A truncate erased them and the
    // door refused to start on its next launch (adversarial review, 2026-08-26).
    let existant = "";
    try {
      existant = fs.readFileSync(reel, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const gardees = existant.split("\n").filter((ligne) => {
      const propre = ligne.trim();
      if (!propre) return false;
      const clef = propre.slice(0, propre.indexOf("=") < 0 ? propre.length : propre.indexOf("=")).trim();
      return clef !== CLEF_DU_JETON && clef !== CLEF_HISTORIQUE_DU_JETON;
    });
    ecrireDUnSeulCoup(reel, gardees.concat([`${CLEF_DU_JETON}=${neuf}`]).join("\n") + "\n");
    const persiste = jetonDuFichier(reel);
    if (!persiste) {
      throw new Error(`the token was just written to ${reel} and does not read back: the door does not guess.`);
    }
    return persiste;
  } finally {
    rendreLeVerrou();
  }
}

// ── TOUTE LA CONFIGURATION DE LA PORTE, AU MÊME ENDROIT ─────────────────────
//
// `web.env` est le seul endroit prévu pour régler la porte, et le lanceur n'y
// lisait QUE le jeton : l'hôte et le port venaient de l'ENV du shell, et de
// nulle part ailleurs. Sonde du 22/08 — un `web.env` portant
// `VALXOS_WEB_PORT=9911` : le lanceur annonçait toujours 8790. Un opérateur qui
// change le port dans le fichier PRÉVU pour ça voyait la porte l'ignorer, sans
// un mot. Le silence était le vrai défaut : ou le fichier gouverne, ou il ne
// déclare pas ces clefs. Il gouverne.
//
// L'ordre ne change pas — c'est celui du jeton, et pour la même raison : l'ENV
// d'abord (le geste d'opérateur délibéré, celui qui permet d'ouvrir une
// deuxième porte sans toucher au fichier), le fichier ensuite, le défaut en
// dernier.
export const CLEF_DE_L_HOTE = "VALXOS_WEB_HOTE";
export const CLEF_HISTORIQUE_DE_L_HOTE = "CC2CC_WEB_HOTE";
export const CLEF_DU_PORT = "VALXOS_WEB_PORT";
export const CLEF_HISTORIQUE_DU_PORT = "CC2CC_WEB_PORT";
export const CLEF_DE_L_OPERATEUR = "VALXOS_WEB_OPERATEUR";
export const CLEF_HISTORIQUE_DE_L_OPERATEUR = "CC2CC_WEB_OPERATEUR";
export const CLEF_DU_CADRE_AUTORISE = "VALXOS_WEB_CADRE_AUTORISE";
export const CLEF_HISTORIQUE_DU_CADRE_AUTORISE = "CC2CC_WEB_CADRE_AUTORISE";
export const HOTE_PAR_DEFAUT = "127.0.0.1";
export const PORT_PAR_DEFAUT = 8790;

// Une origine de cadrage entre telle quelle dans une directive CSP : sa
// validation est donc une frontière de syntaxe, pas une correction aimable.
// Au premier doute, toute la liste tombe. Il n'existe pas de moitié sûre d'une
// directive qui contenait aussi une entrée hostile.
export function originesDeCadrage(valeur) {
  const ecrit = Array.isArray(valeur) ? valeur.join(" ") : String(valeur ?? "");
  if (!ecrit.trim()) return [];

  // Les espaces ASCII séparent les origines. Tout autre blanc est soit un
  // contrôle, soit une ambiguïté qui ne doit jamais voyager jusqu'à l'en-tête.
  if (/[\u0000-\u001f\u007f;]/u.test(ecrit) || /[^\S ]/u.test(ecrit) || ecrit.includes("*")) return [];

  const origines = ecrit.trim().split(/ +/u);
  for (const origine of origines) {
    if (origine === "null" || origine === "'self'") return [];
    // Rien après l'autorité : ni chemin, ni requête, ni fragment. La barre
    // oblique que `URL` ajoute implicitement ne vient jamais de la donnée.
    if (!/^https?:\/\/[^/?#]+$/iu.test(origine)) return [];
    try {
      const url = new URL(origine);
      if (!["http:", "https:"].includes(url.protocol)) return [];
      if (!url.hostname || url.username || url.password) return [];
      if (url.pathname !== "/" || url.search || url.hash) return [];
      if (origine.endsWith(":")) return [];
    } catch {
      return [];
    }
  }
  return origines;
}

// ⚠️ LES RÉGLAGES SE LISENT SANS RIEN ÉCRIRE, et c'est le point : le lanceur
// doit pouvoir VÉRIFIER L'HÔTE avant que le moindre octet ne touche le disque
// (même leçon que le démon sous garde — un refus qui laisse
// le disque déjà touché n'est qu'un demi-refus). `chargerLeJeton`, lui, POSE
// un fichier quand il n'y en a pas : il ne peut donc pas venir en premier.
export function reglagesDeLaPorte({ fichier = fichierDuJeton(), env = process.env } = {}) {
  const duFichier = lireWebEnv(fichier);
  const lire = (clef, clefHistorique) => {
    for (const source of [env, duFichier]) {
      const choisie = Object.hasOwn(source, clef) ? clef : clefHistorique;
      const valeur = String(source[choisie] ?? "").trim();
      if (valeur) return valeur;
    }
    return "";
  };

  const portEcrit = lire(CLEF_DU_PORT, CLEF_HISTORIQUE_DU_PORT);
  // ⚠️ UN PORT ILLISIBLE NE DEVIENT PAS ZÉRO EN SILENCE. `Number("neuf")` rend
  // NaN et `listen(NaN)` prend un port au hasard : la porte s'ouvrirait
  // quelque part, l'annonce dirait autre chose que ce que l'opérateur a écrit,
  // et le marque-page ne la retrouverait plus. On refuse en nommant.
  let port = PORT_PAR_DEFAUT;
  if (portEcrit) {
    port = Number(portEcrit);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(`${CLEF_DU_PORT} = "${portEcrit}" is not a port: the door does not guess where to open.`);
    }
  }

  const operateur = lire(CLEF_DE_L_OPERATEUR, CLEF_HISTORIQUE_DE_L_OPERATEUR);
  if (!operateur) {
    throw new Error(
      `the door refuses to start without an operator name: set ${CLEF_DE_L_OPERATEUR} ` +
        `(or its alias ${CLEF_HISTORIQUE_DE_L_OPERATEUR}) in web.env or in the environment.`
    );
  }
  if (!validateAgentId(operateur)) {
    throw new Error(
      `${CLEF_DE_L_OPERATEUR} = "${operateur}" is not an acceptable name ` +
        `(letters, digits, dot, hyphen or underscore; 64 characters at most).`
    );
  }

  return {
    hote: lire(CLEF_DE_L_HOTE, CLEF_HISTORIQUE_DE_L_HOTE) || HOTE_PAR_DEFAUT,
    port,
    operateur,
    cadreAutorise: originesDeCadrage(lire(CLEF_DU_CADRE_AUTORISE, CLEF_HISTORIQUE_DU_CADRE_AUTORISE))
  };
}

// Les réglages ET le jeton, pour qui veut tout d'un coup. `chargerLeJeton`
// garde SA loi (il en pose un quand il n'y en a pas, en 0600) : on l'appelle,
// on ne la recopie pas.
export function configDeLaPorte({ fichier = fichierDuJeton(), env = process.env } = {}) {
  return { ...reglagesDeLaPorte({ fichier, env }), jeton: chargerLeJeton({ fichier, env }) };
}
