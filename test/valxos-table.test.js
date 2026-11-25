// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA TABLE, LE GESTE HUMAIN (1.1.0, SPEC_A §5, A2) : `valxos-table` administre
// le carnet des tables — ouvertes et fermées — et l'enclos d'un expéditeur ;
// `valxos-send --to table:<nom>` poste par le guichet ; `valxos-inbox` montre
// l'en-tête de table. Cet outil ne lit aucune lettre et n'en marque aucune.
// ⚠️ Toutes les bases sont JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau vivant
// n'est jamais ouvert ici.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { insertMessage, openDatabase } from "../src/lib/database.js";
import { ajouterMembre, creerTable, enclosDe, listerTables, membresDeTable, obtenirTable, poserEnclos } from "../src/lib/tables.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

// Le plancher jetable vaut aussi pour ce processus-ci (revue adverse F2, 21/08).
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-table-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

const repo = path.resolve(new URL("..", import.meta.url).pathname);

function bureau(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-table-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function tableCli(root, ...argv) {
  return spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-table.js"), ...argv], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: "operator-test" }
  });
}

// La base jetable d'un bureau, ouverte le temps d'une lecture ou d'un décor.
function avecLaBase(root, geste) {
  const db = openDatabase({ file: path.join(root, "broker.db") });
  try {
    return geste(db);
  } finally {
    db.close();
  }
}

test("creer, lister, voir : une table ouverte naît avec ses réglages, signée par l'opérateur, et se voit", (t) => {
  const root = bureau(t);
  const creation = tableCli(root, "creer", "famille-test", "--json");
  assert.equal(creation.status, 0, creation.stderr);
  const cree = JSON.parse(creation.stdout);
  assert.equal(cree.ok, true);
  assert.deepEqual(
    [cree.table.nom, cree.table.fermee, cree.table.reveil, cree.table.mode, cree.table.creee_par],
    ["famille-test", false, "reveil", "normal", "operator-test"]
  );

  const texte = tableCli(root, "creer", "film-test", "--fermee", "--reveil", "prochain-tour", "--mode", "direct");
  assert.equal(texte.status, 0, texte.stderr);
  assert.match(texte.stdout, /Table "film-test" created \(closed\): wake prochain-tour, mode direct\./);

  const liste = JSON.parse(tableCli(root, "--json", "lister").stdout);
  assert.deepEqual(liste.tables.map((x) => [x.nom, x.fermee, x.membres]), [["famille-test", false, []], ["film-test", true, []]], "--json avant la commande marche aussi");
  const lisible = tableCli(root, "lister");
  assert.equal(lisible.status, 0, lisible.stderr);
  assert.match(lisible.stdout, /famille-test\s+open\s+wake reveil\s+mode normal\s+0 member\(s\)/);
  assert.match(lisible.stdout, /film-test\s+CLOSED\s+wake prochain-tour\s+mode direct\s+0 member\(s\)/);

  const vue = JSON.parse(tableCli(root, "voir", "film-test", "--json").stdout);
  assert.equal(vue.table.nom, "film-test");
  assert.deepEqual(vue.membres, []);
  assert.deepEqual(vue.enclos, []);
  assert.equal(tableCli(root, "voir", "nulle-part").status, 1, "voir une table inconnue : refus 1");
  assert.equal(tableCli(root, "voir", "FILM-TEST", "--json").status, 0, "le nom se lit comme au carnet");
});

test("un nom invalide sort 2 (nom-de-table-invalide), une table qui existe déjà sort 1 (table-existe) ; sous --json le refus est un objet", (t) => {
  const root = bureau(t);
  const invalide = tableCli(root, "creer", "Famille_Test");
  assert.equal(invalide.status, 2, invalide.stdout);
  assert.match(invalide.stderr, /nom-de-table-invalide/);
  assert.ok(!fs.existsSync(path.join(root, "broker.db")), "un nom invalide est refusé avant d'ouvrir la base");
  const invalideJson = tableCli(root, "creer", "Famille_Test", "--json");
  assert.equal(invalideJson.status, 2);
  assert.deepEqual(Object.keys(JSON.parse(invalideJson.stdout)).sort(), ["message", "ok", "refus"]);
  assert.equal(tableCli(root, "creer", "famille-test").status, 0);
  const doublon = tableCli(root, "creer", "famille-test", "--json");
  assert.equal(doublon.status, 1);
  assert.deepEqual(Object.keys(JSON.parse(doublon.stdout)).sort(), ["message", "ok", "refus"]);
  assert.equal(JSON.parse(doublon.stdout).refus, "table-existe");
  assert.equal(JSON.parse(doublon.stdout).ok, false);
  const regle = tableCli(root, "creer", "autre-test", "--reveil", "jamais");
  assert.equal(regle.status, 2, "une règle de réveil inconnue est un usage faux");
  assert.match(regle.stderr, /"jamais" is not a wake rule: use "reveil" or "prochain-tour" \(reveil-invalide\)/, "la phrase et le code du carnet");
  const mode = tableCli(root, "creer", "autre-test", "--mode", "turbo");
  assert.equal(mode.status, 2);
  assert.match(mode.stderr, /"turbo" is not a table mode: use "normal" or "direct" \(mode-invalide\)/);
  assert.equal(avecLaBase(root, (db) => obtenirTable(db, "autre-test")), null, "un usage refusé ne crée rien");
});

test("adresse, règle et mode se valident par le carnet : sous --json, adresse-invalide, reveil-invalide et mode-invalide sortent en objet, code 2, avant la base", (t) => {
  const root = bureau(t);
  for (const [argv, code] of [
    [["creer", "autre-test", "--reveil", "jamais", "--json"], "reveil-invalide"],
    [["creer", "autre-test", "--mode", "turbo", "--json"], "mode-invalide"],
    [["ajouter", "famille-test", "TABLE:x", "--json"], "adresse-invalide"],
    [["retirer", "famille-test", "--json", "--", "two words"], "adresse-invalide"],
    [["reveil", "famille-test", "jamais", "--json"], "reveil-invalide"],
    [["reveil", "famille-test", "reveil", "--membre", "table:x", "--json"], "adresse-invalide"],
    [["mode", "famille-test", "turbo", "--json"], "mode-invalide"],
    [["enclos", "table:x", "famille-test", "--json"], "adresse-invalide"],
    [["enclos", "--retirer", "--json", "--", "two words"], "adresse-invalide"]
  ]) {
    const r = tableCli(root, ...argv);
    assert.equal(r.status, 2, `${argv.join(" ")} : ${r.stdout}${r.stderr}`);
    const refus = JSON.parse(r.stdout);
    assert.deepEqual([refus.ok, refus.refus, typeof refus.message], [false, code, "string"], argv.join(" "));
  }
  assert.ok(!fs.existsSync(path.join(root, "broker.db")), "aucun de ces refus n'ouvre la base");
});

