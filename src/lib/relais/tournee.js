// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA TOURNÉE DU RELAIS — un échange par Mac, l'aller et le retour en un appel.
//
// Le relais vit sur un Mac (le Studio) et visite chaque autre Mac de
// `relais.json`. Pour chacun, l'ordre est fixe :
//   1. `q = exporterPour(db, mac)` — le paquet d'ici (l'export pose l'OFFRE,
//      `porte_vers`, jamais la confirmation) ;
//   2. `r = transport.echanger(mac, { marquer, paquet: q })` — UN appel : l'autre
//      Mac pose les marques de la tournée d'avant (`marquer`, les accusés de
//      réception et les refus gardés dans `enAttente`), importe `q`, et rend
//      son propre paquet ;
//   3. la réponse se vérifie EN ENTIER (le paquet `r.paquet`, puis
//      `r.resume.refus`, chaque refus `{ msg_id, raison }`) avant la première
//      marque ; puis, dans une seule transaction, `marquerPortees(q moins ses
//      refus)`, `marquerRendus(q.evenements)` et `noterLesRefus` (R29 : les
//      lettres de `q` que l'autre Mac a refusées reçoivent `relais_refus`) —
//      l'autre Mac a importé `q`, et ses refus restent en route ici (R18) ;
//   4. `importerDe(db, mac, r.paquet)` ;
//   5. `enAttente.set(mac, { portees, rendus, refusees })` : ce qu'on vient
//      d'importer, à confirmer à l'autre Mac à la tournée suivante, et ce qu'on
//      vient de refuser de lui (R29 : `echanger` l'écrit sur ses lettres) —
//      seulement si le pas 4 n'a pas levé. S'il a levé, l'entrée se vide :
//      l'autre Mac redonnera tout, et les rejeux sont sans effet.
//
// UN PAS QUI ÉCHOUE NE MARQUE RIEN (la règle 4 de la spec : une lettre attend,
// elle ne se perd pas). Une erreur arrête ce Mac et passe au suivant ; le
// rapport dit laquelle (`erreur` : le `code` de l'erreur, sinon
// `"mac-injoignable"`), à quel pas (`pas`), et son message (`detail`).
//   · pas 1 ou 2 : rien n'est marqué ici ; `enAttente` garde ses accusés (ils
//     repartent : les marques de là-bas sont idempotentes) ;
//   · pas 3 (réponse d'une autre version, `refus` absent ou cassé) : rien n'est
//     marqué, rien n'est importé ; l'autre Mac a peut-être importé `q`, la
//     tournée suivante le redonne et c'est un rejeu ;
//   · pas 4 : les marques du pas 3 restent (elles sont vraies : l'autre Mac a
//     importé `q`) ; les lettres d'avant la panne sont écrites, un rejeu les
//     retrouvera ; aucun accusé n'est promis à l'autre Mac.
// Une veille qui redémarre perd `enAttente` : l'autre Mac redonne alors des
// lettres déjà importées, qui deviennent des rejeux sans effet.
//
// LE RAPPORT, un par Mac, du point de vue d'ici :
//   `apportees`            les lettres neuves écrites ici (pas 4) ;
//   `emportees`            les lettres d'ici confirmées portées (pas 3) ;
//   `conflits`             les refus « conflit », des deux côtés ;
//   `evenements_apportes`  les évènements reçus qui ont changé une lettre d'ici ;
//   `evenements_emportes`  les marques « rendu » posées ici ;
//   `refus_la_bas`         les lettres d'ici que l'autre Mac a refusées (elles
//                          restent en route, et reviennent à chaque tournée ;
//                          chacune porte `relais_refus` ici, R29) ;
//   `refus_ici`            les lettres de là-bas que ce bureau a refusées (leur
//                          refus part à la tournée suivante, `refusees`) ;
//   `duree_ms`, `erreur`, `pas`, `detail`.
// Jamais un corps de lettre : des nombres et des `msg_id`.
// Le dernier rapport de la tournée s'écrit dans `<bureau>/status/relais.json`
// (avec `at`), que `valxos-relais etat` relit.
//
// R37 — LE DERNIER ÉCHANGE (`rendreCeQuiEstDu`). Ce que la veille garde dans
// `enAttente` n'existe que dans sa mémoire : une veille qui sortait sans le
// rendre laissait, chez l'autre Mac, une lettre importée ici avec `porte_at` nul
// (la sonde R34 de la tâche 7). À l'arrêt (SIGTERM, SIGINT) et à la fin de
// `tournee --une`, pour chaque Mac à qui quelque chose est dû — des marques dans
// `enAttente`, ou des évènements d'ici qu'il n'a pas appris —, UN échange :
//   · il porte `marquer` (les confirmations, les rendus, les refus) ;
//   · son paquet n'a AUCUNE lettre et ne pose aucune offre (`paquetSansLettres`)
//     — il garde ses vraies `chaises` (le carnet de là-bas ne perd aucune fiche)
//     et ses vrais `evenements` (marqués rendus ici si l'échange réussit) ;
//   · la réponse se vérifie en entier, comme au pas 3, puis `marquerRendus` ;
//   · le paquet de la réponse n'est PAS importé : l'importer créerait des
//     confirmations dues que plus personne ne rendrait. Ses lettres restent
//     offertes chez l'autre Mac (`porte_vers`, `porte_at` nul) et absentes
//     d'ici : portées à la prochaine veille, ou servies là-bas après `oublier`.
//     Ni perdues, ni doublées.
// Un échange qui échoue ne marque rien ici (son rapport le dit), et `enAttente`
// garde ce qui reste dû ; la veille sort quand même.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { nowIso, runtimePaths } from "../config.js";
import {
  exigerDesRefus,
  exporterPour,
  importerDe,
  lettresPortees,
  marquerPortees,
  marquerRendus,
  noterLesRefus,
  paquetSansLettres,
  verifierLePaquet
} from "./paquet.js";

