// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE CARNET DES TABLES — un carnet d'adresses, jamais une boîte.
//
// Une table dit À QUI écrire et COMMENT réveiller ; elle ne garde aucun
// courrier. Ce fichier prouve le schéma 7 et chaque geste du carnet.
//
// Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) :
// le bureau de poste vivant n'est JAMAIS ouvert ici.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { initSchema, openDatabase } from "../src/lib/database.js";
import { SCHEMA_VERSION, schemaVersion } from "../src/lib/migrations.js";
import { LONGUEUR_POSITION, MODES, REGLES_REVEIL, ajouterMembre, creerTable, enclosDe, enclosDeTable, estMembre, listerTables, membresDeTable, modifierTable, obtenirTable, poserEnclos, retirerEnclos, retirerMembre, validerNomDeTable } from "../src/lib/tables.js";
import * as carnet from "../src/lib/tables.js";
import { poserLeBureau } from "./aide-env.js";

function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-tables-"));
  poserLeBureau(root);
  return root;
}

function bureauDePoste(t) {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return db;
}

const T0 = "2026-10-21T10:00:00.000Z";
const T1 = "2026-10-21T10:05:00.000Z";
const T2 = "2026-10-21T11:00:00.000Z";

// ── LE SCHÉMA 7 ──────────────────────────────────────────────────────────────

