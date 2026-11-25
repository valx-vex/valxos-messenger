#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA COMMANDE DU RELAIS — ce que le relais lance sur l'autre Mac, par ssh, et
// le relais lui-même.
//
//   valxos-relais echanger --de <Mac>   lit { marquer, paquet } sur l'entrée ;
//                                       écrit { resume, paquet } sur la sortie
//   valxos-relais etat                  écrit { moi, en_route, offertes,
//                                       portees_non_accusees, refusees,
//                                       derniere_tournee }
//   valxos-relais tournee [--une]       la veille : une tournée (un échange par
//                                       Mac de relais.json) toutes les
//                                       `intervalle_ms`, puis, à l'arrêt, le
//                                       dernier échange (R37) ; `--une` : une
//                                       seule tournée et son dernier échange,
//                                       leurs rapports sur la sortie
//   valxos-relais oublier <Mac>         le retrait (R28) : `parti_at` sur
//                                       toutes les fiches de ce Mac au carnet ;
//                                       écrit { mac, parties }
//
// `oublier` marche SANS relais.json (on l'a peut-être déjà enlevé : seul le
// bureau compte). S'il est là, il dit qui est ce Mac, et ce Mac ne s'oublie
// pas lui-même. Camp B : aucune fiche ne s'efface, chacune reçoit `parti_at`
// par le même chemin qu'un échange qui ne la montre plus (`ecrireLeCarnet`
// avec une liste vide). Il prend `run/relais.verrou` le temps d'écrire : une
// veille vivante sur ce bureau réécrirait le carnet à sa tournée suivante
// (sortie 3, rien de fait : arrêter le relais d'abord).
//
// `tournee` prend `run/relais.verrou` (le verrou du Facteur, src/facteur/daemon.js),
// les deux modes : deux tournées ne tournent jamais ensemble sur un bureau. Le
// verrou tenu par un vivant : sortie 3, rien de fait. Ses modules (la tournée,
// ssh, le démon) se chargent seulement pour `tournee` : `echanger`, lancé sur
// l'autre Mac à chaque tournée, ne paie pas leur chargement.
//
// `echanger` : UN démarrage de Node par tournée. Dans l'ordre : les marques de
// la tournée d'avant (portées, rendues, et les refus du relais sur les lettres
// d'ici, `marquer.refusees`, R29 — absent d'une veille plus ancienne : aucun),
// l'import du paquet reçu, puis l'export du paquet de ce Mac. Toute l'entrée
// est lue et parsée AVANT la moindre écriture : un JSON tronqué ne touche à
// rien. Il ne s'ouvre que par ssh.
// `etat` compte les lettres en route par sa PROPRE requête en lecture :
// `exporterPour` pose l'offre, il ne sert jamais à compter. Il ne fait que
// lire. Sur TOUT Mac (R37) — le Mac visité compris, dont `relais.json` ne dit
// que `moi` —, `en_route` compte les lettres à porter par Mac de `relais.json` ET
// du carnet, et `offertes` les lettres offertes et pas confirmées (`porte_vers`
// posé, `porte_at` nul, non accusées) par Mac à qui elles ont été offertes :
// celles-là sont peut-être déjà chez l'autre Mac. `portees_non_accusees` (R39)
// compte, par Mac, les lettres d'ici confirmées portées et que personne n'a
// encore accusées : elles sont sur les deux Macs, et une lettre au nom nu y
// serait servie deux fois après le retrait. Il montre aussi les lettres
// d'ici que l'autre Mac a refusées et qui attendent encore (R29).
//
// L'ARRÊT DE LA VEILLE (R37) : SIGTERM ou SIGINT laisse finir la tournée en
// cours, puis la veille fait son dernier échange avec chaque Mac à qui elle
// doit quelque chose (`rendreCeQuiEstDu`, src/lib/relais/tournee.js : les
// confirmations, sans offrir de lettre, sans faire partir le carnet), le dit au
// journal (`relais_dernier_echange`), et sort en 0 en rendant le verrou — même
// si ce dernier échange a échoué. `tournee --une` fait le même dernier échange
// à sa fin.
//
// Les codes de sortie : 0 fait · 1 toute autre erreur (son `code` sur stderr) ;
// pour `tournee --une`, un Mac dont l'échange ou le dernier échange a échoué
// (son rapport le dit) ·
// 2 refusé avant d'agir (ligne de commande, pas de ssh, relais non configuré,
// entrée illisible, un nom de Mac qu'`oublier` ne prend pas) · 3 une tournée
// tient `run/relais.verrou` (`tournee`, `oublier`).
import fs from "node:fs";
import path from "node:path";

