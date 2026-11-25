// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE GUICHET D'UNE TABLE (1.1.0) — poster à `table:<nom>`, le réveil, les
// formes de l'expéditeur. Spec : SPEC_A_TABLES.md §2 et §4.
//
// ⚠️ Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME, et
// la garde CC2CC_GARDE_BUREAU posée pour tout le processus) : le bureau vivant
// n'est JAMAIS ouvert ici. Même plancher que test/guichet.test.js : il se pose
// AVANT le premier test parce qu'`openDatabase` lit `baseDir()` — l'ENV, jamais
// le fichier qu'on lui impose. L'état d'origine se restaure à la fin.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
const GARDE_INITIALE = process.env.CC2CC_GARDE_BUREAU;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-guichet-table-plancher-")));
process.env.CC2CC_GARDE_BUREAU = "1";
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
  if (GARDE_INITIALE === undefined) delete process.env.CC2CC_GARDE_BUREAU;
  else process.env.CC2CC_GARDE_BUREAU = GARDE_INITIALE;
});

import { getMessageById, inscrireUneLettre, lettresDUnEnvoi, openDatabase } from "../src/lib/database.js";
import { registerInstance } from "../src/lib/registry.js";
import { ajouterMembre, creerTable, modifierTable, poserEnclos, retirerMembre } from "../src/lib/tables.js";
import { deciderLeReveil, formesDeLExpediteur, interruptionDEnvoi, posterAUneTable, posterUneLettre } from "../src/lib/guichet.js";
import { refusDuGuichet } from "../src/web/serveur.js";
import { poserLeBureau } from "./aide-env.js";

const decors = [];
function decorJetable(prefixe = "cc2cc-guichet-table-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  decors.push(dir);
  return dir;
}
after(() => {
  for (const dir of decors) fs.rmSync(dir, { recursive: true, force: true });
});

