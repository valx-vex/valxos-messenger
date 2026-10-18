// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE GUICHET — la loi du courrier, écrite une fois, tenue pour toute surface.
//
// ⚠️ Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) : le
// bureau de poste vivant (~/.cc2cc-v2) n'est JAMAIS ouvert ici. Le plancher se
// pose AVANT le premier test parce qu'`openDatabase` appelle `ensureRuntimeDirs`,
// qui lit `baseDir()` — l'ENV du runner, jamais le fichier qu'on lui impose
// (remède de la revue adverse F2). L'état d'origine se restaure à la fin.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-guichet-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { openDatabase } from "../src/lib/database.js";
import { registerInstance, resolveRecipient } from "../src/lib/registry.js";
import { posterUneLettre, resoudreSansCasser, scannerSansCasser } from "../src/lib/guichet.js";
import { poserLeBureau } from "./aide-env.js";

const decors = [];
function decorJetable(prefixe = "cc2cc-guichet-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  decors.push(dir);
  return dir;
}
after(() => {
  for (const dir of decors) fs.rmSync(dir, { recursive: true, force: true });
});

function bureauDePoste(t) {
  const root = decorJetable("cc2cc-guichet-home-");
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => {
    try {
      db.close();
    } catch {
      /* base jetable */
    }
  });
  return db;
}

// Une chaise vivante : c'est elle qui fait taire `attenteDeLaLettre` et qui
// pousse l'avis jusqu'à `trouverLaBoite`. Sans elle, l'avis sortirait par la
// porte « destinataire inconnu » et ne prouverait rien sur le partage de la
// résolution — le compte d'appels serait vrai pour la mauvaise raison.
const MAISON_DE_LA_CHAISE = "/maison/carton";
function chaiseVivante(db, lignee, session = `s-${lignee}`) {
  registerInstance(db, { lineage: lignee, sessionId: session, house: MAISON_DE_LA_CHAISE, pid: 4242 });
  return session;
}

// Le réveil ne frappe à AUCUNE vraie porte ici : ce qu'on veut lire, c'est le
// NOM auquel le guichet a décidé de frapper, pas l'état d'une socket.
function reveilEnregistre() {
  const portes = [];
  return {
    portes,
    reveiller: async (agentId, payload) => {
      portes.push({ agentId, payload });
      return { ok: false, socketPath: `/carton/${agentId}.sock`, error: "ENOENT" };
    }
  };
}

const MAISONS_VIDES = () => ({ houses: [], parSession: new Map() });

// ── L'INSTRUMENT QUI DISTINGUE (remède ①, 22/08) ─────────────────────────────
// La doublure d'origine de ce fichier DÉLÉGUAIT au vrai résolveur
// (`return resolveRecipient(base, nom)`), et c'est précisément ce qui la rendait
// aveugle : quand la doublure rend la MÊME valeur que le résolveur importé, le
// monde « une résolution partagée » et le monde « chacun se refait la sienne »
// produisent le MÊME résultat, et plus aucune assertion ne peut les séparer. Il
// ne restait qu'un compteur — qui ne voit même pas `porteDeReveil`, lequel
// interroge le `resolveRecipient` IMPORTÉ par registry.js, invisible d'ici.
// Mutation exécutée sur l'ancienne version, `porteDeReveil(db, row.recipient)`
// (le réveil se refait sa propre résolution, l'écart exact que le remède de la
// revue adverse #3/C2 a payé — 4 divergences sur 12 lettres rejouées) : 499 pass / 0 fail.
//
// Celle-ci ne délègue PAS. Elle rend une cible que le registre ne porte pas :
// une autre porte de réveil, et une autre maison. Un consommateur qui se refait
// sa propre résolution retombe sur le registre — donc sur l'AUTRE nom et
// l'AUTRE maison — et le test le voit.
const PORTE_DU_RELAIS = "alpha-par-le-relais";
const MAISON_DU_RELAIS = "/maison/du-relais";
function resolveurQuiSeDistingue(session) {
  const demandes = [];
  return {
    demandes,
    resoudre: (_base, nom) => {
      demandes.push(nom);
      return {
        kind: "lineage",
        targets: [
          {
            id: PORTE_DU_RELAIS,
            lineage: PORTE_DU_RELAIS,
            instance_session_id: session,
            house: MAISON_DU_RELAIS
          }
        ]
      };
    }
  };
}

