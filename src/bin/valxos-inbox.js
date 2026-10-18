#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'IDENTITÉ DÉCLARÉE EST VÉRIFIÉE, ICI AUSSI (remède de la revue adverse #4 — HAUT 1).
// Un `--self`/`--from` pris au mot, sans vérification, est SANS DANGER là où
// « from » n'ouvre aucune boîte (n'importe qui peut prétendre être
// l'expéditeur d'une lettre qu'il envoie). `inbox` OUVRE une
// boîte : avant ce remède, `--self` n'était vérifié nulle part côté CLI —
// prouvé, une session A lançant `cc2cc-inbox --self B` lisait le
// courrier de B, avançait son delivered_at, ET journalisait
// `agent_id: "B"` (l'attribution FORGÉE), alors que la même requête au
// guichet MCP se refusait déjà avec `releve-refusee`. `verifierIdentiteDeclaree`
// (database.js) est la MÊME fonction que le guichet MCP utilise — jamais une
// deuxième qui pourrait diverger.
//
// ⚠️ CE QUE CETTE GARDE NE PROMET PAS : un opérateur qui a la main sur SON
// PROPRE process peut toujours poser `CC2CC_SELF=alice` dans SON environnement
// et ÊTRE alice — exactement comme pour le guichet MCP, qui dérive de la
// MÊME variable. La garde arrête une session de déclarer un self HORS DE SA
// FAMILLE (review interne, IMPORTANT 3 — « un AUTRE self que le sien »
// survendait : une session PEUT déclarer sa propre lignée et être honorée,
// toujours — et, SEULEMENT si elle dérive elle-même une lignée plutôt
// qu'une chaise, une chaise de cette même lignée).
// ⚠️ UNE PHRASE VRAIE À SON ORIGINE PEUT DEVENIR FAUSSE EN VOYAGEANT (review
// interne, vague suivante) : la première version de ce commentaire recopiait
// l'énumération du guichet MCP (`identiteDuServeur`, server.js) telle quelle,
// où elle est exacte — le
// guichet MCP ne dérive JAMAIS qu'une lignée, jamais une chaise, donc « une
// chaise de sa lignée » y est toujours vrai. Ici, `deriveSelf()` PEUT rendre
// une chaise (`CC2CC_SELF=alice#sessA`) — et une chaise qui déclare une
// chaise SŒUR est refusée (porte 2, `portesNominales` : « ni destinataire,
// ni instance de la lignée destinataire ») ; seule sa propre lignée NUE lui
// reste accessible au-delà d'elle-même. Copier une phrase vraie à travers
// cette frontière-là la rendait fausse ; elle ne prétend pas non plus
// arrêter quelqu'un qui a un accès shell et peut changer son propre
// environnement.
import { deriveSelf, origineDuNomDerive } from "../lib/config.js";
import {
  ackMessage,
  getDatabase,
  getMessageById,
  listInbox,
  markDelivered,
  nomNuTenuParUneChaise,
  recordEvent,
  verifierIdentiteDeclaree
} from "../lib/database.js";
import { etatDeLaLettre } from "../lib/format.js";
import { resetStopGuard } from "../lib/stop-guard.js";
import { optionalArg, parseArgs, printJson } from "./cli-common.js";

const args = parseArgs(process.argv.slice(2), {
  // --from reste CONNU : son refus dédié (plus bas) dit quoi faire à la place.
  known: ["self", "from", "limit", "include_injected", "mark_delivered", "ack"],
  positionals: false,
  usage:
    "usage: valxos-inbox [--self NAME] [--limit N] [--include-injected false] [--mark-delivered false]\n" +
    "       valxos-inbox --ack MSG_ID [--self NAME]     (acknowledge one letter, as its recipient)"
});

// ── L'ACCUSÉ (A3, revue de l'inconnu F4, 18/10) ─────────────────────────────
// `--ack MSG_ID` signe UNE lettre sous le nom DÉRIVÉ. Il n'a aucune règle à lui :
// il rejoue, dans l'ordre de l'outil MCP `ack` (server.js), les fonctions que ce
// guichet appelle — la lettre existe-t-elle (avant l'identité : un journal peuplé
// de msg_id inventés se cesse de lire), un `--self` déclaré est-il à cette session
// (`verifierIdentiteDeclaree`), cette signature peut-elle fermer CETTE lettre
// (`ackMessage` : destinataire, lignée, copie cc, nom nu vers une chaise). Un
// refus se dit en JSON, se journalise, sort 1, et laisse la lettre intacte (A9).
// Ce que le guichet MCP fait en plus n'est pas une garde : il se réannonce
// (`ensureSelf`) avant d'accuser ; la CLI ne s'annonce pas, comme à la relève.
function refuserLaLigneDeCommande(message) {
  process.stderr.write(`${message}\nNothing was done.\n`);
  process.exitCode = 2;
}