function bureauDePoste(t) {
  const root = decorJetable("cc2cc-guichet-table-home-");
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

// Une chaise vivante (même décor que test/guichet.test.js) : c'est elle qui
// fait taire `attenteDeLaLettre` et pousse l'avis jusqu'à `trouverLaBoite`.
const MAISON_DE_LA_CHAISE = "/maison/carton";
function chaiseVivante(db, lignee, { session = `s-${lignee}`, sessionName = null } = {}) {
  registerInstance(db, { lineage: lignee, sessionId: session, house: MAISON_DE_LA_CHAISE, pid: 4242, sessionName });
  return session;
}

// Le réveil ne frappe à AUCUNE vraie porte : on lit le NOM auquel le guichet a
// décidé de frapper, pas l'état d'une socket.
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

// La table « famille » : alice, bob, carol. `membres` donne le réglage de
// réveil de chacun (null = celui de la table).
function tableFamille(db, { reveil = "reveil", mode = "normal", fermee = false, membres = { alice: null, bob: null, carol: null } } = {}) {
  creerTable(db, { nom: "famille", reveil, mode, fermee, creeePar: "office-test" });
  for (const [adresse, reveilMembre] of Object.entries(membres)) {
    ajouterMembre(db, "famille", adresse, { reveil: reveilMembre, ajoutePar: "office-test" });
  }
}

const compter = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const parNom = (envoi) => Object.fromEntries(envoi.lettres.map((l) => [l.to, l]));

// ── Les colonnes de la 1.1.0 traversent `inscrireUneLettre` ─────────────────
test("inscrireUneLettre écrit les six colonnes de la 1.1.0, et lettresDUnEnvoi relit un envoi dans l'ordre du seq", (t) => {
  const db = bureauDePoste(t);
  const commun = {
    sender: "alice", body: "beat 7",
    envoi_id: "envoi-test-1", table_nom: "film", reponse_a: "msg-origine",
    sans_reveil: 1, sans_copie: 1, sender_chaise: "alice#s-alice",
    // Le compte des re-services n'est jamais tapé par un appelant : une lettre
    // naît à 0, seul le porteur l'incrémente.
    reservices: 9
  };
  const { row: premiere } = inscrireUneLettre(db, { ...commun, recipient: "bob" });
  // Une lettre d'un autre envoi entre les deux : elle ne doit pas se glisser.
  inscrireUneLettre(db, { sender: "alice", recipient: "bob", body: "hors envoi" });
  const { row: seconde } = inscrireUneLettre(db, { ...commun, recipient: "carol" });

  assert.equal(premiere.envoi_id, "envoi-test-1");
  assert.equal(premiere.table_nom, "film");
  assert.equal(premiere.reponse_a, "msg-origine");
  assert.equal(premiere.sans_reveil, 1);
  assert.equal(premiere.sans_copie, 1);
  assert.equal(premiere.sender_chaise, "alice#s-alice");
  assert.equal(premiere.reservices, 0, "le compte des re-services naît à 0, quoi que l'appelant passe");

  // Les défauts : une lettre d'hier ne porte rien de neuf.
  const dHier = inscrireUneLettre(db, { sender: "alice", recipient: "carol", body: "comme avant" }).row;
  assert.equal(dHier.envoi_id, null);
  assert.equal(dHier.table_nom, null);
  assert.equal(dHier.reponse_a, null);
  assert.equal(dHier.sans_reveil, 0);
  assert.equal(dHier.sans_copie, 0);
  assert.equal(dHier.sender_chaise, null);
  assert.equal(dHier.reservices, 0);

  assert.deepEqual(
    lettresDUnEnvoi(db, "envoi-test-1").map((r) => r.msg_id),
    [premiere.msg_id, seconde.msg_id],
    "les lettres de l'envoi, et elles seules, dans l'ordre de naissance"
  );
  assert.deepEqual(lettresDUnEnvoi(db, ""), []);
  assert.deepEqual(lettresDUnEnvoi(db, "envoi-inconnu"), []);
});

// ── LE RÉVEIL, règle pure (spec A §4, les cinq règles) ──────────────────────
test("deciderLeReveil — les cinq règles dans l'ordre où elles se lisent, et rien d'autre", () => {
  const cas = [
    // 1. high/critical : toujours, avant tout le reste (point de revue 5)
    [{ priority: "high", tableReveil: "prochain-tour" }, { sansReveil: false, motif: "priorite-haute" }],
    [{ priority: "critical", tableReveil: "prochain-tour", membreReveil: "prochain-tour", reaction: true, modeTable: "direct" }, { sansReveil: false, motif: "priorite-haute" }],
    // 2. low : jamais, même mentionné
    [{ priority: "low", tableReveil: "reveil", mentionne: true }, { sansReveil: true, motif: "priorite-basse" }],
    // 3. la mention bat la table, le membre et le mode direct
    [{ priority: "normal", tableReveil: "prochain-tour", mentionne: true }, { sansReveil: false, motif: "mention" }],
    [{ priority: "normal", tableReveil: "reveil", membreReveil: "prochain-tour", reaction: true, modeTable: "direct", mentionne: true }, { sansReveil: false, motif: "mention" }],
    // 4. une réaction en mode direct est calme ; en mode normal, non
    [{ priority: "normal", tableReveil: "reveil", reaction: true, modeTable: "direct" }, { sansReveil: true, motif: "reaction-directe" }],
    [{ priority: "normal", tableReveil: "reveil", reaction: true, modeTable: "normal" }, { sansReveil: false, motif: "table" }],
    [{ priority: "normal", tableReveil: "reveil", reaction: false, modeTable: "direct" }, { sansReveil: false, motif: "table" }],
    // 5. le membre, sinon la table
    [{ priority: "normal", tableReveil: "reveil" }, { sansReveil: false, motif: "table" }],
    [{ priority: "normal", tableReveil: "prochain-tour" }, { sansReveil: true, motif: "table" }],
    [{ priority: "normal", tableReveil: "prochain-tour", membreReveil: "reveil" }, { sansReveil: false, motif: "membre" }],
    [{ priority: "normal", tableReveil: "reveil", membreReveil: "prochain-tour" }, { sansReveil: true, motif: "membre" }],
    // la priorité se normalise comme en base : absente ou inconnue = normal
    [{ priority: undefined, tableReveil: "reveil" }, { sansReveil: false, motif: "table" }],
    [{ priority: "n'importe quoi", tableReveil: "prochain-tour" }, { sansReveil: true, motif: "table" }],
    [{ priority: "HIGH", tableReveil: "prochain-tour" }, { sansReveil: false, motif: "priorite-haute" }]
  ];
  for (const [entree, attendu] of cas) {
    assert.deepEqual(deciderLeReveil(entree), attendu, JSON.stringify(entree));
  }
});

// ── LES FORMES DE L'EXPÉDITEUR ──────────────────────────────────────────────
test("formesDeLExpediteur — le nom, la lignée, la chaise, l'adresse humaine ; jamais une résolution", (t) => {
  const db = bureauDePoste(t);
  chaiseVivante(db, "alice", { sessionName: "Atelier" }); // alice#s-alice, nommée
  chaiseVivante(db, "bob"); // bob#s-bob, sans nom
  const tri = (formes) => [...formes].sort();

  assert.deepEqual(tri(formesDeLExpediteur(db, "alice")), ["alice"], "une lignée nue n'a qu'une forme");
  assert.deepEqual(
    tri(formesDeLExpediteur(db, "alice#s-alice")),
    tri(["alice#s-alice", "alice", "alice@Atelier"]),
    "une chaise nommée : elle-même, sa lignée, son adresse humaine"
  );
  assert.deepEqual(
    tri(formesDeLExpediteur(db, "alice", { chaiseId: "alice#s-alice" })),
    tri(["alice", "alice#s-alice", "alice@Atelier"]),
    "la lignée qui poste avec sa chaise à côté a les mêmes formes"
  );
  assert.deepEqual(tri(formesDeLExpediteur(db, "bob#s-bob")), tri(["bob#s-bob", "bob"]), "sans nom de session, pas d'adresse humaine");
  assert.deepEqual(
    tri(formesDeLExpediteur(db, "carol#s-inconnue")),
    tri(["carol#s-inconnue", "carol"]),
    "une chaise inconnue du registre garde ses deux formes nues"
  );
  assert.deepEqual(formesDeLExpediteur(db, ""), []);
  assert.deepEqual(formesDeLExpediteur(db, null), []);
});

// ── LA LETTRE CALME : `sans_reveil` ne frappe à aucune porte ────────────────
test("posterUneLettre — une lettre sans_reveil ne frappe pas à la socket, wake le dit, la colonne est écrite", async (t) => {
  const db = bureauDePoste(t);
  chaiseVivante(db, "bob");
  const { portes, reveiller } = reveilEnregistre();

  const calme = await posterUneLettre(
    db,
    { sender: "alice", recipient: "bob", body: "pour le prochain tour", sans_reveil: 1 },
    { reveiller, maisons: MAISONS_VIDES() }
  );
  assert.deepEqual(calme.wake, { ok: false, skipped: "sans-reveil" });
  assert.equal(calme.row.sans_reveil, 1);
  assert.equal(portes.length, 0, "aucune porte frappée");
  assert.ok("attente" in calme, "l'avis d'attente se calcule quand même");

  // Le rejeu d'une lettre calme reste calme : c'est la LIGNE qui parle (R2),
  // pas le `sans_reveil` de cet appel.
  const rejeu = await posterUneLettre(
    db,
    { msg_id: calme.row.msg_id, sender: "alice", recipient: "bob", body: "pour le prochain tour", sans_reveil: 0 },
    { reveiller, maisons: MAISONS_VIDES() }
  );
  assert.deepEqual(rejeu.wake, { ok: false, skipped: "sans-reveil" });
  assert.equal(portes.length, 0);

  // Et une lettre ordinaire frappe, comme hier.
  const vive = await posterUneLettre(db, { sender: "alice", recipient: "bob", body: "maintenant" }, { reveiller, maisons: MAISONS_VIDES() });
  assert.equal(vive.row.sans_reveil, 0);
  assert.deepEqual(portes.map((p) => p.agentId), ["bob"]);
  assert.equal(vive.wake.skipped, undefined);
});

// ── POSTER À UNE TABLE ──────────────────────────────────────────────────────
test("posterAUneTable — table inconnue, expéditeur non membre : des erreurs typées, et rien n'est écrit", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db);
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  await assert.rejects(
    () => posterAUneTable(db, { sender: "alice", table: "nulle-part", body: "?" }, deps),
    (erreur) => erreur.code === "table-inconnue"
  );
  await assert.rejects(
    () => posterAUneTable(db, { sender: "dave", table: "famille", body: "?" }, deps),
    (erreur) => erreur.code === "pas-membre"
  );
  await assert.rejects(
    () => posterAUneTable(db, { sender: "dave#s-dave", table: "famille", body: "?" }, deps),
    (erreur) => erreur.code === "pas-membre",
    "sous aucune forme : ni la chaise, ni sa lignée"
  );
  await assert.rejects(
    () => posterAUneTable(db, { table: "famille", body: "?" }, deps),
    (erreur) => erreur.code === "pas-membre",
    "sans expéditeur, personne n'est membre"
  );
  assert.equal(compter(db, "messages"), 0);
  assert.equal(compter(db, "delivery_events"), 0);
  assert.equal(portes.length, 0);

  // Le nom se lit comme au carnet : « FAMILLE » est « famille ».
  const envoi = await posterAUneTable(db, { sender: "alice", table: " FAMILLE ", body: "casse" }, deps);
  assert.equal(envoi.count, 2);
  assert.equal(envoi.table.nom, "famille");
});

test("posterAUneTable — un nom hors forme lève nom-de-table-invalide ; les refus nomment la table et bornent ce qu'ils recopient", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db);
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  // Le nom se valide comme au carnet (`validerNomDeTable`) : une surface rend
  // `nom-de-table-invalide`, jamais « inconnue » pour un nom qui ne peut pas exister.
  for (const table of ["Pas Un Nom", "film!", "", undefined, "x".repeat(33)]) {
    await assert.rejects(
      () => posterAUneTable(db, { sender: "alice", table, body: "?" }, deps),
      (erreur) => erreur.code === "nom-de-table-invalide",
      JSON.stringify(table)
    );
  }

  await assert.rejects(
    () => posterAUneTable(db, { sender: "alice", table: "nulle-part", body: "?" }, deps),
    (erreur) => {
      assert.equal(erreur.code, "table-inconnue");
      assert.equal(erreur.table, "nulle-part");
      return true;
    }
  );

  const intrus = `dave\n${"d".repeat(200)}`;
  await assert.rejects(
    () => posterAUneTable(db, { sender: intrus, table: "famille", body: "?" }, deps),
    (erreur) => {
      assert.equal(erreur.code, "pas-membre");
      assert.equal(erreur.table, "famille");
      assert.ok(!erreur.message.includes("d".repeat(65)), "64 caractères recopiés au plus");
      assert.ok(!erreur.message.includes("\n"), "aucun retour à la ligne recopié");
      return true;
    }
  );
  assert.equal(compter(db, "messages"), 0);
  assert.equal(portes.length, 0);
});

