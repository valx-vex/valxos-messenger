// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { garderLEcritureDuBureau, getCopiesPourChaise, getPeerBySessionId, registerPeer } from "./database.js";
import {
  appendLog,
  hostnameFallback,
  maisonsConnues,
  normalizeAgentId,
  runtimePaths,
  safeAgentFileName,
  valeurDeLEnvironnement
} from "./config.js";
// Lecture seule, et rien d'autre : `readMailboxEntry` regarde la fiche avant de
// l'ouvrir (nature, poids) et n'ouvre AUCUNE porte. Aucune sonde n'est faite
// ici — un hook doit rendre la main tout de suite.
import { procStartOf, readMailboxEntry, sessionsDir } from "./postbox.js";
import {
  SEPARATEUR_SESSION,
  chaiseTenanteDeLaLignee,
  deciderLaCopie,
  getInstanceBySession,
  instanceId,
  listerAnciensNoms,
  registerInstance,
  resolveRecipient,
  verdictDeChaise
} from "./registry.js";

export function resolveSelfId(db, hookInput = {}) {
  const explicit = normalizeAgentId(valeurDeLEnvironnement(process.env, "CC2CC_SELF"));
  if (explicit) return explicit;

  const sessionName = normalizeAgentId(valeurDeLEnvironnement(process.env, "CC2CC_SESSION_NAME"));
  if (sessionName) return sessionName;

  // Ce qu'on cherche ici est un nom de LIGNÉE, jamais un nom de chaise. Rendre
  // l'identifiant d'une instance ferait empiler le suffixe à chaque hook
  // (`nom#sess#sess#sess`) et le canal de repli irait chercher le courrier sous
  // un nom que personne n'écrit jamais.
  const sessionId = hookInput.session_id || hookInput.sessionId;
  const peer = getPeerBySessionId(db, sessionId);
  if (peer?.lineage || peer?.id) return peer.lineage || peer.id;

  const cwd = hookInput.cwd || hookInput.workspace || process.cwd();
  if (cwd) {
    const row = db
      .prepare("SELECT * FROM peers WHERE project_path = ? ORDER BY last_seen DESC LIMIT 1")
      .get(cwd);
    if (row?.lineage || row?.id) return row.lineage || row.id;
  }

  return hostnameFallback();
}

// La maison d'où l'on parle. Inconnue se dit null : une maison ne s'invente pas
// (une maison devinée, c'est du courrier porté à la mauvaise porte).
export function houseOfSelf() {
  return process.env.CLAUDE_CONFIG_DIR || null;
}

// ── LE NOM HUMAIN DE CETTE SESSION ──────────────────────────────────────────
//
// Le harnais écrit une fiche par session dans le registre de SA maison, et
// cette fiche porte le nom que l'humain emploie (« atelier »). C'est la seule
// source : le hook, lui, ne reçoit que la session et le répertoire de travail.
// On LIT cette fiche — on ne sonde rien, on n'ouvre aucun socket.
//
// Ce que ce mécanisme NE FAIT PAS, et il faut le savoir :
//   · un renommage (/rename) n'est vu qu'au battement SUIVANT (le prochain
//     hook) — entre les deux, le registre porte l'ancien nom ;
//   · si la maison n'est pas déclarée (`CLAUDE_CONFIG_DIR` absent), on ne
//     regarde que la fiche AU NUMÉRO de ce processus dans les maisons connues,
//     jamais tout leur registre : un hook n'a pas à faire la tournée ;
//   · si le harnais n'écrit pas de nom, il n'y en a pas. Inconnu se dit null.
const PLAFOND_FICHES_LUES = 64;

export function nomDeSession(sessionId, { house = houseOfSelf(), pid = process.ppid, env = process.env } = {}) {
  const session = String(sessionId || "").trim();
  if (!session) return null;
  const maisons = house ? [house] : maisonsConnues({ env });

  // ① La fiche à MON numéro : un fichier, une lecture, dans le cas normal.
  for (const maison of maisons) {
    if (!Number.isInteger(pid) || pid <= 1) break;
    const fiche = readMailboxEntry(path.join(sessionsDir(maison), `${pid}.json`));
    if (fiche && fiche.sessionId === session) return fiche.name || null;
  }

  // ② Sinon, le registre de MA maison déclarée uniquement, et borné. La fiche
  //    peut être rangée sous un autre numéro (processus intermédiaire) : on la
  //    reconnaît à sa SESSION, jamais à autre chose — un nom pris à la fiche
  //    d'un voisin, c'est une lettre livrée à côté.
  if (!house) return null;
  let fichiers;
  try {
    fichiers = fs.readdirSync(sessionsDir(house));
  } catch {
    return null;
  }
  let lues = 0;
  for (const fichier of Array.from(fichiers).filter((f) => /^\d+\.json$/.test(f)).sort()) {
    if (lues >= PLAFOND_FICHES_LUES) break;
    lues += 1;
    const fiche = readMailboxEntry(path.join(sessionsDir(house), fichier));
    if (fiche && fiche.sessionId === session) return fiche.name || null;
  }
  return null;
}