function accuser(db, derive) {
  const msgId = optionalArg(args, "ack");
  // Un accusé par appel : le parseur ne garde que le DERNIER `--ack`, et un
  // premier perdu en silence serait une lettre que l'appelant croit signée.
  const argv = process.argv.slice(2);
  const options = argv.indexOf("--") === -1 ? argv : argv.slice(0, argv.indexOf("--"));
  if (options.filter((jeton) => jeton === "--ack").length > 1) {
    return refuserLaLigneDeCommande("--ack takes one msg_id per call: run the command once per letter");
  }
  if (args.limit !== undefined || args.include_injected !== undefined || args.mark_delivered !== undefined) {
    return refuserLaLigneDeCommande("--ack acknowledges one letter and cannot be combined with --limit, --include-injected or --mark-delivered");
  }

  if (!getMessageById(db, msgId)) {
    printJson({ acked: false, msg_id: msgId, refus: "lettre-inconnue", motif: "no such letter" });
    process.exitCode = 1;
    return;
  }

  const declareBrut = optionalArg(args, "self");
  const identite = verifierIdentiteDeclaree(db, derive, declareBrut);
  if (!identite.autorise) {
    recordEvent(db, msgId, derive, "accuse_refuse", {
      refus: "accuse-refuse",
      declare: identite.declare,
      derivee: derive,
      raison: identite.raison,
      guichet: "valxos-inbox"
    });
    printJson({
      acked: false,
      refus: "accuse-refuse",
      motif: "only the recipient signs",
      msg_id: msgId,
      declare: identite.declare,
      derivee: derive,
      origine: origineDuNomDerive(),
      raison: identite.raison
    });
    process.exitCode = 1;
    return;
  }

  const signataire = identite.declare || derive;
  // Le reçu d'une identité déclarée légitime : de quoi retrouver plus tard chaque
  // accusé signé par une main qui s'était nommée autrement qu'elle-même.
  const journaliserEcart = () => {
    if (identite.declare && identite.declare !== derive) {
      recordEvent(db, msgId, derive, "accuse_identite_declaree", { declaree: identite.declare, derivee: derive });
    }
  };
  try {
    const ligne = ackMessage(db, msgId, signataire);
    journaliserEcart();
    printJson({ acked: true, msg_id: msgId, acked_at: ligne.acked_at });
  } catch (erreur) {
    if (erreur?.code !== "accuse_refuse") throw erreur;
    journaliserEcart();
    printJson({
      acked: false,
      refuse: true,
      refus: "accuse-refuse-lettre",
      msg_id: msgId,
      signataire,
      derivee: derive,
      origine: origineDuNomDerive(),
      destinataire: erreur.destinataire,
      raison: erreur.raison
    });
    process.exitCode = 1;
  }
}

// MINOR 7 (review interne) : `--from` était un second levier pour forger une
// identité AVANT ce remède — l'ancien assistant de la CLI le lisait comme un
// synonyme de `--self`, sans aucune vérification. Cette
// commande-ci ne le lit plus DU TOUT : un silence aurait été pire que ce
// qu'il remplace. `--from alice` sans erreur aurait rendu SA PROPRE boîte
// avec un succès — un résultat qui a l'air bon et ne l'est pas. Un refus
// NOMMÉ plutôt qu'un no-op muet, même thème que toute cette remédiation :
// jamais de silence là où une main pourrait se tromper.
if (args.from !== undefined) {
  process.stderr.write(
    "valxos-inbox does not accept --from; use --self (verified against your derived identity).\n"
  );
  process.exitCode = 2;
} else if (args.ack !== undefined) {
  accuser(getDatabase(), deriveSelf());
} else {
  const db = getDatabase();
  const derive = deriveSelf();
  const declareBrut = optionalArg(args, "self");
  const identite = verifierIdentiteDeclaree(db, derive, declareBrut);

  if (!identite.autorise) {
    // Même doctrine que le guichet MCP : on refuse poliment, on journalise, on
    // ne lève jamais. Le courrier n'est même pas ouvert.
    recordEvent(db, null, derive, "accuse_refuse", {
      refus: "accuse-refuse",
      declare: identite.declare,
      derivee: derive,
      raison: identite.raison,
      guichet: "valxos-inbox"
    });
    printJson({
      refus: "releve-refusee",
      motif: "only the recipient collects its mail",
      declare: identite.declare,
      derivee: derive,
      origine: origineDuNomDerive(),
      raison: identite.raison
    });
    process.exitCode = 1;
  } else {
    const self = identite.declare || derive;
    // Fix round 3 : un acteur NU (sans `#`) ne relève pas en propriétaire une
    // adresse qui mène à une chaise de session (une ou plusieurs) — la même
    // règle que l'accusé (`nomNuTenuParUneChaise`, database.js).
    const raisonNu = nomNuTenuParUneChaise(db, self, derive);
    // --limit sans valeur (remède de la revue adverse #3, C7) : `Number(true || 20)` vaut 1,
    // silencieusement — le mauvais nombre, pas un refus. optionalArg refuse
    // proprement au lieu de deviner.
    let rows = raisonNu ? [] : listInbox(db, self, {
      limit: Number(optionalArg(args, "limit") || 20),
      includeInjected: args.include_injected !== "false"
    });
    if (args.mark_delivered !== "false" && rows.length > 0) {
      // acteurReel (remède de la revue adverse #4) : `self` peut être plus large que la
      // session qui a VRAIMENT lancé cette commande (une chaise signe pour SA
      // lignée) — `derive` reste dans le detail_json même sur ce chemin
      // AUTORISÉ, pour que l'attribution ne puisse jamais se maquiller.
      markDelivered(db, rows, self, "cli_inbox_delivered", { acteurReel: derive });
      resetStopGuard(self);
      // La relève vient de poser delivered_at EN BASE : les objets JS d'avant la
      // marque mentiraient. L'état affiché est celui de la base APRÈS l'effet de
      // bord de cet appel — on relit chaque lettre, dans le même ordre.
      const relire = db.prepare("SELECT * FROM messages WHERE seq = ?");
      rows = rows.map((row) => relire.get(row.seq) || row);
    }
    printJson({
      self,
      count: rows.length,
      messages: rows.map((row) => ({ etat: etatDeLaLettre(row), ...row })),
      ...(raisonNu ? { raison: raisonNu } : {})
    });
  }
}