// ── R2 : tout se dérive de la LIGNE, jamais du `to` qu'on vient de taper ─────
test("posterUneLettre rend {row, resolution, wake, attente} — et le destinataire vient de la BASE", async (t) => {
  const db = bureauDePoste(t);
  chaiseVivante(db, "alpha");
  chaiseVivante(db, "beta");

  const demandes = [];
  const resoudre = (base, nom) => {
    demandes.push(nom);
    return resolveRecipient(base, nom);
  };
  const { portes, reveiller } = reveilEnregistre();

  const premier = await posterUneLettre(
    db,
    { msg_id: "m-rejeu", sender: "expediteur", recipient: "alpha", body: "la première" },
    { resoudre, reveiller, maisons: MAISONS_VIDES() }
  );
  assert.equal(premier.row.recipient, "alpha");
  assert.ok(premier.wake, "la réponse porte le réveil");
  assert.ok("attente" in premier, "la réponse porte l'avis d'attente, même nul");
  assert.ok(premier.resolution, "la réponse porte la résolution partagée");

  demandes.length = 0;
  portes.length = 0;

  // LE REJEU : même msg_id, AUTRE nom. La ligne existante gagne — sinon on
  // réveillerait la porte de `beta` en prétendant avoir livré à `beta`, alors
  // que la seule lettre en base est celle d'`alpha`.
  const rejeu = await posterUneLettre(
    db,
    { msg_id: "m-rejeu", sender: "expediteur", recipient: "beta", body: "la seconde" },
    { resoudre, reveiller, maisons: MAISONS_VIDES() }
  );
  assert.equal(rejeu.row.msg_id, "m-rejeu");
  assert.equal(rejeu.row.recipient, "alpha", "la ligne EXISTANTE parle, jamais le `to` demandé");
  assert.equal(rejeu.row.body, "la première", "aucune seconde lettre n'est née");
  assert.deepEqual(portes.map((p) => p.agentId), ["alpha"], "on frappe chez alpha, jamais chez beta");
  assert.deepEqual(portes.map((p) => p.payload), ["m-rejeu"]);
  assert.deepEqual(demandes, ["alpha"], "même la résolution n'entend jamais parler de beta");
});

// ── C2 : UNE résolution par lettre, lue par les DEUX consommateurs ───────────
// Ce test NOMMAIT C2 et n'en tenait que la moitié : son compteur n'enveloppait
// que le `resoudre` INJECTÉ, alors que `porteDeReveil` interroge le résolveur
// IMPORTÉ. Il reste donc, mais l'instrument a changé (voir
// `resolveurQuiSeDistingue`) : la résolution de cette lettre désigne une porte
// et une maison que le REGISTRE ne connaît pas. Les deux consommateurs sont
// désormais lus sur ce qu'ils PRODUISENT, pas sur un compte d'appels :
//   · le réveil frappe chez `alpha-par-le-relais` — s'il se refait sa propre
//     résolution il frappe chez `alpha`, le nom du registre ;
//   · l'avis dit `boite-endormie` (la maison du relais est dans l'inventaire
//     fourni) — s'il se refait la sienne il lit `/maison/carton`, absent de
//     l'inventaire, et dit `maison-inconnue`.
// Le compteur reste, mais comme témoin secondaire : il ne prouve plus rien à
// lui seul, et il ne doit plus JAMAIS être le seul oracle de ce test.
test("la MÊME résolution sert au réveil et à l'avis — une seule par lettre", async (t) => {
  const db = bureauDePoste(t);
  const session = chaiseVivante(db, "alpha");

  const { demandes, resoudre } = resolveurQuiSeDistingue(session);
  const { portes, reveiller } = reveilEnregistre();
  // L'inventaire fourni connaît la maison DU RELAIS, jamais celle du registre :
  // les deux mondes ne peuvent plus rendre le même avis.
  const maisons = { houses: [{ house: MAISON_DU_RELAIS }], parSession: new Map() };

  const poste = await posterUneLettre(
    db,
    { sender: "expediteur", recipient: "alpha", body: "une seule résolution" },
    { resoudre, reveiller, maisons }
  );

  assert.equal(portes.length, 1);
  assert.equal(
    portes[0].agentId,
    PORTE_DU_RELAIS,
    "le réveil lit LA résolution de cette lettre — pas une deuxième, refaite au registre"
  );
  // L'avis est allé jusqu'à `trouverLaBoite` (aucune boîte dans l'inventaire),
  // et il l'a fait SUR LA MÊME résolution : la maison qu'il a jugée est celle
  // du relais, pas celle du registre.
  assert.equal(
    poste.attente?.motif,
    "boite-endormie",
    "l'avis a traversé l'acheminement sur LA MÊME résolution — `maison-inconnue` voudrait dire qu'il s'en est refait une"
  );
  assert.deepEqual(demandes, ["alpha"], `une résolution par lettre, pas ${demandes.length}`);
});