test("une règle ou un mode entourés de blancs passent comme au carnet, qui les nettoie", (t) => {
  const root = bureau(t);
  const creation = tableCli(root, "creer", "famille-test", "--reveil", " prochain-tour ", "--mode", " direct ", "--json");
  assert.equal(creation.status, 0, creation.stderr);
  assert.deepEqual([JSON.parse(creation.stdout).table.reveil, JSON.parse(creation.stdout).table.mode], ["prochain-tour", "direct"]);
  assert.equal(tableCli(root, "reveil", "famille-test", " reveil ").status, 0);
  assert.equal(tableCli(root, "mode", "famille-test", " normal ").status, 0);
  assert.deepEqual(avecLaBase(root, (db) => [obtenirTable(db, "famille-test").reveil, obtenirTable(db, "famille-test").mode]), ["reveil", "normal"]);
  assert.equal(tableCli(root, "ajouter", "famille-test", "bob", "--reveil", " prochain-tour ").status, 0);
  assert.equal(avecLaBase(root, (db) => membresDeTable(db, "famille-test")[0].reveil), "prochain-tour");
});

test("-h, --help et aucune commande : la même aide, sortie 0, sans bureau ; drapeau inconnu et commande inconnue sortent 2", (t) => {
  const root = bureau(t);
  const court = tableCli(root, "-h");
  const long = tableCli(root, "--help");
  const nue = tableCli(root);
  for (const r of [court, long, nue]) assert.equal(r.status, 0, r.stderr);
  assert.match(long.stdout, /valxos-table creer <name>/);
  assert.equal(court.stdout, long.stdout);
  assert.equal(nue.stdout, long.stdout);
  assert.equal(tableCli(root, "aide").stdout, long.stdout);
  assert.match(long.stdout, /^  valxos-table aide /m, "la commande aide est nommée dans l'aide");
  assert.equal(tableCli(root, "lister", "--jsn").status, 2);
  const inconnue = tableCli(root, "detruire", "famille-test");
  assert.equal(inconnue.status, 2);
  assert.match(inconnue.stderr, /Unknown command: detruire/);
  const forgee = tableCli(root, "x\u001b[2Jy");
  assert.equal(forgee.status, 2);
  assert.ok(!forgee.stderr.includes("\u001b"), "l'écho d'une commande inconnue est borné, sans caractère de contrôle");
  const horsSujet = tableCli(root, "lister", "--fermee");
  assert.equal(horsSujet.status, 2, "un drapeau qui ne s'applique pas à la commande est refusé, jamais ignoré");
  assert.match(horsSujet.stderr, /--fermee does not apply to lister/);
  assert.ok(!fs.existsSync(path.join(root, "broker.db")), "ni l'aide ni un refus de ligne de commande n'ouvrent de base");
});

test("ajouter et retirer : un membre retiré est marqué, pas effacé, et se réajoute ; un absent est dit absent", (t) => {
  const root = bureau(t);
  assert.equal(tableCli(root, "creer", "famille-test").status, 0);
  const ajout = tableCli(root, "ajouter", "famille-test", "alice", "bob", "carol", "--json");
  assert.equal(ajout.status, 0, ajout.stderr);
  assert.deepEqual(JSON.parse(ajout.stdout), { ok: true, table: "famille-test", ajoutes: ["alice", "bob", "carol"] });
  assert.deepEqual(avecLaBase(root, (db) => membresDeTable(db, "famille-test").map((m) => [m.adresse, m.reveil, m.ajoute_par])),
    [["alice", null, "operator-test"], ["bob", null, "operator-test"], ["carol", null, "operator-test"]]);

  const retrait = tableCli(root, "retirer", "famille-test", "bob", "dave", "--json");
  assert.equal(retrait.status, 0, retrait.stderr);
  assert.deepEqual(JSON.parse(retrait.stdout), { ok: true, table: "famille-test", retires: ["bob"], absents: ["dave"] });
  assert.deepEqual(avecLaBase(root, (db) => membresDeTable(db, "famille-test").map((m) => m.adresse)), ["alice", "carol"]);
  assert.equal(avecLaBase(root, (db) => db.prepare("SELECT retire_le FROM table_membres WHERE nom_table = 'famille-test' AND adresse = 'bob'").get()?.retire_le != null), true, "Camp B : la ligne reste, marquée");

  const retour = tableCli(root, "ajouter", "famille-test", "bob", "--reveil", "prochain-tour");
  assert.equal(retour.status, 0, retour.stderr);
  assert.match(retour.stdout, /1 member\(s\) added to "famille-test": bob \(wake prochain-tour\)/);
  assert.deepEqual(avecLaBase(root, (db) => membresDeTable(db, "famille-test").map((m) => [m.adresse, m.reveil])), [["alice", null], ["bob", "prochain-tour"], ["carol", null]]);

  // Le réglage d'un membre est le sien : le retirer puis le réajouter sans --reveil le lui rend.
  assert.equal(tableCli(root, "retirer", "famille-test", "bob").status, 0);
  assert.equal(tableCli(root, "ajouter", "famille-test", "bob").status, 0);
  assert.deepEqual(avecLaBase(root, (db) => membresDeTable(db, "famille-test").find((m) => m.adresse === "bob").reveil), "prochain-tour", "revenu, il garde sa règle");

  assert.equal(tableCli(root, "ajouter", "famille-test").status, 2, "sans adresse : usage");
  assert.equal(tableCli(root, "ajouter", "famille-test", "table:film").status, 2, "une table n'est pas membre");
  assert.equal(tableCli(root, "ajouter", "famille-test", "dave", "TABLE:film").status, 2, "le préfixe se lit sans casse, et rien n'est écrit");
  assert.equal(tableCli(root, "ajouter", "nulle-part", "alice").status, 1, "table inconnue : refus 1");
  assert.deepEqual(avecLaBase(root, (db) => membresDeTable(db, "famille-test").length), 3, "un refus n'écrit rien");
});

test("fermer et ouvrir : la table fermée disparaît de listerTables sans adresses, pas de la vue de l'opérateur", (t) => {
  const root = bureau(t);
  assert.equal(tableCli(root, "creer", "office-test").status, 0);
  const fermeture = tableCli(root, "fermer", "office-test", "--json");
  assert.equal(fermeture.status, 0, fermeture.stderr);
  assert.equal(JSON.parse(fermeture.stdout).table.fermee, true);
  assert.deepEqual(avecLaBase(root, (db) => listerTables(db).map((x) => x.nom)), [], "la bibliothèque cache la fermée aux chaises");
  assert.deepEqual(JSON.parse(tableCli(root, "lister", "--json").stdout).tables.map((x) => [x.nom, x.fermee]), [["office-test", true]], "l'opérateur la voit");
  const ouverture = tableCli(root, "ouvrir", "office-test");
  assert.equal(ouverture.status, 0, ouverture.stderr);
  assert.match(ouverture.stdout, /Table "office-test" is open\./);
  assert.deepEqual(avecLaBase(root, (db) => listerTables(db).map((x) => x.nom)), ["office-test"]);
  assert.equal(tableCli(root, "fermer", "nulle-part").status, 1);
});

