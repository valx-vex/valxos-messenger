#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import { readFileSync, writeSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_ROSTER, baseDir, deriveSelf, nowIso, origineDuNomDerive, refusDeLIdentiteDerivee, validateAgentId } from "../lib/config.js";
import { BUDGET_RESULTAT_INBOX, choisirPourLaReleve, ligneDeSuiteDeLaReleve, partieSousLeBudget, tailleDuContenu } from "../lib/budget-courrier.js";
import {
  ackMessage,
  getDatabase,
  getMessageById,
  getMessageByAnyId,
  history,
  lettresDUnEnvoi,
  listInbox,
  listPeers,
  markDelivered,
  marquerCopiesVues,
  recordEvent,
  registerPeer,
  unregisterPeer,
  droitDeSigner,
  verifierIdentiteDeclaree,
  verdictDeDesinscription,
  nomNuTenuParUneChaise
} from "../lib/database.js";
import {
  SEPARATEUR_INSTANCE,
  broadcastRecipients,
  ficheLisible,
  listLineages,
  pairsEtAlias,
  resolveRecipient
} from "../lib/registry.js";
import { adressesDuRepli, chaiseDuServeurMcp, copiesPourChaise, copiesSansChaise, journaliserRefusUneFois } from "../lib/identity.js";
// Les quatre gestes d'un envoi (inscrire · résoudre · réveiller · avertir) et
// les trois remèdes qu'ils portent (C1, C2, R2) vivent au guichet, pas ici :
// ce fichier n'est plus qu'UNE des surfaces qui postent.
import {
  borne,
  codeDeLaCause,
  estLeCourrierDe,
  formesDeLExpediteur,
  interruptionDEnvoi,
  lettreDeTableRendue,
  nomDeTableDe,
  posterAUneTable,
  posterSousUneClefASoi,
  posterUneLettre,
  resoudreSansCasser,
  scannerSansCasser,
  verifierEnclos
} from "../lib/guichet.js";
import { etatDeLaLettre, jsonToolResult, textToolResult } from "../lib/format.js";
import { resetStopGuard } from "../lib/stop-guard.js";
import {
  LONGUEUR_POSITION,
  MODES,
  REGLES_REVEIL,
  ajouterMembre,
  creerTable,
  estMembre,
  listerTables,
  membresDeTable,
  modifierTable,
  obtenirTable,
  retirerMembre,
  validerNomDeTable
} from "../lib/tables.js";
import { avisDAttente } from "../facteur/round.js";

// S10 (seconde passe adverse) : une identité dérivée que ce paquet ne prend pas
// (une partie de plus de 64 caractères, une lignée vide) refuse le démarrage du
// serveur, avant d'ouvrir le bureau, en une phrase qui dit la limite — jamais
// un nom coupé ou réécrit en silence (config.js, `motifDIdentiteInvalide`).
const refusDIdentite = refusDeLIdentiteDerivee();
if (refusDIdentite) {
  writeSync(2, `VALXOS Messenger MCP server: refusing to start: ${refusDIdentite} (identite-invalide).\n`);
  process.exit(1);
}
const db = getDatabase();
// One truth for the version: package.json. The server announces what the
// package publishes — it said "0.1.0" to every client while the package was 1.0.0-rc.2.
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
// Les instructions vivent dans le SECOND argument (options) — dans le premier,
// le SDK les jette en silence et aucun client ne les a jamais vues.
// Deux noms, un produit : le paquet npm s'appelle `valxos-messenger` (trait
// d'union) ; l'identifiant MCP annoncé ici reste `valxos_messenger` (souligné,
// comme les identifiants de serveurs MCP) — jamais lu dans package.json.
// Le nom de celui qui parle vient de l'ENVIRONNEMENT qui lance le serveur,
// jamais d'un outil : `register` écrit une fiche pour un nom et ne renomme pas
// la session (revue de l'inconnu, 18/10 : « Use register to set your agent name »
// faisait écrire à un nom que personne ne relevait ; épinglé dans
// test/surfaces.test.js). La skill ajoute ce que les hooks font sans nom posé.
const server = new McpServer(
  { name: "valxos_messenger", version: PACKAGE_VERSION }, // identifiant MCP (revue adverse, 23/08), pas le nom npm
  {
    instructions: [
      "VALXOS Messenger (formerly cc2cc-v2 / CEREAL) provides durable local messaging between Claude Code instances and other harnesses.",
      "Your name comes from VALXOS_SELF (or VALXOS_SESSION_NAME) in the environment that starts this server; whoami shows it. register writes a peer card for a name; it does not rename this session.",
      "Use send/broadcast to communicate, inbox to read, and ack to mark messages handled.",
      "Incoming messages may also arrive automatically through plugin monitors and hooks."
    ].join(" ")
  }
);

// ── QUI PARLE (fix 1 de la Task 7, 27/09) ───────────────────────────────────
// Une session qui a une fiche (`sessions/<ppid>.json`, le harnais qui nous a
// lancés) parle en CHAISE : `lignée#session`, dérivée du même geste et du même
// verdict que les hooks (`chaiseDuServeurMcp`). Sans fiche — un client simple,
// Antigravity, Gemini CLI, Codex — on garde la lignée nue d'avant. Relu à
// chaque appel : une session reprise change de fiche sans relancer le serveur.
// UN REFUS DE CHAISE NE DEVIENT JAMAIS LA LIGNÉE NUE (F3, passe adverse,
// 28/09). Un jumeau, ou une fiche d'une autre session, est refusé par les
// hooks pour qu'il n'ait AUCUNE lettre ; retomber ici sur la lignée nue lui
// rendait la boîte de la lignée entière — reproduit : `inbox` livrait la
// lettre de la vraie session, `ack` l'éteignait. Sous refus, le guichet
// répond `refus: "chaise-refusee"` (+ `raison`) : `whoami` sans identité,
// `inbox` vide, `ack` et `history` refusés. `send`/`broadcast` restent
// ouverts sous la lignée nue, marqués `sans_chaise: true` — écrire ne prend la
// lettre de personne, et un appelant bloqué doit pouvoir le dire à quelqu'un.
function identiteDuServeur() {
  const lignee = deriveSelf();
  const chaise = chaiseDuServeurMcp(db);
  if (chaise?.refus) return { id: null, lignee, sessionId: chaise.sessionId, chaise: false, nu: lignee, refus: chaise.refus };
  if (chaise) return { id: chaise.chaiseId, lignee: chaise.lignee, sessionId: chaise.sessionId, chaise: true, nu: lignee };
  return { id: lignee, lignee, sessionId: null, chaise: false, nu: lignee };
}

// Une lignée NUE déclarée par une chaise se résout à cette chaise, jamais crue
// comme lignée : c'est la porte par laquelle une instance sœur a accusé à la
// place de la chaise désignée. Tout autre nom déclaré suit la vérification d'avant.
function declarationResolue(qui, self) {
  const declare = String(self ?? "").trim();
  if (qui.chaise && (declare === qui.lignee || declare === qui.nu)) return "";
  // Fix round 2 : un nom déclaré qui MÈNE à cette chaise (son adresse humaine,
  // un alias vers elle) est cette chaise — elle signe sous son id, jamais sous
  // un nom nu que la base refuse vers une chaise (`signataireNuVersUneChaise`).
  if (qui.chaise && declare) {
    const resolution = resolveRecipient(db, declare);
    if (resolution.targets.length === 1 && resolution.targets[0].id === qui.id) return "";
  }
  return self;
}

// UNE CHAISE DÉCLARÉE N'EST HONORÉE QUE SI LA FICHE DE L'APPELANT LA DÉRIVE
// (fix round 1 de la boucle Task 12, revue I-1, 28/09). La famille d'identité
// (`verifierIdentiteDeclaree`, porte 3) laisse une lignée déclarer N'IMPORTE
// QUELLE chaise en service de sa lignée : un client sans fiche, refusé en nom
// nu, déclarait `self: "lignée#session"` et éteignait la lettre de la vraie
// session. Pour `ack` et `inbox`, un `lignée#session` déclaré passe
// seulement quand il est la chaise que CE serveur a dérivée de sa fiche
// (`qui.id`, le chemin de la Task 7). Un appelant sans chaise garde sa lignée
// nue, ses anciens noms et son adresse humaine (la famille d'avant), jamais
// une chaise. Coût accepté (A8) : une session dont le serveur ne trouve pas sa
// fiche n'accuse plus les lettres de sa lignée — elles restent non accusées,
// jamais prises par un autre. Rend la raison du refus, ou null.
function refusDeChaiseDeclaree(qui, self) {
  const declare = String(self ?? "").trim();
  if (!declare.includes(SEPARATEUR_INSTANCE)) return null;
  if (qui.chaise && declare === qui.id) return null;
  return qui.chaise
    ? "a chair can declare only the chair its own session card derives"
    : "a caller without a chair (no session card derived) cannot declare a chair (lineage#session)";
}

// L'EXPÉDITEUR SE VÉRIFIE (fix round 2 de la boucle Task 12, re-revue r1 :
// M-1 et M-2). `from` restait pris au mot : `from: "dave"` faisait passer la
// clef d'une lettre carol→dave pour la sienne (F12 rouvert), et un jumeau
// refusé signait sous la chaise. Un `from` différent du nom dérivé passe la
// MÊME vérification qu'un `self` déclaré (`verifierIdentiteDeclaree`, la règle
// du nom nu vers une chaise comprise) ; sinon refus `expediteur-refuse`, rien
// n'est posé. La propriété d'une clef se juge ensuite sur le nom DÉRIVÉ seul
// (plus, pour une chaise, sa lignée) — jamais sur le `from` de l'appel.
//
// UN `from` VÉRIFIÉ N'EST PAS TOUJOURS CELUI SOUS LEQUEL LA LETTRE PART (J1,
// jury du 18/10). Un `from` qui se résout à l'appelant — son adresse humaine,
// un ancien nom — passe la vérification, mais `estAMoi` ne le reconnaît pas :
// posée sous ce nom, la lettre était jugée « pas à soi », reposée sous une clef
// neuve, puis refusée (`clef_indisponible`) : deux lettres au destinataire, une
// erreur à l'appelant (mesuré : deux lignes par appel, quatre après un renvoi).
// La lettre part donc sous l'identité DÉRIVÉE, comme sans `from`, pour tout
// nom que `estAMoi` ne connaît pas ; seule la lignée nue d'une chaise, qu'il
// connaît, reste honorée telle quelle.
// Rend `{ sender, estAMoi, sansChaise }` ou `{ refus }` (la réponse à rendre).
function expediteurVerifie(qui, from, guichet) {
  const derive = ensureSelf(qui);
  const estAMoi = (row) => estLeCourrierDe(derive)(row) || (qui.chaise && estLeCourrierDe(qui.lignee)(row));
  const sansChaise = qui.refus ? { sans_chaise: true, refus_chaise: qui.refus } : {};
  const declare = String(from ?? "").trim();
  if (!declare || declare === derive) return { sender: derive, estAMoi, sansChaise };
  const resolu = declarationResolue(qui, declare);
  const identite = resolu ? verifierIdentiteDeclaree(db, derive, resolu) : { autorise: true };
  if (!identite.autorise) {
    recordEvent(db, null, derive, "accuse_refuse", {
      refus: "expediteur-refuse", declare, derivee: derive, raison: identite.raison, guichet
    });
    return {
      refus: jsonToolResult({
        sent: false,
        refus: "expediteur-refuse",
        motif: "a sender writes only under its own name",
        declare,
        derivee: derive,
        origine: origineDuNomDerive(),
        raison: identite.raison
      })
    };
  }
  return { sender: estAMoi({ sender: declare }) ? declare : derive, estAMoi, sansChaise };
}