test("posterAUneTable — une lettre par membre actif, jamais à l'expéditeur, toutes liées par envoi_id et dans le même fil", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db);
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  const { portes, reveiller } = reveilEnregistre();

  const envoi = await posterAUneTable(
    db,
    { sender: "alice", sender_chaise: null, table: "famille", subject: "Beat 7", body: "la salle s'allume", msg_type: "message", sender_model: "model-test" },
    { reveiller, maisons: MAISONS_VIDES() }
  );

  assert.equal(envoi.count, 2);
  assert.match(envoi.envoi_id, /^envoi-[0-9a-f-]{36}$/);
  assert.deepEqual(envoi.table, { nom: "famille", mode: "normal", reveil: "reveil", fermee: false, position: null });
  assert.deepEqual(envoi.lettres.map((l) => l.to), ["bob", "carol"], "les membres, triés, moins l'expéditeur");
  for (const lettre of envoi.lettres) {
    assert.equal(lettre.row.recipient, lettre.to);
    assert.equal(lettre.row.sender, "alice");
    assert.equal(lettre.row.sender_chaise, null);
    assert.equal(lettre.row.subject, "Beat 7");
    assert.equal(lettre.row.body, "la salle s'allume");
    assert.equal(lettre.row.sender_model, "model-test");
    assert.equal(lettre.row.envoi_id, envoi.envoi_id);
    assert.equal(lettre.row.table_nom, "famille");
    assert.equal(lettre.row.thread_id, envoi.envoi_id, "le fil par défaut est l'envoi lui-même");
    assert.equal(lettre.row.reponse_a, null);
    assert.equal(lettre.row.sans_copie, 0, "table ouverte : la copie reste possible");
    assert.equal(lettre.row.sans_reveil, 0);
    assert.equal(lettre.sans_reveil, false);
    assert.equal(lettre.motif_reveil, "table");
    assert.equal(lettre.rejeu, undefined, "un envoi neuf ne porte pas de rejeu — le silence des cas sains");
    assert.equal(lettre.attente?.motif, "maison-inconnue", "l'avis d'attente est calculé par lettre, comme broadcast");
  }
  assert.deepEqual(portes.map((p) => p.agentId), ["bob", "carol"], "on frappe chez chaque membre, jamais chez l'expéditeur");
  assert.deepEqual(portes.map((p) => p.payload), envoi.lettres.map((l) => l.row.msg_id));
  assert.deepEqual(lettresDUnEnvoi(db, envoi.envoi_id).map((r) => r.recipient), ["bob", "carol"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE recipient = 'alice'").get().n, 0);
  assert.equal(compter(db, "messages"), 2);
});

test("point de revue 1 — l'expéditeur seul membre, ou tous les autres retirés : aucune lettre, count 0, un envoi_id quand même", async (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "solo", creeePar: "office-test" });
  ajouterMembre(db, "solo", "alice", { ajoutePar: "office-test" });
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  const seul = await posterAUneTable(db, { sender: "alice", table: "solo", body: "personne" }, deps);
  assert.equal(seul.count, 0);
  assert.deepEqual(seul.lettres, []);
  assert.match(seul.envoi_id, /^envoi-/);
  assert.equal(seul.table.nom, "solo");
  assert.equal(portes.length, 0);
  assert.equal(compter(db, "messages"), 0);

  // bob ajouté puis retiré : même silence, sans erreur.
  ajouterMembre(db, "solo", "bob", { ajoutePar: "office-test" });
  assert.equal(retirerMembre(db, "solo", "bob", { retirePar: "office-test" }), true);
  const encore = await posterAUneTable(db, { sender: "alice", table: "solo", body: "toujours personne" }, deps);
  assert.equal(encore.count, 0);
  assert.deepEqual(encore.lettres, []);
  assert.notEqual(encore.envoi_id, seul.envoi_id, "chaque envoi a le sien");
  assert.equal(compter(db, "messages"), 0);
});

