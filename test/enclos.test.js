// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'ENCLOS (1.1.0, spec A §4, décision A1) — un expéditeur sous enclos n'écrit
// qu'aux membres de la table fermée nommée ; tout le reste est refusé AVANT la
// moindre écriture, et la clef (`hors_enclos: true`) reste dans sa main.
//
// ⚠️ Bases JETABLES (mkdtemp + CC2CC_V2_HOME, garde CC2CC_GARDE_BUREAU posée) :
// le bureau vivant n'est JAMAIS ouvert ici. Même plancher que test/guichet.test.js.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
const GARDE_INITIALE = process.env.CC2CC_GARDE_BUREAU;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-enclos-plancher-")));
process.env.CC2CC_GARDE_BUREAU = "1";
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
  if (GARDE_INITIALE === undefined) delete process.env.CC2CC_GARDE_BUREAU;
  else process.env.CC2CC_GARDE_BUREAU = GARDE_INITIALE;
});

import { openDatabase } from "../src/lib/database.js";
import { registerInstance } from "../src/lib/registry.js";
import { ajouterMembre, creerTable, poserEnclos, retirerEnclos } from "../src/lib/tables.js";
import { posterAUneTable, posterUneLettre, verifierEnclos } from "../src/lib/guichet.js";
import { poserLeBureau } from "./aide-env.js";

const decors = [];
function decorJetable(prefixe = "cc2cc-enclos-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  decors.push(dir);
  return dir;
}
after(() => {
  for (const dir of decors) fs.rmSync(dir, { recursive: true, force: true });
});

function bureauDePoste(t) {
  const root = decorJetable("cc2cc-enclos-home-");
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

const MAISON_DE_LA_CHAISE = "/maison/carton";
function chaiseVivante(db, lignee, session = `s-${lignee}`) {
  registerInstance(db, { lineage: lignee, sessionId: session, house: MAISON_DE_LA_CHAISE, pid: 4242 });
  return session;
}

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
const compter = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

// Le décor : « famille » (ouverte : alice, bob, carol), « fermee-test » (fermée :
// alice, carol, hal-test), et carol sous enclos « fermee-test ».
function decorDeLEnclos(t) {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "famille", creeePar: "office-test" });
  for (const adresse of ["alice", "bob", "carol"]) ajouterMembre(db, "famille", adresse, { ajoutePar: "office-test" });
  creerTable(db, { nom: "fermee-test", fermee: true, creeePar: "office-test" });
  for (const adresse of ["alice", "carol", "hal-test"]) ajouterMembre(db, "fermee-test", adresse, { ajoutePar: "office-test" });
  poserEnclos(db, "carol", "fermee-test", { posePar: "office-test" });
  return db;
}

// ── verifierEnclos : la règle, seule ────────────────────────────────────────
test("verifierEnclos — rien à redire sans enclos ; sous enclos, seuls les membres de la table fermée et table:<enclos> passent", (t) => {
  const db = decorDeLEnclos(t);

  assert.equal(verifierEnclos(db, "alice", ["bob", "dave"]), null, "alice n'a pas d'enclos");
  assert.equal(verifierEnclos(db, "carol", ["alice", "hal-test"]), null, "deux membres de fermee-test");
  assert.deepEqual(
    verifierEnclos(db, "carol", ["bob", "alice", "dave"]),
    { refus: "hors-enclos", enclos: "fermee-test", destinataires_refuses: ["bob", "dave"] },
    "les deux hors de fermee-test, dans l'ordre donné ; alice passe"
  );
  assert.equal(verifierEnclos(db, "carol", ["table:fermee-test"]), null, "l'adresse de sa propre table");
  assert.deepEqual(
    verifierEnclos(db, "carol", ["table:famille"]),
    { refus: "hors-enclos", enclos: "fermee-test", destinataires_refuses: ["table:famille"] },
    "une autre table est un destinataire comme un autre : refusée"
  );
  assert.equal(verifierEnclos(db, "carol", ["bob"], { horsEnclos: true }), null, "la clef dans la main de l'expéditeur");
  assert.equal(verifierEnclos(db, "carol", []), null, "rien à vérifier, rien à refuser");

  // L'enclos est posé sur la LIGNÉE ; il vaut pour la chaise qui poste.
  chaiseVivante(db, "carol");
  assert.deepEqual(
    verifierEnclos(db, "carol#s-carol", ["bob"]),
    { refus: "hors-enclos", enclos: "fermee-test", destinataires_refuses: ["bob"] },
    "la chaise de carol est sous le même enclos"
  );
  assert.deepEqual(
    verifierEnclos(db, "carol", ["bob"], { chaiseId: "carol#s-carol" }),
    { refus: "hors-enclos", enclos: "fermee-test", destinataires_refuses: ["bob"] }
  );
});