// `selfId` n'est plus le nom d'une fiche de maison : c'est le nom d'une LIGNÉE.
// Chaque session vivante de cette lignée est une instance, avec sa propre chaise.
//
// Le modèle n'est plus estampillé ici. La fiche était réécrite par le dernier
// hook passé — y compris les PostToolUse déclenchés par des sous-agents — et
// n'avait donc aucune notion de qui parle. Le modèle voyage désormais avec la
// lettre (`messages.sender_model`).
export function touchSelf(db, selfId, hookInput = {}, extra = {}) {
  const sessionId = hookInput.session_id || hookInput.sessionId || null;
  const projectPath = hookInput.cwd || hookInput.workspace || process.cwd();
  const description = extra.description || "Claude Code session";

  if (!sessionId) {
    // Sans session, aucune instance ne peut être nommée : on garde le geste
    // d'avant pour que le canal de repli continue de fonctionner exactement
    // comme hier.
    return registerPeer(db, {
      id: selfId,
      project_path: projectPath,
      description,
      session_id: null,
      pid: process.ppid,
      model: null,
      status: "active",
      metadata: {
        hook_event: hookInput.hook_event_name || hookInput.hookEventName || null,
        transcript_path: hookInput.transcript_path || null
      }
    });
  }

  const house = extra.house || houseOfSelf();
  return registerInstance(db, {
    lineage: selfId,
    sessionId,
    house,
    pid: process.ppid,
    // L'heure de naissance du processus, À CHAQUE BATTEMENT (Run 6, Task 6,
    // fix 1) : sans elle, la chaise n'est jamais CONFIRMÉE et ne peut retenir
    // personne comme jumeau — un pid recyclé par un processus sans rapport
    // bloquait sinon une session reprise pour de bon. `ps` muet → null, et la
    // chaise reste simplement non confirmée.
    procStart: extra.procStart || procStartOf(process.ppid),
    projectPath,
    description,
    status: "active",
    // Ce qui SAIT le nom, c'est la fiche de session. On le recopie au registre
    // des pairs pour que le guichet puisse répondre à « lignée@nom » — la fiche
    // reste la source, le registre n'en est que l'écho.
    sessionName: extra.sessionName !== undefined ? extra.sessionName : nomDeSession(sessionId, { house })
  });
}

// TOUS les noms sous lesquels cette session doit aller chercher son courrier.
//
// Les hooks cherchaient sous le seul nom de LIGNÉE. Une lettre adressée à une
// CHAISE (`lignée#session`) n'était donc rattrapable par aucun repli : elle
// restait en base, adressée à un nom que personne ne lit. C'est A9 violé par
// construction pour tout courrier nominatif — et le Facteur (T4) route par
// chaise. On ramasse donc la lignée ET les chaises de la session courante,
// jamais celles du voisin : une lettre nominative se lit sur SA chaise.
// « cette adresse-là mène-t-elle à MOI, et à moi seul ? » — la question que le
// repli pose avant d'aller chercher du courrier sous un nom qui n'est pas
// exactement le sien. Une adresse AMBIGUË est refusée : elle désigne une
// personne, et une adresse qui répond pour deux n'en est pas une.
//
// ⚠️ LA CLAUSE `ambigu` NE PEUT ÊTRE MISE EN DÉFAUT PAR AUCUNE BASE ATTEIGNABLE,
// et il faut le savoir plutôt que de la croire éprouvée : `targets.length !== 1`
// la couvre entièrement, parce qu'aucune ambiguïté du guichet ne nomme une seule
// personne (les deux marches qui la produisent en ont toujours au moins deux).
// On la garde quand même — elle DIT l'intention, et elle deviendrait la seule
// garde le jour où cet invariant tomberait. Cet invariant-là, lui, est épinglé :
// test/adresse-humaine.test.js, « INVARIANT — une résolution AMBIGUË ne nomme
// JAMAIS une seule cible ». Si ce test rougit, cette clause est ce qui reste
// entre une lignée ambiguë et une lettre servie à deux personnes.
function estPourMoi(db, adresse, sessionId) {
  const resolution = resolveRecipient(db, adresse);
  if (resolution.kind === "ambigu" || resolution.targets.length !== 1) return false;
  return resolution.targets[0].instance_session_id === sessionId;
}