test("point de revue 3 — l'expéditeur membre sous une autre forme que celle sous laquelle il poste ne reçoit pas sa propre lettre", async (t) => {
  const db = bureauDePoste(t);
  chaiseVivante(db, "alice", { sessionName: "Atelier" }); // alice#s-alice, alice@Atelier
  chaiseVivante(db, "bob");
  const { reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  // ① la table liste la LIGNÉE, l'expéditeur poste en CHAISE
  creerTable(db, { nom: "par-lignee", creeePar: "office-test" });
  ajouterMembre(db, "par-lignee", "alice", { ajoutePar: "office-test" });
  ajouterMembre(db, "par-lignee", "bob", { ajoutePar: "office-test" });
  const un = await posterAUneTable(db, { sender: "alice#s-alice", table: "par-lignee", body: "①" }, deps);
  assert.deepEqual(un.lettres.map((l) => l.to), ["bob"]);
  assert.equal(un.lettres[0].row.sender, "alice#s-alice");

  // ② la table liste la CHAISE, l'expéditeur poste en lignée avec sa chaise à côté
  creerTable(db, { nom: "par-chaise", creeePar: "office-test" });
  ajouterMembre(db, "par-chaise", "alice#s-alice", { ajoutePar: "office-test" });
  ajouterMembre(db, "par-chaise", "bob", { ajoutePar: "office-test" });
  const deux = await posterAUneTable(db, { sender: "alice", sender_chaise: "alice#s-alice", table: "par-chaise", body: "②" }, deps);
  assert.deepEqual(deux.lettres.map((l) => l.to), ["bob"]);
  assert.equal(deux.lettres[0].row.sender_chaise, "alice#s-alice", "la chaise voyage avec la lettre, pour l'affichage");

  // ③ la table liste l'ADRESSE HUMAINE, l'expéditeur poste en chaise
  creerTable(db, { nom: "par-nom", creeePar: "office-test" });
  ajouterMembre(db, "par-nom", "alice@Atelier", { ajoutePar: "office-test" });
  ajouterMembre(db, "par-nom", "bob", { ajoutePar: "office-test" });
  const trois = await posterAUneTable(db, { sender: "alice#s-alice", table: "par-nom", body: "③" }, deps);
  assert.deepEqual(trois.lettres.map((l) => l.to), ["bob"]);

  // ④ et la lignée nue qui poste, listée par sa chaise, SANS chaise à côté :
  //    le guichet ne devine pas — alice ne peut pas être reconnue, elle n'est
  //    pas membre (pas-membre), et bob ne reçoit rien non plus.
  await assert.rejects(
    () => posterAUneTable(db, { sender: "alice", table: "par-chaise", body: "④" }, deps),
    (erreur) => erreur.code === "pas-membre"
  );

  assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE recipient LIKE 'alice%'").get().n, 0, "jamais sa propre lettre");
  assert.equal(compter(db, "messages"), 3);
});

test("point de revue 5 — high réveille toujours (table prochain-tour, membre prochain-tour) ; low jamais ; le membre bat la table", async (t) => {
  const db = bureauDePoste(t);
  // Table prochain-tour ; bob sans réglage ; carol réglée « reveil » (elle veut être sonnée).
  tableFamille(db, { reveil: "prochain-tour", membres: { alice: null, bob: null, carol: "reveil" } });
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };
  const CALME = { ok: false, skipped: "sans-reveil" };

  const normal = parNom(await posterAUneTable(db, { sender: "alice", table: "famille", body: "normal" }, deps));
  assert.equal(normal.bob.sans_reveil, true);
  assert.equal(normal.bob.motif_reveil, "table");
  assert.deepEqual(normal.bob.wake, CALME);
  assert.equal(normal.bob.row.sans_reveil, 1);
  assert.equal(normal.carol.sans_reveil, false);
  assert.equal(normal.carol.motif_reveil, "membre");
  assert.equal(normal.carol.row.sans_reveil, 0);
  assert.deepEqual(portes.map((p) => p.agentId), ["carol"], "une seule porte : le membre réglé « reveil »");

  portes.length = 0;
  const haute = parNom(await posterAUneTable(db, { sender: "alice", table: "famille", body: "urgent", priority: "high" }, deps));
  assert.equal(haute.bob.sans_reveil, false);
  assert.equal(haute.bob.motif_reveil, "priorite-haute");
  assert.equal(haute.bob.row.sans_reveil, 0);
  assert.equal(haute.bob.row.priority, "high");
  assert.equal(haute.carol.motif_reveil, "priorite-haute");
  assert.deepEqual(portes.map((p) => p.agentId), ["bob", "carol"], "high frappe partout, même dans une table prochain-tour");

  portes.length = 0;
  const critique = parNom(await posterAUneTable(db, { sender: "alice", table: "famille", body: "feu", priority: "critical" }, deps));
  assert.equal(critique.bob.motif_reveil, "priorite-haute");
  assert.deepEqual(portes.map((p) => p.agentId), ["bob", "carol"]);

  portes.length = 0;
  const basse = parNom(await posterAUneTable(db, { sender: "alice", table: "famille", body: "pour plus tard", priority: "low" }, deps));
  for (const nom of ["bob", "carol"]) {
    assert.equal(basse[nom].sans_reveil, true, `${nom} : low est calme`);
    assert.equal(basse[nom].motif_reveil, "priorite-basse");
    assert.deepEqual(basse[nom].wake, CALME);
    assert.equal(basse[nom].row.sans_reveil, 1);
  }
  assert.equal(portes.length, 0, "low ne frappe à aucune porte, même chez le membre réglé reveil");

  // Table « reveil », bob réglé prochain-tour : normal le laisse dormir, high le sonne.
  creerTable(db, { nom: "veille", creeePar: "office-test" });
  ajouterMembre(db, "veille", "alice", { ajoutePar: "office-test" });
  ajouterMembre(db, "veille", "bob", { reveil: "prochain-tour", ajoutePar: "office-test" });
  portes.length = 0;
  const dort = parNom(await posterAUneTable(db, { sender: "alice", table: "veille", body: "normal" }, deps));
  assert.equal(dort.bob.sans_reveil, true);
  assert.equal(dort.bob.motif_reveil, "membre");
  assert.equal(portes.length, 0);
  const sonne = parNom(await posterAUneTable(db, { sender: "alice", table: "veille", body: "urgent", priority: "high" }, deps));
  assert.equal(sonne.bob.sans_reveil, false);
  assert.equal(sonne.bob.motif_reveil, "priorite-haute");
  assert.deepEqual(portes.map((p) => p.agentId), ["bob"]);
});

test("mode direct — un beat réveille, une réaction (reponse_a) ne réveille personne, une mention réveille quand même ; en mode normal la réaction réveille", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db, { mode: "direct" });
  chaiseVivante(db, "alice");
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };
  const CALME = { ok: false, skipped: "sans-reveil" };

  const beat = await posterAUneTable(db, { sender: "alice", table: "famille", subject: "Beat 7", body: "la salle s'allume" }, deps);
  assert.equal(beat.table.mode, "direct");
  for (const lettre of beat.lettres) {
    assert.equal(lettre.sans_reveil, false);
    assert.equal(lettre.motif_reveil, "table");
  }
  assert.deepEqual(portes.map((p) => p.agentId), ["bob", "carol"], "le beat réveille");

  portes.length = 0;
  const origine = parNom(beat).bob.row.msg_id;
  const reaction = await posterAUneTable(
    db,
    { sender: "bob", table: "famille", body: "hahaha", reponse_a: origine, thread_id: beat.envoi_id },
    deps
  );
  assert.deepEqual(reaction.lettres.map((l) => l.to), ["alice", "carol"]);
  for (const lettre of reaction.lettres) {
    assert.equal(lettre.sans_reveil, true);
    assert.equal(lettre.motif_reveil, "reaction-directe");
    assert.deepEqual(lettre.wake, CALME);
    assert.equal(lettre.row.reponse_a, origine);
    assert.equal(lettre.row.thread_id, beat.envoi_id, "le fil donné est gardé");
    assert.equal(lettre.row.sans_reveil, 1);
  }
  assert.equal(portes.length, 0, "la réaction ne frappe à aucune porte");

  // La mention : carol est sonnée malgré le mode direct, alice reste calme.
  const mention = parNom(await posterAUneTable(
    db,
    { sender: "bob", table: "famille", body: "carol, tu vois ?", reponse_a: origine, thread_id: beat.envoi_id, reveiller: ["carol"] },
    deps
  ));
  assert.equal(mention.carol.sans_reveil, false);
  assert.equal(mention.carol.motif_reveil, "mention");
  assert.equal(mention.alice.sans_reveil, true);
  assert.equal(mention.alice.motif_reveil, "reaction-directe");
  assert.deepEqual(portes.map((p) => p.agentId), ["carol"]);

  // En mode normal, la même réaction réveille.
  modifierTable(db, "famille", { mode: "normal" });
  portes.length = 0;
  const enNormal = await posterAUneTable(db, { sender: "bob", table: "famille", body: "hahaha", reponse_a: origine }, deps);
  assert.equal(enNormal.table.mode, "normal");
  for (const lettre of enNormal.lettres) {
    assert.equal(lettre.sans_reveil, false);
    assert.equal(lettre.motif_reveil, "table");
  }
  assert.deepEqual(portes.map((p) => p.agentId), ["alice", "carol"]);
});

test("reveiller — la mention sonne le membre nommé dans une table prochain-tour ; les autres restent calmes ; un nom qui n'est pas membre ne crée rien", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db, { reveil: "prochain-tour" });
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  const envoi = parNom(await posterAUneTable(db, { sender: "alice", table: "famille", body: "bob, à toi", reveiller: ["bob"] }, deps));
  assert.equal(envoi.bob.sans_reveil, false);
  assert.equal(envoi.bob.motif_reveil, "mention");
  assert.equal(envoi.bob.row.sans_reveil, 0);
  assert.equal(envoi.carol.sans_reveil, true);
  assert.equal(envoi.carol.motif_reveil, "table");
  assert.deepEqual(portes.map((p) => p.agentId), ["bob"]);

  portes.length = 0;
  const bruit = await posterAUneTable(db, { sender: "alice", table: "famille", body: "dave ?", reveiller: ["dave", "alice", " "] }, deps);
  assert.equal(bruit.count, 2, "une mention n'ajoute jamais un destinataire");
  assert.deepEqual(bruit.lettres.map((l) => l.to), ["bob", "carol"]);
  for (const lettre of bruit.lettres) assert.equal(lettre.sans_reveil, true);
  assert.equal(portes.length, 0);
  assert.equal(compter(db, "messages"), 4);
});