// ── C1 : le scan se PARTAGE — broadcast n'en fait pas un par cible ───────────
// ⑤ (22/08) — ce test fournissait `MAISONS_VIDES()` ET un scanner qui rendait
// `MAISONS_VIDES()` : les deux mondes rendaient la MÊME valeur, et seul le
// compte d'appels les séparait. Mutation exécutée : garder l'appel mais jeter
// son CONTENU (`const houses = []; const parSession = new Map();`) → 6 pass /
// 0 fail. Un compteur ne prouve jamais qu'une valeur a été LUE.
// L'inventaire fourni contient donc désormais la maison de la chaise : s'il est
// lu, l'avis dit `boite-endormie` (maison connue, aucune boîte) ; s'il est jeté
// pour un `houses: []`, l'avis dit `maison-inconnue`. Les deux mondes ne
// peuvent plus rendre la même chose.
test("un {houses, parSession} fourni est RÉUTILISÉ, jamais recalculé — et son CONTENU est lu", async (t) => {
  const db = bureauDePoste(t);
  chaiseVivante(db, "alpha");
  chaiseVivante(db, "beta");

  let scans = 0;
  const scanner = () => {
    scans += 1;
    return MAISONS_VIDES();
  };
  const { reveiller } = reveilEnregistre();
  // MAISON_DE_LA_CHAISE est celle que `chaiseVivante` inscrit au registre. Le
  // scanner, lui, ne rendrait rien : les deux valeurs sont distinguables.
  const maisons = { houses: [{ house: MAISON_DE_LA_CHAISE }], parSession: new Map() };

  const avis = [];
  for (const nom of ["alpha", "beta"]) {
    const poste = await posterUneLettre(
      db,
      { sender: "expediteur", recipient: nom, body: "diffusion" },
      { reveiller, scanner, maisons }
    );
    avis.push(poste.attente?.motif);
  }

  assert.equal(scans, 0, `un scan fourni ne se recalcule pas — ${scans} scan(s) de trop`);
  assert.deepEqual(
    avis,
    ["boite-endormie", "boite-endormie"],
    "l'inventaire FOURNI a été lu : sa maison est connue. `maison-inconnue` voudrait dire qu'on a jeté son contenu"
  );
});

test("aucun {houses, parSession} fourni ⇒ le guichet en calcule un lui-même, UN par lettre", async (t) => {
  const db = bureauDePoste(t);
  chaiseVivante(db, "alpha");

  let scans = 0;
  const scanner = () => {
    scans += 1;
    return MAISONS_VIDES();
  };
  const { reveiller } = reveilEnregistre();

  await posterUneLettre(
    db,
    { sender: "expediteur", recipient: "alpha", body: "sans maisons" },
    { reveiller, scanner }
  );

  assert.equal(scans, 1, `le guichet doit scanner lui-même quand personne ne lui donne de maisons (${scans})`);
});

