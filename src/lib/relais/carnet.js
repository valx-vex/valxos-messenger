// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE CARNET D'ADRESSES DE L'AUTRE MAC (schéma 8, table `carnet`).
//
// Chaque Mac garde son bureau. Le carnet dit quelles chaises vivent sur
// l'AUTRE Mac, telles que le dernier échange du relais les a montrées : une
// lettre pour l'une d'elles est « à porter » (`resolveRecipient` rend
// `kind: "distant"`, registry.js). Le carnet ne livre rien ; il répond à une
// seule question : « ce nom vit-il là-bas ? ».
//
// Camp B, sans exception : AUCUN DELETE ici. Une chaise que l'autre Mac ne
// montre plus reçoit `parti_at`, et sa fiche reste lisible pour toujours. Une
// chaise qui revient reprend sa fiche (`parti_at` remis à nul).
//
// Ce module ne lit QUE le carnet, et n'importe rien de registry.js : c'est
// registry.js qui l'importe (aucun cycle). La règle de tenue d'une lignée, qui
// compare une désignée d'ici à une désignée de là-bas, vit dans registry.js
// (`laLigneeEstTenueAilleurs`), à côté de la résolution qu'elle commande ; ce
// module lui fournit la moitié distante et l'ordre (`clefDeTenue`,
// `comparerClefsDeTenue`).
//
// Les lectures ne PEUVENT PAS échouer bruyamment (même doctrine que
// `lireAncienNom`) : sur un bureau où la table n'a pas pu naître, il n'y a
// simplement personne au carnet, et le courrier local circule comme avant.
import { nowIso } from "../config.js";

const COLONNES = "chaise_id, lineage, instance_session_id, mac, is_primary, designe_at, vu_at, parti_at";

function carnetInvalide(message) {
  const erreur = new Error(`invalid carnet entry: ${message}`);
  erreur.code = "carnet-chaise-invalide";
  return erreur;
}

// Inscrire les chaises que l'autre Mac vient de montrer. `chaises` est la liste
// COMPLÈTE de ce Mac (le paquet porte toutes ses chaises en service) : une
// fiche de CE Mac absente de la liste est partie. Les fiches d'un autre Mac ne
// sont jamais touchées. Une transaction : une chaise illisible refuse tout le
// lot, et rien n'est écrit (un pas qui échoue ne marque rien).
export function ecrireLeCarnet(db, mac, chaises, { at = null } = {}) {
  const nomDuMac = String(mac ?? "").trim();
  if (!nomDuMac) throw carnetInvalide("the other Mac's name is required");
  const heure = at || nowIso();
  const liste = Array.isArray(chaises) ? chaises : [];

  const inscrire = db.prepare(`
    INSERT INTO carnet (${COLONNES})
    VALUES (@chaise_id, @lineage, @instance_session_id, @mac, @is_primary, @designe_at, @vu_at, NULL)
    ON CONFLICT(chaise_id) DO UPDATE SET
      lineage = excluded.lineage,
      instance_session_id = excluded.instance_session_id,
      mac = excluded.mac,
      is_primary = excluded.is_primary,
      designe_at = excluded.designe_at,
      vu_at = excluded.vu_at,
      parti_at = NULL
  `);
  const presentes = db.prepare("SELECT chaise_id FROM carnet WHERE mac = ? AND parti_at IS NULL");
  const marquerPartie = db.prepare("UPDATE carnet SET parti_at = ? WHERE chaise_id = ? AND mac = ? AND parti_at IS NULL");

  return db.transaction(() => {
    const vues = new Set();
    for (const chaise of liste) {
      const chaiseId = String(chaise?.chaise_id ?? "").trim();
      const lineage = String(chaise?.lineage ?? "").trim();
      if (!chaiseId) throw carnetInvalide("a chair without chaise_id");
      if (!lineage) throw carnetInvalide(`chair ${JSON.stringify(chaiseId)} has no lineage`);
      const session = chaise?.instance_session_id;
      inscrire.run({
        chaise_id: chaiseId,
        lineage,
        instance_session_id: session === null || session === undefined || session === "" ? null : String(session),
        mac: nomDuMac,
        is_primary: chaise?.is_primary === true || Number(chaise?.is_primary) === 1 ? 1 : 0,
        designe_at: chaise?.designe_at ? String(chaise.designe_at) : null,
        vu_at: heure
      });
      vues.add(chaiseId);
    }
    let parties = 0;
    for (const { chaise_id: chaiseId } of presentes.all(nomDuMac)) {
      if (!vues.has(chaiseId)) parties += marquerPartie.run(heure, chaiseId, nomDuMac).changes;
    }
    return { inscrites: vues.size, parties };
  })();
}