test("point de revue 2 — table fermée, lignée ambiguë : la lettre attend (lignee-ambigue) et porte sans_copie = 1", async (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "fermee-test", fermee: true, creeePar: "office-test" });
  ajouterMembre(db, "fermee-test", "alice", { ajoutePar: "office-test" });
  ajouterMembre(db, "fermee-test", "bob", { ajoutePar: "office-test" });
  // Deux chaises vivantes de bob, aucune désignée : le guichet dit « ambigu ».
  chaiseVivante(db, "bob", { session: "s-bob-1" });
  chaiseVivante(db, "bob", { session: "s-bob-2" });
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  const envoi = await posterAUneTable(db, { sender: "alice", table: "fermee-test", body: "entre nous" }, deps);
  assert.equal(envoi.count, 1);
  assert.equal(envoi.table.fermee, true);
  const [lettre] = envoi.lettres;
  assert.equal(lettre.to, "bob");
  assert.equal(lettre.row.recipient, "bob", "la lettre est à la lignée : elle attend une désignation");
  assert.equal(lettre.attente?.motif, "lignee-ambigue");
  assert.equal(lettre.attente?.candidats, 2);
  assert.equal(lettre.row.sans_copie, 1, "aucune copie cc : personne ne la voit en attendant (Tâche 4 lit cette colonne)");
  assert.equal(lettre.row.table_nom, "fermee-test");
  assert.deepEqual(portes.map((p) => p.agentId), ["bob"], "on frappe au nom de la lignée, comme hier pour une lignée ambiguë");

  // La même lettre sur une table OUVERTE reste copiable.
  creerTable(db, { nom: "ouverte", creeePar: "office-test" });
  ajouterMembre(db, "ouverte", "alice", { ajoutePar: "office-test" });
  ajouterMembre(db, "ouverte", "bob", { ajoutePar: "office-test" });
  const ouverte = await posterAUneTable(db, { sender: "alice", table: "ouverte", body: "public" }, deps);
  assert.equal(ouverte.table.fermee, false);
  assert.equal(ouverte.lettres[0].row.sans_copie, 0);
  assert.equal(ouverte.lettres[0].attente?.motif, "lignee-ambigue");
});

test("msg_id donné — une clef par membre (<msg_id>#<adresse>) ; le rejeu rend les lignes existantes et n'en crée aucune", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db);
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  const { reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  const premier = await posterAUneTable(db, { sender: "alice", table: "famille", body: "beat 7", msg_id: "beat-7" }, deps);
  assert.deepEqual(premier.lettres.map((l) => l.row.msg_id), ["beat-7#bob", "beat-7#carol"]);
  assert.ok(premier.lettres.every((l) => l.rejeu == null), "un envoi neuf ne porte pas de rejeu");
  assert.equal(compter(db, "messages"), 2);

  const second = await posterAUneTable(db, { sender: "alice", table: "famille", body: "beat 7, renvoyé", msg_id: "beat-7" }, deps);
  assert.equal(compter(db, "messages"), 2, "Camp B jusque dans le rejeu : jamais deux lettres pour une même clef");
  assert.deepEqual(second.lettres.map((l) => l.row.msg_id), ["beat-7#bob", "beat-7#carol"]);
  assert.deepEqual(second.lettres.map((l) => l.row.body), ["beat 7", "beat 7"], "la ligne EXISTANTE gagne (R2)");
  assert.deepEqual(second.lettres.map((l) => l.rejeu?.motif), ["msg_id-deja-connu", "msg_id-deja-connu"], "et le posteur l'apprend, par lettre (④)");
  assert.deepEqual(
    second.lettres.map((l) => l.ecarte),
    [{ body: "beat 7, renvoyé" }, { body: "beat 7, renvoyé" }],
    "et ce qu'il vient de taper, parti nulle part, lui est rendu par lettre (⑧)"
  );
  assert.deepEqual(
    second.lettres.map((l) => l.row.envoi_id),
    [premier.envoi_id, premier.envoi_id],
    "les lignes gardent leur premier envoi ; `row.envoi_id` dit la vérité, pas `envoi_id` de ce rappel"
  );
  assert.notEqual(second.envoi_id, premier.envoi_id);

  // Sans msg_id, chaque lettre naît sous sa propre clef générée.
  const libre = await posterAUneTable(db, { sender: "alice", table: "famille", body: "beat 8" }, deps);
  for (const lettre of libre.lettres) assert.match(lettre.row.msg_id, /^msg-[0-9a-f-]{36}$/);
  assert.equal(compter(db, "messages"), 4);
});

test("C1 — un seul scan des maisons pour tout l'envoi ; un scan fourni n'est jamais recalculé, et son CONTENU est lu", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db);
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  const { reveiller } = reveilEnregistre();

  let scans = 0;
  const scanner = () => {
    scans += 1;
    return MAISONS_VIDES();
  };
  const sansMaisons = await posterAUneTable(db, { sender: "alice", table: "famille", body: "diffusion" }, { reveiller, scanner });
  assert.equal(scans, 1, `un scan pour deux lettres, pas ${scans}`);
  assert.deepEqual(sansMaisons.lettres.map((l) => l.attente?.motif), ["maison-inconnue", "maison-inconnue"]);

  scans = 0;
  // L'inventaire fourni connaît la maison des chaises : s'il est lu, l'avis dit
  // boite-endormie ; s'il est jeté pour un scan neuf, il dirait maison-inconnue.
  const maisons = { houses: [{ house: MAISON_DE_LA_CHAISE }], parSession: new Map() };
  const avecMaisons = await posterAUneTable(db, { sender: "alice", table: "famille", body: "diffusion" }, { reveiller, scanner, maisons });
  assert.equal(scans, 0, "un scan fourni ne se recalcule pas");
  assert.deepEqual(avecMaisons.lettres.map((l) => l.attente?.motif), ["boite-endormie", "boite-endormie"]);
});

// ── ROUND 1 (revue de la tâche 2) ───────────────────────────────────────────