function selfId() {
  return identiteDuServeur().id;
}

// La réponse unique d'un guichet devant une chaise refusée (F3).
function refusDeChaise(qui, champs = {}) {
  return jsonToolResult({
    ...champs,
    refus: "chaise-refusee",
    raison: qui.refus,
    session: qui.sessionId,
    lignee: qui.nu,
    motif: "this process is not the chair of its session (the hooks refuse it too): it does not speak for the lineage"
  });
}

function ensureSelf(qui = identiteDuServeur()) {
  // Une chaise s'est déjà annoncée comme au hook (`touchSelf`) : aucune fiche
  // nue « lignée » à recréer à côté d'elle.
  if (qui.chaise) return qui.id;
  // Une chaise REFUSÉE n'en pose pas non plus (F3) : une fiche nue « lignée »
  // posée par un jumeau serait une deuxième boîte à côté de la vraie chaise.
  if (qui.refus) return qui.nu;
  const id = qui.id;
  registerPeer(db, {
    id,
    project_path: process.cwd(),
    description: "VALXOS Messenger MCP session",
    status: "active"
  });
  return id;
}

// ── LES TABLES AU GUICHET MCP (1.1.0) ────────────────────────────────────────
// Une table est un carnet d'adresses, pas une boîte : `send` à `table:<nom>`
// crée une lettre par membre (le guichet, `posterAUneTable`), et tout ce qui
// suit (accusé, copies, tournée, moniteur) raisonne par lettre comme avant.
// Ici ne vivent que la FORME des refus — jamais une règle. Le préfixe
// `table:` (`nomDeTableDe`), la forme d'une lettre de table rendue
// (`lettreDeTableRendue`) et celle d'un envoi interrompu (`interruptionDEnvoi`)
// vivent au guichet : `valxos-send` rend les mêmes, sans copie.

// Un refus finit devant un inconnu : ce qu'il recopie de l'entrée (une
// adresse, un nom de table, une clef) passe par la borne du guichet (`borne` :
// 64 points de code, contrôles aplatis) — la règle, jamais une copie. Une
// valeur absente reste absente (null), au lieu de devenir une chaîne vide.
function borneLEcho(valeur) {
  return valeur === null || valeur === undefined ? null : borne(valeur);
}

// La chaise qui poste, pour l'affichage seulement (`messages.sender_chaise`) :
// l'identité du serveur quand c'est une chaise, rien sinon.
function chaiseDe(qui) {
  return qui.chaise ? qui.id : null;
}

// Toutes les formes sous lesquelles l'appelant peut être membre d'une table ou
// auteur d'une lettre : le nom dérivé, sa lignée, sa chaise, son adresse humaine.
function formesDeLAppelant(qui, sender) {
  return formesDeLExpediteur(db, sender, { chaiseId: chaiseDe(qui) });
}

const MOTIF_ENCLOS = "this sender is enclosed: its letters only go to the members of its closed table (pass hors_enclos: true to step out)";
// S9 : deux enclos actifs tiennent l'expéditeur, sous deux de ses formes, dans deux tables.
const MOTIF_CONFLIT = "this sender is enclosed in more than one table: no letter goes out until the operator lifts one of these enclosures (pass hors_enclos: true to step out)";

// LA SONNETTE LAISSE UNE TRACE. `wake` ne vit que dans la réponse du send ;
// `envoi_status` doit pourtant dire « sonné » quand le réveil direct a réussi.
// Un événement par lettre réveillée, sous le nom de l'expéditeur.
function journaliserLesSonneries(sender, lettres) {
  for (const lettre of lettres || []) {
    if (lettre.wake?.ok === true && lettre.row?.msg_id) {
      recordEvent(db, lettre.row.msg_id, sender, "sonnee", { via: "mcp_send", socket: lettre.wake.socketPath ?? null });
    }
  }
}

// UN ENVOI DE TABLE QUI CASSE EN CHEMIN DIT CE QUI EST PARTI : la forme vit au
// guichet (`interruptionDEnvoi`, partagée avec `valxos-send`). Les sonneries
// des lettres parties se journalisent au guichet qui appelle
// (`journaliserLesSonneries`), jamais depuis un formateur de refus.

// UN REFUS DU GUICHET DES TABLES SE REND, IL NE SE LÈVE JAMAIS VERS LE CLIENT.
// Chaque code est un littéral ici : docs/MCP_CLIENTS.md les liste, et la sonde
// de la doc les lit dans ce fichier. `champs` arrive déjà borné. Rend null pour
// une erreur qui n'est pas un refus connu et n'a rien écrit — elle remonte
// alors comme une panne, pas comme un refus. Une panne qui a écrit des lettres
// se rend, elle, sous NOTRE code (`envoi-interrompu`) : le code brut de
// l'erreur d'origine (SQLite, `clef_indisponible`…) part dans `cause`, jamais
// dans `refus` — `refus` ne porte que des codes que la doc connaît.
function refusDeTable(erreur, champs = {}) {
  const interruption = interruptionDEnvoi(erreur);
  const base = { ...champs, ...(interruption || {}) };
  const motif = (phrase) => interruption?.motif ?? phrase;
  switch (erreur?.code) {
    case "hors-enclos":
      return jsonToolResult({
        ...base,
        refus: "hors-enclos",
        enclos: erreur.enclos,
        destinataires_refuses: erreur.destinataires_refuses,
        ...(erreur.autres ? { autres: erreur.autres } : {}),
        motif: motif(MOTIF_ENCLOS)
      });
    case "parametre-invalide":
      return jsonToolResult({ ...base, refus: "parametre-invalide", parametre: erreur.parametre ?? null, motif: motif(erreur.message) });
    case "enclos-conflit":
      return jsonToolResult({
        ...base,
        refus: "enclos-conflit",
        tables: erreur.tables,
        enclos_poses: erreur.enclos_poses,
        motif: motif(MOTIF_CONFLIT)
      });
    case "table-inconnue":
      return jsonToolResult({ ...base, refus: "table-inconnue", motif: motif("no table of that name") });
    case "pas-membre":
      return jsonToolResult({ ...base, refus: "pas-membre", motif: motif("the caller is not a member of this table under any of its names") });
    case "nom-de-table-invalide":
      return jsonToolResult({
        ...base,
        refus: "nom-de-table-invalide",
        motif: motif("a table name is 1 to 32 characters: lowercase letters, digits and hyphens, starting with a letter or a digit")
      });
    case "table-existe":
      return jsonToolResult({ ...base, refus: "table-existe", motif: motif("a table of that name already exists (tables are never deleted)") });
    case "reveil-invalide":
      return jsonToolResult({ ...base, refus: "reveil-invalide", motif: motif("reveil is 'reveil' or 'prochain-tour'") });
    case "adresse-invalide":
      return jsonToolResult({
        ...base,
        refus: "adresse-invalide",
        // B10 : le guichet dit pourquoi quand ce n'est pas l'adresse d'un membre (une lettre sans destinataire).
        motif: motif(erreur.motif_refus ?? "a member address is a lineage, a chair (lineage#session), a human address (lineage@name) or a bare card, without spaces, never table:<name>")
      });
    default:
      if (!interruption) return null;
      return jsonToolResult({ ...base, refus: "envoi-interrompu", ...(codeDeLaCause(erreur) ? { cause: codeDeLaCause(erreur) } : {}) });
  }
}

// Une table telle que le client la voit : ses membres actifs, `membre` (l'appelant
// en est-il, sous l'une de ses formes ? on ne poste qu'à une table dont on est
// membre) et le réveil qui vaut pour lui (le sien, sinon celui de la table ;
// null quand il n'en est pas membre). `fermee` est un booléen, pas un 0/1. La
// position part telle quelle : du texte non fiable, mais dans du JSON.
function tableRendue(table, formes = []) {
  const membres = membresDeTable(db, table.nom);
  const moi = membres.find((m) => formes.includes(m.adresse)) || null;
  return {
    nom: table.nom,
    fermee: Number(table.fermee) === 1,
    reveil: table.reveil,
    mode: table.mode,
    position: table.position ?? null,
    position_par: table.position_par ?? null,
    position_le: table.position_le ?? null,
    membres: membres.map((m) => ({ adresse: m.adresse, reveil: m.reveil ?? null })),
    membre: Boolean(moi),
    mon_reveil: moi ? (moi.reveil ?? table.reveil) : null
  };
}

// L'EN-TÊTE DE TABLE SUR CHAQUE LETTRE RENDUE (1.1.0) : `table`, `envoi_id`,
// `reponse_a`, `position` (celle de la table, lue une fois par table et par
// appel) et `rappel` (le nombre de re-services de la lettre). La ligne reste
// entière dessous, `etat` en tête comme avant : la forme d'avant ne perd rien.
// Une table FERMÉE n'est vue que de ses membres : sa position ne se montre
// qu'à un lecteur qui en est membre sous l'une de ses formes — un membre
// retiré relit ses vieilles lettres sans lire la position d'aujourd'hui.
function decorerLesLettres(rows, formes = []) {
  const positions = new Map();
  const positionDe = (nom) => {
    if (!nom) return null;
    if (!positions.has(nom)) {
      const table = obtenirTable(db, nom);
      const visible = table && (Number(table.fermee) !== 1 || estMembre(db, table.nom, formes));
      positions.set(nom, visible ? table.position ?? null : null);
    }
    return positions.get(nom);
  };
  return rows.map((row) => ({
    etat: etatDeLaLettre(row),
    ...row,
    table: row.table_nom ?? null,
    envoi_id: row.envoi_id ?? null,
    reponse_a: row.reponse_a ?? null,
    position: positionDe(row.table_nom),
    rappel: Number(row.reservices ?? 0)
  }));
}

// Les formes du lecteur d'une boîte : le nom relevé (déclaré ou dérivé) et le
// nom dérivé, chacun avec sa lignée, sa chaise et son adresse humaine.
function formesDuLecteur(qui, ...noms) {
  return [...new Set(noms.filter(Boolean).flatMap((nom) => formesDeLAppelant(qui, nom)))];
}