import { runtimePaths } from "../lib/config.js";
import { openDatabase } from "../lib/database.js";
import { resolveRecipient } from "../lib/registry.js";
import { ecrireLeCarnet } from "../lib/relais/carnet.js";
import { lireLaConfigDuRelais } from "../lib/relais/config.js";
import {
  exigerDesRefus,
  exigerUnNomDeMac,
  exporterPour,
  importerDe,
  marquerPortees,
  marquerRendus,
  noterLesRefus
} from "../lib/relais/paquet.js";
import { Sortie, executer, optionalArg, parseArgs, requireArg } from "./cli-common.js";

const USAGE = `usage: valxos-relais echanger --de <Mac>   (reads {marquer, paquet} on stdin; only over ssh)
       valxos-relais etat
       valxos-relais tournee [--une]       (the relay: one exchange per Mac of relais.json, every intervalle_ms; --une: one round; both hand back what they owe before exiting)
       valxos-relais oublier <Mac>         (removing the relay: this office forgets the chairs of that Mac)`;

const objet = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function laConfig(racine) {
  const config = lireLaConfigDuRelais(racine);
  if (!config) throw new Sortie(2, `the relay is not configured on this Mac (no relais.json in ${racine})`);
  return config;
}

// Toute l'entrée, puis le parse, puis la forme : jamais au fil de l'eau.
function lireLEntree() {
  let brut;
  try {
    brut = fs.readFileSync(0, "utf8");
  } catch (erreur) {
    throw new Sortie(2, `paquet-illisible: standard input cannot be read (${erreur.message})`);
  }
  let entree;
  try {
    entree = JSON.parse(brut);
  } catch (erreur) {
    throw new Sortie(2, `paquet-illisible: standard input is not valid JSON (${erreur.message})`);
  }
  const m = entree?.marquer;
  const bonneForme =
    objet(entree) && objet(entree.paquet) && objet(m) &&
    Array.isArray(m.portees) && m.portees.every((id) => typeof id === "string") &&
    Array.isArray(m.rendus);
  if (!bonneForme) {
    throw new Sortie(2, "paquet-illisible: expected { marquer: { portees: string[], rendus: [], refusees?: [] }, paquet: {} }");
  }
  // R29 : les refus du relais, vérifiés comme le reste AVANT la première marque.
  if (m.refusees !== undefined) {
    try {
      exigerDesRefus(m.refusees, "marquer.refusees");
    } catch (erreur) {
      throw new Sortie(2, `paquet-illisible: ${erreur.message}`);
    }
  }
  return entree;
}

async function echanger(args) {
  const de = requireArg(args, "de");
  if (!process.env.SSH_CONNECTION) throw new Sortie(2, "echanger only opens over ssh (the relay)");
  const { root } = runtimePaths();
  const { moi } = laConfig(root);
  const { marquer, paquet } = lireLEntree();
  // Avant la moindre écriture : un `--de` faux ne doit marquer aucune lettre.
  try {
    exigerUnNomDeMac(de, "--de");
  } catch (erreur) {
    throw new Sortie(2, `${erreur.code}: ${erreur.message}`);
  }
  if (de === moi) throw new Sortie(2, `paquet-mal-adresse: --de "${de}" is this Mac itself (moi)`);
  if (paquet.de !== de) throw new Sortie(2, `paquet-mal-adresse: --de "${de}" does not match the packet's sender ${JSON.stringify(paquet.de)}`);
  if (paquet.pour !== moi) throw new Sortie(2, `paquet-mal-adresse: the packet is addressed to ${JSON.stringify(paquet.pour)}, not to this Mac "${moi}"`);
  const db = openDatabase();
  try {
    marquerPortees(db, de, marquer.portees);
    marquerRendus(db, de, marquer.rendus);
    noterLesRefus(db, de, marquer.refusees ?? []);
    const resume = await importerDe(db, de, paquet, { moi });
    process.stdout.write(`${JSON.stringify({ resume, paquet: exporterPour(db, de, { moi }) })}\n`);
  } finally {
    db.close();
  }
  return 0;
}