// ── posterUneLettre : le refus précède l'écriture ───────────────────────────
test("posterUneLettre — hors de l'enclos, la lettre est refusée AVANT toute écriture ; hors_enclos: true la laisse sortir", async (t) => {
  const db = decorDeLEnclos(t);
  chaiseVivante(db, "bob");
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  await assert.rejects(
    () => posterUneLettre(db, { sender: "carol", recipient: "bob", body: "hors de l'enclos" }, deps),
    (erreur) => {
      assert.equal(erreur.code, "hors-enclos");
      assert.equal(erreur.enclos, "fermee-test");
      assert.deepEqual(erreur.destinataires_refuses, ["bob"]);
      assert.match(erreur.message, /hors_enclos: true/);
      return true;
    }
  );
  assert.equal(compter(db, "messages"), 0, "aucune lettre");
  assert.equal(compter(db, "delivery_events"), 0, "aucun événement — rien n'a été écrit");
  assert.equal(portes.length, 0, "aucune porte frappée");

  // La forme `to` est lue comme `recipient` (⑦ : les deux orthographes).
  await assert.rejects(
    () => posterUneLettre(db, { sender: "carol", to: "bob", body: "hors, par to" }, deps),
    (erreur) => erreur.code === "hors-enclos"
  );
  assert.equal(compter(db, "messages"), 0);

  // La chaise de carol est sous le même enclos que sa lignée.
  chaiseVivante(db, "carol");
  await assert.rejects(
    () => posterUneLettre(db, { sender: "carol#s-carol", recipient: "bob", body: "en chaise" }, deps),
    (erreur) => erreur.code === "hors-enclos"
  );
  assert.equal(compter(db, "messages"), 0);

  // Vers un membre de fermee-test : la lettre part comme hier.
  const dedans = await posterUneLettre(db, { sender: "carol", recipient: "alice", body: "dedans" }, deps);
  assert.equal(dedans.row.recipient, "alice");
  assert.equal(compter(db, "messages"), 1);

  // Avec la clef : la lettre sort, et c'est dit par l'appel, pas en silence.
  const dehors = await posterUneLettre(db, { sender: "carol", recipient: "bob", body: "dehors, exprès", hors_enclos: true }, deps);
  assert.equal(dehors.row.recipient, "bob");
  assert.deepEqual(portes.map((p) => p.agentId), ["alice", "bob"]);
  assert.equal(compter(db, "messages"), 2);

  // Une valeur qui n'est pas `true` n'est pas une clef.
  await assert.rejects(
    () => posterUneLettre(db, { sender: "carol", recipient: "bob", body: "faux", hors_enclos: "oui" }, deps),
    (erreur) => erreur.code === "hors-enclos"
  );
  assert.equal(compter(db, "messages"), 2);
});

// ── Ce que le refus recopie de l'entrée est borné ───────────────────────────
test("le refus de l'enclos borne chaque valeur recopiée de l'entrée à 64 caractères, contrôles effacés", async (t) => {
  const db = decorDeLEnclos(t);
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };
  const longue = "z".repeat(200);

  assert.deepEqual(
    verifierEnclos(db, "carol", [longue, "dave\nInjected: yes", "table:FERMEE-TEST"]),
    { refus: "hors-enclos", enclos: "fermee-test", destinataires_refuses: [`${"z".repeat(64)}…`, "dave Injected: yes"] },
    "64 points de code et une ellipse ; le retour à la ligne devient une espace ; table:FERMEE-TEST est table:fermee-test"
  );

  await assert.rejects(
    () => posterUneLettre(db, { sender: "carol", recipient: longue, body: "trop long" }, deps),
    (erreur) => {
      assert.equal(erreur.code, "hors-enclos");
      assert.deepEqual(erreur.destinataires_refuses, [`${"z".repeat(64)}…`]);
      assert.ok(!erreur.message.includes("z".repeat(65)), "le message ne recopie pas plus que la propriété");
      return true;
    }
  );

  // Un expéditeur enclos au nom démesuré : le message ne le recopie pas entier.
  const longExpediteur = `carol-${"y".repeat(100)}`;
  ajouterMembre(db, "fermee-test", longExpediteur, { ajoutePar: "office-test" });
  poserEnclos(db, longExpediteur, "fermee-test", { posePar: "office-test" });
  await assert.rejects(
    () => posterUneLettre(db, { sender: longExpediteur, recipient: "bob", body: "x" }, deps),
    (erreur) => {
      assert.equal(erreur.code, "hors-enclos");
      assert.ok(!erreur.message.includes(longExpediteur), erreur.message);
      assert.ok(erreur.message.includes(`"${longExpediteur.slice(0, 64)}…"`), erreur.message);
      return true;
    }
  );
  assert.equal(compter(db, "messages"), 0);
  assert.equal(portes.length, 0);
});