const ERREUR_PAR_DEFAUT = "mac-injoignable";
const objet = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const vide = () => ({ portees: [], rendus: [], refusees: [] });

function reponseInvalide(message) {
  const erreur = new Error(`invalid answer from the other Mac: ${message}`);
  erreur.code = "paquet-invalide";
  return erreur;
}

/**
 * Une tournée : un échange par Mac de `config.macs`, dans l'ordre du fichier.
 * Rend un rapport par Mac. Ne lève pas pour l'échec d'un Mac (son rapport le
 * dit) ; `journal` reçoit ce qui n'est pas un rapport (le statut qui ne
 * s'écrit pas).
 */
export async function faireUneTourneeDuRelais({
  db,
  config,
  transport,
  enAttente,
  at = nowIso,
  deps = {},
  racine = runtimePaths().root,
  journal = () => {}
} = {}) {
  if (!(enAttente instanceof Map)) throw new TypeError("enAttente must be a Map kept by the watch from one round to the next");
  if (typeof transport?.echanger !== "function") throw new TypeError("transport must have an echanger(mac, entree) function");
  const rapports = [];
  for (const mac of Object.keys(config.macs)) {
    rapports.push(await tourneeDUnMac({ db, moi: config.moi, mac, transport, enAttente, at, deps }));
  }
  if (rapports.length > 0) ecrireLeStatut(racine, { at: at(), ...rapports.at(-1) }, journal);
  return rapports;
}

async function tourneeDUnMac({ db, moi, mac, transport, enAttente, at, deps }) {
  const debut = performance.now();
  const rapport = {
    mac,
    apportees: 0,
    emportees: 0,
    conflits: 0,
    evenements_apportes: 0,
    evenements_emportes: 0,
    refus_la_bas: [],
    refus_ici: [],
    duree_ms: 0,
    erreur: null,
    pas: null,
    detail: null
  };
  let pas = "exporter";
  try {
    // 1. L'export.
    const q = exporterPour(db, mac, { moi });

    // 2. L'échange.
    pas = "echanger";
    const r = await transport.echanger(mac, { marquer: enAttente.get(mac) ?? vide(), paquet: q });

    // 3. La réponse se vérifie en entier, puis les marques, ensemble.
    pas = "marquer";
    if (!objet(r)) throw reponseInvalide("not an object");
    if (!objet(r.resume)) throw reponseInvalide("no resume");
    verifierLePaquet(r.paquet, { de: mac, ici: moi });
    const portees = lettresPortees(q, r.resume.refus);
    const refusLaBas = exigerDesRefus(r.resume.refus, "refusal").map(({ msg_id, raison }) => ({ msg_id, raison }));
    const offertes = new Set(q.lettres.map((l) => l.msg_id));
    // Les nombres du rapport ne s'écrivent qu'APRÈS la transaction (R31) : une
    // marque qui lève défait les autres, et le rapport ne dit rien de porté.
    const marques = db.transaction(() => {
      const emportees = marquerPortees(db, mac, portees, { at: at() });
      const evenementsEmportes = marquerRendus(db, mac, q.evenements, { at: at() });
      noterLesRefus(db, mac, refusLaBas.filter((x) => offertes.has(x.msg_id)));
      return { emportees, evenements_emportes: evenementsEmportes };
    })();
    rapport.emportees = marques.emportees;
    rapport.evenements_emportes = marques.evenements_emportes;
    rapport.refus_la_bas = refusLaBas;

    // 4. L'import ; 5. les accusés à rendre, seulement s'il a réussi.
    pas = "importer";
    let resumeLocal;
    try {
      resumeLocal = await importerDe(db, mac, r.paquet, { moi, at: at(), deps });
    } catch (erreur) {
      enAttente.delete(mac);
      throw erreur;
    }
    rapport.refus_ici = resumeLocal.refus.map(({ msg_id, raison }) => ({ msg_id, raison }));
    enAttente.set(mac, {
      portees: lettresPortees(r.paquet, resumeLocal.refus),
      rendus: r.paquet.evenements,
      refusees: rapport.refus_ici.map((x) => ({ ...x }))
    });
    rapport.apportees = resumeLocal.neuves;
    rapport.evenements_apportes = resumeLocal.evenements;
  } catch (erreur) {
    rapport.erreur = typeof erreur?.code === "string" && erreur.code ? erreur.code : ERREUR_PAR_DEFAUT;
    rapport.pas = pas;
    rapport.detail = String(erreur?.message ?? erreur);
  }
  rapport.conflits = [...rapport.refus_la_bas, ...rapport.refus_ici].filter((r) => r.raison === "conflit").length;
  rapport.duree_ms = Math.round(performance.now() - debut);
  return rapport;
}