// L'ACCUSÉ SE SIGNE — et LA RELÈVE AUSSI (G1). `self` reste au schéma (compat),
// mais c'est une DEMANDE, jamais une identité : on ne la trouve légitime que si
// la session qui appelle (DÉRIVÉE, jamais déclarée) a le droit de porter ce
// nom-là. Avant G1, `ack` et `inbox` prenaient `self` au mot, et
// `droitDAccuser` jugeait un nom qu'on lui avait simplement TENDU, jamais
// vérifié contre la session qui parlait vraiment.
//
// La question posée ici est EXACTEMENT celle que `droitDAccuser` sait déjà
// trancher pour un accusé, destinataire et signataire inversés : « la session
// dérivée a-t-elle le droit de signer POUR le nom qu'elle déclare ? » Elle
// rejoue ses portes 2, 3 ET 4 — le nom dérivé, sa lignée, une chaise de sa
// lignée, OU toute adresse que la résolution lui ramène (un ancien nom, une
// adresse humaine) : une seule résolution EXISTANTE, jamais une deuxième qui
// pourrait diverger. Cette famille est PLUS LARGE que ce qu'`adressesDuRepli`
// sert au repli (clée sur le vrai `session_id` de l'appelant, elle ne rend que
// SA PROPRE chaise) ; l'excédent est refermé plus loin dans la chaîne par
// `refusDeChaiseDeclaree` (ci-dessus, 28/09) pour une chaise déclarée, et par
// `nomNuTenuParUneChaise` (database.js) pour un nom nu.
//
// (Le court-circuit `declare === derive`, et le corps de
// `verifierIdentiteDeclaree` lui-même, vivent dans database.js, juste après
// `droitDAccuser` — EXPORTÉE pour que le CLI (`cc2cc-inbox`) rejoue la MÊME
// vérification que le guichet MCP, jamais une deuxième qui pourrait diverger. La
// garde PAR LETTRE d'`ackMessage` [porte 1 comprise] n'est pas touchée : elle
// juge si CE nom peut signer CETTE lettre, une question différente de celle
// posée ici.)

server.registerTool(
  "whoami",
  {
    description: "Return this VALXOS Messenger agent identity and runtime summary.",
    inputSchema: {}
  },
  async () => {
    const qui = identiteDuServeur();
    if (qui.refus) return refusDeChaise(qui, { id: null, self: null, peers: listPeers(db), runtime: baseDir() });
    const id = ensureSelf(qui);
    return jsonToolResult({
      id,
      peers: listPeers(db),
      runtime: baseDir()
    });
  }
);

server.registerTool(
  "register",
  {
    description:
      "Register a named peer card on VALXOS Messenger — no session identity; chairs come from harness "
      + "session announcements, not this tool (see the chaise skill).",
    inputSchema: {
      id: z.string().describe("Agent ID, for example alice-codex"),
      project_path: z.string().optional().describe("Project path for this instance"),
      description: z.string().optional().describe("Short peer description")
    }
  },
  async ({ id, project_path, description }) => {
    if (!validateAgentId(id)) {
      return textToolResult("Invalid id. Use letters, numbers, dot, underscore, or hyphen; max 64 chars.");
    }
    const peer = registerPeer(db, {
      id,
      project_path: project_path || process.cwd(),
      description: description || "Claude Code peer",
      status: "active"
    });
    return jsonToolResult({ registered: true, peer });
  }
);

server.registerTool(
  "list_peers",
  {
    description:
      "List registered VALXOS Messenger peers in service: an announced chair (a live session) and a legacy "
      + "peer card registered without session identity (register) both count. Set include_dead to also see "
      + "chairs marked offline or dead. Priority aliases (an old name that always leads to another lineage) "
      + "are listed separately under aliases; a peer card masked by an alias carries masque_par_alias. "
      + "lineages names, per lineage, the designated chair (chaise_designee) that receives the lineage's mail; "
      + "other live chairs only see a cc copy, and a lineage with sans_chaise_designee holds its mail until a chair is designated.",
    inputSchema: {
      include_dead: z.boolean().optional()
    }
  },
  async ({ include_dead } = {}) => {
    const includeDead = include_dead === true;
    // Les alias à côté des pairs, jamais parmi eux : un nom qui mène ailleurs
    // n'est pas une boîte (Run 6, 27/09).
    const { peers: pairs, aliases } = pairsEtAlias(db, listPeers(db, { includeDead }));
    // LA CHAISE DÉSIGNÉE, PAR LIGNÉE (Run 6, Task 7) : celle qui reçoit le
    // courrier de la lignée — la même résolution qui livre, jamais une
    // deuxième. Les autres chaises n'en voient qu'une copie cc ; une lignée
    // `sans_chaise_designee` tient son courrier jusqu'à une désignation.
    const lineages = listLineages(db).map((l) => {
      const resolution = resolveRecipient(db, l.lineage);
      const designee = resolution.kind === "lineage" ? resolution.targets[0]?.id || null : null;
      return { ...l, chaise_designee: designee, sans_chaise_designee: resolution.kind === "ambigu" };
    });
    const designeeDe = new Map(lineages.map((l) => [l.lineage, l.chaise_designee]));
    // La fiche lisible (Task 8) s'ajoute par-dessus : elle ne retire rien.
    const peers = pairs.map((p) => (p.instance_session_id && p.lineage
      ? { ...p, chaise_designee: designeeDe.get(p.lineage) === p.id }
      : p)).map(ficheLisible);
    const registered = new Set(peers.map((peer) => peer.id));
    // Le roster de préparation n'est plus une liste de destinataires : servir un
    // nom que personne ne porte, c'est faire écrire des lettres mortes.
    const roster = DEFAULT_ROSTER.map((id) => ({
      id,
      registered: registered.has(id)
    }));
    // On dit CE QU'ON MONTRE : une liste de trois chaises et une liste de
    // quarante-trois se ressemblent trop pour qu'on laisse deviner laquelle
    // on vient de rendre.
    return jsonToolResult({ self: selfId(), peers, aliases, lineages, roster, include_dead: includeDead });
  }
);

server.registerTool(
  "unregister",
  {
    description: "Mark a stale VALXOS Messenger peer offline. Camp B: the row is never deleted.",
    inputSchema: {
      id: z.string()
    }
  },
  async ({ id }) => {
    // N1 (seconde passe adverse) : une chaise ne se retire que par elle-même
    // (sa fiche la dérive) ou quand son processus est mort.
    const qui = identiteDuServeur();
    const verdict = verdictDeDesinscription(db, id, { appelant: qui.chaise ? qui.id : null });
    if (!verdict.autorise) {
      const derive = qui.chaise ? qui.id : qui.nu;
      const chaise = String(id).trim();
      recordEvent(db, null, derive, "desinscription_refusee", { id: chaise, derivee: derive, raison: verdict.raison, guichet: "unregister" });
      journaliserRefusUneFois(derive, {
        raison: "desinscription-d-une-chaise-vivante",
        sessionId: chaise.slice(chaise.indexOf(SEPARATEUR_INSTANCE) + SEPARATEUR_INSTANCE.length),
        agentId: null,
        pid: process.ppid
      });
      return jsonToolResult({ unregistered: false, refus: "desinscription-refusee", id: chaise, derivee: derive, raison: verdict.raison });
    }
    const result = unregisterPeer(db, id, { par: qui.chaise ? qui.id : qui.nu, raison: verdict.raison });
    if (!result) return textToolResult(`Peer not found: ${id}`);
    return jsonToolResult({ unregistered: true, peer: result });
  }
);

server.registerTool(
  "send",
  {
    // Claude Code ≥ 2.1.287 diffère les outils MCP derrière la recherche d'outils ;
    // les hooks et les skills demandent au modèle d'appeler `inbox`, `send` et
    // `ack` sans détour : ces trois-là se chargent toujours.
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "Send a durable message to another VALXOS Messenger peer — or, with to: table:<name>, one letter to every member "
      + "of that table (each with its own msg_id and acknowledgement, linked by envoi_id). A letter to a name no one has "
      + "ever carried is still posted: attente.motif is destinataire-inconnu and attente.suggestions lists close names "
      + "in service; if it is still waiting after VALXOS_RETOUR_APRES_S (900 s by default), the Facteur sends you a calm "
      + "status letter from facteur (return to sender), and the original stays in the office.",
    inputSchema: {
      to: z.string().describe(
        "A peer address (lineage, lineage#session, lineage@name, a card) — or table:<name> to post one letter to every member of that table, each with its own msg_id and acknowledgement."
      ),
      from: z.string().optional().describe(
        "Sender name. Defaults to this session's derived identity. A different name is VERIFIED like a declared self (your lineage, your old names, a human address that leads to you — never another session's chair); otherwise the send is refused (refus: \"expediteur-refuse\") and nothing is posted. An accepted name other than your own lineage is posted as your derived identity."
      ),
      subject: z.string().optional(),
      body: z.string(),
      thread_id: z.string().optional(),
      priority: z.enum(["low", "normal", "high", "critical"]).optional(),
      msg_type: z.enum(["message", "task", "response", "status"]).optional(),
      msg_id: z.string().optional()
        .describe("Idempotency key. Resending with the same msg_id never creates a second letter."),
      sender_model: z.string().optional()
        .describe("Model tag of the sender, as declared by the sender. Leave empty when unknown."),
      reveiller: z.array(z.string()).optional()
        .describe("Table sends only: members to wake whatever the table's or their own wake rule (50 names of 200 characters at most; beyond, refus: parametre-invalide)."),
      hors_enclos: z.boolean().optional()
        .describe("Step out of your enclosure (valxos-table enclos) for this send. Without it, a recipient outside the enclosure refuses the whole send (refus: hors-enclos) and nothing is written.")
    }
  },
  async ({ to, from, subject, body, thread_id, priority, msg_type, msg_id, sender_model, reveiller, hors_enclos }) => {
    const qui = identiteDuServeur();
    const expediteur = expediteurVerifie(qui, from, "send");
    if (expediteur.refus) return expediteur.refus;
    const { sender, estAMoi, sansChaise } = expediteur;
    const sender_chaise = chaiseDe(qui);

    // ── LA TABLE (1.1.0) : une lettre par membre, par le guichet ────────────
    // Pas de `posterSousUneClefASoi` ici : la clef, si elle est donnée, devient
    // `<msg_id>#<adresse>` par membre au guichet — qui la passe lui-même par
    // `posterSousUneClefASoi`, membre par membre (F12).
    const nomDeTable = nomDeTableDe(to);
    if (nomDeTable !== null) {
      let envoi;
      try {
        envoi = await posterAUneTable(db, {
          sender,
          sender_chaise,
          table: nomDeTable,
          subject,
          body,
          thread_id,
          priority,
          msg_type,
          msg_id,
          sender_model,
          reveiller: reveiller || [],
          hors_enclos: hors_enclos === true
        });
      } catch (erreur) {
        journaliserLesSonneries(sender, erreur?.lettres_ecrites);
        const refus = refusDeTable(erreur, { sent: false, table: borneLEcho(erreur?.table ?? nomDeTable), ...sansChaise });
        if (refus) return refus;
        throw erreur;
      }
      journaliserLesSonneries(sender, envoi.lettres);
      return jsonToolResult({
        sent: true,
        table: envoi.table,
        envoi_id: envoi.envoi_id,
        count: envoi.count,
        results: envoi.lettres.map((lettre) => lettreDeTableRendue(lettre, envoi.envoi_id)),
        ...sansChaise
      });
    }

    // Aucune maison fournie : le guichet paie SON scan pour cette lettre-là
    // (C1 — un par appel de `send`, c'est la loi d'ici).
    // F12 (28/09) : jamais sous la clef d'un tiers — la ligne d'autrui (son
    // destinataire, son seq) ne revient pas au posteur ; la clef est écartée.
    // L'ENCLOS (1.1.0) : le guichet refuse avant d'écrire ; le refus se rend.
    let poste;
    try {
      poste = await posterSousUneClefASoi(db, {
        msg_id,
        sender,
        sender_chaise,
        recipient: to,
        subject,
        body,
        thread_id,
        priority,
        msg_type,
        sender_model,
        hors_enclos: hors_enclos === true
      }, { estAMoi });
    } catch (erreur) {
      const refus = refusDeTable(erreur, { sent: false, recipient: borneLEcho(to), ...sansChaise });
      if (refus) return refus;
      throw erreur;
    }
    const { row, wake, attente, rejeu, ecarte, clefEcartee } = poste;
    return jsonToolResult({
      sent: true,
      msg_id: row.msg_id,
      seq: row.seq,
      recipient: row.recipient,
      wake,
      ...sansChaise,
      ...(attente ? { attente } : {}),
      // ④ — l'annonce du rejeu vient du GUICHET, elle ne se recalcule plus ici.
      // La FORME rendue au client ne bouge pas d'un octet ; seul l'endroit où
      // le fait est établi change, pour que la troisième surface l'hérite au
      // lieu de la recopier une troisième fois.
      ...(rejeu ? { rejeu } : {}),
      // ⑧ — A8 VAUT POUR CETTE SURFACE AUSSI. Un rejeu qui jette le corps que
      // le client vient d'écrire ne peut pas répondre `sent:true` tout court.
      // Le champ n'existe QUE quand quelque chose a réellement été perdu : sur
      // un envoi neuf comme sur un renvoi idempotent honnête, la réponse est
      // rigoureusement celle d'avant ce remède.
      ...(ecarte ? { ecarte } : {}),
      ...(clefEcartee ? { clef_ecartee: { demandee: clefEcartee, motif: "clef-deja-prise" } } : {})
    });
  }
);