// ── point de revue 6 : l'envoi à une table, refusé entier avant toute écriture ─
test("point de revue 6 — carol sous enclos envoie à table:famille : refus entier avant toute écriture, destinataires_refuses nomme les membres hors enclos", async (t) => {
  const db = decorDeLEnclos(t);
  chaiseVivante(db, "alice");
  chaiseVivante(db, "bob");
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  await assert.rejects(
    () => posterAUneTable(db, { sender: "carol", table: "famille", body: "à toute la famille" }, deps),
    (erreur) => {
      assert.equal(erreur.code, "hors-enclos");
      assert.equal(erreur.enclos, "fermee-test");
      // alice est membre de fermee-test : acceptée ; bob ne l'est pas ; carol est l'expéditeur.
      assert.deepEqual(erreur.destinataires_refuses, ["bob"]);
      return true;
    }
  );
  assert.equal(compter(db, "messages"), 0, "la base ne contient aucune ligne nouvelle");
  assert.equal(compter(db, "delivery_events"), 0);
  assert.equal(portes.length, 0, "ni alice ni bob n'ont été réveillés : l'envoi est refusé ENTIER");

  // La chaise de carol, même enclos, même refus.
  chaiseVivante(db, "carol");
  await assert.rejects(
    () => posterAUneTable(db, { sender: "carol#s-carol", table: "famille", body: "en chaise" }, deps),
    (erreur) => erreur.code === "hors-enclos"
  );
  assert.equal(compter(db, "messages"), 0);

  // Avec la clef : l'envoi part, à alice ET bob, et la base le dit.
  const dehors = await posterAUneTable(db, { sender: "carol", table: "famille", body: "exprès", hors_enclos: true }, deps);
  assert.deepEqual(dehors.lettres.map((l) => l.to), ["alice", "bob"]);
  assert.equal(compter(db, "messages"), 2);
});

test("l'enclos accepte table:fermee-test — la table de l'enclos elle-même, membres compris", async (t) => {
  const db = decorDeLEnclos(t);
  chaiseVivante(db, "alice");
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  const envoi = await posterAUneTable(db, { sender: "carol", table: "fermee-test", body: "entre nous" }, deps);
  assert.deepEqual(envoi.lettres.map((l) => l.to), ["alice", "hal-test"]);
  assert.equal(envoi.table.fermee, true);
  for (const lettre of envoi.lettres) {
    assert.equal(lettre.row.sans_copie, 1, "table fermée : jamais de copie");
    assert.equal(lettre.row.table_nom, "fermee-test");
  }
  assert.deepEqual(portes.map((p) => p.agentId), ["alice", "hal-test"]);
  assert.equal(compter(db, "messages"), 2);

  // Et le même mot par la règle seule.
  assert.equal(verifierEnclos(db, "carol", ["table:fermee-test", "alice", "hal-test"]), null);
});

// Mineur de la revue : la liste des refusés est bornée en NOMBRE aussi.
test("le refus de l'enclos ne recopie que 20 destinataires refusés, et compte les autres", async (t) => {
  const db = decorDeLEnclos(t);
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };
  const foule = Array.from({ length: 25 }, (_, i) => `x-${String(i).padStart(2, "0")}`);

  const refus = verifierEnclos(db, "carol", foule);
  assert.deepEqual(refus.destinataires_refuses, foule.slice(0, 20));
  assert.equal(refus.autres, 5);

  creerTable(db, { nom: "foule", creeePar: "office-test" });
  ajouterMembre(db, "foule", "carol", { ajoutePar: "office-test" });
  for (let i = 1; i <= 23; i += 1) ajouterMembre(db, "foule", `m-${String(i).padStart(2, "0")}`, { ajoutePar: "office-test" });
  await assert.rejects(
    () => posterAUneTable(db, { sender: "carol", table: "foule", body: "à la foule" }, deps),
    (erreur) => {
      assert.equal(erreur.code, "hors-enclos");
      assert.equal(erreur.destinataires_refuses.length, 20);
      assert.equal(erreur.autres, 3);
      assert.match(erreur.message, /and 3 more/);
      assert.ok(!erreur.message.includes("m-21"), erreur.message);
      return true;
    }
  );
  assert.equal(compter(db, "messages"), 0);
  assert.equal(portes.length, 0);
});