// Les Macs que ce bureau connaît : ceux de `relais.json`, puis ceux du carnet.
// Le Mac visité n'a que `moi` : ses Macs sont ceux que la veille lui a montrés.
function lesMacsConnus(db, config) {
  const macs = new Set(Object.keys(config.macs));
  try {
    for (const { mac } of db.prepare("SELECT DISTINCT mac FROM carnet ORDER BY mac ASC").all()) macs.add(mac);
  } catch {
    /* un bureau sans carnet : aucun Mac de plus */
  }
  return [...macs];
}

const zeroPour = (macs) => Object.fromEntries(macs.map((mac) => [mac, 0]));

// Les lettres que `exporterPour` porterait, comptées sans rien écrire, par Mac
// vers lequel la résolution d'ici les porte.
function enRoute(db, macs) {
  const compte = zeroPour(macs);
  const verdicts = new Map();
  const lignes = db
    .prepare("SELECT recipient FROM messages WHERE acked_at IS NULL AND via IS NULL AND porte_at IS NULL")
    .all();
  for (const { recipient } of lignes) {
    if (!verdicts.has(recipient)) {
      let mac = null;
      try {
        const resolution = resolveRecipient(db, recipient);
        if (resolution?.kind === "distant") mac = resolution.mac;
      } catch {
        mac = null;
      }
      verdicts.set(recipient, mac);
    }
    const mac = verdicts.get(recipient);
    if (mac !== null) compte[mac] = (compte[mac] ?? 0) + 1;
  }
  return compte;
}

// R37 : les lettres nées ici, OFFERTES à un Mac (`porte_vers`) et dont la
// confirmation n'est pas revenue (`porte_at` nul), non accusées : l'autre Mac
// les a peut-être importées. Par Mac à qui elles ont été offertes, connu du
// carnet ou non. Les lettres refusées y sont aussi (elles se représentent à
// chaque tournée) ; `refusees` les nomme.
function offertes(db, macs) {
  const compte = zeroPour(macs);
  const lignes = db
    .prepare(`
      SELECT porte_vers AS mac, COUNT(*) AS n FROM messages
      WHERE via IS NULL AND porte_vers IS NOT NULL AND porte_at IS NULL AND acked_at IS NULL
      GROUP BY porte_vers ORDER BY porte_vers ASC
    `)
    .all();
  for (const { mac, n } of lignes) compte[mac] = (compte[mac] ?? 0) + n;
  return compte;
}

// R39 : les lettres nées ici, CONFIRMÉES portées vers un Mac (`porte_at` posé,
// `porte_vers` ce Mac) et que personne n'a accusées : elles vivent sur les deux
// Macs jusqu'à l'accusé, qui revient d'ici à la prochaine tournée. Par Mac.
function porteesNonAccusees(db, macs) {
  const compte = zeroPour(macs);
  const lignes = db
    .prepare(`
      SELECT porte_vers AS mac, COUNT(*) AS n FROM messages
      WHERE via IS NULL AND porte_vers IS NOT NULL AND porte_at IS NOT NULL AND acked_at IS NULL
      GROUP BY porte_vers ORDER BY porte_vers ASC
    `)
    .all();
  for (const { mac, n } of lignes) compte[mac] = (compte[mac] ?? 0) + n;
  return compte;
}

// R29 : les lettres nées ici, que l'autre Mac a refusées (`relais_refus` du Mac
// à qui elles sont offertes), et qui attendent encore (ni portées ni accusées) :
// chacune avec son refus le plus récent.
function refusees(db) {
  const lettres = [];
  const vues = new Set();
  const lignes = db
    .prepare(`
      SELECT m.msg_id, json_extract(e.detail_json, '$.mac') AS mac, json_extract(e.detail_json, '$.raison') AS raison,
             e.event_at AS at
      FROM messages m JOIN delivery_events e ON e.msg_id = m.msg_id AND e.event_type = 'relais_refus'
      WHERE m.via IS NULL AND m.porte_at IS NULL AND m.acked_at IS NULL
        AND json_extract(e.detail_json, '$.mac') = m.porte_vers
      ORDER BY m.seq ASC, e.id DESC
    `)
    .all();
  for (const ligne of lignes) {
    if (vues.has(ligne.msg_id)) continue;
    vues.add(ligne.msg_id);
    lettres.push(ligne);
  }
  return { nombre: lettres.length, lettres };
}