server.registerTool(
  "broadcast",
  {
    description: "Broadcast on VALXOS Messenger: send a message to every lineage that has a registered peer. No peers means no letters.",
    inputSchema: {
      from: z.string().optional().describe("Sender name, verified like send.from."),
      subject: z.string().optional(),
      body: z.string(),
      thread_id: z.string().optional(),
      priority: z.enum(["low", "normal", "high", "critical"]).optional(),
      sender_model: z.string().optional()
        .describe("Model tag of the sender, as declared by the sender. Leave empty when unknown."),
      hors_enclos: z.boolean().optional()
        .describe("Step out of your enclosure (valxos-table enclos) for this broadcast; without it, one recipient outside the enclosure refuses the whole broadcast before any letter is written.")
    }
  },
  async ({ from, subject, body, thread_id, priority, sender_model, hors_enclos }) => {
    const qui = identiteDuServeur();
    const expediteur = expediteurVerifie(qui, from, "broadcast");
    if (expediteur.refus) return expediteur.refus;
    const { sender, sansChaise } = expediteur;
    const sender_chaise = chaiseDe(qui);
    // Une lettre par LIGNÉE, jamais une par chaise, et aucune vers un nom que
    // personne ne porte : plus de repli vers un roster de préparation.
    const targets = broadcastRecipients(db, sender);
    // L'ENCLOS (1.1.0) : TOUT l'envoi se refuse AVANT la première lettre. Le
    // guichet refuserait lettre par lettre — les premières déjà écrites quand la
    // troisième refuse. La même règle, posée une fois sur la liste entière, sous
    // les mêmes formes de l'expéditeur que le guichet (sa chaise comprise).
    const enclos = verifierEnclos(db, sender, targets, { horsEnclos: hors_enclos === true, chaiseId: sender_chaise });
    if (enclos) {
      const motif = enclos.refus === "enclos-conflit" ? MOTIF_CONFLIT : MOTIF_ENCLOS;
      return jsonToolResult({ broadcast: false, count: 0, results: [], ...enclos, motif, ...sansChaise });
    }
    const results = [];
    // UN SEUL scan des maisons pour TOUTE la diffusion (C1) : les maisons ne
    // changent pas d'une cible à l'autre dans le MÊME appel. On le calcule ici
    // et on le TEND à chaque lettre — le guichet le réutilise au lieu d'en
    // refaire un. La résolution, elle, reste par lettre (C2) : le guichet en
    // fait une par cible, jamais une partagée entre deux destinataires.
    const maisons = scannerSansCasser();
    for (const to of targets) {
      // La loi actée : toute lettre qui ATTENDRA prévient son posteur — le
      // broadcast n'y échappait pas moins qu'un send.
      let poste;
      try {
        poste = await posterUneLettre(
          db,
          {
            sender,
            sender_chaise,
            recipient: to,
            subject,
            body,
            thread_id,
            priority,
            msg_type: "broadcast",
            sender_model,
            hors_enclos: hors_enclos === true
          },
          { maisons }
        );
      } catch (erreur) {
        // Un enclos posé PENDANT la diffusion (entre deux réveils) : le guichet
        // refuse cette lettre-ci, les précédentes sont parties — la réponse les
        // rend, jamais « rien d'écrit ».
        const refus = refusDeTable(erreur, { broadcast: false, count: results.length, results, interrompu: results.length > 0, ...sansChaise });
        if (refus) return refus;
        throw erreur;
      }
      const { row, wake, attente } = poste;
      results.push({ to, msg_id: row.msg_id, seq: row.seq, wake, ...(attente ? { attente } : {}) });
    }
    return jsonToolResult({
      broadcast: true,
      count: results.length,
      results,
      ...sansChaise
    });
  }
);