// F1 — F12 vaut aussi pour une table : jamais la lettre d'un tiers sous sa clef.
test("F12 — une clef d'entrée tenue par la lettre d'un tiers est écartée : le membre reçoit sa lettre sous une clef neuve, clef_ecartee le dit, la porte du tiers ne sonne pas", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db);
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  chaiseVivante(db, "dave");
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  // bob écrit à dave sous la clef que la table donnerait à carol.
  const duTiers = inscrireUneLettre(db, { msg_id: "beat-7#carol", sender: "bob", recipient: "dave", subject: "entre nous", body: "rien pour alice" }).row;

  const envoi = parNom(await posterAUneTable(db, { sender: "alice", table: "famille", body: "beat 7", msg_id: "beat-7" }, deps));
  assert.equal(envoi.carol.row.sender, "alice", "jamais la lettre de bob rendue à alice");
  assert.equal(envoi.carol.row.recipient, "carol", "carol reçoit bien sa lettre");
  assert.equal(envoi.carol.row.body, "beat 7");
  assert.match(envoi.carol.row.msg_id, /^msg-[0-9a-f-]{36}$/, "sous une clef que le guichet génère");
  assert.equal(envoi.carol.clef_ecartee, "beat-7#carol");
  assert.equal(envoi.carol.rejeu, undefined, "une lettre neuve n'est pas un rejeu");
  assert.equal(envoi.bob.row.msg_id, "beat-7#bob");
  assert.equal(envoi.bob.clef_ecartee, undefined, "le silence des cas sains");
  assert.deepEqual(portes.map((p) => p.agentId), ["bob", "carol"], "la porte de dave n'a pas sonné");
  assert.deepEqual(getMessageById(db, "beat-7#carol"), duTiers, "la lettre du tiers est intacte");

  // alice rejoue : sa propre clef est un rejeu, sans clef écartée ; celle du
  // tiers est écartée encore (A8 : un doublon plutôt qu'une lettre perdue).
  portes.length = 0;
  const rejeu = parNom(await posterAUneTable(db, { sender: "alice", table: "famille", body: "beat 7", msg_id: "beat-7" }, deps));
  assert.equal(rejeu.bob.rejeu?.motif, "msg_id-deja-connu");
  assert.equal(rejeu.bob.clef_ecartee, undefined);
  assert.equal(rejeu.bob.row.msg_id, "beat-7#bob");
  assert.equal(rejeu.carol.clef_ecartee, "beat-7#carol");
  assert.equal(rejeu.carol.row.sender, "alice");
  assert.ok(!portes.some((p) => p.agentId === "dave"), "toujours pas chez dave");

  // La clef d'entrée se nettoie avant le suffixe : « beat-9 » et non « beat-9 ».
  const propre = await posterAUneTable(db, { sender: "alice", table: "famille", body: "beat 9", msg_id: "  beat-9 " }, deps);
  assert.deepEqual(propre.lettres.map((l) => l.row.msg_id), ["beat-9#bob", "beat-9#carol"]);
});

// F2 — ⑧ : `ecarte` dit ce que le posteur a TAPÉ et qui n'est parti nulle part,
// jamais ce que le guichet a dérivé (le fil par défaut, la priorité normalisée).
test("⑧ — un rejeu de table rend ecarte par lettre quand ce qui est tapé diffère ; un rejeu identique, sans priorité ou sans fil n'écarte rien", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db);
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  const { reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };
  const base = { sender: "alice", table: "famille", body: "beat 7", msg_id: "beat-7" };

  const premier = await posterAUneTable(db, { ...base, priority: "high" }, deps);
  for (const lettre of premier.lettres) assert.equal(lettre.ecarte, undefined, "un envoi neuf n'écarte rien");

  const identique = await posterAUneTable(db, { ...base, priority: "high" }, deps);
  for (const lettre of identique.lettres) {
    assert.equal(lettre.rejeu?.motif, "msg_id-deja-connu");
    assert.equal(lettre.ecarte, undefined, "un renvoi identique n'écarte rien — le fil neuf n'a pas été tapé");
  }

  const sansPriorite = await posterAUneTable(db, base, deps);
  for (const lettre of sansPriorite.lettres) {
    assert.equal(lettre.ecarte, undefined, "une priorité non tapée ne s'écarte pas, même vers une lettre high");
  }

  const autreCorps = await posterAUneTable(db, { ...base, body: "beat 7, bis" }, deps);
  for (const lettre of autreCorps.lettres) assert.deepEqual(lettre.ecarte, { body: "beat 7, bis" });

  const autreFil = await posterAUneTable(db, { ...base, priority: "low", thread_id: "fil-tape" }, deps);
  for (const lettre of autreFil.lettres) {
    assert.deepEqual(lettre.ecarte, { priority: "low", thread_id: "fil-tape" }, "un fil et une priorité TAPÉS qui diffèrent sont écartés");
  }
  assert.equal(compter(db, "messages"), 2);
});

// F3 — un envoi qui casse en chemin ne se fait jamais passer pour « rien d'écrit ».
test("un envoi qui casse au deuxième membre lève le code d'origine avec adresse, envoi_id et lettres_ecrites — la base et l'erreur disent la même chose", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db);
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  let coups = 0;
  const reveiller = async (agentId) => {
    coups += 1;
    if (coups === 2) {
      const panne = new Error("the test socket broke");
      panne.code = "PANNE_TEST";
      throw panne;
    }
    return { ok: true, socketPath: `/carton/${agentId}.sock` };
  };

  await assert.rejects(
    () => posterAUneTable(db, { sender: "alice", table: "famille", body: "beat 7" }, { reveiller, maisons: MAISONS_VIDES() }),
    (erreur) => {
      assert.equal(erreur.code, "PANNE_TEST", "le code de l'erreur d'origine");
      assert.equal(erreur.adresse, "carol", "le membre où l'envoi a cassé");
      assert.match(erreur.envoi_id, /^envoi-/);
      assert.equal(erreur.table, "famille");
      assert.match(erreur.message, /the test socket broke/);
      assert.equal(erreur.cause?.code, "PANNE_TEST");
      const [pourBob, pourCarol] = erreur.lettres_ecrites;
      assert.equal(erreur.lettres_ecrites.length, 2);
      assert.equal(pourBob.to, "bob");
      assert.deepEqual(pourBob.wake, { ok: true, socketPath: "/carton/bob.sock" }, "la lettre partie garde son réveil");
      // carol : sa lettre est NÉE avant que le réveil ne casse — la base le dit.
      assert.equal(pourCarol.to, "carol");
      assert.equal(pourCarol.interrompue, true);
      assert.equal(pourCarol.wake, null, "on ne sait pas si sa porte a été frappée");
      assert.equal(pourCarol.row.recipient, "carol");
      assert.deepEqual(
        lettresDUnEnvoi(db, erreur.envoi_id).map((r) => r.msg_id),
        erreur.lettres_ecrites.map((l) => l.row.msg_id)
      );
      return true;
    }
  );
  assert.equal(compter(db, "messages"), 2);
});

test("un enclos posé pendant l'envoi : hors-enclos au membre suivant, avant d'écrire sa lettre ; lettres_ecrites nomme celles déjà parties", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db);
  creerTable(db, { nom: "fermee-test", fermee: true, creeePar: "office-test" });
  ajouterMembre(db, "fermee-test", "alice", { ajoutePar: "office-test" });
  ajouterMembre(db, "fermee-test", "bob", { ajoutePar: "office-test" });
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  const portes = [];
  // Une CLI pose l'enclos d'alice pendant le réveil de bob.
  const reveiller = async (agentId) => {
    portes.push(agentId);
    if (portes.length === 1) poserEnclos(db, "alice", "fermee-test", { posePar: "office-test" });
    return { ok: false, socketPath: `/carton/${agentId}.sock`, error: "ENOENT" };
  };

  await assert.rejects(
    () => posterAUneTable(db, { sender: "alice", table: "famille", body: "à tous" }, { reveiller, maisons: MAISONS_VIDES() }),
    (erreur) => {
      assert.equal(erreur.code, "hors-enclos");
      assert.equal(erreur.enclos, "fermee-test", "les champs du refus d'origine restent lisibles");
      assert.deepEqual(erreur.destinataires_refuses, ["carol"]);
      assert.equal(erreur.adresse, "carol");
      assert.deepEqual(erreur.lettres_ecrites.map((l) => l.to), ["bob"], "une lettre partie, puis le refus");
      assert.equal(erreur.lettres_ecrites[0].interrompue, undefined);
      return true;
    }
  );
  assert.equal(compter(db, "messages"), 1, "la lettre de carol n'a jamais été écrite");
  assert.deepEqual(portes, ["bob"]);
});