// ── S9 (seconde passe adverse, bloquant) : DEUX ENCLOS SUR DEUX FORMES D'UN MÊME EXPÉDITEUR ─
// `poserEnclos` n'interdisait le changement de table que pour la MÊME chaîne, et
// `verifierEnclos` prenait le PREMIER enclos trouvé : `alice` enclos dans « one »,
// `alice#s1` dans « two », et la chaise écrivait à carol (membre de « two »
// seulement) sans `hors_enclos`. Le carnet refuse maintenant le second enclos ;
// le guichet résout TOUS les enclos qui tiennent l'expéditeur, et deux enclos
// hérités vers deux tables refusent la lettre (`enclos-conflit`).
function decorDeDeuxTables(t, membres) {
  const db = bureauDePoste(t);
  for (const nom of ["one", "two"]) {
    creerTable(db, { nom, fermee: true, creeePar: "office-test" });
    for (const adresse of membres[nom]) ajouterMembre(db, nom, adresse, { ajoutePar: "office-test" });
  }
  return db;
}
const enclosActifs = (db) => db.prepare("SELECT expediteur, nom_table FROM enclos WHERE retire_le IS NULL ORDER BY expediteur").all()
  .map((e) => [e.expediteur, e.nom_table]);

test("S9 — poserEnclos refuse un second enclos vers une autre table sur une forme du même expéditeur (lignée, chaise, chaise courte, adresse humaine), dans les deux ordres", (t) => {
  const pleine = "alice#0123abcd-4567-89ab";
  const formes = ["alice", "alice#s1", "alice#0123abcd", "alice@atelier", pleine];
  const paires = [
    ["alice", "alice#s1"], ["alice#s1", "alice"],
    // la chaise s1 porte le nom de session « atelier » : alice@atelier est elle
    ["alice@atelier", "alice#s1"], ["alice#s1", "alice@atelier"],
    ["alice", "alice@atelier"], ["alice@atelier", "alice"],
    // la chaise courte d'une chaise de la fiche, et la chaise elle-même
    ["alice#0123abcd", pleine], [pleine, "alice#0123abcd"],
    ["alice#0123abcd", "alice"], ["alice", "alice#0123abcd"]
  ];
  for (const [premier, second] of paires) {
    const db = decorDeDeuxTables(t, { one: formes, two: formes });
    registerInstance(db, { lineage: "alice", sessionId: "s1", house: MAISON_DE_LA_CHAISE, pid: 4242, sessionName: "atelier" });
    registerInstance(db, { lineage: "alice", sessionId: "0123abcd-4567-89ab", house: MAISON_DE_LA_CHAISE, pid: 4243 });
    poserEnclos(db, premier, "one", { posePar: "office-test" });
    assert.throws(() => poserEnclos(db, second, "two", { posePar: "office-test" }), (erreur) => {
      assert.equal(erreur.code, "enclos-existe", `${premier} puis ${second}`);
      assert.deepEqual([erreur.nom, erreur.expediteur], ["one", premier], `${premier} puis ${second}`);
      assert.match(erreur.message, new RegExp(`"${second}" is the same sender as "${premier}", already enclosed in table "one"`));
      return true;
    });
    assert.deepEqual(enclosActifs(db), [[premier, "one"]], `${premier} puis ${second} : rien de posé`);
    assert.equal(poserEnclos(db, second, "one", { posePar: "office-test" }).nom_table, "one", "la même table : aucun conflit");
  }
  // Deux chaises sœurs ne sont jamais le même expéditeur : chacune garde son enclos.
  const db = decorDeDeuxTables(t, { one: ["alice#s1"], two: ["alice#s2"] });
  poserEnclos(db, "alice#s1", "one");
  assert.equal(poserEnclos(db, "alice#s2", "two").nom_table, "two");
  assert.deepEqual(enclosActifs(db), [["alice#s1", "one"], ["alice#s2", "two"]]);
});