test("un bureau neuf porte le schéma 8 : les trois tables, les sept colonnes, les trois index", (t) => {
  const db = bureauDePoste(t);
  assert.equal(SCHEMA_VERSION, 8);
  assert.equal(schemaVersion(db), 8);
  const noms = (type, liste) => db
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name IN (${liste.map(() => "?").join(", ")}) ORDER BY name`)
    .all(type, ...liste)
    .map((r) => r.name);
  assert.deepEqual(noms("table", ["tables", "table_membres", "enclos"]), ["enclos", "table_membres", "tables"]);
  assert.deepEqual(
    noms("index", ["idx_messages_envoi", "idx_messages_table_seq", "idx_table_membres_adresse"]),
    ["idx_messages_envoi", "idx_messages_table_seq", "idx_table_membres_adresse"]
  );
  const colonnes = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
  for (const c of ["envoi_id", "table_nom", "reponse_a", "sans_reveil", "sans_copie", "sender_chaise", "reservices"]) {
    assert.ok(colonnes.includes(c), `colonne manquante sur messages : ${c}`);
  }
  // Les défauts : une lettre d'aujourd'hui, insérée sans un mot sur les tables, est ordinaire.
  db.prepare("INSERT INTO messages (msg_id, sender, recipient, body, created_at) VALUES ('t7-1', 'bob', 'alice', 'sans table', ?)").run(T0);
  const lettre = db.prepare("SELECT envoi_id, table_nom, reponse_a, sans_reveil, sans_copie, sender_chaise, reservices FROM messages WHERE msg_id = 't7-1'").get();
  assert.deepEqual(lettre, { envoi_id: null, table_nom: null, reponse_a: null, sans_reveil: 0, sans_copie: 0, sender_chaise: null, reservices: 0 });
  // Les contraintes vivent sur les colonnes neuves : un drapeau hors {0,1} ne s'écrit pas.
  assert.throws(() => db.prepare("UPDATE messages SET sans_reveil = 2").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE messages SET sans_copie = 2").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE messages SET reservices = -1").run(), /CHECK/);
});

// ── LE NOM D'UNE TABLE ───────────────────────────────────────────────────────

test("validerNomDeTable : minuscules, 1 à 32 caractères de [a-z0-9-], jamais un début par « - » ni un séparateur d'adresse", () => {
  assert.equal(validerNomDeTable("Film"), "film");
  assert.equal(validerNomDeTable("  FERMEE-TEST "), "fermee-test");
  assert.equal(validerNomDeTable("famille-test"), "famille-test");
  assert.equal(validerNomDeTable("7"), "7");
  assert.equal(validerNomDeTable("a".repeat(32)), "a".repeat(32));
  for (const mauvais of ["", "   ", "-film", "a b", "table:film", "film@atelier", "film#1", "é", "a".repeat(33), null, undefined, 42]) {
    assert.throws(
      () => validerNomDeTable(mauvais),
      (erreur) => erreur instanceof Error && erreur.code === "nom-de-table-invalide" && /table name/.test(erreur.message),
      `« ${String(mauvais)} » devrait être refusé`
    );
  }
  assert.deepEqual(REGLES_REVEIL, ["reveil", "prochain-tour"]);
  assert.deepEqual(MODES, ["normal", "direct"]);
  assert.equal(LONGUEUR_POSITION, 120);
});

test("validerNomDeTable : l'écho du refus remplace les caractères de contrôle par une espace, même avant le 64e caractère", () => {
  assert.throws(
    () => validerNomDeTable("ab\ncd ef"),
    (e) => e.code === "nom-de-table-invalide" && e.message.startsWith('"ab cd ef" is not a table name') && !/[\r\n]/.test(e.message)
  );
  assert.throws(
    () => validerNomDeTable(`x\ty\u2028z\r${"w".repeat(80)}`),
    (e) => e.message.startsWith(`"x y z ${"w".repeat(58)}…" is not a table name`),
    "tabulation, séparateur de ligne Unicode et retour chariot : une espace chacun, puis la coupe à 64"
  );
});

// ── CRÉER, LIRE ──────────────────────────────────────────────────────────────

test("creerTable : la ligne naît avec ses défauts, le nom en minuscules, et les deux cachets", (t) => {
  const db = bureauDePoste(t);
  const ligne = creerTable(db, { nom: "Film", creeePar: "alice", now: T0 });
  assert.deepEqual(ligne, {
    nom: "film", fermee: 0, reveil: "reveil", mode: "normal",
    position: null, position_par: null, position_le: null,
    creee_par: "alice", creee_le: T0, modifiee_le: T0
  });
  assert.deepEqual(obtenirTable(db, "FILM"), ligne, "obtenirTable normalise comme creerTable");
  assert.equal(obtenirTable(db, "inconnue"), null);
  assert.equal(obtenirTable(db, "table:film"), null, "un nom invalide ne lève pas à la lecture : il n'existe pas, c'est tout");
  assert.equal(obtenirTable(db, null), null);
});

test("creerTable : fermée, prochain-tour, direct — chaque réglage s'écrit tel quel, le cachet est l'heure courante par défaut", (t) => {
  const db = bureauDePoste(t);
  const avant = new Date().toISOString();
  const ligne = creerTable(db, { nom: "fermee-test", fermee: true, reveil: "prochain-tour", mode: "direct" });
  assert.equal(ligne.fermee, 1);
  assert.equal(ligne.reveil, "prochain-tour");
  assert.equal(ligne.mode, "direct");
  assert.equal(ligne.creee_par, null);
  assert.ok(ligne.creee_le >= avant, "le cachet est posé maintenant");
  assert.equal(ligne.modifiee_le, ligne.creee_le);
});

test("creerTable : un nom déjà pris est refusé (table-existe), un réglage inconnu aussi, et un refus n'écrit rien", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film" });
  assert.throws(() => creerTable(db, { nom: "FILM" }), (e) => e.code === "table-existe" && e.nom === "film" && /already exists/.test(e.message));
  assert.throws(() => creerTable(db, { nom: "x", reveil: "jamais" }), (e) => e.code === "reveil-invalide");
  assert.throws(() => creerTable(db, { nom: "x", mode: "silencieux" }), (e) => e.code === "mode-invalide");
  assert.throws(() => creerTable(db, { nom: "-x" }), (e) => e.code === "nom-de-table-invalide");
  assert.throws(() => creerTable(db, {}), (e) => e.code === "nom-de-table-invalide");
  assert.equal(obtenirTable(db, "x"), null, "un refus n'écrit rien");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tables").get().n, 1);
});

// ── LISTER : ce que chacun voit ──────────────────────────────────────────────

test("listerTables : sans adresses, toutes les tables OUVERTES, triées par nom ; une table fermée est invisible", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film", now: T0 });
  creerTable(db, { nom: "famille-test", now: T0 });
  creerTable(db, { nom: "fermee-test", fermee: true, now: T0 });
  ajouterMembre(db, "fermee-test", "alice", { now: T0 });
  assert.deepEqual(listerTables(db).map((l) => l.nom), ["famille-test", "film"], "fermée = invisible sans adresses");
  assert.deepEqual(listerTables(db, {}).map((l) => l.nom), ["famille-test", "film"]);
  assert.deepEqual(listerTables(db, { adresses: null }).map((l) => l.nom), ["famille-test", "film"]);
});

test("listerTables : avec adresses, les tables dont UN membre actif est dans la liste — fermées comprises, sous la forme écrite", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film", now: T0 });
  creerTable(db, { nom: "fermee-test", fermee: true, now: T0 });
  creerTable(db, { nom: "office-test", now: T0 });
  ajouterMembre(db, "film", "alice", { now: T0 });
  ajouterMembre(db, "fermee-test", "alice#sess-1", { now: T0 });
  ajouterMembre(db, "office-test", "bob", { now: T0 });
  assert.deepEqual(listerTables(db, { adresses: ["alice", "alice#sess-1", "alice@atelier"] }).map((l) => l.nom), ["fermee-test", "film"]);
  assert.deepEqual(listerTables(db, { adresses: ["alice"] }).map((l) => l.nom), ["film"], "la lignée seule n'est pas la chaise écrite dans fermee-test");
  assert.deepEqual(listerTables(db, { adresses: "bob" }).map((l) => l.nom), ["office-test"], "une chaîne seule est acceptée");
  assert.deepEqual(listerTables(db, { adresses: ["carol"] }), [], "aucune table pour une adresse qui n'est membre de rien");
  assert.deepEqual(listerTables(db, { adresses: [] }), [], "une liste vide ne rend rien : ce n'est pas « toutes »");
  retirerMembre(db, "fermee-test", "alice#sess-1", { now: T1 });
  assert.deepEqual(listerTables(db, { adresses: ["alice#sess-1"] }), [], "un membre retiré ne voit plus la table fermée");
});

// ── LES MEMBRES ──────────────────────────────────────────────────────────────

test("ajouterMembre : la ligne, le réveil propre, la table touchée ; table inconnue, réglage inconnu et adresse vide refusés", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film", now: T0 });
  const ligne = ajouterMembre(db, "film", " bob ", { reveil: "prochain-tour", ajoutePar: "alice", now: T1 });
  assert.deepEqual(ligne, { nom_table: "film", adresse: "bob", reveil: "prochain-tour", ajoute_par: "alice", ajoute_le: T1, retire_par: null, retire_le: null });
  assert.equal(obtenirTable(db, "film").modifiee_le, T1, "un membre qui entre modifie la table");
  assert.throws(() => ajouterMembre(db, "inconnue", "bob"), (e) => e.code === "table-inconnue" && e.nom === "inconnue");
  assert.throws(() => ajouterMembre(db, "film", "carol", { reveil: "jamais" }), (e) => e.code === "reveil-invalide");
  for (const mauvaise of ["", "  ", "a b", "table:film", null]) {
    assert.throws(() => ajouterMembre(db, "film", mauvaise), (e) => e.code === "adresse-invalide", `« ${String(mauvaise)} »`);
  }
  assert.deepEqual(membresDeTable(db, "film").map((m) => m.adresse), ["bob"], "un refus n'écrit rien");
});

test("membresDeTable et estMembre : les actifs seulement, triés par adresse, sous la forme écrite", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film", now: T0 });
  ajouterMembre(db, "film", "carol", { now: T0 });
  ajouterMembre(db, "film", "alice#sess-1", { now: T0 });
  ajouterMembre(db, "film", "bob@atelier", { reveil: "prochain-tour", ajoutePar: "alice", now: T0 });
  assert.deepEqual(membresDeTable(db, "FILM"), [
    { adresse: "alice#sess-1", reveil: null, ajoute_par: null, ajoute_le: T0 },
    { adresse: "bob@atelier", reveil: "prochain-tour", ajoute_par: "alice", ajoute_le: T0 },
    { adresse: "carol", reveil: null, ajoute_par: null, ajoute_le: T0 }
  ]);
  assert.equal(estMembre(db, "film", ["alice", "alice#sess-1"]), true, "une des formes suffit");
  assert.equal(estMembre(db, "film", ["alice"]), false, "la lignée seule n'est pas la chaise écrite : la forme compte (le guichet donne toutes les formes)");
  assert.equal(estMembre(db, "film", "carol"), true, "une chaîne seule est acceptée");
  assert.equal(estMembre(db, "film", []), false);
  assert.equal(estMembre(db, "film", [""]), false);
  assert.equal(estMembre(db, "inconnue", ["carol"]), false, "une table inconnue n'a aucun membre : pas d'exception à la lecture");
  assert.deepEqual(membresDeTable(db, "inconnue"), []);
});

test("retrait puis réajout : le retrait marque (Camp B), le réajout réactive avec retire_le à NULL et un cachet neuf", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film", now: T0 });
  ajouterMembre(db, "film", "bob", { ajoutePar: "alice", now: T0 });
  assert.equal(retirerMembre(db, "film", "bob", { retirePar: "alice", now: T1 }), true);
  assert.equal(obtenirTable(db, "film").modifiee_le, T1, "un membre qui sort modifie la table");
  assert.equal(retirerMembre(db, "film", "bob", { now: T2 }), false, "déjà retiré : rien à marquer");
  assert.equal(retirerMembre(db, "film", "carol"), false, "jamais membre : rien à marquer");
  assert.equal(retirerMembre(db, "film", ""), false);
  assert.throws(() => retirerMembre(db, "inconnue", "bob"), (e) => e.code === "table-inconnue");
  assert.equal(obtenirTable(db, "film").modifiee_le, T1, "un retrait sans effet ne touche pas la table");
  const marque = db.prepare("SELECT * FROM table_membres WHERE nom_table = 'film' AND adresse = 'bob'").get();
  assert.deepEqual(marque, { nom_table: "film", adresse: "bob", reveil: null, ajoute_par: "alice", ajoute_le: T0, retire_par: "alice", retire_le: T1 }, "la ligne reste, avec son heure de retrait");
  assert.deepEqual(membresDeTable(db, "film"), [], "retiré = plus actif");
  assert.equal(estMembre(db, "film", ["bob"]), false);

  const revenu = ajouterMembre(db, "film", "bob", { reveil: "prochain-tour", ajoutePar: "carol", now: T2 });
  assert.deepEqual(revenu, { nom_table: "film", adresse: "bob", reveil: "prochain-tour", ajoute_par: "carol", ajoute_le: T2, retire_par: null, retire_le: null }, "réactivé : cachet neuf, retrait effacé");
  assert.equal(estMembre(db, "film", ["bob"]), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM table_membres").get().n, 1, "une seule ligne par (table, adresse) : la clef primaire");
});

test("ajouterMembre sur un membre ACTIF ne change que son réveil : le cachet d'entrée reste", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film", now: T0 });
  ajouterMembre(db, "film", "bob", { ajoutePar: "alice", now: T0 });
  const regle = ajouterMembre(db, "film", "bob", { reveil: "prochain-tour", ajoutePar: "carol", now: T1 });
  assert.equal(regle.reveil, "prochain-tour");
  assert.equal(regle.ajoute_le, T0, "le cachet d'entrée ne bouge pas");
  assert.equal(regle.ajoute_par, "alice", "ni l'auteur de l'entrée");
  const garde = ajouterMembre(db, "film", "bob", { now: T1 });
  assert.equal(garde.reveil, "prochain-tour", "réveil omis : le réglage du membre ne bouge pas");
  const defaut = ajouterMembre(db, "film", "bob", { reveil: null, now: T1 });
  assert.equal(defaut.reveil, null, "réveil null, dit exprès = le réglage de la table");
});

test("ajouterMembre qui RÉACTIVE un membre retiré garde son réveil d'avant quand aucun n'est donné ; un membre neuf suit la table", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film", now: T0 });
  ajouterMembre(db, "film", "bob", { reveil: "prochain-tour", ajoutePar: "alice", now: T0 });
  assert.equal(retirerMembre(db, "film", "bob", { retirePar: "alice", now: T1 }), true);
  const revenu = ajouterMembre(db, "film", "bob", { ajoutePar: "carol", now: T2 });
  assert.deepEqual(
    revenu,
    { nom_table: "film", adresse: "bob", reveil: "prochain-tour", ajoute_par: "carol", ajoute_le: T2, retire_par: null, retire_le: null },
    "réactivé sans réveil : cachet neuf, et le réglage d'avant revient avec lui"
  );
  assert.equal(retirerMembre(db, "film", "bob", { now: T2 }), true);
  assert.equal(ajouterMembre(db, "film", "bob", { reveil: "reveil", now: T2 }).reveil, "reveil", "un réveil donné gagne toujours");
  assert.equal(ajouterMembre(db, "film", "carol", { now: T2 }).reveil, null, "un membre neuf sans réveil suit la table");
});

// ── MODIFIER : réveil, mode, fermée, position ────────────────────────────────

test("modifierTable : chaque champ est optionnel, la position se tronque à 120 caractères, modifiee_le avance", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film", now: T0 });
  const direct = modifierTable(db, "Film", { mode: "direct", now: T1 });
  assert.equal(direct.mode, "direct");
  assert.equal(direct.reveil, "reveil", "un champ omis ne bouge pas");
  assert.equal(direct.fermee, 0);
  assert.equal(direct.modifiee_le, T1);
  assert.equal(direct.creee_le, T0, "le cachet de création ne bouge jamais");

  const longue = "v".repeat(200);
  const posee = modifierTable(db, "film", { position: `  ${longue}  `, positionPar: "bob", now: T2 });
  assert.equal(posee.position, "v".repeat(LONGUEUR_POSITION), "tronquée, après trim");
  assert.equal(posee.position_par, "bob");
  assert.equal(posee.position_le, T2);
  assert.equal(posee.modifiee_le, T2);
  const emoji = modifierTable(db, "film", { position: "🎬".repeat(130), now: T2 });
  assert.equal([...emoji.position].length, LONGUEUR_POSITION, "120 caractères (points de code), pas 120 unités UTF-16");
  const courte = modifierTable(db, "film", { position: "vu jusqu'à 1:25:00", now: T2 });
  assert.equal(courte.position, "vu jusqu'à 1:25:00");
  assert.equal(courte.position_par, null, "positionPar omis = inconnu");

  const fermee = modifierTable(db, "film", { fermee: true, reveil: "prochain-tour", now: T2 });
  assert.equal(fermee.fermee, 1);
  assert.equal(fermee.reveil, "prochain-tour");
  assert.equal(fermee.position, "vu jusqu'à 1:25:00", "fermer ne touche pas la position");
  const rouverte = modifierTable(db, "film", { fermee: false, now: T2 });
  assert.equal(rouverte.fermee, 0);

  const effacee = modifierTable(db, "film", { position: null, now: T2 });
  assert.equal(effacee.position, null, "position: null efface");
  assert.equal(effacee.position_par, null);
  assert.equal(effacee.position_le, T2, "l'heure de l'effacement reste");
  modifierTable(db, "film", { position: "encore", now: T2 });
  assert.equal(modifierTable(db, "film", { position: "   ", now: T2 }).position, null, "une position blanche efface aussi");

  assert.throws(() => modifierTable(db, "film", { reveil: "jamais" }), (e) => e.code === "reveil-invalide");
  assert.throws(() => modifierTable(db, "film", { mode: "x" }), (e) => e.code === "mode-invalide");
  assert.throws(() => modifierTable(db, "inconnue", { mode: "direct" }), (e) => e.code === "table-inconnue");
  const telle = obtenirTable(db, "film");
  assert.deepEqual(modifierTable(db, "film", { now: "2026-12-31T00:00:00.000Z" }), telle, "rien à modifier : la ligne telle quelle, modifiee_le n'avance pas");
  assert.deepEqual(modifierTable(db, "film", {}), telle);
});

// ── L'ENCLOS : un expéditeur, une table FERMÉE ───────────────────────────────

test("enclos sur table ouverte refusé : rien n'est posé", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film", now: T0 });
  assert.throws(
    () => poserEnclos(db, "bob", "film", { posePar: "alice", now: T0 }),
    (e) => e.code === "enclos-table-ouverte" && e.nom === "film" && /is open/.test(e.message)
  );
  assert.throws(() => poserEnclos(db, "bob", "inconnue"), (e) => e.code === "table-inconnue");
  creerTable(db, { nom: "fermee-test", fermee: true, now: T0 });
  assert.throws(() => poserEnclos(db, "", "fermee-test"), (e) => e.code === "adresse-invalide");
  assert.throws(() => poserEnclos(db, "table:fermee-test", "fermee-test"), (e) => e.code === "adresse-invalide");
  assert.equal(enclosDe(db, "bob"), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM enclos").get().n, 0, "un refus n'écrit rien");
  assert.equal(retirerEnclos(db, "bob"), false, "rien à retirer");
});

// B8 (relecture du carnet) : re-poser un enclos ACTIF sur une autre table le déplaçait en silence —
// la table quittée pouvait ensuite se rouvrir sans que personne l'ait voulu. Tant qu'il tient, un
// enclos ne se déplace plus : `enclos-existe`, et rien ne bouge. Re-poser sur la MÊME table reste un
// geste sans surprise ; levé (`retirerEnclos`), il se pose ailleurs.
test("enclos sur table fermée : la ligne ; re-poser ailleurs un enclos actif est refusé (enclos-existe, B8) ; levé, il se pose ailleurs ; retirer rend vrai puis faux", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "fermee-test", fermee: true, now: T0 });
  creerTable(db, { nom: "office-test", fermee: true, now: T0 });
  ajouterMembre(db, "fermee-test", "bob", { now: T0 });
  ajouterMembre(db, "office-test", "bob", { now: T0 });
  const ligne = poserEnclos(db, " bob ", "FERMEE-TEST", { posePar: "alice", now: T0 });
  assert.deepEqual(ligne, { expediteur: "bob", nom_table: "fermee-test", pose_par: "alice", pose_le: T0 });
  assert.deepEqual(enclosDe(db, "bob"), ligne);
  assert.deepEqual(enclosDe(db, " bob "), ligne, "l'expéditeur se lit après trim, comme il s'écrit");
  assert.throws(
    () => poserEnclos(db, "bob", "office-test", { posePar: "carol", now: T1 }),
    (e) => e.code === "enclos-existe" && e.nom === "fermee-test" && e.expediteur === "bob" && /lift it first/.test(e.message),
    "un enclos actif ne se déplace pas en silence"
  );
  assert.deepEqual(enclosDe(db, "bob"), ligne, "rien n'a bougé");
  assert.deepEqual(poserEnclos(db, "bob", "fermee-test", { posePar: "carol", now: T1 }).nom_table, "fermee-test", "re-poser sur la même table reste permis");
  assert.equal(retirerEnclos(db, "bob"), true);
  const deplace = poserEnclos(db, "bob", "office-test", { posePar: "carol", now: T2 });
  assert.deepEqual(deplace, { expediteur: "bob", nom_table: "office-test", pose_par: "carol", pose_le: T2 }, "levé, un enclos se pose ailleurs");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM enclos").get().n, 1, "un expéditeur n'a qu'une ligne d'enclos");
  assert.equal(retirerEnclos(db, "bob"), true);
  assert.equal(retirerEnclos(db, "bob"), false);
  assert.equal(enclosDe(db, "bob"), null);
  assert.equal(enclosDe(db, ""), null);
  assert.equal(retirerEnclos(db, ""), false);
});

test("enclosDeTable : les enclos ACTIFS d'une table, par expéditeur ; un enclos levé n'y est plus, une autre table non plus", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "fermee-test", fermee: true, now: T0 });
  creerTable(db, { nom: "office-test", fermee: true, now: T0 });
  for (const qui of ["carol", "bob", "alice"]) ajouterMembre(db, "fermee-test", qui, { now: T0 });
  ajouterMembre(db, "office-test", "dave", { now: T0 });
  poserEnclos(db, "carol", "fermee-test", { posePar: "alice", now: T0 });
  poserEnclos(db, "bob", "fermee-test", { posePar: "alice", now: T1 });
  poserEnclos(db, "alice", "fermee-test", { now: T1 });
  poserEnclos(db, "dave", "office-test", { now: T1 });
  retirerEnclos(db, "alice", { retirePar: "bob", now: T2 });
  assert.deepEqual(enclosDeTable(db, "FERMEE-TEST"), [
    { expediteur: "bob", pose_par: "alice", pose_le: T1 },
    { expediteur: "carol", pose_par: "alice", pose_le: T0 }
  ]);
  assert.deepEqual(enclosDeTable(db, "inconnue"), []);
  assert.deepEqual(enclosDeTable(db, "pas un nom"), [], "un nom qui ne peut pas exister n'a aucun enclos");
});

test("enclosDe : un bureau d'avant la version 7 n'a aucun enclos — jamais une porte fermée", (t) => {
  // Le guichet lira l'enclos à CHAQUE envoi : une table absente (migration
  // ratée, vieux bureau en lecture) ne doit pas fermer le courrier à toute la
  // machine. Même doctrine que `lireAlias` (registry.js).
  const root = tempHome();
  const db = new Database(path.join(root, "broker.db"));
  initSchema(db);
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'enclos'").get(), undefined, "SONDE : pas de table enclos");
  assert.equal(enclosDe(db, "bob"), null);
});

test("enclosDe n'avale que « no such table » : une base verrouillée ou une colonne absente remonte, elle n'ouvre pas la porte en silence", (t) => {
  // Une serrure que l'expéditeur a DEMANDÉE : toute autre panne qu'une table
  // absente doit se voir, pas lever l'enclos.
  const verrouillee = { prepare() { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); } };
  assert.throws(() => enclosDe(verrouillee, "bob"), (e) => e.code === "SQLITE_BUSY");
  const root = tempHome();
  const db = new Database(path.join(root, "broker.db"));
  initSchema(db);
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  // Un enclos d'avant ses colonnes de retrait : la table est là, la colonne non.
  db.exec("CREATE TABLE enclos (expediteur TEXT PRIMARY KEY, nom_table TEXT NOT NULL, pose_par TEXT, pose_le TEXT NOT NULL)");
  assert.throws(() => enclosDe(db, "bob"), /no such column/);
});

// ── L'ENCLOS SE MARQUE, IL NE S'EFFACE PAS (Camp B) ──────────────────────────

test("retirer un enclos le MARQUE : la ligne reste avec son heure et son auteur, enclosDe ne voit plus rien, re-poser réactive la même ligne", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "fermee-test", fermee: true, now: T0 });
  ajouterMembre(db, "fermee-test", "bob", { now: T0 });
  poserEnclos(db, "bob", "fermee-test", { posePar: "alice", now: T0 });
  assert.equal(retirerEnclos(db, "bob", { retirePar: "alice", now: T1 }), true);
  assert.deepEqual(
    db.prepare("SELECT * FROM enclos WHERE expediteur = 'bob'").get(),
    { expediteur: "bob", nom_table: "fermee-test", pose_par: "alice", pose_le: T0, retire_par: "alice", retire_le: T1 },
    "la ligne reste, avec son heure et son auteur"
  );
  assert.equal(enclosDe(db, "bob"), null, "retiré = plus d'enclos actif");
  assert.equal(retirerEnclos(db, "bob", { retirePar: "carol", now: T2 }), false, "déjà retiré : rien à marquer");
  assert.equal(db.prepare("SELECT retire_le FROM enclos WHERE expediteur = 'bob'").get().retire_le, T1, "un second retrait ne réécrit pas le premier");

  const revenu = poserEnclos(db, "bob", "fermee-test", { posePar: "carol", now: T2 });
  assert.deepEqual(revenu, { expediteur: "bob", nom_table: "fermee-test", pose_par: "carol", pose_le: T2 }, "réactivé : pose neuve");
  assert.deepEqual(
    db.prepare("SELECT retire_par, retire_le FROM enclos WHERE expediteur = 'bob'").get(),
    { retire_par: null, retire_le: null },
    "réactivé : le retrait est effacé"
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM enclos").get().n, 1, "une seule ligne par expéditeur");
  assert.equal(retirerEnclos(db, "bob"), true, "retirePar omis : le retrait se fait quand même");
  assert.equal(db.prepare("SELECT retire_par FROM enclos WHERE expediteur = 'bob'").get().retire_par, null);
  assert.equal(retirerEnclos(db, "inconnu"), false);
  assert.equal(retirerEnclos(db, ""), false);
});

// ── L'ENCLOS EXIGE UN MEMBRE ACTIF ───────────────────────────────────────────

function observerLesRequetes(db) {
  // Dit, pour chaque requête préparée, si une transaction était ouverte à cet instant.
  const vues = [];
  const preparer = db.prepare.bind(db);
  db.prepare = (sql) => {
    vues.push({ sql: String(sql).replace(/\s+/g, " ").trim(), dansUneTransaction: db.inTransaction });
    return preparer(sql);
  };
  return vues;
}

test("poserEnclos exige un membre ACTIF de la table : un non-membre, un membre retiré et une autre forme d'adresse sont refusés (pas-membre), rien n'est écrit", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "fermee-test", fermee: true, now: T0 });
  ajouterMembre(db, "fermee-test", "alice", { now: T0 });
  assert.throws(
    () => poserEnclos(db, "bob", "fermee-test", { now: T1 }),
    (e) => e.code === "pas-membre" && e.nom === "fermee-test" && e.expediteur === "bob" && /not an active member/.test(e.message)
  );
  ajouterMembre(db, "fermee-test", "bob", { now: T0 });
  retirerMembre(db, "fermee-test", "bob", { now: T1 });
  assert.throws(() => poserEnclos(db, "bob", "fermee-test", { now: T2 }), (e) => e.code === "pas-membre", "un membre retiré n'est plus membre");
  assert.throws(() => poserEnclos(db, "alice#sess-1", "fermee-test", { now: T2 }), (e) => e.code === "pas-membre", "la forme écrite compte : la lignée membre n'est pas sa chaise");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM enclos").get().n, 0, "un refus n'écrit rien");
  assert.deepEqual(poserEnclos(db, "alice", "fermee-test", { now: T2 }), { expediteur: "alice", nom_table: "fermee-test", pose_par: null, pose_le: T2 }, "un membre actif, lui, est enclos");
});

test("poserEnclos : la vérification d'appartenance et l'écriture tiennent dans UNE transaction (comme poserAlias)", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "fermee-test", fermee: true, now: T0 });
  ajouterMembre(db, "fermee-test", "bob", { now: T0 });
  const vues = observerLesRequetes(db);
  poserEnclos(db, "bob", "fermee-test", { now: T1 });
  const concernees = vues.filter((v) => /FROM table_membres|INSERT INTO enclos/.test(v.sql));
  assert.equal(concernees.length >= 2, true, "SONDE : la vérification et l'INSERT ont bien été préparés");
  assert.deepEqual(concernees.filter((v) => !v.dansUneTransaction), [], "aucune des deux hors transaction");
});

// ── UNE TABLE SOUS ENCLOS NE SE ROUVRE PAS, SON ENCLOS NE PERD PAS SON MEMBRE ─

test("une table sous enclos ne se rouvre pas : modifierTable(fermee: false) lève table-sous-enclos et ne change rien ; retirer l'enclos lève la serrure", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "fermee-test", fermee: true, now: T0 });
  creerTable(db, { nom: "autre", fermee: true, now: T0 });
  ajouterMembre(db, "fermee-test", "bob", { now: T0 });
  poserEnclos(db, "bob", "fermee-test", { now: T0 });
  const avant = obtenirTable(db, "fermee-test");
  assert.throws(
    () => modifierTable(db, "fermee-test", { fermee: false, now: T2 }),
    (e) => e.code === "table-sous-enclos" && e.nom === "fermee-test" && e.expediteur === "bob" && /enclosure/.test(e.message)
  );
  assert.throws(() => modifierTable(db, "fermee-test", { mode: "direct", fermee: false, now: T2 }), (e) => e.code === "table-sous-enclos");
  assert.deepEqual(obtenirTable(db, "fermee-test"), avant, "un refus ne change rien, pas même un autre champ donné avec lui");
  // Le reste se règle sous enclos : seule la serrure est tenue.
  const reglee = modifierTable(db, "fermee-test", { mode: "direct", position: "épisode 3", fermee: true, now: T2 });
  assert.equal(reglee.mode, "direct");
  assert.equal(reglee.fermee, 1);
  // Un enclos sur une AUTRE table ne tient pas celle-ci.
  assert.equal(modifierTable(db, "autre", { fermee: false, now: T2 }).fermee, 0);
  // Lever la serrure rend le geste possible.
  assert.equal(retirerEnclos(db, "bob", { now: T2 }), true);
  assert.equal(modifierTable(db, "fermee-test", { fermee: false, now: T2 }).fermee, 0);
});

test("un expéditeur enclos ne se retire pas de sa table : retirerMembre lève table-sous-enclos, un autre membre se retire, et retirer l'enclos lève la serrure", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "fermee-test", fermee: true, now: T0 });
  creerTable(db, { nom: "film", now: T0 });
  ajouterMembre(db, "fermee-test", "alice", { now: T0 });
  ajouterMembre(db, "fermee-test", "bob", { now: T0 });
  ajouterMembre(db, "film", "bob", { now: T0 });
  poserEnclos(db, "bob", "fermee-test", { now: T0 });
  assert.throws(
    () => retirerMembre(db, "fermee-test", "bob", { now: T2 }),
    (e) => e.code === "table-sous-enclos" && e.nom === "fermee-test" && e.expediteur === "bob" && /enclosure/.test(e.message)
  );
  assert.deepEqual(membresDeTable(db, "fermee-test").map((m) => m.adresse), ["alice", "bob"], "le refus ne retire personne");
  assert.equal(obtenirTable(db, "fermee-test").modifiee_le, T0, "le refus ne touche pas la table");
  assert.equal(retirerMembre(db, "film", "bob", { now: T2 }), true, "bob reste libre de quitter une AUTRE table");
  assert.equal(retirerMembre(db, "fermee-test", "alice", { now: T2 }), true, "un autre membre de la table enclose se retire");
  assert.equal(retirerEnclos(db, "bob", { now: T2 }), true);
  assert.equal(retirerMembre(db, "fermee-test", "bob", { now: T2 }), true, "la serrure levée, le retrait passe");
});

test("rouvrir une table et retirer un membre enclos : la vérification de l'enclos et le geste tiennent dans UNE transaction", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "fermee-test", fermee: true, now: T0 });
  ajouterMembre(db, "fermee-test", "alice", { now: T0 });
  ajouterMembre(db, "fermee-test", "bob", { now: T0 });
  poserEnclos(db, "bob", "fermee-test", { now: T0 });
  const vues = observerLesRequetes(db);
  retirerMembre(db, "fermee-test", "alice", { now: T1 });
  modifierTable(db, "fermee-test", { mode: "direct", fermee: true, now: T1 });
  try { modifierTable(db, "fermee-test", { fermee: false, now: T2 }); } catch { /* table-sous-enclos : voulu */ }
  const concernees = vues.filter((v) => /FROM enclos|UPDATE table_membres SET retire_par|UPDATE tables SET/.test(v.sql));
  assert.equal(concernees.length >= 4, true, "SONDE : les lectures d'enclos et les écritures ont bien été préparées");
  assert.deepEqual(concernees.filter((v) => !v.dansUneTransaction), [], "aucune hors transaction");
});

// ── LES MESSAGES NE RECOPIENT PAS L'ENTRÉE SANS BORNE ────────────────────────

test("un refus ne recopie que 64 caractères de l'entrée, sans retour à la ligne : un nom d'un mégaoctet ne revient pas en entier", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film", fermee: true, now: T0 });
  const enorme = `${"x".repeat(100000)}\nseconde ligne\r\n`;
  const ennuyeuse = "z".repeat(100000);
  const cas = {
    "nom invalide": () => validerNomDeTable(enorme),
    "réveil inconnu": () => creerTable(db, { nom: "y", reveil: enorme }),
    "mode inconnu": () => creerTable(db, { nom: "y", mode: enorme }),
    "adresse invalide": () => ajouterMembre(db, "film", enorme),
    "table inconnue": () => ajouterMembre(db, enorme, "bob"),
    "table inconnue (enclos)": () => poserEnclos(db, "bob", enorme),
    "adresse invalide (enclos)": () => poserEnclos(db, enorme, "film"),
    "pas membre": () => poserEnclos(db, ennuyeuse, "film")
  };
  for (const [nom, geste] of Object.entries(cas)) {
    assert.throws(geste, (e) => {
      assert.ok(e.message.length < 400, `${nom} : message de ${e.message.length} caractères`);
      assert.doesNotMatch(e.message, /[\r\n]/, `${nom} : pas de retour à la ligne`);
      assert.doesNotMatch(e.message, /x{65}|z{65}/, `${nom} : pas plus de 64 caractères recopiés`);
      // `e.nom` rend le nom DEMANDÉ : borné comme le message. (`e.expediteur`, lui,
      // est une adresse déjà validée que l'appelant reprend telle quelle.)
      if (typeof e.nom === "string") assert.ok([...e.nom].length <= 65, `${nom} : e.nom borné`);
      return typeof e.code === "string";
    });
  }
  // Un nom ordinaire, lui, revient en entier.
  assert.throws(() => ajouterMembre(db, "inconnue", "bob"), (e) => e.nom === "inconnue" && /"inconnue"/.test(e.message));
});

// ── CAMP B : rien ne s'efface ────────────────────────────────────────────────

test("une table ne se supprime pas : tous ses membres retirés, elle existe encore et son nom reste pris", (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "film", now: T0 });
  ajouterMembre(db, "film", "alice", { now: T0 });
  ajouterMembre(db, "film", "bob", { now: T0 });
  retirerMembre(db, "film", "alice", { now: T1 });
  retirerMembre(db, "film", "bob", { now: T1 });
  assert.deepEqual(membresDeTable(db, "film"), []);
  assert.ok(obtenirTable(db, "film"), "la table est toujours là");
  assert.throws(() => creerTable(db, { nom: "film" }), (e) => e.code === "table-existe", "son nom reste pris : les tables ne se suppriment pas");
  assert.deepEqual(listerTables(db).map((l) => l.nom), ["film"], "ouverte et vide, elle se liste encore");
  assert.deepEqual(listerTables(db, { adresses: ["alice", "bob"] }), [], "mais plus pour les adresses retirées");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM table_membres WHERE nom_table = 'film' AND retire_le IS NOT NULL").get().n, 2, "les deux retraits sont en ligne, datés");
  assert.deepEqual(
    Object.keys(carnet).filter((nom) => /supprimer|effacer|delete|drop/i.test(nom)),
    [],
    "aucune fonction du carnet ne supprime ni n'efface : Camp B"
  );
  // Les noms exportés ne disent pas tout : on lit aussi le source. Aucun DELETE,
  // aucun DROP — une ligne retirée se marque (`retire_le`), elle ne s'efface pas.
  const source = fs.readFileSync(new URL("../src/lib/tables.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i, "aucun DELETE FROM dans le carnet");
  assert.doesNotMatch(source, /\bDROP\b/i, "aucun DROP dans le carnet");
});