// F4 — R2 : sur un rejeu, le réveil annoncé est celui de LA LIGNE, comme `wake`.
test("R2 — sur un rejeu, sans_reveil et motif_reveil se lisent sur la ligne (motif « rejeu »), jamais sur l'appel", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db, { reveil: "prochain-tour" });
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };
  const CALME = { ok: false, skipped: "sans-reveil" };

  // Une lettre calme, rejouée en high : elle reste calme, et le dit.
  const calme = await posterAUneTable(db, { sender: "alice", table: "famille", body: "plus tard", msg_id: "k-calme" }, deps);
  for (const lettre of calme.lettres) assert.equal(lettre.sans_reveil, true);
  const rejeuHaut = await posterAUneTable(db, { sender: "alice", table: "famille", body: "plus tard", msg_id: "k-calme", priority: "high" }, deps);
  for (const lettre of rejeuHaut.lettres) {
    assert.equal(lettre.rejeu?.motif, "msg_id-deja-connu");
    assert.equal(lettre.sans_reveil, true, "la ligne est calme : personne n'a été sonné");
    assert.equal(lettre.motif_reveil, "rejeu");
    assert.deepEqual(lettre.wake, CALME, "et wake dit la même chose");
    assert.deepEqual(lettre.ecarte, { priority: "high" }, "la priorité tapée n'est partie nulle part");
  }
  assert.equal(portes.length, 0);

  // L'inverse : une lettre high, rejouée sans priorité, sonne comme sa ligne.
  await posterAUneTable(db, { sender: "alice", table: "famille", body: "vite", msg_id: "k-haut", priority: "high" }, deps);
  portes.length = 0;
  const rejeuNormal = await posterAUneTable(db, { sender: "alice", table: "famille", body: "vite", msg_id: "k-haut" }, deps);
  for (const lettre of rejeuNormal.lettres) {
    assert.equal(lettre.sans_reveil, false, "la ligne n'est pas calme");
    assert.equal(lettre.motif_reveil, "rejeu");
    assert.equal(lettre.wake.skipped, undefined);
  }
  assert.deepEqual(portes.map((p) => p.agentId), ["bob", "carol"]);
});

// Mineurs de la revue : une mention seule (une CLI peut passer une chaîne), et
// les autres orthographes qu'`inscrireUneLettre` accepte (⑦).
test("posterAUneTable — reveiller accepte un nom seul, et l'entrée lit text, type, threadId, senderModel comme la base", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db, { reveil: "prochain-tour" });
  chaiseVivante(db, "bob");
  chaiseVivante(db, "carol");
  const { portes, reveiller } = reveilEnregistre();
  const deps = { reveiller, maisons: MAISONS_VIDES() };

  const seul = parNom(await posterAUneTable(db, { sender: "alice", table: "famille", body: "bob ?", reveiller: "bob" }, deps));
  assert.equal(seul.bob.motif_reveil, "mention");
  assert.equal(seul.carol.motif_reveil, "table");
  assert.deepEqual(portes.map((p) => p.agentId), ["bob"]);

  const autres = await posterAUneTable(
    db,
    { from: "alice", table: "famille", text: "par text", type: "task", threadId: "fil-tape", senderModel: "model-test" },
    deps
  );
  assert.equal(autres.count, 2);
  for (const lettre of autres.lettres) {
    assert.equal(lettre.row.sender, "alice");
    assert.equal(lettre.row.body, "par text");
    assert.equal(lettre.row.msg_type, "task");
    assert.equal(lettre.row.thread_id, "fil-tape");
    assert.equal(lettre.row.sender_model, "model-test");
  }
});

// B7 (relecture du guichet, J2) — LE PRÉ-CONTRÔLE D'ENCLOS D'UN ENVOI DE TABLE CANONISE LA CHAISE
// COURTE. `posterUneLettre` accepte un membre inscrit sous la forme courte d'une chaise quand sa forme
// entière est membre de l'enclos ; le pré-contrôle de l'envoi entier, lui, passait les adresses
// brutes et refusait l'envoi à tort (`hors-enclos`). Il lit maintenant les deux formes.
const SESSION_DE_BOB = "35e98d0b-3f2c-4d66-9fa6-08608bb889cf";
test("B7 — l'enclos d'un envoi de table canonise la chaise courte d'un membre avant de juger : jamais un refus à tort", async (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "bob", sessionId: SESSION_DE_BOB, house: MAISON_DE_LA_CHAISE, pid: process.pid });
  creerTable(db, { nom: "office-test", fermee: true, creeePar: "office-test" });
  for (const adresse of ["alice", `bob#${SESSION_DE_BOB}`]) ajouterMembre(db, "office-test", adresse, { ajoutePar: "office-test" });
  poserEnclos(db, "alice", "office-test", { posePar: "office-test" });
  creerTable(db, { nom: "famille", creeePar: "office-test" });
  for (const adresse of ["alice", "bob#35e98d0b"]) ajouterMembre(db, "famille", adresse, { ajoutePar: "office-test" });
  const deps = { reveiller: reveilEnregistre().reveiller, maisons: MAISONS_VIDES() };

  const envoi = await posterAUneTable(db, { sender: "alice", table: "famille", body: "inside the enclosure" }, deps);
  assert.deepEqual(envoi.lettres.map((l) => [l.to, l.row.recipient]), [["bob#35e98d0b", `bob#${SESSION_DE_BOB}`]]);

  // Le contrôle : un membre hors de l'enclos fait toujours refuser l'envoi entier.
  ajouterMembre(db, "famille", "carol", { ajoutePar: "office-test" });
  const avant = compter(db, "messages");
  await assert.rejects(
    () => posterAUneTable(db, { sender: "alice", table: "famille", body: "with carol" }, deps),
    (erreur) => erreur.code === "hors-enclos" && erreur.destinataires_refuses.join() === "carol"
  );
  assert.equal(compter(db, "messages"), avant, "rien d'écrit");
});