test("sous enclos : la table ne se rouvre pas et l'expéditeur enclos ne s'en retire pas (table-sous-enclos, 1) ; le retrait est tout ou rien", (t) => {
  const root = bureau(t);
  avecLaBase(root, (db) => {
    creerTable(db, { nom: "office-test", fermee: true, creeePar: "operator-test" });
    for (const adresse of ["alice", "bob", "carol"]) ajouterMembre(db, "office-test", adresse, { ajoutePar: "operator-test" });
    poserEnclos(db, "alice", "office-test", { posePar: "operator-test" });
  });
  const ouvrir = tableCli(root, "ouvrir", "office-test", "--json");
  assert.equal(ouvrir.status, 1, ouvrir.stderr);
  assert.equal(JSON.parse(ouvrir.stdout).refus, "table-sous-enclos");
  assert.equal(avecLaBase(root, (db) => obtenirTable(db, "office-test").fermee), 1, "la table reste fermée");

  const retrait = tableCli(root, "retirer", "office-test", "bob", "alice");
  assert.equal(retrait.status, 1, retrait.stderr);
  assert.match(retrait.stderr, /Nothing was done: .*\(table-sous-enclos\)/);
  assert.deepEqual(avecLaBase(root, (db) => membresDeTable(db, "office-test").map((m) => m.adresse)), ["alice", "bob", "carol"], "bob n'est pas parti à moitié");

  assert.equal(tableCli(root, "enclos", "--retirer", "alice").status, 0);
  assert.equal(tableCli(root, "retirer", "office-test", "alice").status, 0, "la serrure levée, le retrait passe");
  assert.equal(tableCli(root, "ouvrir", "office-test").status, 0, "et la table se rouvre");
});

test("reveil : la règle de la table, ou celle d'un membre avec --membre ; une règle inconnue sort 2 ; un non-membre n'est jamais ajouté en passant", (t) => {
  const root = bureau(t);
  assert.equal(tableCli(root, "creer", "famille-test").status, 0);
  assert.equal(tableCli(root, "ajouter", "famille-test", "alice", "bob").status, 0);
  const table = tableCli(root, "reveil", "famille-test", "prochain-tour", "--json");
  assert.equal(table.status, 0, table.stderr);
  assert.equal(JSON.parse(table.stdout).table.reveil, "prochain-tour");
  const membre = tableCli(root, "reveil", "famille-test", "reveil", "--membre", "bob");
  assert.equal(membre.status, 0, membre.stderr);
  assert.match(membre.stdout, /Member bob of "famille-test" wakes: reveil\./);
  assert.deepEqual(avecLaBase(root, (db) => membresDeTable(db, "famille-test").map((m) => [m.adresse, m.reveil])), [["alice", null], ["bob", "reveil"]]);
  const etranger = tableCli(root, "reveil", "famille-test", "reveil", "--membre", "dave", "--json");
  assert.equal(etranger.status, 1, etranger.stderr);
  assert.equal(JSON.parse(etranger.stdout).refus, "pas-membre");
  assert.deepEqual(avecLaBase(root, (db) => membresDeTable(db, "famille-test").map((m) => m.adresse)), ["alice", "bob"], "dave n'est pas devenu membre");
  assert.equal(tableCli(root, "reveil", "famille-test", "jamais").status, 2);
  assert.equal(tableCli(root, "reveil", "famille-test").status, 2, "la règle manque : usage");
  assert.equal(tableCli(root, "reveil", "nulle-part", "reveil", "--membre", "bob").status, 1, "table inconnue : refus 1");
  assert.equal(avecLaBase(root, (db) => obtenirTable(db, "famille-test").reveil), "prochain-tour", "un refus ne change rien");
});

test("mode et position : direct/normal, un texte libre coupé à 120 caractères, signé et daté, cité comme dans l'en-tête des lettres", (t) => {
  const root = bureau(t);
  assert.equal(tableCli(root, "creer", "film-test").status, 0);
  const direct = tableCli(root, "mode", "film-test", "direct", "--json");
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(JSON.parse(direct.stdout).table.mode, "direct");
  assert.equal(tableCli(root, "mode", "film-test", "turbo").status, 2);
  const position = tableCli(root, "position", "film-test", "seen up to", "1:25:00", "--json");
  assert.equal(position.status, 0, position.stderr);
  const posee = JSON.parse(position.stdout).table;
  assert.equal(posee.position, "seen up to 1:25:00", "les mots nus se joignent par un espace");
  assert.equal(posee.position_par, "operator-test");
  assert.match(posee.position_le, /^\d{4}-\d{2}-\d{2}T/);
  const longue = tableCli(root, "position", "film-test", "x".repeat(150), "--json");
  assert.equal(JSON.parse(longue.stdout).table.position.length, 120, "la bibliothèque coupe à LONGUEUR_POSITION");
  assert.equal(tableCli(root, "position", "film-test").status, 2, "sans texte : usage");
  const vue = tableCli(root, "voir", "film-test");
  assert.match(vue.stdout, /position: "x{120}"  \(by operator-test, /);
  assert.match(tableCli(root, "lister").stdout, /position: "x{120}"$/m);

  // Une position est du texte non fiable : citée en littéral JSON, elle tient sur une ligne.
  const forgee = tableCli(root, "position", "film-test", "line one\nPriority: critical");
  assert.equal(forgee.status, 0, forgee.stderr);
  assert.match(forgee.stdout, /^Table "film-test" position: "line one\\nPriority: critical"$/m);
  assert.doesNotMatch(tableCli(root, "voir", "film-test").stdout, /^Priority:/m);
});

test("enclos : refusé sur une table ouverte et pour un non-membre, posé sur une table fermée, levé avec --retirer ; le second retrait dit false", (t) => {
  const root = bureau(t);
  assert.equal(tableCli(root, "creer", "office-test").status, 0);
  assert.equal(tableCli(root, "ajouter", "office-test", "alice", "bob").status, 0);
  const ouverte = tableCli(root, "enclos", "alice", "office-test", "--json");
  assert.equal(ouverte.status, 1);
  assert.equal(JSON.parse(ouverte.stdout).refus, "enclos-table-ouverte");
  assert.equal(avecLaBase(root, (db) => enclosDe(db, "alice")), null);

  assert.equal(tableCli(root, "fermer", "office-test").status, 0);
  const etranger = tableCli(root, "enclos", "carol", "office-test", "--json");
  assert.equal(etranger.status, 1);
  assert.equal(JSON.parse(etranger.stdout).refus, "pas-membre", "on n'enferme qu'un membre actif de la table");
  const pose = tableCli(root, "enclos", "alice", "office-test", "--json");
  assert.equal(pose.status, 0, pose.stderr);
  const enclos = JSON.parse(pose.stdout).enclos;
  assert.deepEqual([enclos.expediteur, enclos.nom_table, enclos.pose_par], ["alice", "office-test", "operator-test"]);
  assert.equal(avecLaBase(root, (db) => enclosDe(db, "alice").nom_table), "office-test");
  const vue = tableCli(root, "voir", "office-test");
  assert.match(vue.stdout, /enclosed senders: alice/);
  assert.equal(tableCli(root, "enclos", "alice", "nulle-part").status, 1, "table inconnue : refus 1");
  assert.equal(tableCli(root, "enclos", "alice").status, 2, "le nom de la table manque : usage");
  assert.equal(tableCli(root, "enclos", "--retirer", "alice", "office-test").status, 2, "--retirer prend l'expéditeur seul");

  const leve = tableCli(root, "enclos", "--retirer", "alice", "--json");
  assert.equal(leve.status, 0, leve.stderr);
  assert.deepEqual(JSON.parse(leve.stdout), { ok: true, expediteur: "alice", retire: true, encore_enclos: [], autres_enclos_de_la_lignee: [] }, "N3 : `encore_enclos` dit ce qui tient encore (rien ici)");
  assert.equal(avecLaBase(root, (db) => enclosDe(db, "alice")), null);
  assert.equal(avecLaBase(root, (db) => db.prepare("SELECT retire_par FROM enclos WHERE expediteur = 'alice'").get().retire_par), "operator-test", "Camp B : l'enclos levé reste, signé");
  assert.doesNotMatch(tableCli(root, "voir", "office-test").stdout, /enclosed senders/, "un enclos levé ne se montre plus");
  assert.deepEqual(JSON.parse(tableCli(root, "voir", "office-test", "--json").stdout).enclos, []);
  const encore = tableCli(root, "enclos", "--retirer", "alice");
  assert.equal(encore.status, 0, encore.stderr);
  assert.match(encore.stdout, /No enclosure for "alice": nothing to lift\./);
});

test("l'outil n'affiche JAMAIS le contenu d'une lettre, et n'y touche pas", (t) => {
  const root = bureau(t);
  avecLaBase(root, (db) => {
    creerTable(db, { nom: "famille-test", creeePar: "alice" });
    ajouterMembre(db, "famille-test", "bob", { ajoutePar: "alice" });
    insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "bob", body: "SECRET-DU-COURRIER", table_nom: "famille-test", envoi_id: "envoi-1" });
  });
  for (const argv of [["lister"], ["lister", "--json"], ["voir", "famille-test"], ["voir", "famille-test", "--json"], ["fermer", "famille-test"], ["ouvrir", "famille-test"]]) {
    const r = tableCli(root, ...argv);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes("SECRET-DU-COURRIER"), `${argv.join(" ")} ne lit pas le courrier`);
  }
  const lettre = avecLaBase(root, (db) => db.prepare("SELECT delivered_at, carried_at, acked_at, injected_at FROM messages WHERE msg_id = 'L1'").get());
  assert.deepEqual(lettre, { delivered_at: null, carried_at: null, acked_at: null, injected_at: null }, "aucun effet de bord sur le courrier");
});