server.registerTool(
  "inbox",
  {
    // Toujours chargé, comme `send` et `ack` (raison : voir `send`).
    _meta: { "anthropic/alwaysLoad": true },
    description: "Read unread VALXOS Messenger messages for this peer. By default this marks them delivered to avoid Stop-hook loops. A declared `self` is verified against this session's own derived identity before it is trusted. When `self` is a chair (lineage#session), letters to its lineage that belong to another (designated) chair are listed once under `copies`, flagged cc: true with chaise_designee — never delivered, never yours to ack. One result stays under 16,000 bytes, so the client shows it whole: when mail does not fit, the oldest letters that fit are shown and marked, and a closing line says how many wait and to call `inbox` again with `after`; a letter too long for one result is read part by part with `msg_id` and `offset`, and marked delivered once every part has been shown.",
    inputSchema: {
      self: z.string().optional().describe(
        "LEGACY. Identity should come from this session, not from the call. A declared name is VERIFIED against the derived identity's own family (itself, its lineage, or any address that resolves back to it — an old name, a human address) before it is trusted — a name outside that family is refused, never silently honored. A chair (lineage#session) can be declared for inbox and ack only when this session's own session file derives that same chair."
      ),
      limit: z.number().int().min(1).max(100).optional(),
      include_injected: z.boolean().optional(),
      mark_delivered: z.boolean().optional(),
      after: z.number().int().min(0).optional().describe(
        "Only letters whose seq is greater than this: the cursor a closing line gives when more letters wait."
      ),
      msg_id: z.string().optional().describe(
        "Read this one letter (or cc copy), part by part when it is long; `limit`, `after` and `include_injected` are then ignored."
      ),
      offset: z.number().int().min(0).optional().describe(
        "With `msg_id`: where the part starts in the letter's body (the `next_offset` a previous part gave)."
      )
    }
  },
  async ({ self, limit, include_injected, mark_delivered, after, msg_id, offset }) => {
    const qui = identiteDuServeur();
    if (qui.refus) return refusDeChaise(qui, { self: null, count: 0, messages: [] });
    const derive = qui.id;
    const declarationDeChaise = refusDeChaiseDeclaree(qui, declarationResolue(qui, self));
    const identite = declarationDeChaise
      ? { autorise: false, declare: String(self).trim(), raison: declarationDeChaise }
      : verifierIdentiteDeclaree(db, derive, declarationResolue(qui, self));
    if (!identite.autorise) {
      // D3 H1-1 : on refuse poliment, on journalise, on ne lève jamais. Le
      // courrier n'est même pas ouvert — un nom qu'on n'a pas le droit de
      // porter ne donne droit à AUCUN regard sur la boîte de quiconque.
      recordEvent(db, null, derive, "accuse_refuse", {
        refus: "accuse-refuse",
        declare: identite.declare,
        derivee: derive,
        raison: identite.raison,
        guichet: "inbox"
      });
      return jsonToolResult({
        refus: "releve-refusee",
        motif: "only the recipient collects its mail",
        declare: identite.declare,
        derivee: derive,
        origine: origineDuNomDerive(),
        raison: identite.raison
      });
    }

    const id = identite.declare || ensureSelf(qui);
    // `msg_id` cherche la lettre elle-même (filtre dans la requête), sans curseur, même derrière 100 plus anciennes.
    const uneLettre = msg_id !== undefined;
    const borne = uneLettre ? 100 : limit || 20;
    const includeInjected = uneLettre || include_injected !== false;
    const apres = uneLettre ? null : after ?? null;
    const msgIdCherche = uneLettre ? String(msg_id) : null;
    let rows;
    let cc = null;
    let montrerCopies = false;
    let raisonNu = null;
    if (qui.chaise && id === qui.id) {
      // La boîte d'une CHAISE est celle que ses hooks relèvent : sa lignée
      // quand elle lui revient, ses chaises, son nom humain, ses anciens noms.
      const parSeq = new Map();
      for (const adresse of adressesDuRepli(db, qui.lignee, { session_id: qui.sessionId })) {
        for (const row of listInbox(db, adresse, { limit: borne, includeInjected, apres, msgId: msgIdCherche })) parSeq.set(row.seq, row);
      }
      rows = [...parSeq.values()].sort((a, b) => a.seq - b.seq).slice(0, borne);
      cc = copiesPourChaise(db, qui.lignee, qui.sessionId, { limit: borne, msgId: msgIdCherche });
      montrerCopies = true;
    } else {
      rows = listInbox(db, id, { limit: borne, includeInjected, apres, msgId: msgIdCherche });
      const coupe = id.indexOf(SEPARATEUR_INSTANCE);
      if (coupe > 0) {
        cc = copiesPourChaise(db, id.slice(0, coupe), id.slice(coupe + SEPARATEUR_INSTANCE.length), { limit: borne, msgId: msgIdCherche });
        montrerCopies = true;
      } else {
        // Un client SANS chaise (lignée nue) : la lettre de sa lignée tenue
        // par une chaise DÉSIGNÉE vivante n'est pour lui qu'une copie (fix 1,
        // sonde 7). Un client solo ne voit aucune différence, forme comprise.
        cc = copiesSansChaise(db, id, { limit: borne, msgId: msgIdCherche });
        if (cc.chaiseDesignee) {
          rows = rows.filter((row) => row.recipient !== id);
          montrerCopies = true;
        }
        // Fix round 3 : une adresse qui mène à une chaise de session (une
        // seule, ou plusieurs — lignée ambiguë) ne se relève pas en
        // propriétaire par un nom nu. La boîte est vide et dit pourquoi.
        raisonNu = nomNuTenuParUneChaise(db, id, derive);
        if (raisonNu) rows = rows.filter((row) => row.recipient !== id);
      }
    }
    const marquer = mark_delivered !== false;
    const formes = formesDuLecteur(qui, id, derive);
    // LA COPIE CC (Run 6, Task 7) : quand le nom relevé est une CHAISE
    // (`lignée#session`), le courrier de SA lignée qui est à une autre chaise
    // (ou tenu, sans chaise désignée) se montre à part, marqué cc — une fois,
    // jamais livré, jamais accusable par elle (`ackMessage` le refuse).
    const enCopies = (liste) => decorerLesLettres(liste, formes).map((row) => ({
      ...row,
      cc: true,
      chaise_designee: cc.chaiseDesignee,
      sans_chaise_designee: cc.sansChaiseDesignee,
      note: "Copy for your information, NOT addressed to this session: do not ack it and do not answer as its recipient."
    }));
    // LA RELÈVE SOUS BUDGET (1.1.0, Tâche 7, tour des réserves). Mesuré sur un vrai Claude Code
    // (2.1.330) : un résultat de 17 119 caractères arrive entier, ceux de 68 344 et 180 272 sont rangés
    // dans un fichier et le modèle n'en lit rien — pendant que cet outil tamponnait tout
    // `mcp_inbox_delivered`. Un résultat tient maintenant dans BUDGET_RESULTAT_INBOX octets
    // (budget-courrier.js) ; seul ce qui est montré entier est marqué livré (ou vu, pour une copie).
    // Sous le budget, le résultat est celui d'avant, à l'octet. Au-dessus : le plus long début de la
    // boîte qui tient, la clé `waiting` et une ligne de suite (un second bloc de texte) qui dit combien
    // attendent et le curseur `after`. Une lettre trop longue pour un seul résultat se lit par parties
    // (`msg_id`, `offset`) ; chaque partie montrée se journalise (`partie_lue`), et la lettre n'est
    // marquée livrée que quand toutes ses parties l'ont été.
    const composer = ({ lettres, copies, suite = null, partie = null }) => {
      const valeur = {
        self: id,
        count: lettres.length,
        messages: decorerLesLettres(lettres, formes),
        ...(montrerCopies ? { copies: enCopies(copies) } : {}),
        ...(raisonNu ? { raison: raisonNu } : {}),
        ...(suite ? { waiting: { letters: suite.lettres, copies: suite.copies, after: suite.apres } } : {})
      };
      const ligne = ligneDeSuiteDeLaReleve({ ...(suite || {}), partie });
      const contenu = jsonToolResult(valeur).content;
      return ligne ? [...contenu, { type: "text", text: ligne }] : contenu;
    };
    const copiesEnMain = montrerCopies ? cc.rows : [];
    const relire = db.prepare("SELECT * FROM messages WHERE seq = ?");
    const toutLue = (msgId, taille) => {
      const parties = db
        .prepare("SELECT detail_json FROM delivery_events WHERE msg_id = ? AND agent_id = ? AND event_type = 'partie_lue'")
        .all(msgId, id)
        .map((e) => { try { return JSON.parse(e.detail_json); } catch { return null; } })
        .filter((d) => d && Number.isInteger(d.debut) && Number.isInteger(d.fin))
        .sort((a, b) => a.debut - b.debut);
      let couvert = 0;
      for (const d of parties) {
        if (d.debut > couvert) return false;
        couvert = Math.max(couvert, d.fin);
      }
      return couvert >= taille;
    };
    // Une partie d'une lettre (ou d'une copie). Elle se montre dans l'état de la base AVANT cet appel ;
    // `next_offset` null dit que c'était la dernière.
    const lirePartie = ({ row, copie, debut = 0, suite = null }) => {
      const corps = String(row.body ?? "");
      const composerLaPartie = (d, f) => {
        const page = { ...row, body: corps.slice(d, f), body_offset: d, body_chars: corps.length, next_offset: f < corps.length ? f : null };
        return composer({ lettres: copie ? [] : [page], copies: copie ? [page] : [], suite, partie: { fin: f, taille: corps.length } });
      };
      const partie = partieSousLeBudget({ corps, debut, composerLaPartie });
      if (!partie) {
        // Revue de la tâche 7 : le refus garde la SUITE (`waiting`, la ligne de suite, `after` = le
        // `seq` de cette lettre) et dit ce `seq` — son `msg_id` peut être le champ démesuré lui-même.
        // Il ne renvoie à aucune commande qui marquerait livré ce que personne n'a vu.
        const valeur = {
          self: id,
          count: 0,
          messages: [],
          ...(montrerCopies ? { copies: [] } : {}),
          refus: "entete-trop-grande",
          seq: row.seq,
          note: "This letter's header alone (its msg_id, sender or subject) is larger than one result can carry, so no part of it can be shown here; it is not marked delivered and stays waiting.",
          ...(suite ? { waiting: { letters: suite.lettres, copies: suite.copies, after: suite.apres } } : {})
        };
        const ligne = ligneDeSuiteDeLaReleve({ ...(suite || {}) });
        const contenu = jsonToolResult(valeur).content;
        return { content: ligne ? [...contenu, { type: "text", text: ligne }] : contenu };
      }
      let livree = false;
      if (marquer) {
        db.transaction(() => {
          recordEvent(db, row.msg_id, id, "partie_lue", { debut: partie.debut, fin: partie.fin, taille: partie.taille });
          if (!toutLue(row.msg_id, partie.taille)) return;
          if (copie) marquerCopiesVues(db, [row], cc.chaiseId, { via: "mcp_inbox" });
          else markDelivered(db, [row], id, "mcp_inbox_delivered", { acteurReel: derive });
          livree = !copie;
        })();
      }
      if (livree) resetStopGuard(id);
      return { content: composerLaPartie(partie.debut, partie.fin) };
    };
    if (uneLettre) {
      const cible = String(msg_id);
      const lettre = rows.find((row) => row.msg_id === cible);
      const copie = lettre ? null : copiesEnMain.find((row) => row.msg_id === cible);
      if (!lettre && !copie) {
        return jsonToolResult({
          self: id,
          count: 0,
          messages: [],
          note: "No unread letter with this msg_id in this mailbox."
        });
      }
      return lirePartie({ row: lettre || copie, copie: Boolean(copie), debut: offset ?? 0 });
    }
    // La marque avant la forme, comme aux crochets : on choisit sur la forme que la base aura APRÈS
    // la marque (même instant, même compte de re-service), puis, d'un seul tenant, on marque ce qui a
    // été choisi, on relit, on met en forme et on mesure. Un autre processus qui a changé une lettre
    // entre-temps fait annuler la marque, et le choix se refait une fois, plus petit.
    const instant = nowIso();
    const aVenir = (row) => (marquer
      ? { ...row, delivered_at: instant, reservices: Number(row.reservices ?? 0) + (row.delivered_at ? 1 : 0) }
      : row);
    const originales = new Map(rows.map((row) => [row.seq, row]));
    let marge = 0;
    for (let essai = 0; essai < 2; essai += 1) {
      const choix = choisirPourLaReleve({
        lettres: rows.map(aVenir),
        copies: copiesEnMain,
        composer,
        budget: BUDGET_RESULTAT_INBOX - marge
      });
      if (choix.longue) {
        const { row, copie } = choix.longue;
        return lirePartie({ row: copie ? row : originales.get(row.seq), copie, suite: choix.suite });
      }
      let contenu = null;
      let exces = 0;
      try {
        db.transaction(() => {
          if (marquer && choix.lettres.length > 0) {
            // acteurReel (remède de la revue adverse #4) : `id` peut être plus large que la session
            // qui a VRAIMENT appuyé sur la touche (une chaise signe pour SA
            // lignée) — `derive` reste dans le detail_json même sur ce chemin
            // AUTORISÉ, pour que l'attribution ne puisse jamais se maquiller.
            markDelivered(db, choix.lettres, id, "mcp_inbox_delivered", { acteurReel: derive, at: instant });
          }
          if (marquer && choix.copies.length > 0) marquerCopiesVues(db, choix.copies, cc.chaiseId, { via: "mcp_inbox" });
          // La relève vient de poser delivered_at EN BASE : les objets JS d'avant
          // la marque mentiraient. L'état affiché est celui de la base APRÈS
          // l'effet de bord de cet appel — on relit chaque lettre, dans le même
          // ordre. (Même doctrine que valxos-inbox.js, un correctif antérieur.)
          const lettres = choix.lettres.map((row) => (marquer ? relire.get(row.seq) : null) || originales.get(row.seq) || row);
          contenu = composer({ lettres, copies: choix.copies, suite: choix.suite });
          const taille = tailleDuContenu(contenu);
          if (taille > BUDGET_RESULTAT_INBOX) {
            exces = taille - BUDGET_RESULTAT_INBOX;
            throw DEPASSEMENT_DE_LA_RELEVE;
          }
        })();
      } catch (erreur) {
        if (erreur !== DEPASSEMENT_DE_LA_RELEVE) throw erreur;
        marge += exces;
        continue;
      }
      // Le verrou d'arrêt est tenu sous le nom de la CHAISE quand il y en a
      // une (F4, comme aux hooks : `lignée#session`), sous la lignée nue
      // sinon — `id` est exactement ce nom-là.
      if (marquer && choix.lettres.length > 0) resetStopGuard(id);
      return { content: contenu };
    }
    return jsonToolResult({ self: id, count: 0, messages: [], note: "The mail changed while it was read; call inbox again." });
  }
);

const DEPASSEMENT_DE_LA_RELEVE = Symbol("depassement-de-la-releve");