test("S9 — un bureau hérité où deux enclos tiennent la même chaise vers deux tables : la lettre est refusée (enclos-conflit, avec les tables), directe ou de table ; jamais acceptée en silence", async (t) => {
  const db = decorDeDeuxTables(t, { one: ["alice", "bob"], two: ["alice#s1", "carol"] });
  // Posés avant ce correctif (le carnet les refuserait aujourd'hui) : la base de la passe adverse.
  const inserer = db.prepare("INSERT INTO enclos (expediteur, nom_table, pose_par, pose_le) VALUES (?, ?, 'office-test', '2026-10-21T00:00:00.000Z')");
  inserer.run("alice", "one");
  inserer.run("alice#s1", "two");
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };
  const conflit = {
    refus: "enclos-conflit",
    tables: ["one", "two"],
    enclos_poses: [{ expediteur: "alice", table: "one" }, { expediteur: "alice#s1", table: "two" }]
  };
  assert.deepEqual(verifierEnclos(db, "alice#s1", ["carol"]), conflit, "la sonde de la passe adverse");
  assert.deepEqual(verifierEnclos(db, "alice#s1", ["alice"]), conflit, "même vers un membre des deux tables : le conflit se règle d'abord");
  assert.deepEqual(verifierEnclos(db, "alice", ["carol"], { chaiseId: "alice#s1" }), conflit, "la chaise donnée à part");
  assert.deepEqual(
    verifierEnclos(db, "alice", ["carol"]),
    { refus: "hors-enclos", enclos: "one", destinataires_refuses: ["carol"] },
    "la lignée sans sa chaise n'a qu'un enclos"
  );

  const refuse = (erreur) => {
    assert.equal(erreur.code, "enclos-conflit");
    assert.deepEqual(erreur.tables, ["one", "two"]);
    assert.deepEqual(erreur.enclos_poses, conflit.enclos_poses);
    assert.match(erreur.message, /enclosed in more than one table \(one, two\)/);
    assert.match(erreur.message, /valxos-table enclos --retirer/);
    return true;
  };
  await assert.rejects(() => posterUneLettre(db, { sender: "alice#s1", sender_chaise: "alice#s1", recipient: "carol", body: "probe" }, deps), refuse);
  await assert.rejects(() => posterUneLettre(db, { sender: "alice#s1", recipient: "bob", body: "probe" }, deps), refuse);
  await assert.rejects(() => posterAUneTable(db, { sender: "alice#s1", sender_chaise: "alice#s1", table: "two", body: "to the table" }, deps), refuse);
  assert.equal(compter(db, "messages"), 0, "aucune lettre");
  assert.equal(portes.length, 0, "aucune porte frappée");

  // La clef de l'expéditeur ouvre les deux serrures, et c'est dit par l'appel.
  const dehors = await posterUneLettre(db, { sender: "alice#s1", sender_chaise: "alice#s1", recipient: "carol", body: "on purpose", hors_enclos: true }, deps);
  assert.equal(dehors.row.recipient, "carol");

  // L'opérateur lève l'un d'eux : la règle d'un seul enclos revient.
  assert.equal(retirerEnclos(db, "alice#s1", { retirePar: "office-test" }), true);
  assert.deepEqual(verifierEnclos(db, "alice#s1", ["carol"]), { refus: "hors-enclos", enclos: "one", destinataires_refuses: ["carol"] });
  assert.equal(verifierEnclos(db, "alice#s1", ["bob"]), null);
});

test("S9 — l'enclos posé sur la chaise courte tient la chaise entière qui poste", (t) => {
  const db = decorDeDeuxTables(t, { one: ["alice#0123abcd", "bob"], two: ["carol"] });
  registerInstance(db, { lineage: "alice", sessionId: "0123abcd-4567-89ab", house: MAISON_DE_LA_CHAISE, pid: 4243 });
  poserEnclos(db, "alice#0123abcd", "one");
  assert.deepEqual(
    verifierEnclos(db, "alice#0123abcd-4567-89ab", ["carol"]),
    { refus: "hors-enclos", enclos: "one", destinataires_refuses: ["carol"] }
  );
  assert.equal(verifierEnclos(db, "alice#0123abcd-4567-89ab", ["bob"]), null);
  assert.equal(verifierEnclos(db, "ALICE#0123abcd-4567-89ab", ["carol"]), null, "la lignée se lit à la lettre, comme la résolution");
  assert.equal(verifierEnclos(db, "alice#fedcba98-1111", ["carol"]), null, "une autre chaise de la lignée n'est pas tenue");
  assert.deepEqual(
    verifierEnclos(db, "alice#0123ABCD-ffff", ["carol"]),
    { refus: "hors-enclos", enclos: "one", destinataires_refuses: ["carol"] },
    "toute chaise que la forme courte désigne (la session sans casse) est tenue : l'enclos se lit large, jamais étroit"
  );
  assert.equal(verifierEnclos(db, "alice", ["carol"]), null, "ni la lignée");
});