export function adressesDuRepli(db, selfId, hookInput = {}) {
  const lignee = String(selfId || "").trim();
  const adresses = [];
  const sessionId = hookInput.session_id || hookInput.sessionId || null;
  // 27/09 : le courrier de la LIGNÉE est à la chaise désignée, pas à toutes ses chaises.
  // On retire la lignée de MA boîte exactement quand elle n'est pour moi qu'une
  // COPIE (`deciderLaCopie`) : une autre chaise vivante de ma lignée la tient,
  // ou elle est tenue faute de désignée (ambiguë). Ces cas-là passent par
  // `copiesPourMoi`. Tout le reste garde le geste d'avant — sans session, ou
  // quand le guichet ne mène à aucune chaise de ma lignée (A8 : on préfère un
  // doublon à une lettre perdue). Plus étroit que `estPourMoi` à dessein : ce
  // dernier retirait aussi la lignée d'une session dont la chaise n'est pas
  // encore inscrite, et la lettre n'était alors plus à personne.
  const pourUnAutre = sessionId && lignee
    && deciderLaCopie({ lignee, sessionId, resolution: resolveRecipient(db, lignee) }).copie;
  if (lignee && !pourUnAutre) adresses.push(lignee);

  let chaise = null;
  if (sessionId) {
    if (lignee) adresses.push(instanceId(lignee, sessionId));
    // Une chaise enregistrée sous un autre nom (maison renommée, fiche héritée)
    // garde son adresse : on va chercher son courrier aussi.
    chaise = getInstanceBySession(db, sessionId);
    if (chaise?.id) adresses.push(chaise.id);
  }

  // ── A8 : on préfère un doublon à une lettre perdue ────────────────────────
  // Les deux adresses NEUVES. Elles ne s'ajoutent que si le GUICHET les ramène
  // à cette chaise-ci : le repli ne doit jamais servir de porte de derrière à
  // une garde que le guichet a posée.

  // ① Mon nom humain, `lignée@atelier`. S'il est porté par deux boîtes, le
  //    guichet répond « ambigu » et personne ne le prend : la lettre attend,
  //    exactement comme au guichet.
  const nomHumain = chaise?.session_name || null;
  if (lignee && nomHumain) {
    const adresse = `${lignee}${SEPARATEUR_SESSION}${nomHumain}`;
    if (estPourMoi(db, adresse, sessionId)) adresses.push(adresse);
  }

  // ② Mes ANCIENS noms de famille. Une lettre du 22/07/2026 adressée à l'ancien
  //    nom court d'une lignée a attendu sept semaines parce qu'aucun repli
  //    n'allait la chercher : un nom qu'aucun repli ne lit est une lettre
  //    perdue, et A9 promet le contraire. Le scan est borné (`listerAnciensNoms`).
  if (sessionId) {
    for (const renvoi of listerAnciensNoms(db)) {
      const ancien = String(renvoi.ancien_nom || "").trim();
      if (!ancien || adresses.includes(ancien)) continue;
      // Le renvoi se lit AU GUICHET, jamais à la main : si l'ancien nom est
      // redevenu vivant chez quelqu'un d'autre, son courrier est à lui.
      // Et la MÊME question qu'au « @nom » : « cette adresse-là mène-t-elle à
      // MOI, et à moi seul ? ». Un ancien nom hérite de sa lignée, AMBIGUÏTÉ
      // COMPRISE — et quand le guichet dit « ambigu », il fait attendre la
      // lettre. Se contenter ici de « suis-je dans la liste des candidats ? »
      // servait à DEUX chaises la même lettre, chacune de son côté, sans que
      // ni l'une ni l'autre puisse jamais l'éteindre : le repli devenait la
      // porte de derrière d'une garde que le comptoir venait de poser.
      if (estPourMoi(db, ancien, sessionId)) adresses.push(ancien);
    }
  }
  return [...new Set(adresses)];
}