server.registerTool(
  "history",
  {
    description:
      "Show VALXOS Messenger message history with a peer or thread. A declared `self` is verified against this session's own derived identity before it is trusted — `peer` stays free (it filters whose correspondence with YOU, not who you are).",
    inputSchema: {
      self: z.string().optional().describe(
        "LEGACY. Identity should come from this session, not from the call. A declared name is VERIFIED against the derived identity's own family (itself, its lineage, or any address that resolves back to it — an old name, a human address) before it is trusted — a name outside that family is refused, never silently honored. A chair (lineage#session) can be declared for inbox and ack only when this session's own session file derives that same chair."
      ),
      peer: z.string().optional(),
      thread_id: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional()
    }
  },
  async ({ self, peer, thread_id, limit }) => {
    // L'historique garde la lignée nue d'avant (hors du périmètre du fix 1 :
    // il ne livre ni n'accuse rien). Une chaise ne recrée pas de fiche nue.
    const qui = identiteDuServeur();
    if (qui.refus) return refusDeChaise(qui, { self: null });
    const derive = qui.nu;
    // S-codes (cinquième passe adverse) : un `self` déclaré se vérifie EN
    // PREMIER. Le sien (sa chaise, ou sa lignée nue) ne change rien. Une autre
    // chaise — une sœur vivante ou hors service — ou un nom que la garde de
    // famille refuse (`verifierIdentiteDeclaree`, la même qu'`inbox`) rend
    // TOUJOURS `identite-refusee`, et rien n'est rendu. Un nom de la famille
    // (un ancien nom aliasé) choisit la correspondance relue, jamais le lecteur.
    const declareBrut = String(self ?? "").trim();
    let declare = null;
    if (declareBrut && declareBrut !== qui.id && declareBrut !== qui.nu) {
      const identite = declareBrut.includes(SEPARATEUR_INSTANCE)
        ? { autorise: false, raison: "a declared chair that is not this session's own chair" }
        : verifierIdentiteDeclaree(db, derive, declareBrut);
      if (!identite.autorise) {
        recordEvent(db, null, derive, "accuse_refuse", {
          refus: "identite-refusee",
          declare: declareBrut,
          derivee: qui.id,
          raison: identite.raison,
          guichet: "history"
        });
        return jsonToolResult({
          ok: false,
          refus: "identite-refusee",
          motif: "history reads as this session's own identity: a declared self may be this session's chair or its lineage, or a name of its family, never another chair",
          declare: borneLEcho(declareBrut),
          derivee: qui.id,
          origine: origineDuNomDerive(),
          raison: identite.raison
        });
      }
      declare = identite.declare || declareBrut;
    }

    const id = declare || (qui.chaise ? qui.nu : ensureSelf(qui));
    // Fix round 3 : un appelant sans chaise ne relit pas en propriétaire la
    // correspondance d'une adresse tenue par une chaise de session.
    const raisonNu = qui.chaise ? null : nomNuTenuParUneChaise(db, id, derive);
    if (raisonNu) return jsonToolResult({ messages: [], raison: raisonNu });
    // S19 : une chaise relit TOUTE sa correspondance — ce qui est à sa lignée
    // ou à elle, ce qu'elle a posté sous l'une ou l'autre —, déclarée ou non.
    const noms = declare ? [declare] : qui.chaise ? [qui.nu, qui.id] : [id];
    // S14 : une lettre fermée que ce lecteur ne lit pas (ni destinataire, ni chaise expéditrice, ni
    // membre de sa table) est omise — une chaise sœur ne la lit pas sous la lignée nue. R1 : le
    // lecteur est l'identité DÉRIVÉE de cette session (sa chaise, sinon son nom nu), jamais le nom
    // déclaré, qui ne choisit que la correspondance relue.
    const formes = formesDeLAppelant(qui, qui.id);
    return jsonToolResult({
      messages: decorerLesLettres(history(db, {
        self: noms,
        peer,
        thread_id,
        limit: limit || 50,
        lecteur: { formes, chaise: chaiseDe(qui) }
      }), formes)
    });
  }
);

// L'accusé est le seul geste terminal du dépôt : signer le courrier d'un autre,
// c'est le faire disparaître. `ackMessage` refuse toute signature qui n'est ni
// celle du destinataire, ni celle de sa lignée — ET, depuis G1, `self` lui-même
// est vérifié avant d'être servi à `ackMessage` : voir `verifierIdentiteDeclaree`.
//
// LA RÈGLE D'AUJOURD'HUI (fixes des 27 et 28/09 ; le récit du résidu qu'ils ont
// fermé est au CHANGELOG, « A declared `self` naming a chair is honoured only
// when… » — le code ne garde que ce qui est vivant) :
//
// 1. QUI PARLE. Quand le harnais qui nous a lancés a une fiche de session
//    (`sessions/<ppid>.json`), `identiteDuServeur` rend la CHAISE
//    (`lignée#session`) ; un client sans fiche (Antigravity, Gemini CLI, Codex)
//    garde la lignée NUE que dérive son environnement (`deriveSelf`). Un
//    processus REFUSÉ comme chaise (jumeau, fiche d'une autre session) ne
//    retombe jamais sur la lignée nue : il ne relève et n'accuse rien. Un nom
//    nu n'agit jamais en propriétaire d'une adresse qui mène à une chaise
//    vivante de session, désignée ou non (`gardeDeLaCopie`,
//    `signataireNuVersUneChaise`, database.js ; F3, 28/09).
//
// 2. `self` RESTE ACCEPTÉ (compat), comme une DEMANDE VÉRIFIÉE et jamais comme
//    une identité. `verifierIdentiteDeclaree` rejoue `droitDAccuser`,
//    DESTINATAIRE ET SIGNATAIRE INVERSÉS : « la session dérivée a-t-elle le
//    droit de porter le nom qu'elle déclare ? ». Un nom hors de sa famille
//    (elle-même, sa lignée, une chaise de sa lignée, ou toute adresse que la
//    résolution lui ramène — ancien nom, adresse humaine) est REFUSÉ
//    (`refus: "accuse-refuse"`), journalisé (`accuse_refuse`), jamais honoré en
//    silence, et la lettre n'est même pas ouverte. Pour `inbox` et `ack`, une
//    CHAISE déclarée n'est honorée que si la fiche de CE serveur dérive cette
//    chaise-là : `refusDeChaiseDeclaree` (28/09) ferme le cas d'une lignée qui
//    déclarait la chaise d'une sœur. `history` vérifie sous la lignée nue, et la
//    base refuse au nom nu toute adresse qui mène à une chaise vivante. Un écart
//    entre un nom déclaré légitime et le nom dérivé laisse un reçu distinct
//    (`accuse_identite_declaree`).
//
// 3. `mcp.json` NE POSE PAS d'identité. Dans une maison qui n'en exporte pas,
//    le nom dérivé est le NOM D'HÔTE, et tout accusé non déclaré est refusé
//    (l'`inbox` de cette maison est déjà vide pour la même raison). On ne
//    devine pas un nom à la place de l'opérateur — mais un refus dit d'où vient
//    le nom qu'on lui a opposé : c'est `origine` dans la réponse de refus.
//    Corriger la cause demande la configuration du harnais, hors de ce serveur.
server.registerTool(
  "ack",
  {
    // Toujours chargé, comme `send` et `inbox` (raison : voir `send`).
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "Acknowledge a VALXOS Messenger message as handled. This is the only terminal gesture: only the recipient, a live instance of the recipient lineage, or the lineage of the recipient chair may sign it. A declared `self` is verified against this session's own derived identity before it is trusted. A refusal is either an identity-guard refusal (`refus: \"accuse-refuse\"`, the declared `self` isn't yours to claim) or a per-letter refusal (`refuse: true`, `refus: \"accuse-refuse-lettre\"` — your identity is legitimate but not this letter's recipient); either way `acked` stays false and the letter is untouched. A chair cannot ack a letter to its lineage that is only a cc copy for it (the lineage's designated chair holds it, or none is designated yet). A caller without a chair (bare lineage name) cannot ack a lineage letter that the lineage routes to one live session chair, designated or not: that chair signs it. A process refused as its session's chair (refus: \"chaise-refusee\", a twin) acks nothing.",
    inputSchema: {
      msg_id: z.string().describe(
        "The letter's msg_id (shown as `id=` in the delivery). The `Receipt:` id the Facteur prints above a letter it carried is accepted too."
      ),
      self: z.string().optional().describe(
        "LEGACY. Identity should come from this session, not from the call. A declared name is VERIFIED against the derived identity's own family (itself, its lineage, or any address that resolves back to it — an old name, a human address) before it is trusted — a name outside that family is refused, never silently honored. A chair (lineage#session) can be declared for inbox and ack only when this session's own session file derives that same chair — then still checked against the letter's recipient."
      )
    }
  },
  async ({ msg_id: identifiantDonne, self }) => {
    const qui = identiteDuServeur();
    const derive = qui.id;
    const origine = origineDuNomDerive();

    // L'identifiant montré à la remise (`Receipt: <uuid>`, l'identifiant de la
    // tentative du Facteur) se résout en `msg_id` AVANT tout le reste : la garde
    // d'identité, la règle de la sœur et le journal ne voient que le `msg_id`.
    const lettreTrouvee = getMessageByAnyId(db, identifiantDonne);
    const msg_id = lettreTrouvee ? lettreTrouvee.msg_id : identifiantDonne;

    // L'existence AVANT l'identité : on ne journalise jamais un refus sur un
    // msg_id qui n'a jamais été une lettre (même loi que `journaliserEcart`
    // ci-dessous — un journal peuplé de msg_id inventés est un journal qu'on
    // cesse de lire), et « Message not found » reste la seule chose vraie à
    // dire quand il n'y a rien à accuser.
    if (!lettreTrouvee) {
      return textToolResult(
        `Message not found: ${identifiantDonne} (acknowledge with the msg_id shown as \`id=\` in the delivery)`
      );
    }
    if (qui.refus) return refusDeChaise(qui, { acked: false, msg_id });

    const declarationDeChaise = refusDeChaiseDeclaree(qui, declarationResolue(qui, self));
    const identite = declarationDeChaise
      ? { autorise: false, declare: String(self).trim(), raison: declarationDeChaise }
      : verifierIdentiteDeclaree(db, derive, declarationResolue(qui, self));
    if (!identite.autorise) {
      // D3 H1-1 : on refuse poliment, on journalise, on ne lève jamais. A9 :
      // la lettre reste intacte — un accusé refusé ne pose jamais `acked_at`,
      // elle reviendra.
      recordEvent(db, msg_id, derive, "accuse_refuse", {
        refus: "accuse-refuse",
        declare: identite.declare,
        derivee: derive,
        raison: identite.raison,
        guichet: "ack"
      });
      return jsonToolResult({
        acked: false,
        refus: "accuse-refuse",
        motif: "only the recipient signs",
        msg_id,
        declare: identite.declare,
        derivee: derive,
        origine,
        raison: identite.raison
      });
    }

    const id = identite.declare || ensureSelf(qui);

    // Le reçu d'identité déclarée ne s'écrit que sur une lettre QUI EXISTE : le
    // guichet ne journalise pas la remise d'une lettre qui n'existe pas, et un
    // journal peuplé de msg_id inventés est un journal qu'on cesse de lire.
    const journaliserEcart = () => {
      if (identite.declare && identite.declare !== derive) {
        recordEvent(db, msg_id, derive, "accuse_identite_declaree", { declaree: identite.declare, derivee: derive });
      }
    };

    try {
      const row = ackMessage(db, msg_id, id);
      if (!row) return textToolResult(`Message not found: ${identifiantDonne}`);
      journaliserEcart();
      return jsonToolResult({ acked: true, message: row });
    } catch (erreur) {
      // Un refus se rend comme un refus : ni succès muet, ni panne du guichet.
      // Ce refus-CI vient de `ackMessage` : `self` était légitime pour LA
      // SESSION dérivée (le check ci-dessus), mais pas pour CETTE lettre-là
      // (le destinataire réel diffère) — une garde distincte, pas un doublon.
      if (erreur?.code === "accuse_refuse") {
        // Un refus PROUVE que la lettre existe : le reçu a un objet.
        journaliserEcart();
        // ⚠️ DEUX VOCABULAIRES DE REFUS AU MÊME OUTIL, À UNE LETTRE D'ÉCART —
        // fix round 2 (finding réviseur, MINOR). Le refus ci-dessus (garde
        // d'identité) porte `refus: "accuse-refuse"` ; celui-ci (garde PAR
        // LETTRE d'`ackMessage` : `self` était légitime pour la SESSION, pas
        // pour CE destinataire-là) portait SEULEMENT `refuse: true` —
        // `refus` vs `refuse`, un caractère d'écart, deux sens différents, et
        // le lecteur le plus susceptible de confondre les deux est un modèle.
        // `refuse: true` RESTE (compat) ; `refus` DEVIENT le discriminateur
        // stable commun aux deux formes, avec une valeur DISTINCTE de
        // `"accuse-refuse"` pour qu'on ne confonde jamais les deux gardes en
        // le lisant seul.
        return jsonToolResult({
          acked: false,
          refuse: true,
          refus: "accuse-refuse-lettre",
          msg_id,
          signataire: id,
          derivee: derive,
          origine,
          destinataire: erreur.destinataire,
          raison: erreur.raison
        });
      }
      throw erreur;
    }
  }
);