test("la sortie lisible borne ce qu'une session a pu écrire : une adresse à séquence d'échappement n'atteint pas le terminal", (t) => {
  const root = bureau(t);
  const forgee = "bob\u001b[2Jx";
  avecLaBase(root, (db) => {
    creerTable(db, { nom: "famille-test", creeePar: "operator-test" });
    ajouterMembre(db, "famille-test", forgee, { ajoutePar: "carol\u0007" });
  });
  const vue = tableCli(root, "voir", "famille-test");
  assert.equal(vue.status, 0, vue.stderr);
  assert.ok(!/[\u0007\u001b]/.test(vue.stdout), "aucun caractère de contrôle dans la vue lisible");
  assert.match(vue.stdout, /bob \[2Jx/);
  assert.deepEqual(JSON.parse(tableCli(root, "voir", "famille-test", "--json").stdout).membres.map((m) => m.adresse), [forgee], "le JSON, lui, rend l'adresse exacte");
});

// ── LA LETTRE À UNE TABLE PAR valxos-send, L'EN-TÊTE PAR valxos-inbox ────────
function sendCli(root, self, ...argv) {
  return spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-send.js"), ...argv], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: self }
  });
}

function inboxCli(root, self, ...argv) {
  return spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-inbox.js"), ...argv], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: self }
  });
}

const compterLesLettres = (root) => avecLaBase(root, (db) => db.prepare("SELECT COUNT(*) AS n FROM messages").get().n);

function decorDeTable(t) {
  const root = bureau(t);
  avecLaBase(root, (db) => {
    creerTable(db, { nom: "famille-test", creeePar: "operator-test" });
    for (const adresse of ["alice", "bob", "carol"]) ajouterMembre(db, "famille-test", adresse, { ajoutePar: "operator-test" });
  });
  return root;
}

test("valxos-send --to table:<nom> : une lettre par membre hors de l'expéditeur, un envoi_id, la réponse de table", (t) => {
  const root = decorDeTable(t);
  const r = sendCli(root, "alice", "--to", "table:famille-test", "--subject", "Beat 7", "--body", "the beat", "--msg-id", "beat-7");
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const sortie = JSON.parse(r.stdout);
  assert.equal(sortie.sent, true);
  assert.deepEqual(sortie.table, { nom: "famille-test", mode: "normal", reveil: "reveil", fermee: false, position: null }, "la table entière, comme l'outil MCP send");
  assert.equal(sortie.from, "alice");
  assert.match(sortie.envoi_id, /^envoi-/);
  assert.equal(sortie.count, 2);
  assert.deepEqual(sortie.results.map((l) => l.to).sort(), ["bob", "carol"], "l'expéditeur ne reçoit pas sa propre lettre");
  for (const lettre of sortie.results) {
    assert.equal(lettre.msg_id, `beat-7#${lettre.to}`, "l'idempotence est par membre");
    assert.equal(typeof lettre.seq, "number");
    assert.equal(lettre.sans_reveil, false);
    assert.equal(typeof lettre.motif_reveil, "string");
    assert.ok(lettre.wake, "le réveil a été tenté (la porte répond, même fermée)");
    assert.equal(lettre.attente?.motif, "destinataire-inconnu", "bob et carol n'ont pas de chaise : la lettre attend, comme un send");
    assert.equal(lettre.rejeu, undefined, "une lettre neuve ne se dit pas rejouée");
  }
  assert.equal(compterLesLettres(root), 2);
  const rejeu = JSON.parse(sendCli(root, "alice", "--to", "table:famille-test", "--body", "the beat", "--msg-id", "beat-7").stdout);
  assert.equal(compterLesLettres(root), 2, "le même msg_id ne crée pas de seconde lettre par membre");
  assert.equal(rejeu.count, 2);
  for (const lettre of rejeu.results) {
    assert.equal(lettre.motif_reveil, "rejeu", "le réveil d'un rejeu se lit sur la ligne");
    assert.equal(lettre.rejeu?.motif, "msg_id-deja-connu");
    assert.equal(lettre.envoi_id, sortie.envoi_id, "la lettre rejouée appartient à l'envoi qui l'a fait naître");
  }
});