// ── LA COPIE CC : LA LETTRE DE LIGNÉE VUE PAR UNE CHAISE QUI N'EN EST PAS LA
//    DESTINATAIRE (Run 6, Task 7, 27/09) ────────────────────────────────────
//
// Observé ce jour : une lettre à la lignée LIVRÉE à la chaise désignée ET à une
// instance sœur, et l'instance sœur l'a accusée à la place de la chaise
// désignée. La règle : une
// lettre à la lignée est à la chaise que le GUICHET désigne (`resolveRecipient`,
// la même résolution qui livre — loi du 13/08) ; chaque autre chaise vivante de
// la lignée en voit une COPIE : une fois, marquée cc, jamais livrée, jamais
// accusable par elle, jamais un Stop. Quand le guichet dit « ambigu » (aucune
// désignée, ou la désignée est morte), la lettre est TENUE pour la lignée et
// chaque chaise vivante voit la copie avec le drapeau `sans-chaise-designee`,
// pour qu'un humain désigne.
//
// La RÈGLE pure (`deciderLaCopie`) vit dans registry.js, à côté de la
// résolution qu'elle lit : `ackMessage` (database.js) la consulte aussi, et
// database.js ne peut pas importer ce module-ci (il en est importé). Elle est
// ré-exportée d'ici pour les appelants de l'identité.
export { deciderLaCopie };

// La copie d'UNE chaise, lue en base : ce que les hooks ET le guichet MCP
// servent. La chaise doit être une chaise EN SERVICE de cette lignée — une
// fiche d'une autre famille ne lit pas le courrier de celle-ci, même en copie.
export function copiesPourChaise(db, lignee, sessionId, { limit = 20 } = {}) {
  const vide = { rows: [], chaiseId: null, destinataire: null, chaiseDesignee: null, sansChaiseDesignee: false };
  const nom = String(lignee || "").trim();
  if (!nom || !sessionId) return vide;
  const chaise = getInstanceBySession(db, sessionId);
  if (!chaise || chaise.lineage !== nom || ["offline", "dead"].includes(chaise.status)) return vide;
  const resolution = resolveRecipient(db, nom);
  const verdict = deciderLaCopie({ lignee: nom, sessionId, resolution });
  if (!verdict.copie) return vide;
  const cible = verdict.chaise_designee ? resolution.targets[0] : null;
  return {
    rows: getCopiesPourChaise(db, nom, chaise.id, { limit }),
    chaiseId: chaise.id,
    destinataire: cible ? (cible.session_name ? `${cible.session_name} (${cible.id})` : cible.id) : null,
    chaiseDesignee: verdict.chaise_designee,
    sansChaiseDesignee: verdict.sans_chaise_designee
  };
}

// Pour les hooks : la lignée dérivée et la session de l'entrée standard.
export function copiesPourMoi(db, selfId, hookInput = {}, { limit = 20 } = {}) {
  const sessionId = hookInput.session_id || hookInput.sessionId || null;
  return copiesPourChaise(db, selfId, sessionId, { limit });
}

// Pour un signataire SANS chaise (client MCP nu, fix 1) : la lettre de sa
// lignée tenue par UNE chaise vivante avec session — désignée ou non depuis F3
// (passe adverse, 28/09), la même règle que `gardeDeLaCopie` — n'est pour lui
// qu'une copie. Marque `cc_vu` sous son nom nu. Un client solo (sa seule fiche,
// sans session) ne voit rien ici : son courrier lui est livré comme avant.
export function copiesSansChaise(db, lignee, { limit = 20 } = {}) {
  const vide = { rows: [], chaiseId: null, destinataire: null, chaiseDesignee: null, sansChaiseDesignee: false };
  const nom = String(lignee || "").trim();
  if (!nom || nom.includes("#")) return vide;
  const tenante = chaiseTenanteDeLaLignee(db, nom);
  if (!tenante) return vide;
  return {
    rows: getCopiesPourChaise(db, nom, nom, { limit }),
    chaiseId: nom,
    destinataire: tenante.session_name ? `${tenante.session_name} (${tenante.id})` : tenante.id,
    chaiseDesignee: tenante.id,
    sansChaiseDesignee: false
  };
}