// ── LES TABLES (1.1.0) ───────────────────────────────────────────────────────
server.registerTool(
  "tables",
  {
    description:
      "List VALXOS Messenger tables: the tables you are a member of under one of your names (lineage, chair, human "
      + "address) — membre: true, you post to them with send to table:<name> — plus the open tables you are not a member "
      + "of — membre: false, to discover them; join one with table_manage add, then post. A closed table is listed only "
      + "to its members. Each table carries its members, its wake rule (reveil / prochain-tour), its mode (normal / "
      + "direct), its shared position and mon_reveil, the wake rule that applies to you (null when you are not a member).",
    inputSchema: {}
  },
  async () => {
    const qui = identiteDuServeur();
    if (qui.refus) return refusDeChaise(qui, { self: null, tables: [] });
    const sender = ensureSelf(qui);
    const formes = formesDeLAppelant(qui, sender);
    // Celles (fermées comprises) dont une forme de l'appelant est membre, et les
    // ouvertes à découvrir — une fois chacune, triées par nom ; `membre` dit
    // lesquelles reçoivent son `send`.
    const parNom = new Map();
    for (const table of [...listerTables(db), ...listerTables(db, { adresses: formes })]) parNom.set(table.nom, table);
    const tables = [...parNom.values()]
      .sort((a, b) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0))
      .map((table) => tableRendue(table, formes));
    return jsonToolResult({ self: sender, tables });
  }
);

server.registerTool(
  "table_manage",
  {
    description:
      "Manage a VALXOS Messenger table from this session. create: a new open table (you become its first member; fermee: true "
      + "is refused here). On an OPEN table: add without adresse (or with one of your own names) joins it, remove without "
      + "adresse leaves it (retire says whether anything was removed); adding or removing another member, or setting "
      + "another member's wake rule, needs you to be a member (refus: \"pas-membre\"). reveil without adresse: your own wake "
      + "rule on any table you belong to. mode: normal or direct, on any table you belong to. position: the shared position "
      + "in the table header (120 characters), on any table you belong to. Closed tables and enclosures are a human gesture "
      + "(valxos-table): add, remove, enclos and create with fermee: true answer refus: \"table-fermee\".",
    inputSchema: {
      action: z.enum(["create", "add", "remove", "reveil", "mode", "position", "enclos"]),
      nom: z.string().describe("Table name: 1 to 32 lowercase letters, digits or hyphens"),
      adresse: z.string().optional().describe("add / remove: the member (omitted = yourself: join or leave); reveil: the member whose rule changes (omitted = yourself)"),
      reveil: z.enum(REGLES_REVEIL).optional().describe("Wake rule: reveil (wake now) or prochain-tour (quiet until the next turn)"),
      mode: z.enum(MODES).optional().describe("normal, or direct (reactions to a table letter go to the whole table without waking anyone)"),
      fermee: z.boolean().optional().describe("create only; true is refused here (valxos-table creer --fermee)"),
      position: z.string().max(LONGUEUR_POSITION).optional().describe("Shared position shown in the table header, 120 characters at most")
    }
  },
  async ({ action, nom, adresse, reveil, mode, fermee, position }) => {
    const qui = identiteDuServeur();
    const nomRendu = borneLEcho(nom);
    if (qui.refus) return refusDeChaise(qui, { ok: false, action, nom: nomRendu });
    const sender = ensureSelf(qui);
    const formes = formesDeLAppelant(qui, sender);
    const refusFermee = () => jsonToolResult({
      ok: false, refus: "table-fermee", action, nom: nomRendu,
      motif: "the members of a closed table only move by a human gesture (valxos-table); so do creating one and enclosing a sender"
    });
    // L'adresse refusée est de l'entrée recopiée : bornée, et entre guillemets
    // JSON dans la phrase.
    const refusMembre = (adresseRefusee = null) => jsonToolResult({
      ok: false, refus: "pas-membre", action, nom: nomRendu,
      ...(adresseRefusee ? { adresse: borneLEcho(adresseRefusee) } : {}),
      motif: adresseRefusee
        ? `${JSON.stringify(borneLEcho(adresseRefusee))} is not a member of this table`
        : "the caller is not a member of this table under any of its names"
    });
    // La forme sous laquelle l'appelant entre dans une table (créer, rejoindre) :
    // une CHAISE entre sous sa LIGNÉE — une table dure plus qu'une session, et
    // les autres chaises de la lignée y sont alors chez elles (leurs formes
    // portent la lignée, jamais la chaise d'une sœur).
    const formeDEntree = qui.chaise ? qui.lignee : sender;
    // B1 (passe adverse) : un paramètre que l'action EXIGE et qui manque est un
    // refus en JSON, comme les autres — jamais une phrase nue ni une erreur
    // d'outil. Une `adresse` DONNÉE mais blanche (ajouter, retirer, régler un
    // autre) manque aussi : elle ne se lit jamais comme « moi ».
    const refusParametre = (parametre, attendu) => jsonToolResult({
      ok: false, refus: "parametre-manquant", parametre, action, nom: nomRendu,
      motif: `${action} needs ${parametre}: ${attendu}`
    });
    // L'enclos est la serrure qu'un expéditeur demande à un humain : jamais d'ici.
    if (action === "enclos") return refusFermee();
    if (["add", "remove", "reveil"].includes(action) && adresse !== undefined && !String(adresse).trim()) {
      return refusParametre("adresse", "the member it concerns (omit adresse to act for yourself)");
    }
    if (action === "reveil" && !reveil) return refusParametre("reveil", "'reveil' or 'prochain-tour'");
    if (action === "mode" && !mode) return refusParametre("mode", "'normal' or 'direct'");
    if (action === "position" && position === undefined) {
      return refusParametre("position", "the text shown in the table header (120 characters at most)");
    }
    try {
      if (action === "create") {
        if (fermee === true) return refusFermee();
        // Le créateur est le premier membre : sans ça il ne pourrait pas poster
        // à la table qu'il vient d'ouvrir (`pas-membre`). Les deux gestes, ou aucun.
        const table = db.transaction(() => {
          const creee = creerTable(db, { nom, reveil: reveil ?? "reveil", mode: mode ?? "normal", creeePar: sender });
          ajouterMembre(db, creee.nom, formeDEntree, { ajoutePar: sender });
          return creee;
        })();
        return jsonToolResult({ ok: true, action, table: tableRendue(obtenirTable(db, table.nom), formes) });
      }
      const table = obtenirTable(db, validerNomDeTable(nom));
      if (!table) return jsonToolResult({ ok: false, refus: "table-inconnue", action, nom: nomRendu, motif: "no table of that name" });
      const fermeeTable = Number(table.fermee) === 1;
      const appelantMembre = () => estMembre(db, table.nom, formes);
      let retire;
      if (action === "add" || action === "remove") {
        if (fermeeTable) return refusFermee();
        const donnee = String(adresse ?? "").trim();
        // SOI-MÊME (sans adresse, ou sous une de ses formes) : rejoindre une
        // table ouverte, ou la quitter — à quiconque. UN AUTRE : réservé aux
        // membres ; sinon n'importe quelle session viderait n'importe quelle
        // table ouverte.
        const soiMeme = !donnee || formes.includes(donnee);
        if (!soiMeme && !appelantMembre()) return refusMembre();
        if (action === "add") {
          const membre = donnee || formeDEntree;
          // Ré-ajouter un membre sans `reveil` ne touche pas son réglage : la
          // règle vit au carnet (`ajouterMembre`, `reveil` omis = inchangé, pour
          // un membre actif comme pour un membre retiré qui revient).
          ajouterMembre(db, table.nom, membre, { reveil, ajoutePar: sender });
        } else {
          // Quitter sans adresse : toutes les formes sous lesquelles on est membre.
          const partants = donnee ? [donnee] : formes.filter((forme) => estMembre(db, table.nom, [forme]));
          retire = false;
          for (const partant of partants) {
            if (retirerMembre(db, table.nom, partant, { retirePar: sender })) retire = true;
          }
        }
      } else if (action === "reveil") {
        const autre = String(adresse ?? "").trim();
        // Sans adresse : moi, sous la forme qui est membre. Avec : un autre
        // membre, table ouverte seulement — le réglage d'un membre ne vaut que
        // pour lui, et sur une table fermée personne ne règle pour un autre.
        const cible = autre && !formes.includes(autre) ? autre : formes.find((forme) => estMembre(db, table.nom, [forme])) || null;
        if (!cible) return refusMembre();
        if (!formes.includes(cible) && fermeeTable) return refusFermee();
        // Le réveil d'un AUTRE : un membre seulement — un inconnu ne rend pas
        // silencieux un membre d'une table où lui-même n'écrit pas.
        if (!formes.includes(cible) && !appelantMembre()) return refusMembre();
        if (!estMembre(db, table.nom, [cible])) return refusMembre(cible);
        ajouterMembre(db, table.nom, cible, { reveil, ajoutePar: sender });
      } else {
        if (!appelantMembre()) return refusMembre();
        if (action === "mode") {
          modifierTable(db, table.nom, { mode });
        } else {
          modifierTable(db, table.nom, { position, positionPar: sender });
        }
      }
      return jsonToolResult({
        ok: true,
        action,
        ...(retire === undefined ? {} : { retire }),
        table: tableRendue(obtenirTable(db, table.nom), formes)
      });
    } catch (erreur) {
      const refus = refusDeTable(erreur, { ok: false, action, nom: nomRendu });
      if (refus) return refus;
      throw erreur;
    }
  }
);