test("valxos-send --to TABLE:<Nom> se lit comme au carnet ; un nom qui ne peut pas exister est un refus en JSON (nom-de-table-invalide, 2)", (t) => {
  const root = decorDeTable(t);
  const casse = sendCli(root, "alice", "--to", "TABLE: Famille-Test", "--body", "x");
  assert.equal(casse.status, 0, casse.stderr);
  assert.equal(JSON.parse(casse.stdout).table.nom, "famille-test");
  const faux = sendCli(root, "alice", "--to", "table:Pas Un Nom", "--body", "x");
  assert.equal(faux.status, 2, faux.stderr);
  const refus = JSON.parse(faux.stdout);
  assert.deepEqual([refus.sent, refus.refus], [false, "nom-de-table-invalide"]);
  assert.equal(compterLesLettres(root), 2, "seul l'envoi valide a écrit");
});

test("valxos-send --priority low et --reveiller : les règles de réveil du guichet se lisent dans la réponse", (t) => {
  const root = decorDeTable(t);
  avecLaBase(root, (db) => ajouterMembre(db, "famille-test", "bob", { reveil: "prochain-tour", ajoutePar: "operator-test" }));
  const basse = JSON.parse(sendCli(root, "alice", "--to", "table:famille-test", "--body", "quiet", "--priority", "low").stdout);
  assert.deepEqual(basse.results.map((l) => [l.to, l.sans_reveil, l.motif_reveil]).sort(), [["bob", true, "priorite-basse"], ["carol", true, "priorite-basse"]]);
  const normale = JSON.parse(sendCli(root, "alice", "--to", "table:famille-test", "--body", "beat").stdout);
  assert.deepEqual(normale.results.map((l) => [l.to, l.sans_reveil, l.motif_reveil]).sort(), [["bob", true, "membre"], ["carol", false, "table"]]);
  const mention = JSON.parse(sendCli(root, "alice", "--to", "table:famille-test", "--body", "beat", "--reveiller", "bob").stdout);
  assert.deepEqual(mention.results.map((l) => [l.to, l.sans_reveil, l.motif_reveil]).sort(), [["bob", false, "mention"], ["carol", false, "table"]]);
  const haute = JSON.parse(sendCli(root, "alice", "--to", "table:famille-test", "--body", "now", "--priority", "high").stdout);
  assert.deepEqual(haute.results.map((l) => [l.to, l.sans_reveil, l.motif_reveil]).sort(), [["bob", false, "priorite-haute"], ["carol", false, "priorite-haute"]]);
  const direct = sendCli(root, "alice", "--to", "bob", "--body", "x", "--reveiller", "bob");
  assert.equal(direct.status, 2, "--reveiller ne vaut que pour une table : jamais ignoré en silence");
  assert.match(direct.stderr, /--reveiller applies to table sends only/);
});

test("valxos-send refuse table-inconnue et pas-membre en JSON, sortie 2, sans rien écrire", (t) => {
  const root = decorDeTable(t);
  const inconnue = sendCli(root, "alice", "--to", "table:nulle-part", "--body", "x");
  assert.equal(inconnue.status, 2, inconnue.stderr);
  assert.equal(JSON.parse(inconnue.stdout).sent, false);
  assert.equal(JSON.parse(inconnue.stdout).refus, "table-inconnue");
  assert.equal(JSON.parse(inconnue.stdout).table, "nulle-part");
  const etranger = sendCli(root, "dave", "--to", "table:famille-test", "--body", "x");
  assert.equal(etranger.status, 2, etranger.stderr);
  assert.equal(JSON.parse(etranger.stdout).refus, "pas-membre");
  assert.equal(compterLesLettres(root), 0, "aucune ligne nouvelle");
});

test("l'enclos (point de revue 6 vu de la CLI) : un send hors de la table fermée est refusé entier, --hors-enclos le laisse sortir, table:<enclos> passe", (t) => {
  const root = bureau(t);
  avecLaBase(root, (db) => {
    creerTable(db, { nom: "office-test", fermee: true, creeePar: "operator-test" });
    ajouterMembre(db, "office-test", "alice", { ajoutePar: "operator-test" });
    ajouterMembre(db, "office-test", "bob", { ajoutePar: "operator-test" });
    poserEnclos(db, "alice", "office-test", { posePar: "operator-test" });
  });
  const refus = sendCli(root, "alice", "--to", "carol", "--body", "out");
  assert.equal(refus.status, 2, refus.stderr);
  const sortie = JSON.parse(refus.stdout);
  assert.equal(sortie.sent, false);
  assert.equal(sortie.refus, "hors-enclos");
  assert.equal(sortie.enclos, "office-test");
  assert.deepEqual(sortie.destinataires_refuses, ["carol"]);
  assert.equal(compterLesLettres(root), 0, "le refus précède toute écriture");

  const dedans = JSON.parse(sendCli(root, "alice", "--to", "bob", "--body", "in").stdout);
  assert.equal(dedans.sent, true, "un membre de l'enclos reçoit");
  const dehors = JSON.parse(sendCli(root, "alice", "--to", "carol", "--body", "out", "--hors-enclos").stdout);
  assert.equal(dehors.sent, true, "--hors-enclos est la clef dans la main de l'expéditeur");
  const table = JSON.parse(sendCli(root, "alice", "--to", "table:office-test", "--body", "all").stdout);
  assert.equal(table.count, 1);
  assert.equal(table.results[0].to, "bob");
  assert.equal(compterLesLettres(root), 3);
});