// B9 (relecture du guichet, J3) — UNE MENTION RECONNAÎT UN MEMBRE SOUS SES FORMES. `reveiller` se
// comparait à l'adresse telle que la table la liste : nommer la lignée d'un membre inscrit en chaise,
// la chaise d'un membre inscrit en lignée, ou la forme entière d'une chaise courte ne réveillait
// personne, sans le dire. Une chaise SŒUR ne réveille pas l'autre : la mention vise un membre.
// m6 (re-revue du round FINAL) : une mention de CHAISE ne vaut pour un membre inscrit en lignée
// que si la chaise est connue (une fiche `peers`, ou une adresse que la résolution mène à une
// chaise de cette lignée) : `bob#zzzzzzzz`, `bob#` ou `bob@nope` ne réveillent personne.
test("B9 — reveiller reconnaît un membre sous son adresse inscrite, sa lignée ou sa chaise ; une chaise sœur ne le réveille pas", async (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "dave", sessionId: SESSION_DE_BOB, house: MAISON_DE_LA_CHAISE, pid: process.pid });
  chaiseVivante(db, "bob", { sessionName: "atelier" });
  tableFamille(db, { reveil: "prochain-tour", membres: { alice: null, bob: null, "carol#s-carol": null, "dave#35e98d0b": null } });
  const deps = { reveiller: reveilEnregistre().reveiller, maisons: MAISONS_VIDES() };
  const motifs = async (reveiller) => {
    const envoi = await posterAUneTable(db, { sender: "alice", table: "famille", body: "beat", reveiller }, deps);
    return Object.fromEntries(envoi.lettres.map((l) => [l.to, l.motif_reveil]));
  };
  assert.deepEqual(await motifs([]), { bob: "table", "carol#s-carol": "table", "dave#35e98d0b": "table" }, "contrôle : la table fait dormir tout le monde");
  assert.equal((await motifs(["bob"]))["bob"], "mention", "l'adresse inscrite");
  assert.equal((await motifs(["bob#s-bob"]))["bob"], "mention", "une chaise d'un membre inscrit en lignée");
  assert.equal((await motifs(["bob@atelier"]))["bob"], "mention", "une adresse humaine d'un membre inscrit en lignée");
  assert.equal((await motifs(["carol"]))["carol#s-carol"], "mention", "la lignée d'un membre inscrit en chaise");
  assert.equal((await motifs([`dave#${SESSION_DE_BOB}`]))["dave#35e98d0b"], "mention", "la forme entière d'une chaise courte");
  assert.equal((await motifs(["dave#35e98d0b"]))["dave#35e98d0b"], "mention", "la forme courte telle qu'inscrite");
  const soeur = await motifs(["carol#s-other"]);
  assert.equal(soeur["carol#s-carol"], "table", "une chaise sœur ne réveille pas le membre inscrit");
  assert.equal(soeur.bob, "table");
  for (const inconnue of ["bob#zzzzzzzz", "bob#", "bob@nope", "bob#99999999"]) {
    assert.equal((await motifs([inconnue]))["bob"], "table", `m6 : ${inconnue} n'est pas une chaise connue de bob`);
  }
});

// m6 (re-revue du round FINAL) : `reveiller` se borne — 50 mentions de 200 caractères au plus.
// Au-delà, l'envoi entier est refusé (`parametre-invalide`, `parametre: "reveiller"`), avant toute
// lettre : chaque mention coûte une résolution, et 10 000 mentions coûtaient 0,8 s.
test("m6 — reveiller : plus de 50 mentions, ou une mention de plus de 200 caractères, refuse l'envoi (parametre-invalide) avant toute lettre ; 50 de 200 passent", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db);
  const deps = { reveiller: reveilEnregistre().reveiller, maisons: MAISONS_VIDES() };
  for (const reveiller of [Array.from({ length: 51 }, (_, n) => `m${n}`), ["x".repeat(201)], [`${"é".repeat(201)}`]]) {
    await assert.rejects(
      () => posterAUneTable(db, { sender: "alice", table: "famille", body: "beat", reveiller }, deps),
      (erreur) => {
        assert.equal(erreur.code, "parametre-invalide");
        assert.equal(erreur.parametre, "reveiller");
        assert.match(erreur.message, /at most 50 names of at most 200 characters/);
        return true;
      }
    );
  }
  assert.equal(compter(db, "messages"), 0, "rien d'écrit");
  const envoi = await posterAUneTable(db, {
    sender: "alice", table: "famille", body: "beat", reveiller: [...Array.from({ length: 49 }, (_, n) => `m${n}`), "y".repeat(200)]
  }, deps);
  assert.equal(envoi.count, 2);
});

// B14 (relecture du guichet) — UNE PANNE SANS CODE S'APPELLE `envoi-interrompu`. L'erreur d'un envoi
// qui casse gardait `erreur.code`, et une panne sans code (un TypeError, un réveil qui lève nu)
// donnait une erreur SANS code — précisément ce que les surfaces lisent. Elle porte maintenant
// `envoi-interrompu` ; la panne d'origine reste dans `cause`, et aucune surface n'invente une cause.
test("B14 — une panne sans code au milieu d'un envoi : code envoi-interrompu, la panne d'origine dans cause ; la porte web ne lui invente pas de cause", async (t) => {
  const db = bureauDePoste(t);
  tableFamille(db);
  let coups = 0;
  const reveiller = async (agentId) => {
    coups += 1;
    if (coups === 2) throw new TypeError("a codeless failure");
    return { ok: true, socketPath: `/carton/${agentId}.sock` };
  };
  let attrapee = null;
  await assert.rejects(
    () => posterAUneTable(db, { sender: "alice", table: "famille", body: "beat" }, { reveiller, maisons: MAISONS_VIDES() }),
    (erreur) => {
      attrapee = erreur;
      return true;
    }
  );
  assert.equal(attrapee.code, "envoi-interrompu");
  assert.equal(attrapee.cause instanceof TypeError, true, "la panne d'origine");
  assert.equal(attrapee.cause.code, undefined);
  assert.deepEqual(attrapee.lettres_ecrites.map((l) => l.to), ["bob", "carol"]);
  assert.equal(interruptionDEnvoi(attrapee).lettres_ecrites.length, 2);
  const refus = refusDuGuichet(attrapee);
  assert.equal(refus.statut, 500);
  assert.equal(refus.corps.refus, "envoi-interrompu");
  assert.equal("cause" in refus.corps, false, "aucune cause inventée : la panne n'avait pas de code");
});

// B14 — LA LETTRE NÉE DU MEMBRE FAUTIF SE TROUVE SOUS LA FORME ÉCRITE. Un membre inscrit en chaise
// courte reçoit sa lettre sous la forme ENTIÈRE (`canoniserLaChaiseCourte`) ; la recherche de la
// lettre née comparait à la forme inscrite et ne la trouvait pas : le rapport en disait une de moins.
test("B14 — un envoi qui casse au membre inscrit en chaise courte : sa lettre née entre dans lettres_ecrites (interrompue)", async (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "bob", sessionId: SESSION_DE_BOB, house: MAISON_DE_LA_CHAISE, pid: process.pid });
  tableFamille(db, { membres: { alice: null, "bob#35e98d0b": null, carol: null } });
  const reveiller = async () => {
    const panne = new Error("the test socket broke");
    panne.code = "PANNE_TEST";
    throw panne;
  };
  let attrapee = null;
  await assert.rejects(
    () => posterAUneTable(db, { sender: "alice", table: "famille", body: "beat" }, { reveiller, maisons: MAISONS_VIDES() }),
    (erreur) => {
      attrapee = erreur;
      return true;
    }
  );
  assert.equal(attrapee.code, "PANNE_TEST");
  assert.equal(attrapee.adresse, "bob#35e98d0b");
  assert.deepEqual(attrapee.lettres_ecrites.map((l) => [l.to, l.row.recipient, l.interrompue]), [["bob#35e98d0b", `bob#${SESSION_DE_BOB}`, true]]);
  assert.deepEqual(lettresDUnEnvoi(db, attrapee.envoi_id).map((r) => r.msg_id), attrapee.lettres_ecrites.map((l) => l.row.msg_id), "la base et l'erreur disent la même chose");
});