/**
 * R37 : le dernier échange, Mac par Mac (l'ordre de `config.macs`). Rend un
 * rapport par Mac VISITÉ — un Mac à qui rien n'est dû n'est pas visité :
 * `{ mac, confirmees, rendus, refus_rendus, evenements_emportes, duree_ms,
 * erreur, pas, detail }`. `confirmees`, `rendus` et `refus_rendus` comptent ce
 * que l'autre Mac a reçu de `enAttente` (0 si l'échange a échoué) ;
 * `evenements_emportes` les marques « rendu » posées ici. Ne lève pas pour
 * l'échec d'un Mac.
 */
export async function rendreCeQuiEstDu({ db, config, transport, enAttente, at = nowIso } = {}) {
  if (!(enAttente instanceof Map)) throw new TypeError("enAttente must be the Map kept by the watch");
  if (typeof transport?.echanger !== "function") throw new TypeError("transport must have an echanger(mac, entree) function");
  const rapports = [];
  for (const mac of Object.keys(config.macs)) {
    const rapport = await dernierEchange({ db, moi: config.moi, mac, transport, enAttente, at });
    if (rapport) rapports.push(rapport);
  }
  return rapports;
}

// Rend `null` quand rien n'est dû à `mac` (aucun échange).
async function dernierEchange({ db, moi, mac, transport, enAttente, at }) {
  const debut = performance.now();
  const du = enAttente.get(mac) ?? vide();
  const rapport = {
    mac,
    confirmees: 0,
    rendus: 0,
    refus_rendus: 0,
    evenements_emportes: 0,
    duree_ms: 0,
    erreur: null,
    pas: null,
    detail: null
  };
  let pas = "exporter";
  try {
    const q = paquetSansLettres(db, mac, { moi });
    if (du.portees.length + du.rendus.length + (du.refusees?.length ?? 0) + q.evenements.length === 0) {
      enAttente.delete(mac);
      return null;
    }
    pas = "echanger";
    const r = await transport.echanger(mac, { marquer: du, paquet: q });
    pas = "marquer";
    if (!objet(r)) throw reponseInvalide("not an object");
    if (!objet(r.resume)) throw reponseInvalide("no resume");
    verifierLePaquet(r.paquet, { de: mac, ici: moi });
    exigerDesRefus(r.resume.refus, "refusal");
    // La réponse est entière : l'autre Mac a posé `marquer` avant d'importer et
    // de répondre. Ce qui était dû est rendu, même si la marque d'ici lève.
    rapport.confirmees = du.portees.length;
    rapport.rendus = du.rendus.length;
    rapport.refus_rendus = du.refusees?.length ?? 0;
    enAttente.delete(mac);
    rapport.evenements_emportes = marquerRendus(db, mac, q.evenements, { at: at() });
  } catch (erreur) {
    rapport.erreur = typeof erreur?.code === "string" && erreur.code ? erreur.code : ERREUR_PAR_DEFAUT;
    rapport.pas = pas;
    rapport.detail = String(erreur?.message ?? erreur);
  }
  rapport.duree_ms = Math.round(performance.now() - debut);
  return rapport;
}

// Le statut s'écrit d'un geste (un brouillon, puis `rename`) : `etat` ne lit
// jamais un fichier à moitié écrit. Un statut qui ne s'écrit pas ne fait pas
// rater la tournée — ses marques sont posées ; il se dit au journal.
function ecrireLeStatut(racine, statut, journal) {
  const dossier = path.join(racine, "status");
  const fichier = path.join(dossier, "relais.json");
  const brouillon = `${fichier}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
    fs.writeFileSync(brouillon, `${JSON.stringify(statut)}\n`, { mode: 0o600 });
    fs.renameSync(brouillon, fichier);
  } catch (erreur) {
    try {
      fs.unlinkSync(brouillon);
    } catch {
      /* jamais écrit */
    }
    journal({ evenement: "relais_statut_non_ecrit", fichier, detail: String(erreur?.message ?? erreur) });
  }
}