test("valxos-send sous enclos vers une table de 25 non-membres : 20 refusés nommés, `autres` compte les 5 suivants, rien n'est écrit", (t) => {
  const root = bureau(t);
  const membres = Array.from({ length: 25 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`);
  avecLaBase(root, (db) => {
    creerTable(db, { nom: "office-test", fermee: true, creeePar: "operator-test" });
    ajouterMembre(db, "office-test", "alice", { ajoutePar: "operator-test" });
    poserEnclos(db, "alice", "office-test", { posePar: "operator-test" });
    creerTable(db, { nom: "famille-test", creeePar: "operator-test" });
    for (const adresse of ["alice", ...membres]) ajouterMembre(db, "famille-test", adresse, { ajoutePar: "operator-test" });
  });
  const r = sendCli(root, "alice", "--to", "table:famille-test", "--body", "out");
  assert.equal(r.status, 2, r.stderr);
  const sortie = JSON.parse(r.stdout);
  assert.deepEqual([sortie.sent, sortie.refus, sortie.enclos], [false, "hors-enclos", "office-test"]);
  assert.deepEqual(sortie.destinataires_refuses, membres.slice(0, 20));
  assert.equal(sortie.autres, 5, "la liste est bornée, et la CLI dit combien il en reste");
  assert.equal(compterLesLettres(root), 0);
});

test("valxos-send : un envoi de table qui casse en chemin dit ce qui est parti (envoi-interrompu, cause d'origine), jamais « rien d'écrit »", (t) => {
  const root = decorDeTable(t);
  // Une vraie panne au milieu de l'envoi : SQLite refuse la lettre de carol (le second membre, par adresse).
  avecLaBase(root, (db) => db.exec("CREATE TRIGGER panne_carol BEFORE INSERT ON messages WHEN NEW.recipient = 'carol' BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;"));
  const r = sendCli(root, "alice", "--to", "table:famille-test", "--body", "the beat", "--msg-id", "beat-8");
  assert.equal(r.status, 2, r.stderr);
  const sortie = JSON.parse(r.stdout);
  assert.equal(sortie.sent, false);
  assert.equal(sortie.refus, "envoi-interrompu", "le code brut de SQLite n'est pas un refus à nous");
  assert.equal(sortie.cause, "SQLITE_CONSTRAINT_TRIGGER");
  assert.equal(sortie.interrompu, true);
  assert.equal(sortie.table, "famille-test");
  assert.equal(sortie.adresse, "carol");
  assert.match(sortie.envoi_id, /^envoi-/);
  assert.deepEqual(sortie.lettres_ecrites.map((l) => [l.to, l.msg_id]), [["bob", "beat-8#bob"]], "la lettre de bob est partie, et la réponse le dit");
  assert.match(sortie.motif, /after 1 letter\(s\) were written/);
  assert.match(r.stderr, /1 letter\(s\) sent, then envoi-interrompu/);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /nothing (was )?written/i);
  assert.equal(compterLesLettres(root), 1);
});

test("valxos-send : un enclos posé pendant l'envoi garde SON code (hors-enclos) et dit les lettres déjà parties", (t) => {
  const root = decorDeTable(t);
  // L'enclos tombe juste après la lettre de bob : celle de carol le rencontre au guichet.
  avecLaBase(root, (db) => db.exec(`CREATE TRIGGER enclos_en_course AFTER INSERT ON messages WHEN NEW.recipient = 'bob'
    BEGIN INSERT INTO enclos (expediteur, nom_table, pose_par, pose_le) VALUES ('alice', 'office-test', 'operator-test', '2026-10-22T00:00:00.000Z'); END;`));
  const r = sendCli(root, "alice", "--to", "table:famille-test", "--body", "the beat");
  assert.equal(r.status, 2, r.stderr);
  const sortie = JSON.parse(r.stdout);
  assert.deepEqual([sortie.sent, sortie.refus, sortie.enclos, sortie.adresse], [false, "hors-enclos", "office-test", "carol"]);
  assert.deepEqual(sortie.destinataires_refuses, ["carol"]);
  assert.deepEqual(sortie.lettres_ecrites.map((l) => l.to), ["bob"]);
  assert.equal(Object.hasOwn(sortie, "cause"), false, "un code à nous n'a pas de cause étrangère (comme le MCP)");
  assert.match(r.stderr, /1 letter\(s\) sent, then hors-enclos/);
});

test("valxos-send : une clef de membre déjà prise par le courrier d'un tiers est écartée, et la lettre le dit sous la forme du send ordinaire", (t) => {
  const root = decorDeTable(t);
  avecLaBase(root, (db) => insertMessage(db, { msg_id: "beat-9#bob", sender: "carol", recipient: "dave", body: "theirs" }));
  const sortie = JSON.parse(sendCli(root, "alice", "--to", "table:famille-test", "--body", "mine", "--msg-id", "beat-9").stdout);
  const pourBob = sortie.results.find((l) => l.to === "bob");
  assert.deepEqual(pourBob.clef_ecartee, { demandee: "beat-9#bob", motif: "clef-deja-prise" });
  assert.notEqual(pourBob.msg_id, "beat-9#bob");
  assert.equal(sortie.results.find((l) => l.to === "carol").clef_ecartee, undefined, "le silence des cas sains");
});

test("valxos-send : l'aide nomme table:NAME, --reveiller et --hors-enclos ; --hors-enclos n'avale pas le mot suivant", (t) => {
  const root = bureau(t);
  const aide = sendCli(root, "alice", "-h");
  assert.equal(aide.status, 0);
  assert.match(aide.stdout, /--to NAME\|table:NAME/);
  assert.match(aide.stdout, /\[--reveiller A,B\] \[--hors-enclos\]/);
  const r = sendCli(root, "alice", "--to", "bob", "--hors-enclos", "the body as a bare word");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(inboxCli(root, "bob").stdout).messages[0].body, "the body as a bare word");
});

test("valxos-inbox : chaque lettre dit sa table (nom, mode, position), envoi_id, reponse_a, chaise_nom et rappel", (t) => {
  const root = decorDeTable(t);
  avecLaBase(root, (db) => db.prepare("UPDATE tables SET mode = 'direct', position = 'seen up to 1:25:00', position_par = 'alice', position_le = '2026-10-21T10:00:00.000Z' WHERE nom = 'famille-test'").run());
  const envoi = JSON.parse(sendCli(root, "alice", "--to", "table:famille-test", "--subject", "Beat 7", "--body", "the beat").stdout);
  const inbox = inboxCli(root, "bob");
  assert.equal(inbox.status, 0, inbox.stderr);
  const sortie = JSON.parse(inbox.stdout);
  assert.equal(sortie.count, 1);
  const lettre = sortie.messages[0];
  assert.equal(lettre.etat, "reçue", "la relève marque livré, comme avant");
  assert.equal(lettre.table, "famille-test", "la forme de l'inbox MCP : le nom de la table, une chaîne");
  assert.equal(lettre.position, "seen up to 1:25:00");
  assert.equal(lettre.envoi_id, envoi.envoi_id);
  assert.equal(lettre.table_nom, "famille-test");
  assert.equal(lettre.reponse_a, null);
  assert.equal(lettre.chaise_nom, null, "la CLI n'a pas de chaise");
  assert.equal(lettre.rappel, 0, "première relève : aucun rappel");
  assert.equal(lettre.affichage, undefined, "l'enrichissement est à plat, pas en sous-objet");

  const simple = JSON.parse(sendCli(root, "carol", "--to", "bob", "--body", "plain").stdout);
  const relue = JSON.parse(inboxCli(root, "bob").stdout);
  const plate = relue.messages.find((m) => m.msg_id === simple.msg_id);
  assert.equal(plate.table, null, "une lettre sans table le dit");
  assert.equal(plate.position, null);
});

test("valxos-inbox : la position d'une table FERMÉE ne se montre qu'à un lecteur qui en est encore membre", (t) => {
  const root = bureau(t);
  avecLaBase(root, (db) => {
    creerTable(db, { nom: "office-test", fermee: true, creeePar: "operator-test" });
    for (const adresse of ["alice", "bob"]) ajouterMembre(db, "office-test", adresse, { ajoutePar: "operator-test" });
    db.prepare("UPDATE tables SET position = 'quarter close' WHERE nom = 'office-test'").run();
  });
  assert.equal(sendCli(root, "alice", "--to", "table:office-test", "--body", "numbers").status, 0);
  assert.equal(tableCli(root, "retirer", "office-test", "bob").status, 0);
  const lettre = JSON.parse(inboxCli(root, "bob").stdout).messages[0];
  assert.equal(lettre.table, "office-test");
  assert.equal(lettre.position, null, "un membre retiré relit sa lettre sans la position d'aujourd'hui");
});

test("valxos-inbox lit la position sous les formes du LECTEUR : une chaise dont la lignée est membre de la table fermée la voit", (t) => {
  // La lettre est à la chaise `bob#s-1`, la table liste la lignée `bob`. Les formes du lecteur
  // (`formesDeLExpediteur` : la chaise ET sa lignée) en font un membre ; la règle par défaut
  // d'`enrichirPourAffichage` (le seul destinataire, `bob#s-1`, qui n'est pas écrit dans la
  // table) tairait la position. La lettre est posée en base : aucun envoi de la CLI n'adresse
  // une lettre de table à une chaise que la table ne liste pas.
  const root = bureau(t);
  avecLaBase(root, (db) => {
    creerTable(db, { nom: "office-test", fermee: true, creeePar: "operator-test" });
    for (const adresse of ["alice", "bob"]) ajouterMembre(db, "office-test", adresse, { ajoutePar: "operator-test" });
    db.prepare("UPDATE tables SET position = 'quarter close' WHERE nom = 'office-test'").run();
    insertMessage(db, { msg_id: "c1", sender: "alice", recipient: "bob#s-1", body: "numbers", table_nom: "office-test", envoi_id: "envoi-c" });
  });
  const relue = inboxCli(root, "bob#s-1");
  assert.equal(relue.status, 0, relue.stderr);
  const lettre = JSON.parse(relue.stdout).messages.find((m) => m.msg_id === "c1");
  assert.equal(lettre.table, "office-test");
  assert.equal(lettre.position, "quarter close", "la lignée du lecteur est membre : la position se montre");
});

// A5 (relecture du guichet, J1) — UNE ADRESSE HUMAINE DONNE SA LIGNÉE. L'expéditeur qui poste sous
// `alice@atelier` (la CLI, `sender_chaise` nul) n'avait pour formes que ce nom : un enclos posé sur
// la lignée `alice` n'était pas lu, et une table qui liste `alice` lui écrivait sa propre lettre.
test("A5 — valxos-send sous une adresse humaine (alice@atelier) : exclu de sa propre table sous sa lignée, et l'enclos posé sur la lignée le tient", (t) => {
  const root = bureau(t);
  avecLaBase(root, (db) => {
    creerTable(db, { nom: "famille-test", creeePar: "operator-test" });
    for (const adresse of ["alice", "alice@atelier", "bob"]) ajouterMembre(db, "famille-test", adresse, { ajoutePar: "operator-test" });
  });
  const envoi = sendCli(root, "alice@atelier", "--to", "table:famille-test", "--body", "beat");
  assert.equal(envoi.status, 0, `${envoi.stdout}\n${envoi.stderr}`);
  const sortie = JSON.parse(envoi.stdout);
  assert.equal(sortie.from, "alice@atelier", "sonde impossible sinon : la CLI poste sous l'adresse humaine");
  assert.deepEqual(sortie.results.map((l) => l.to), ["bob"], "ni alice ni alice@atelier : ce sont ses noms");
  assert.equal(avecLaBase(root, (db) => db.prepare("SELECT count(*) AS n FROM messages WHERE recipient LIKE 'alice%'").get().n), 0);

  avecLaBase(root, (db) => {
    creerTable(db, { nom: "office-test", fermee: true, creeePar: "operator-test" });
    for (const adresse of ["alice", "bob"]) ajouterMembre(db, "office-test", adresse, { ajoutePar: "operator-test" });
    poserEnclos(db, "alice", "office-test", { posePar: "operator-test" });
  });
  const avant = compterLesLettres(root);
  const dehors = sendCli(root, "alice@atelier", "--to", "carol", "--body", "out");
  assert.equal(dehors.status, 2, `${dehors.stdout}\n${dehors.stderr}`);
  const refus = JSON.parse(dehors.stdout);
  assert.deepEqual([refus.sent, refus.refus, refus.enclos, refus.destinataires_refuses], [false, "hors-enclos", "office-test", ["carol"]]);
  assert.equal(compterLesLettres(root), avant, "le refus précède toute écriture");
  const dedans = JSON.parse(sendCli(root, "alice@atelier", "--to", "bob", "--body", "in").stdout);
  assert.equal(dedans.sent, true, "un membre de l'enclos reçoit");
});

// B10, vu de la CLI : `valxos-send --to "   "` est un refus en JSON, sortie 2, rien d'écrit.
test("B10 — valxos-send à un destinataire blanc : refus adresse-invalide en JSON, sortie 2, rien d'écrit", (t) => {
  const root = bureau(t);
  const r = sendCli(root, "alice", "--to", "   ", "--body", "nobody");
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  const sortie = JSON.parse(r.stdout);
  assert.deepEqual([sortie.sent, sortie.refus], [false, "adresse-invalide"]);
  assert.equal(compterLesLettres(root), 0);
});

// B8, vu de la CLI : `valxos-table enclos` sur une autre table pendant qu'un enclos tient est un refus
// du carnet (sortie 1, `enclos-existe` sous --json), et l'enclos reste où il était.
test("B8 — valxos-table enclos ailleurs pendant qu'un enclos tient : enclos-existe, sortie 1 ; levé, il se pose", (t) => {
  const root = bureau(t);
  avecLaBase(root, (db) => {
    for (const nom of ["office-test", "fermee-test"]) {
      creerTable(db, { nom, fermee: true, creeePar: "operator-test" });
      ajouterMembre(db, nom, "alice", { ajoutePar: "operator-test" });
    }
  });
  assert.equal(tableCli(root, "enclos", "alice", "office-test").status, 0);
  const refus = tableCli(root, "enclos", "alice", "fermee-test", "--json");
  assert.equal(refus.status, 1, `${refus.stdout}\n${refus.stderr}`);
  assert.deepEqual([JSON.parse(refus.stdout).ok, JSON.parse(refus.stdout).refus], [false, "enclos-existe"]);
  assert.equal(avecLaBase(root, (db) => enclosDe(db, "alice").nom_table), "office-test", "l'enclos n'a pas bougé");
  assert.equal(tableCli(root, "enclos", "--retirer", "alice").status, 0);
  assert.equal(tableCli(root, "enclos", "alice", "fermee-test").status, 0, "levé, il se pose ailleurs");
  assert.equal(avecLaBase(root, (db) => enclosDe(db, "alice").nom_table), "fermee-test");
});

// S9, vu de la CLI : `valxos-table enclos` sur une AUTRE forme du même expéditeur (ici son
// adresse humaine) vers une autre table est refusé (`enclos-existe`, sortie 1) ; et un bureau
// hérité où deux enclos le tiennent déjà fait refuser `valxos-send` (`enclos-conflit`, sortie 2).
test("S9 — valxos-table enclos sur une autre forme du même expéditeur : enclos-existe, sortie 1 ; un bureau hérité en conflit : valxos-send refuse (enclos-conflit), rien d'écrit", (t) => {
  const root = bureau(t);
  avecLaBase(root, (db) => {
    for (const [nom, membres] of [["office-test", ["alice", "bob"]], ["fermee-test", ["alice@atelier", "carol"]]]) {
      creerTable(db, { nom, fermee: true, creeePar: "operator-test" });
      for (const adresse of membres) ajouterMembre(db, nom, adresse, { ajoutePar: "operator-test" });
    }
  });
  assert.equal(tableCli(root, "enclos", "alice", "office-test").status, 0);
  const refus = tableCli(root, "enclos", "alice@atelier", "fermee-test", "--json");
  assert.equal(refus.status, 1, `${refus.stdout}\n${refus.stderr}`);
  const lu = JSON.parse(refus.stdout);
  assert.deepEqual([lu.ok, lu.refus], [false, "enclos-existe"]);
  assert.match(lu.message, /"alice@atelier" is the same sender as "alice", already enclosed in table "office-test"/);
  const texte = tableCli(root, "enclos", "alice@atelier", "fermee-test");
  assert.equal(texte.status, 1);
  assert.match(texte.stderr, /Nothing was done: .*same sender as "alice".*\(enclos-existe\)/);
  assert.equal(avecLaBase(root, (db) => enclosDe(db, "alice@atelier")), null, "rien de posé");

  avecLaBase(root, (db) => db.prepare(
    "INSERT INTO enclos (expediteur, nom_table, pose_par, pose_le) VALUES ('alice@atelier', 'fermee-test', 'operator-test', '2026-10-21T00:00:00.000Z')"
  ).run());
  const avant = compterLesLettres(root);
  const envoi = sendCli(root, "alice@atelier", "--to", "bob", "--body", "inside one table");
  assert.equal(envoi.status, 2, `${envoi.stdout}\n${envoi.stderr}`);
  const sortie = JSON.parse(envoi.stdout);
  assert.deepEqual([sortie.sent, sortie.refus, sortie.tables], [false, "enclos-conflit", ["fermee-test", "office-test"]]);
  assert.deepEqual(sortie.enclos_poses, [{ expediteur: "alice", table: "office-test" }, { expediteur: "alice@atelier", table: "fermee-test" }]);
  assert.equal(compterLesLettres(root), avant, "rien d'écrit");
  assert.equal(sendCli(root, "alice", "--to", "bob", "--body", "the lineage alone").status, 0, "la lignée seule n'a qu'un enclos");
});

// N2 (re-revue du round 2) : l'aide se sert AVANT toute dérivation d'identité — sous une identité
// que le paquet refuse (`#foo`), `--help` et l'outil seul rendaient le refus (sortie 2), `-h` l'aide.
test("N2 — valxos-table --help, aide et l'outil seul servent l'aide (sortie 0) même sous une identité refusée ; une commande, elle, refuse", (t) => {
  const root = bureau(t);
  const lancer = (...argv) => spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-table.js"), ...argv], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: "#foo" }
  });
  for (const argv of [["--help"], ["-h"], ["aide"], []]) {
    const r = lancer(...argv);
    assert.equal(r.status, 0, `${argv.join(" ") || "(seul)"} : ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /valxos-table aide/, argv.join(" "));
  }
  const refus = lancer("lister");
  assert.equal(refus.status, 2);
  assert.match(refus.stderr, /refusing to start: .*\(identite-invalide\)/);
  assert.equal(fs.existsSync(path.join(root, "broker.db")), false, "aucun bureau ouvert");
});

// N3 (re-revue du round 2) : « lifted: it writes to anyone again » était faux quand une autre forme
// du même expéditeur reste enclose (le geste que la doc indique pour sortir d'un `enclos-conflit`).
test("N3 — valxos-table enclos --retirer dit ce qui tient encore : une autre forme du même expéditeur enclose ailleurs est nommée ; sinon, il écrit de nouveau à qui il veut", (t) => {
  const root = bureau(t);
  avecLaBase(root, (db) => {
    for (const [nom, membres] of [["office-test", ["alice", "bob"]], ["fermee-test", ["alice@atelier", "carol"]]]) {
      creerTable(db, { nom, fermee: true, creeePar: "operator-test" });
      for (const adresse of membres) ajouterMembre(db, nom, adresse, { ajoutePar: "operator-test" });
    }
    poserEnclos(db, "alice", "office-test", { posePar: "operator-test" });
    db.prepare("INSERT INTO enclos (expediteur, nom_table, pose_par, pose_le) VALUES ('alice@atelier', 'fermee-test', 'operator-test', '2026-10-21T00:00:00.000Z')").run();
  });
  const texte = tableCli(root, "enclos", "--retirer", "alice@atelier");
  assert.equal(texte.status, 0, texte.stderr);
  assert.match(texte.stdout, /Enclosure of "alice@atelier" lifted for this form; the sender is still enclosed by "alice" in table "office-test"\./);
  assert.doesNotMatch(texte.stdout, /writes to anyone again/);
  const lu = JSON.parse(tableCli(root, "enclos", "--retirer", "alice", "--json").stdout);
  assert.deepEqual([lu.retire, lu.encore_enclos, lu.autres_enclos_de_la_lignee], [true, [], []], "la dernière forme levée : plus rien ne le tient");
  avecLaBase(root, (db) => poserEnclos(db, "alice", "office-test", { posePar: "operator-test" }));
  const seul = tableCli(root, "enclos", "--retirer", "alice");
  assert.match(seul.stdout, /Enclosure of "alice" lifted: it writes to anyone again\./);
});

// R3 (re-revue du round 3) : `encore_enclos` disait « still enclosed by alice#S2 » après avoir levé
// `alice#S1` : deux chaises sœurs sont deux expéditeurs (S9). Ce qui tient encore se calcule pour
// l'expéditeur précis (`enclosQuiTiennent`) ; un autre enclos de la lignée se dit à part.
test("R3 — valxos-table enclos --retirer alice#S1 pendant que la sœur alice#S2 reste enclose : il écrit de nouveau à qui il veut, et la sœur est nommée à part", (t) => {
  const root = bureau(t);
  avecLaBase(root, (db) => {
    for (const [nom, membres] of [["one-test", ["alice#S1", "bob"]], ["two-test", ["alice#S2", "carol"]]]) {
      creerTable(db, { nom, fermee: true, creeePar: "operator-test" });
      for (const adresse of membres) ajouterMembre(db, nom, adresse, { ajoutePar: "operator-test" });
    }
    poserEnclos(db, "alice#S1", "one-test", { posePar: "operator-test" });
    poserEnclos(db, "alice#S2", "two-test", { posePar: "operator-test" });
  });
  const texte = tableCli(root, "enclos", "--retirer", "alice#S1");
  assert.equal(texte.status, 0, texte.stderr);
  assert.match(texte.stdout, /Enclosure of "alice#S1" lifted: it writes to anyone again\./);
  assert.match(texte.stdout, /Another sender of its lineage is still enclosed: "alice#S2" in table "two-test"\./);
  assert.doesNotMatch(texte.stdout, /the sender is still enclosed/);
  avecLaBase(root, (db) => poserEnclos(db, "alice#S1", "one-test", { posePar: "operator-test" }));
  const lu = JSON.parse(tableCli(root, "enclos", "--retirer", "alice#S1", "--json").stdout);
  assert.deepEqual([lu.retire, lu.encore_enclos, lu.autres_enclos_de_la_lignee], [true, [], [{ expediteur: "alice#S2", table: "two-test" }]]);
});