// ── R2 (suite) + ⑥ : la ligne existante gagne MÊME quand personne ne la résout ─
// Le test R2 du haut de ce fichier ne mordait que par chance : ses deux noms
// sont des lignées VIVANTES, donc la résolution a exactement UNE cible, et dans
// ce cas `porteDeReveil` IGNORE son argument destinataire (registry.js:723-726)
// et lit la cible de la résolution. Mutation exécutée sur ce décor-là — dériver
// le réveil et l'avis d'`entree.recipient` au lieu de `row.recipient`, en
// laissant la résolution sur la ligne : VERT, alors que c'est exactement le bug.
//
// Hors de ce cas, il est bien réel : `ghost` n'a AUCUNE fiche, la résolution a
// zéro cible, `porteDeReveil` rend alors le nom TEL QU'IL LUI EST DONNÉ — et
// c'est là que la mutation frappe à la socket d'`alpha` pour une lettre qui est
// en base au nom de `ghost`. Le posteur, lui, s'entend dire que tout va bien.
test("le rejeu d'une lettre au nom d'un fantôme frappe chez le FANTÔME — pas chez le nom qu'on vient de taper", async (t) => {
  const db = bureauDePoste(t);
  chaiseVivante(db, "alpha"); // vivante, résolvable, et JAMAIS la destinataire

  const { portes, reveiller } = reveilEnregistre();

  const premier = await posterUneLettre(
    db,
    { msg_id: "m-fantome", sender: "expediteur", recipient: "ghost", body: "au fantôme" },
    { reveiller, maisons: MAISONS_VIDES() }
  );
  assert.equal(premier.row.recipient, "ghost");
  assert.equal(premier.resolution.targets.length, 0, "le décor ne vaut QUE si `ghost` est vraiment introuvable");
  assert.equal(premier.rejeu, null, "un premier envoi n'est le rejeu de rien");

  portes.length = 0;

  // LE REJEU : même msg_id, et cette fois un nom PARFAITEMENT vivant.
  const rejeu = await posterUneLettre(
    db,
    { msg_id: "m-fantome", sender: "expediteur", recipient: "alpha", body: "détourné" },
    { reveiller, maisons: MAISONS_VIDES() }
  );

  assert.equal(rejeu.row.recipient, "ghost", "la ligne EXISTANTE parle");
  assert.equal(rejeu.row.body, "au fantôme", "aucune seconde lettre n'est née");
  assert.deepEqual(
    portes.map((p) => p.agentId),
    ["ghost"],
    "on frappe chez le fantôme — frapper chez alpha réveillerait la mauvaise porte pour une lettre qui n'est pas la sienne"
  );
  assert.equal(
    rejeu.attente?.motif,
    "destinataire-inconnu",
    "l'avis parle de la lettre EN BASE — un avis nul dirait au posteur que tout va bien"
  );
  // ④ — et le posteur apprend que son `to` a été écarté, au guichet, pas dans
  // la mise en forme d'une surface.
  assert.deepEqual(rejeu.rejeu, { motif: "msg_id-deja-connu", demande: "alpha" });
});

// ── LES DEUX ABSTENTIONS : un accessoire qui tombe ne retient pas la lettre ──
test("un scan qui LÈVE n'empêche pas la lettre de partir", async (t) => {
  const db = bureauDePoste(t);
  chaiseVivante(db, "alpha");

  const { portes, reveiller } = reveilEnregistre();
  const scanner = () => {
    throw new Error("la tournée des maisons a explosé");
  };

  const poste = await posterUneLettre(
    db,
    { sender: "expediteur", recipient: "alpha", body: "malgré le scan" },
    { reveiller, scanner }
  );

  assert.ok(poste.row?.msg_id, "la lettre est en base");
  assert.equal(poste.row.recipient, "alpha");
  assert.equal(portes.length, 1, "le réveil a quand même eu lieu");
  assert.ok(poste.resolution, "la résolution, elle, a bien été faite");

  // L'abstention se dit aussi toute seule : des maisons vides, jamais une erreur.
  const replique = scannerSansCasser({ scanner });
  assert.deepEqual(replique.houses, []);
  assert.equal(replique.parSession.size, 0);
});

test("une résolution qui LÈVE n'empêche pas la lettre de partir", async (t) => {
  const db = bureauDePoste(t);
  chaiseVivante(db, "alpha");

  const { portes, reveiller } = reveilEnregistre();
  const resoudre = () => {
    throw new Error("le registre a explosé");
  };

  const poste = await posterUneLettre(
    db,
    { sender: "expediteur", recipient: "alpha", body: "malgré la résolution" },
    { reveiller, resoudre, maisons: MAISONS_VIDES() }
  );

  assert.ok(poste.row?.msg_id, "la lettre est en base");
  assert.equal(poste.row.recipient, "alpha");
  assert.equal(poste.resolution, null, "l'abstention se dit NULL, elle ne jette pas");
  assert.equal(portes.length, 1, "le réveil a quand même eu lieu");

  // L'abstention se dit aussi toute seule.
  assert.equal(resoudreSansCasser(db, "alpha", { resoudre }), null);
});