function derniereTournee(racine) {
  let brut;
  try {
    brut = fs.readFileSync(path.join(racine, "status", "relais.json"), "utf8");
  } catch (erreur) {
    if (erreur?.code === "ENOENT") return null;
    throw erreur;
  }
  try {
    return JSON.parse(brut);
  } catch (erreur) {
    const e = new Error(`status/relais.json is not valid JSON (${erreur.message})`);
    e.code = "status-illisible";
    throw e;
  }
}

function etat() {
  const { root, db: fichier } = runtimePaths();
  const config = laConfig(root);
  const db = openDatabase({ file: fichier, readonly: true });
  try {
    const macs = lesMacsConnus(db, config);
    const bilan = {
      moi: config.moi,
      en_route: enRoute(db, macs),
      offertes: offertes(db, macs),
      portees_non_accusees: porteesNonAccusees(db, macs),
      refusees: refusees(db),
      derniere_tournee: derniereTournee(root)
    };
    process.stdout.write(`${JSON.stringify(bilan)}\n`);
  } finally {
    db.close();
  }
  return 0;
}

// Un rapport mérite le journal de la veille quand il a bougé quelque chose, ou
// quand son erreur ou ses refus changent (une panne se dit une fois, et son
// retour aussi ; une lettre refusée, qui se représente à chaque tournée, aussi) :
// un Mac qui dort une nuit n'écrit pas une ligne toutes les deux secondes.
const aBouge = (r) => r.apportees + r.emportees + r.evenements_apportes + r.evenements_emportes > 0;
const etatDuMac = (r) => JSON.stringify([r.erreur, r.refus_la_bas, r.refus_ici]);

async function tournee(args) {
  const une = args.une === true;
  const { root, run } = runtimePaths();
  const config = laConfig(root);
  const [{ journalNdjson, prendreLeVerrou, lireLeVerrou, sommeil }, { faireUneTourneeDuRelais, rendreCeQuiEstDu }, { transportsSsh }] =
    await Promise.all([
      import("../facteur/daemon.js"),
      import("../lib/relais/tournee.js"),
      import("../lib/relais/transport-ssh.js")
    ]);
  const transport = transportsSsh(config);
  // Le bureau s'ouvre AVANT le verrou (la leçon du Facteur, daemon.js) : une
  // ouverture refusée ne laisse jamais un verrou orphelin.
  const db = openDatabase();
  const verrou = path.join(run, "relais.verrou");
  const jeton = prendreLeVerrou(verrou);
  if (!jeton) {
    db.close();
    const tenant = lireLeVerrou(verrou);
    throw new Sortie(3, `another relay round holds ${path.join("run", "relais.verrou")}${tenant?.pid ? ` (pid ${tenant.pid})` : ""}; nothing was done`);
  }
  const enAttente = new Map();
  const tourner = () => faireUneTourneeDuRelais({ db, config, transport, enAttente, racine: root, journal: journalNdjson });
  // R37 : ce que la veille doit (`enAttente`) n'existe que dans sa mémoire ; il
  // se rend avant la sortie, en un dernier échange par Mac.
  const rendre = () => rendreCeQuiEstDu({ db, config, transport, enAttente });
  try {
    if (une) {
      const rapports = await tourner();
      const derniers = await rendre();
      process.stdout.write(`${JSON.stringify({ rapports, derniers_echanges: derniers })}\n`);
      for (const r of rapports.filter((x) => x.erreur !== null)) process.stderr.write(`${r.mac}: ${r.erreur} (${r.pas}): ${r.detail}\n`);
      for (const r of derniers.filter((x) => x.erreur !== null)) {
        process.stderr.write(`${r.mac}: last exchange: ${r.erreur} (${r.pas}): ${r.detail}\n`);
      }
      return [...rapports, ...derniers].some((r) => r.erreur !== null) ? 1 : 0;
    }

    // La veille. L'arrêt propre : la tournée en cours se termine, puis le
    // dernier échange rend ce qui est dû (R37), puis le verrou se rend. Une
    // tournée interrompue ne perd rien (la règle 4).
    const arret = new AbortController();
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.on(signal, () => {
        journalNdjson({ evenement: "relais_rappele", signal });
        arret.abort();
      });
    }
    journalNdjson({
      evenement: "relais_en_service",
      pid: process.pid,
      moi: config.moi,
      macs: Object.keys(config.macs),
      intervalle_ms: config.intervalle_ms
    });
    const derniersEtats = new Map();
    let tours = 0;
    while (!arret.signal.aborted) {
      try {
        for (const r of await tourner()) {
          if (aBouge(r) || etatDuMac(r) !== (derniersEtats.get(r.mac) ?? etatDuMac({ erreur: null, refus_la_bas: [], refus_ici: [] }))) {
            journalNdjson({ evenement: "relais_tournee", ...r });
          }
          derniersEtats.set(r.mac, etatDuMac(r));
        }
      } catch (erreur) {
        // Une panne hors d'un Mac (la base…) n'arrête pas la veille : le
        // courrier attend, et la tournée suivante réessaie.
        journalNdjson({ evenement: "relais_tournee_en_panne", code: erreur?.code ?? null, detail: String(erreur?.message ?? erreur) });
      }
      tours += 1;
      if (!arret.signal.aborted) await sommeil(config.intervalle_ms, arret.signal);
    }
    // R37 : le dernier échange. Un échec se dit au journal, et la veille sort
    // quand même : rien n'est marqué à tort, et `etat` montre ce qui reste en vol.
    try {
      for (const r of await rendre()) journalNdjson({ evenement: "relais_dernier_echange", ...r });
    } catch (erreur) {
      journalNdjson({ evenement: "relais_dernier_echange_en_panne", code: erreur?.code ?? null, detail: String(erreur?.message ?? erreur) });
    }
    journalNdjson({ evenement: "relais_hors_service", tours });
    return 0;
  } finally {
    jeton.relacher();
    db.close();
  }
}