// ── LA CHAISE DU GUICHET MCP (fix 1 de la Task 7, 27/09) ────────────────────
//
// Le serveur MCP est lancé par le harnais de SA session, comme les hooks : son
// parent (`process.ppid`) est le même processus, et la fiche
// `sessions/<ppid>.json` de la maison dit sa session. On la lit du même geste
// que `nomDeSession` (ma maison déclarée, sinon les maisons connues, fiche à MON
// numéro seulement), puis le verdict est CELUI des hooks (`chaiseReceptrice`,
// jamais une deuxième règle). Une chaise reçue s'annonce comme au hook
// (`touchSelf`) et devient l'identité opérationnelle du serveur :
// `lignée#session`.
// Rien ici ne lève : pas de maison, maison absente, pas de fiche → null, et le
// serveur garde la lignée nue (client simple : Antigravity, Gemini CLI, Codex —
// leur parent n'est pas une session).
// UN REFUS N'EST PAS UN « PAS DE FICHE » (F3, passe adverse, 28/09). Fiche
// d'une autre session, jumeau : le verdict rend `{ refus, lignee, sessionId }`
// et le serveur ne parle PAS en lignée nue — les hooks refusent ce processus
// précisément pour qu'il n'ait aucune lettre ; le guichet MCP ne lui rend pas
// par derrière les droits de la lignée entière.
export function chaiseDuServeurMcp(db, { pid = process.ppid, house = houseOfSelf(), env = process.env } = {}) {
  try {
    if (!db || !Number.isInteger(pid) || pid <= 1) return null;
    const maisons = house ? [house] : maisonsConnues({ env });
    let fiche = null;
    let maison = null;
    for (const candidate of maisons) {
      const lue = readMailboxEntry(path.join(sessionsDir(candidate), `${pid}.json`));
      if (lue?.sessionId) {
        fiche = lue;
        maison = candidate;
        break;
      }
    }
    if (!fiche) return null;
    const sessionId = String(fiche.sessionId);
    const entree = { session_id: sessionId, cwd: process.cwd() };
    const qui = chaiseReceptrice(db, entree, { pid, house: maison });
    if (!qui.recoit) {
      // Fix round 2 : le repli sur la lignée nue n'est accepté QUE s'il se dit —
      // même journal, même clef (`cleDeRefus`), même marque exclusive que les
      // hooks (hook-common.js) : un jumeau à la porte MCP se lit au journal du
      // bureau comme un jumeau à la porte des hooks, une fois par clef.
      const ligneeRefusee = resolveSelfId(db, entree);
      journaliserRefusUneFois(ligneeRefusee, { raison: qui.raison, sessionId, agentId: null, pid });
      return { refus: qui.raison, lignee: ligneeRefusee, sessionId };
    }
    const lignee = resolveSelfId(db, entree);
    if (!lignee) return null;
    touchSelf(db, lignee, entree, { house: maison, description: "Claude Code session" });
    return { chaiseId: instanceId(lignee, sessionId), lignee, sessionId };
  } catch {
    return null;
  }
}

// ── QUI REÇOIT : LE VRAI PROCESSUS DE LA SESSION (Run 6, Task 6, 27/09) ─────
//
// Observé ce jour : une lettre à une lignée injectée par PostToolUse dans
// TROIS sous-agents de sa chaise désignée. Un sous-agent partage le session_id
// ET le pid de sa session (il vit dans le même processus) : seul `agent_id` le distingue — le
// harnais (2.1.281, 2.1.283) le décrit « présent seulement quand le hook part
// d'un sous-agent, absent pour le fil principal ». Un fork partage le
// session_id mais PAS le pid : la chaise appartient au pid vivant qui la tient.
//
// La RÈGLE est pure et vit ici, une seule fois. Le moniteur Python la reflète
// (`decider_la_chaise`, src/monitor/valxos_monitor.py) et un test joue le même
// tableau des deux côtés (test/monitor.test.js, « PARITÉ »). Toucher l'une sans
// l'autre, c'est un moniteur qui sert une lettre que les hooks refusent.
//
//   agent_id présent              → sous-agent              (refus)
//   pas de session                → sans-session            (reçoit : le repli d'hier)
//   ma fiche porte une autre session → fiche-d-une-autre-session (refus)
//   la chaise est à un AUTRE pid, vivant ET CONFIRMÉ → jumeau (refus)
//   sinon                         → chaise                  (reçoit)
//
// CONFIRMÉ (fix 1, review Task 6) veut dire : la ligne porte une heure de
// naissance ET cette heure est celle du processus vivant à ce pid — le verdict
// `meme-incarnation` de `verdictDeChaise`, jamais l'optimiste `pid-vivant`
// (pid vivant, rien d'inscrit). Reproduit : une ligne restée « active » pour
// S1, son pid recyclé par un processus sans rapport, S1 reprise sous un autre
// pid → refusée comme jumeau, pour toujours (le refus saute `touchSelf`, la
// ligne ne se corrige jamais). Une chaise morte, indécidable ou non confirmée
// ne retient personne : on préfère un doublon à une lettre perdue (A8), et le
// nouveau venu prend la chaise au battement.
export function deciderLaChaise({ agentId = null, sessionId = null, ficheSessionId = null, pid = null, chaise = null } = {}) {
  if (agentId) return { recoit: false, raison: "sous-agent" };
  if (!sessionId) return { recoit: true, raison: "sans-session" };
  if (ficheSessionId && ficheSessionId !== sessionId) return { recoit: false, raison: "fiche-d-une-autre-session" };
  if (chaise && Number(chaise.pid) !== Number(pid) && chaise.etat === "vivante" && chaise.raison === "meme-incarnation") {
    return { recoit: false, raison: "jumeau" };
  }
  return { recoit: true, raison: "chaise" };
}