server.registerTool(
  "envoi_status",
  {
    description:
      "Show what became of a VALXOS Messenger table send, letter by letter: the recipient, the chair the address resolves to "
      + "now (cible), the states cree / sonne / montre / accuse (timestamps; null when not reached — sonne is a successful "
      + "direct wake or the Facteur's carry (for a Codex chair, the instant of the ring that carried it), montre the first "
      + "delivery or injection, accuse the recipient's acknowledgement) and "
      + "the waiting notice (attente), and tournee: the Facteur's last attempt for the letter (state, reason, at; e.g. "
      + "reason sonnette-codex-impossible when a Codex chair could not be rung), null before any attempt. Served only to "
      + "the sender of that send. There is no \"read\" state: only an acknowledgement means seen and handled.",
    inputSchema: {
      envoi_id: z.string().describe("The envoi_id returned by send to table:<name> or by reply to a table")
    }
  },
  async ({ envoi_id }) => {
    const qui = identiteDuServeur();
    const envoiRendu = borneLEcho(envoi_id);
    if (qui.refus) return refusDeChaise(qui, { envoi_id: envoiRendu });
    const sender = ensureSelf(qui);
    const rows = lettresDUnEnvoi(db, envoi_id);
    if (rows.length === 0) return jsonToolResult({ refus: "envoi-inconnu", envoi_id: envoiRendu, motif: "no letter carries this envoi_id" });
    // L'expéditeur seul. S14 (troisième passe adverse) : quand la lettre porte
    // la chaise qui l'a postée (`sender_chaise`), c'est CETTE chaise, et elle
    // seule — une chaise sœur sous la même lignée nue n'est pas l'expéditrice ;
    // sans chaise posée, le nom posté. Une lettre d'un autre posteur sous le même
    // `envoi_id` ne se montre jamais — l'état d'un envoi ne se prête à personne.
    const formes = formesDeLAppelant(qui, sender);
    const miennes = rows.filter((row) => formes.includes(row.sender_chaise || row.sender));
    if (miennes.length === 0) {
      return jsonToolResult({ refus: "pas-expediteur", envoi_id: envoiRendu, motif: "only the sender of a table send reads its status" });
    }
    // Un seul scan des maisons pour tout l'envoi (C1) ; une résolution par
    // lettre, lue par la cible ET par l'avis (C2). Une résolution qui casse
    // coûte la cible et l'avis de CETTE lettre, jamais la réponse.
    // Les fiches Codex du scan vont à l'avis : il ne relit pas le bureau à chaque lettre.
    const { houses, parSession, fichesCodex } = scannerSansCasser();
    const sonnerie = db.prepare("SELECT event_at FROM delivery_events WHERE msg_id = ? AND event_type = 'sonnee' ORDER BY id ASC LIMIT 1");
    // B17 (marche Codex) : « montré » est la PREMIÈRE présentation. `delivered_at`
    // se réécrit à chaque service ; le journal, lui, garde chaque livraison
    // (`markDelivered` : `delivered`, `<porte>_delivered`, `porte_web_relevee`).
    // Une copie vue par une autre chaise (`cc_vu`) n'est pas une présentation.
    const premiereLivraison = db.prepare(`
      SELECT MIN(event_at) AS t FROM delivery_events
      WHERE msg_id = ?
        AND (event_type IN ('delivered', 'porte_web_relevee') OR event_type LIKE '%\\_delivered' ESCAPE '\\')
    `);
    // LA TOURNÉE (1.1.0, Tâche 10) : la dernière tentative du Facteur pour la lettre — c'est là
    // que se lit une raison de tournée (`sonnette-codex-impossible`…), qu'aucun avis du guichet
    // ne peut dire au moment de l'envoi. Par `rowid` : l'ordre réel, quoi que dise l'horloge.
    const derniereTentative = db.prepare(
      "SELECT state, reason, claimed_at_ms, finished_at_ms FROM facteur_attempts WHERE msg_id = ? ORDER BY rowid DESC LIMIT 1"
    );
    const tourneeDe = (msgId) => {
      const tentative = derniereTentative.get(msgId);
      if (!tentative) return null;
      const instant = Number(tentative.finished_at_ms ?? tentative.claimed_at_ms);
      return {
        state: tentative.state,
        reason: tentative.reason ?? null,
        at: Number.isFinite(instant) ? new Date(instant).toISOString() : null
      };
    };
    const premierDe = (...heures) => heures.filter(Boolean).sort()[0] ?? null;
    const lettres = miennes.map((row) => {
      const resolution = resoudreSansCasser(db, row.recipient);
      const cible = resolution?.targets?.length === 1 ? resolution.targets[0].id ?? null : null;
      const attente = avisDAttente(db, { recipient: row.recipient }, { houses, parSession, resoudre: resolveRecipient, resolutionExistante: resolution, fichesCodex });
      return {
        recipient: row.recipient,
        msg_id: row.msg_id,
        cible,
        resolution: resolution?.kind ?? null,
        etats: {
          cree: row.created_at,
          // « sonné » : la sonnette a répondu (l'événement du send) ou le
          // Facteur a remis — le plus ancien des deux.
          sonne: premierDe(row.carried_at, sonnerie.get(row.msg_id)?.event_at),
          montre: premierDe(premiereLivraison.get(row.msg_id)?.t ?? row.delivered_at, row.injected_at),
          accuse: row.acked_at ?? null
        },
        sans_reveil: Number(row.sans_reveil) === 1,
        tournee: tourneeDe(row.msg_id),
        ...(attente ? { attente } : {})
      };
    });
    return jsonToolResult({ envoi_id: miennes[0].envoi_id, table: miennes[0].table_nom ?? null, count: lettres.length, lettres });
  }
);

// ── RÉPONDRE (1.1.0, Q1 = A) ─────────────────────────────────────────────────
// Un geste du Messenger, pas une adresse à retaper : la lettre dit à qui
// répondre (sa chaise quand elle est connue), dans quel fil, et si elle vient
// d'une table. « Toute la table » est un choix explicite ; en mode direct c'est
// le défaut, et la réaction ne réveille personne (le guichet le décide).
server.registerTool(
  "reply",
  {
    // Toujours chargé, comme `send`, `inbox` et `ack` : les hooks et les skills
    // demandent au modèle de répondre sans détour.
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "Reply to a VALXOS Messenger letter without retyping an address: the answer goes to its author (its chair when "
      + "known), in the letter's thread, as msg_type response with reponse_a = msg_id. For a table letter, "
      + "toute_la_table: true answers the whole table instead (one letter per member, linked by envoi_id); in a table in "
      + "direct mode that is the default — a reaction nobody is woken for — and toute_la_table: false brings it back to "
      + "the author. reveiller names members to wake anyway; hors_enclos steps out of an enclosure. Only the letter's "
      + "recipient or sender may reply (refus: \"pas-destinataire\").",
    inputSchema: {
      msg_id: z.string().describe("The letter you answer"),
      body: z.string(),
      subject: z.string().optional().describe("Defaults to the letter's subject"),
      priority: z.enum(["low", "normal", "high", "critical"]).optional(),
      toute_la_table: z.boolean().optional()
        .describe("Answer every member of the letter's table (default: only when that table is in direct mode)"),
      hors_enclos: z.boolean().optional().describe("Step out of your enclosure (valxos-table enclos) for this reply"),
      reveiller: z.array(z.string()).optional().describe("Table replies only: members to wake whatever the table's rule (50 names of 200 characters at most; beyond, refus: parametre-invalide)"),
      sender_model: z.string().optional()
        .describe("Model tag of the sender, as declared by the sender. Leave empty when unknown.")
    }
  },
  async ({ msg_id, body, subject, priority, toute_la_table, hors_enclos, reveiller, sender_model }) => {
    const qui = identiteDuServeur();
    const clefRendue = borneLEcho(msg_id);
    if (qui.refus) return refusDeChaise(qui, { sent: false, msg_id: clefRendue });
    const lettre = getMessageById(db, msg_id);
    if (!lettre) return jsonToolResult({ sent: false, refus: "lettre-inconnue", msg_id: clefRendue, motif: "no letter carries this msg_id" });
    const sender = ensureSelf(qui);
    const sender_chaise = chaiseDe(qui);
    // Qui peut répondre : l'auteur de la lettre, ou son destinataire — sous
    // n'importe laquelle de ses formes (lignée, chaise, adresse humaine). Le
    // destinataire, seulement s'il a le droit de SIGNER la lettre : la règle
    // d'`ack` (`droitDeSigner`), jamais une deuxième. Une chaise qui n'en voit
    // qu'une copie cc (la lettre de sa lignée est à la chaise désignée, ou
    // tenue faute de désignation) n'y répond pas.
    // S14 : l'auteur est la chaise qui a posté quand elle est posée (`sender_chaise`), sinon le nom posté.
    const formes = formesDeLAppelant(qui, sender);
    const estAuteur = formes.includes(lettre.sender_chaise || lettre.sender);
    const droit = !estAuteur && formes.includes(lettre.recipient) ? droitDeSigner(db, lettre.recipient, sender) : null;
    if (!estAuteur && !droit?.autorise) {
      return jsonToolResult({
        sent: false,
        refus: "pas-destinataire",
        msg_id: clefRendue,
        motif: "only the letter's recipient or its sender replies to it — a cc copy is not yours to answer",
        ...(droit?.raison ? { raison: droit.raison } : {})
      });
    }
    if (toute_la_table === true && !lettre.table_nom) {
      return jsonToolResult({ sent: false, refus: "toute-la-table-sans-table", msg_id: clefRendue, motif: "this letter was not sent to a table" });
    }
    const commun = {
      sender,
      sender_chaise,
      subject: subject ?? lettre.subject ?? null,
      body,
      // Le fil de la lettre, sinon la lettre elle-même devient le fil.
      thread_id: lettre.thread_id ?? lettre.msg_id,
      priority,
      msg_type: "response",
      sender_model,
      reponse_a: lettre.msg_id,
      hors_enclos: hors_enclos === true
    };
    // Vers la table : sur demande, ou par défaut quand la table est en mode
    // direct (une réaction, calme — c'est le guichet qui décide `sans_reveil`).
    const table = lettre.table_nom ? obtenirTable(db, lettre.table_nom) : null;
    const versLaTable = Boolean(lettre.table_nom) && (toute_la_table ?? table?.mode === "direct");
    try {
      if (versLaTable) {
        const envoi = await posterAUneTable(db, { ...commun, table: lettre.table_nom, reveiller: reveiller || [] });
        journaliserLesSonneries(sender, envoi.lettres);
        return jsonToolResult({
          sent: true,
          reponse_a: lettre.msg_id,
          table: envoi.table,
          envoi_id: envoi.envoi_id,
          count: envoi.count,
          results: envoi.lettres.map((une) => lettreDeTableRendue(une, envoi.envoi_id))
        });
      }
      const auteur = lettre.sender_chaise || lettre.sender;
      // A2 : la discrétion de la lettre répondue la suit. Une lettre d'une table
      // FERMÉE (ou une réponse à l'une d'elles) porte `sans_copie = 1` ; la
      // réponse directe, hors table, l'hérite — sinon une chaise sœur de
      // l'auteur la verrait en copie cc (le chemin de table, lui, le dérive de
      // `table.fermee`).
      const sans_copie = Number(lettre.sans_copie) === 1 ? 1 : 0;
      const { row, wake, attente } = await posterUneLettre(db, { ...commun, recipient: auteur, sans_copie });
      return jsonToolResult({
        sent: true,
        reponse_a: lettre.msg_id,
        msg_id: row.msg_id,
        seq: row.seq,
        recipient: row.recipient,
        thread_id: row.thread_id,
        wake,
        ...(attente ? { attente } : {})
      });
    } catch (erreur) {
      journaliserLesSonneries(sender, erreur?.lettres_ecrites);
      const refus = refusDeTable(erreur, { sent: false, msg_id: clefRendue, ...(versLaTable ? { table: lettre.table_nom } : {}) });
      if (refus) return refus;
      throw erreur;
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