// Le retrait (R28) : ce bureau oublie les chaises de `mac`.
async function oublier(mac) {
  try {
    exigerUnNomDeMac(mac, "the Mac to forget");
  } catch (erreur) {
    throw new Sortie(2, `${erreur.code}: ${erreur.message}`);
  }
  const { root, run } = runtimePaths();
  const config = lireLaConfigDuRelais(root);
  if (config && mac === config.moi) {
    throw new Sortie(2, `"${mac}" is this Mac itself (moi in relais.json): the address book only holds the other Mac's chairs`);
  }
  const { prendreLeVerrou, lireLeVerrou } = await import("../facteur/daemon.js");
  const db = openDatabase();
  const verrou = path.join(run, "relais.verrou");
  const jeton = prendreLeVerrou(verrou);
  if (!jeton) {
    db.close();
    const tenant = lireLeVerrou(verrou);
    throw new Sortie(3, `a relay round holds ${path.join("run", "relais.verrou")}${tenant?.pid ? ` (pid ${tenant.pid})` : ""}: stop the relay first, or its next round writes the address book again; nothing was done`);
  }
  try {
    const connus = db.prepare("SELECT DISTINCT mac FROM carnet ORDER BY mac ASC").all().map((l) => l.mac);
    const { parties } = ecrireLeCarnet(db, mac, []);
    process.stdout.write(`${JSON.stringify({ mac, parties })}\n`);
    if (!connus.includes(mac)) {
      const liste = connus.length > 0 ? connus.map((nom) => JSON.stringify(nom)).join(", ") : "none";
      process.stderr.write(`note: the address book has no chair of ${JSON.stringify(mac)} (Mac names are case-sensitive; Macs it knows: ${liste})\n`);
    }
  } finally {
    jeton.relacher();
    db.close();
  }
  return 0;
}

async function principal() {
  const args = parseArgs(process.argv.slice(2), { known: ["de"], booleans: ["une"], usage: USAGE });
  const commande = args._[0];
  const positionnels = commande === "oublier" ? 2 : 1;
  if (args._.length !== positionnels || !["echanger", "etat", "tournee", "oublier"].includes(commande)) throw new Sortie(2, USAGE);
  if (commande !== "echanger" && optionalArg(args, "de") !== undefined) throw new Sortie(2, `${commande} takes no --de`);
  if (commande !== "tournee" && args.une === true) throw new Sortie(2, "--une only goes with tournee");
  try {
    if (commande === "tournee") return await tournee(args);
    if (commande === "oublier") return await oublier(args._[1]);
    return commande === "echanger" ? await echanger(args) : etat();
  } catch (erreur) {
    if (erreur instanceof Sortie) throw erreur;
    throw new Sortie(1, `${erreur?.code ?? "erreur"}: ${erreur?.message ?? erreur}`);
  }
}

await executer(principal);