// La fiche entière d'une chaise présente au carnet (`parti_at` nul), ou null.
export function ficheDuCarnet(db, adresse) {
  const id = String(adresse ?? "").trim();
  if (!id) return null;
  try {
    return db.prepare(`SELECT ${COLONNES} FROM carnet WHERE chaise_id = ? AND parti_at IS NULL`).get(id) || null;
  } catch {
    return null;
  }
}

// Une chaise de l'autre Mac, par son `chaise_id` EXACT.
export function chaiseDistante(db, adresse) {
  const fiche = ficheDuCarnet(db, adresse);
  return fiche ? { mac: fiche.mac, chaise_id: fiche.chaise_id } : null;
}

// Les fiches présentes d'une lignée (ordre stable : mac, puis chaise_id).
export function chaisesDistantesDeLaLignee(db, lignee) {
  const nom = String(lignee ?? "").trim();
  if (!nom) return [];
  try {
    return db
      .prepare(`SELECT ${COLONNES} FROM carnet WHERE lineage = ? AND parti_at IS NULL ORDER BY mac ASC, chaise_id ASC`)
      .all(nom);
  } catch {
    return [];
  }
}

// Les lignées présentes au carnet (pour la tournée générale, `broadcastRecipients`).
export function ligneesDuCarnet(db) {
  try {
    return db
      .prepare("SELECT DISTINCT lineage FROM carnet WHERE parti_at IS NULL ORDER BY lineage ASC")
      .all()
      .map((r) => r.lineage)
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── L'ORDRE DE TENUE ────────────────────────────────────────────────────────
//
// Une seule règle, la même sur les deux Macs : la clef d'une désignée est le
// couple `[designe_at ?? "", chaise_id]`, et la plus GRANDE tient la lignée.
// Comparée telle quelle sur les deux Macs, elle désigne la même chaise des deux
// côtés : à égalité d'heure, le `chaise_id` départage ; une désignée d'avant le
// schéma 8 (`designe_at` nul) vaut "" et cède à toute désignée datée.
// ⚠️ L'ordre est celui des unités de code (`<`), JAMAIS `localeCompare` : un
// ordre qui dépend de la langue de la machine pourrait différer d'un Mac à
// l'autre, et deux Macs qui ne trient pas pareil gardent chacun la lignée.
export function clefDeTenue(designeAt, chaiseId) {
  return [designeAt ? String(designeAt) : "", String(chaiseId ?? "")];
}

export function comparerClefsDeTenue(a, b) {
  for (let i = 0; i < 2; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// La désignée de l'autre Mac qui a la plus grande clef, pour cette lignée, ou null.
export function designeeDistante(db, lignee) {
  let meilleure = null;
  for (const fiche of chaisesDistantesDeLaLignee(db, lignee)) {
    if (Number(fiche.is_primary) !== 1) continue;
    const clef = clefDeTenue(fiche.designe_at, fiche.chaise_id);
    if (!meilleure || comparerClefsDeTenue(clef, meilleure.clef) > 0) meilleure = { fiche, clef };
  }
  return meilleure;
}