// Les lectures autour de la règle. `agent_id` se tranche AVANT d'ouvrir quoi que
// ce soit : un sous-agent n'a droit à aucun regard sur la boîte, pas même au
// registre. `db` peut donc être null quand l'appelant n'a pas encore ouvert.
export function chaiseReceptrice(db, hookInput = {}, { pid = process.ppid, house = houseOfSelf(), verdict = verdictDeChaise } = {}) {
  const agentId = hookInput.agent_id || null;
  if (agentId) return deciderLaChaise({ agentId });
  const sessionId = hookInput.session_id || hookInput.sessionId || null;
  if (!sessionId) return deciderLaChaise({ sessionId });
  let ficheSessionId = null;
  if (house && Number.isInteger(pid) && pid > 1) {
    const maFiche = readMailboxEntry(path.join(sessionsDir(house), `${pid}.json`));
    ficheSessionId = maFiche?.sessionId || null;
  }
  // Une fiche qui porte une autre session suffit : pas de regard au registre.
  if (ficheSessionId && ficheSessionId !== sessionId) return deciderLaChaise({ sessionId, ficheSessionId, pid });
  const ligne = db ? getInstanceBySession(db, sessionId) : null;
  const avis = ligne ? verdict(ligne) : null;
  const chaise = ligne ? { pid: ligne.pid, etat: avis.etat, raison: avis.raison } : null;
  return deciderLaChaise({ sessionId, ficheSessionId, pid, chaise });
}

// Le refus est MUET pour celui qu'on refuse (aucune lettre, aucun texte qui
// pourrait en trahir une) mais il se DIT au journal du bureau — une fois par
// (raison, session, sous-agent, pid), jamais à chaque geste : un sous-agent
// déclenche un PostToolUse par outil. L'unicité tient à une marque posée en
// création exclusive, lue par le moniteur Python avec la MÊME clef.
export function cleDeRefus({ raison, sessionId = null, agentId = null, pid = null }) {
  return crypto
    .createHash("sha256")
    .update(`${raison}|${sessionId || ""}|${agentId || ""}|${pid ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

export function journaliserRefusUneFois(agent, detail) {
  try {
    // Sous garde, le bureau vivant ne reçoit pas cette écriture non plus.
    garderLEcritureDuBureau();
    const dossier = path.join(runtimePaths().run, "chaises-refusees");
    fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
    const marque = path.join(dossier, cleDeRefus(detail));
    try {
      fs.closeSync(fs.openSync(marque, "wx", 0o600));
    } catch (erreur) {
      if (erreur?.code === "EEXIST") return false;
      throw erreur;
    }
    appendLog(safeAgentFileName(agent || "system"), "chaise_refusee", {
      raison: detail.raison,
      session_id: detail.sessionId || null,
      agent_id: detail.agentId || null,
      pid: detail.pid ?? null
    });
    return true;
  } catch {
    // Un hook ne lève jamais : un journal qui n'a pas pu s'écrire ne change
    // rien au refus lui-même.
    return false;
  }
}
