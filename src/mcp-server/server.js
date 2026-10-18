#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_ROSTER, baseDir, deriveSelf, origineDuNomDerive, validateAgentId } from "../lib/config.js";
import {
  ackMessage,
  getDatabase,
  getMessageById,
  history,
  listInbox,
  listPeers,
  markDelivered,
  marquerCopiesVues,
  recordEvent,
  registerPeer,
  unregisterPeer,
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
import { estLeCourrierDe, posterSousUneClefASoi, posterUneLettre, scannerSansCasser } from "../lib/guichet.js";
import { etatDeLaLettre, jsonToolResult, textToolResult } from "../lib/format.js";
import { resetStopGuard } from "../lib/stop-guard.js";

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
    description: "Send a durable message to another VALXOS Messenger peer.",
    inputSchema: {
      to: z.string(),
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
        .describe("Model tag of the sender, as declared by the sender. Leave empty when unknown.")
    }
  },
  async ({ to, from, subject, body, thread_id, priority, msg_type, msg_id, sender_model }) => {
    const qui = identiteDuServeur();
    const expediteur = expediteurVerifie(qui, from, "send");
    if (expediteur.refus) return expediteur.refus;
    const { sender, estAMoi, sansChaise } = expediteur;
    // Aucune maison fournie : le guichet paie SON scan pour cette lettre-là
    // (C1 — un par appel de `send`, c'est la loi d'ici).
    // F12 (28/09) : jamais sous la clef d'un tiers — la ligne d'autrui (son
    // destinataire, son seq) ne revient pas au posteur ; la clef est écartée.
    const { row, wake, attente, rejeu, ecarte, clefEcartee } = await posterSousUneClefASoi(db, {
      msg_id,
      sender,
      recipient: to,
      subject,
      body,
      thread_id,
      priority,
      msg_type,
      sender_model
    }, { estAMoi });
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
        .describe("Model tag of the sender, as declared by the sender. Leave empty when unknown.")
    }
  },
  async ({ from, subject, body, thread_id, priority, sender_model }) => {
    const qui = identiteDuServeur();
    const expediteur = expediteurVerifie(qui, from, "broadcast");
    if (expediteur.refus) return expediteur.refus;
    const { sender, sansChaise } = expediteur;
    // Une lettre par LIGNÉE, jamais une par chaise, et aucune vers un nom que
    // personne ne porte : plus de repli vers un roster de préparation.
    const targets = broadcastRecipients(db, sender);
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
      const { row, wake, attente } = await posterUneLettre(
        db,
        {
          sender,
          recipient: to,
          subject,
          body,
          thread_id,
          priority,
          msg_type: "broadcast",
          sender_model
        },
        { maisons }
      );
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
    description: "Read unread VALXOS Messenger messages for this peer. By default this marks them delivered to avoid Stop-hook loops. A declared `self` is verified against this session's own derived identity before it is trusted. When `self` is a chair (lineage#session), letters to its lineage that belong to another (designated) chair are listed once under `copies`, flagged cc: true with chaise_designee — never delivered, never yours to ack.",
    inputSchema: {
      self: z.string().optional().describe(
        "LEGACY. Identity should come from this session, not from the call. A declared name is VERIFIED against the derived identity's own family (itself, its lineage, or any address that resolves back to it — an old name, a human address) before it is trusted — a name outside that family is refused, never silently honored. A chair (lineage#session) can be declared for inbox and ack only when this session's own session file derives that same chair."
      ),
      limit: z.number().int().min(1).max(100).optional(),
      include_injected: z.boolean().optional(),
      mark_delivered: z.boolean().optional()
    }
  },
  async ({ self, limit, include_injected, mark_delivered }) => {
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
    const borne = limit || 20;
    const includeInjected = include_injected !== false;
    let rows;
    let cc = null;
    let montrerCopies = false;
    let raisonNu = null;
    if (qui.chaise && id === qui.id) {
      // La boîte d'une CHAISE est celle que ses hooks relèvent : sa lignée
      // quand elle lui revient, ses chaises, son nom humain, ses anciens noms.
      const parSeq = new Map();
      for (const adresse of adressesDuRepli(db, qui.lignee, { session_id: qui.sessionId })) {
        for (const row of listInbox(db, adresse, { limit: borne, includeInjected })) parSeq.set(row.seq, row);
      }
      rows = [...parSeq.values()].sort((a, b) => a.seq - b.seq).slice(0, borne);
      cc = copiesPourChaise(db, qui.lignee, qui.sessionId, { limit: borne });
      montrerCopies = true;
    } else {
      rows = listInbox(db, id, { limit: borne, includeInjected });
      const coupe = id.indexOf(SEPARATEUR_INSTANCE);
      if (coupe > 0) {
        cc = copiesPourChaise(db, id.slice(0, coupe), id.slice(coupe + SEPARATEUR_INSTANCE.length), { limit: borne });
        montrerCopies = true;
      } else {
        // Un client SANS chaise (lignée nue) : la lettre de sa lignée tenue
        // par une chaise DÉSIGNÉE vivante n'est pour lui qu'une copie (fix 1,
        // sonde 7). Un client solo ne voit aucune différence, forme comprise.
        cc = copiesSansChaise(db, id, { limit: borne });
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
    if (mark_delivered !== false && rows.length > 0) {
      // acteurReel (remède de la revue adverse #4) : `id` peut être plus large que la session
      // qui a VRAIMENT appuyé sur la touche (une chaise signe pour SA
      // lignée) — `derive` reste dans le detail_json même sur ce chemin
      // AUTORISÉ, pour que l'attribution ne puisse jamais se maquiller.
      markDelivered(db, rows, id, "mcp_inbox_delivered", { acteurReel: derive });
      // Le verrou d'arrêt est tenu sous le nom de la CHAISE quand il y en a
      // une (F4, comme aux hooks : `lignée#session`), sous la lignée nue
      // sinon — `id` est exactement ce nom-là.
      resetStopGuard(id);
      // La relève vient de poser delivered_at EN BASE : les objets JS d'avant
      // la marque mentiraient. L'état affiché est celui de la base APRÈS
      // l'effet de bord de cet appel — on relit chaque lettre, dans le même
      // ordre. (Même doctrine que valxos-inbox.js, un correctif antérieur.)
      const relire = db.prepare("SELECT * FROM messages WHERE seq = ?");
      rows = rows.map((row) => relire.get(row.seq) || row);
    }
    // LA COPIE CC (Run 6, Task 7) : quand le nom relevé est une CHAISE
    // (`lignée#session`), le courrier de SA lignée qui est à une autre chaise
    // (ou tenu, sans chaise désignée) se montre à part, marqué cc — une fois,
    // jamais livré, jamais accusable par elle (`ackMessage` le refuse).
    let copies = null;
    if (montrerCopies) {
      if (mark_delivered !== false && cc.rows.length > 0) marquerCopiesVues(db, cc.rows, cc.chaiseId, { via: "mcp_inbox" });
      copies = cc.rows.map((row) => ({
        etat: etatDeLaLettre(row),
        ...row,
        cc: true,
        chaise_designee: cc.chaiseDesignee,
        sans_chaise_designee: cc.sansChaiseDesignee,
        note: "Copy for your information, NOT addressed to this session: do not ack it and do not answer as its recipient."
      }));
    }
    return jsonToolResult({
      self: id,
      count: rows.length,
      messages: rows.map((row) => ({ etat: etatDeLaLettre(row), ...row })),
      ...(copies ? { copies } : {}),
      ...(raisonNu ? { raison: raisonNu } : {})
    });
  }
);

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
    // Une surface de LECTURE hors famille est le même trou qu'une relève ou
    // qu'un accusé : la garde et sa forme de refus sont RÉUTILISÉES telles
    // quelles depuis `inbox` — deux guichets qui posent la même question de
    // légitimité rendent la même réponse, jamais deux formes qui divergent.
    const identite = verifierIdentiteDeclaree(db, derive, self);
    if (!identite.autorise) {
      recordEvent(db, null, derive, "accuse_refuse", {
        refus: "accuse-refuse",
        declare: identite.declare,
        derivee: derive,
        raison: identite.raison,
        guichet: "history"
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

    const id = identite.declare || (qui.chaise ? qui.nu : ensureSelf(qui));
    // Fix round 3 : un appelant sans chaise ne relit pas en propriétaire la
    // correspondance d'une adresse tenue par une chaise de session.
    const raisonNu = qui.chaise ? null : nomNuTenuParUneChaise(db, id, derive);
    if (raisonNu) return jsonToolResult({ messages: [], raison: raisonNu });
    return jsonToolResult({
      messages: history(db, {
        self: id,
        peer,
        thread_id,
        limit: limit || 50
      }).map((row) => ({ etat: etatDeLaLettre(row), ...row }))
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
      msg_id: z.string(),
      self: z.string().optional().describe(
        "LEGACY. Identity should come from this session, not from the call. A declared name is VERIFIED against the derived identity's own family (itself, its lineage, or any address that resolves back to it — an old name, a human address) before it is trusted — a name outside that family is refused, never silently honored. A chair (lineage#session) can be declared for inbox and ack only when this session's own session file derives that same chair — then still checked against the letter's recipient."
      )
    }
  },
  async ({ msg_id, self }) => {
    const qui = identiteDuServeur();
    const derive = qui.id;
    const origine = origineDuNomDerive();

    // L'existence AVANT l'identité : on ne journalise jamais un refus sur un
    // msg_id qui n'a jamais été une lettre (même loi que `journaliserEcart`
    // ci-dessous — un journal peuplé de msg_id inventés est un journal qu'on
    // cesse de lire), et « Message not found » reste la seule chose vraie à
    // dire quand il n'y a rien à accuser.
    if (!getMessageById(db, msg_id)) return textToolResult(`Message not found: ${msg_id}`);
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
      if (!row) return textToolResult(`Message not found: ${msg_id}`);
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

const transport = new StdioServerTransport();
await server.connect(transport);
