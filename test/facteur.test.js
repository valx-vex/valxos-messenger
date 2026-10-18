// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE FACTEUR — la tournée qui ne perd ni ne double.
//
// ⚠️ Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) : le
// bureau de poste vivant (~/.cc2cc-v2/broker.db) n'est JAMAIS ouvert ici. Toutes
// les boîtes aux lettres sont NOS PROPRES fausses boîtes, montées dans un
// répertoire temporaire : aucune session vivante n'est touchée, jamais.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import {
  DEFAULT_CARRIED_GRACE_MS,
  MAISONS_PAR_DEFAUT,
  REGLAGES_FACTEUR_PAR_DEFAUT,
  maisonsConnues,
  reglagesDuFacteur,
  verifierLesReglages
} from "../src/lib/config.js";
import { getPendingForContext, insertMessage, openDatabase } from "../src/lib/database.js";
import { SCHEMA_VERSION, migrate, schemaVersion } from "../src/lib/migrations.js";
import { registerInstance } from "../src/lib/registry.js";

import {
  ETAT_ACCUSEE,
  ETAT_DIFFEREE,
  ETAT_PRETE,
  ETAT_RESERVEE,
  avisDAttente,
  construireParSession,
  etatDuCourrier,
  faireLaTournee,
  lierLaBoite,
  noterLEchec,
  noterLaRemise,
  perimerLesBaux,
  plierLaLettre,
  prendreUneLettre
} from "../src/facteur/round.js";
import { registerPeer } from "../src/lib/database.js";
import { resolveRecipient } from "../src/lib/registry.js";
import { cheminDuVerrou, demarrerLeFacteur, lireLeVerrou, prendreLeVerrou } from "../src/facteur/daemon.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const RACINE = path.resolve(new URL("..", import.meta.url).pathname);

// Le décor se démonte : une suite qui laisse traîner ses maisons de carton finit
// par en laisser des milliers.
const decors = [];
function decorJetable(prefixe = "cc2cc-facteur-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  decors.push(dir);
  return dir;
}
after(() => {
  for (const dir of decors) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHome() {
  const root = decorJetable("cc2cc-facteur-home-");
  poserLeBureau(root);
  return root;
}

function bureauDePoste(t) {
  const root = tempHome();
  const fichier = path.join(root, "broker.db");
  const db = openDatabase({ file: fichier });
  db.fichier = fichier;
  db.racine = root;
  t.after(() => {
    try {
      db.close();
    } catch {
      /* base jetable */
    }
  });
  return db;
}

// Une chaise vivante : une instance au registre + la boîte que l'inventaire rend.
function chaise(db, { lignee, session, maison = "/maison/carton", pid = 4242, socketPath = "/carton.sock", token = null }) {
  registerInstance(db, { lineage: lignee, sessionId: session, house: maison, pid });
  return {
    house: maison,
    pid,
    sessionId: session,
    name: lignee,
    socketPath,
    kind: null,
    status: "idle",
    procStart: "Thu Aug 13 09:00:00 2026",
    preuve: "registre",
    token
  };
}

// L'inventaire que rend la tournée des maisons (T1) : les boîtes ET les maisons
// parcourues — sans ce second membre, « maison inconnue » et « boîte endormie »
// se ressembleraient.
function inventaire(boites, maisons = null) {
  const noms = maisons || [...new Set(boites.map((b) => b.house))];
  const houses = noms.map((house) => ({
    house,
    readable: true,
    fiches: 1,
    boxes: 1,
    sondees: 0,
    endormies: 0,
    illisibles: 0,
    doublons: 0
  }));
  return () => ({ boxes: boites, houses });
}

// Le même inventaire, mais dans la forme que `avisDAttente`/`trouverLaBoite`
// attendent ({houses, parSession}, pas {boxes, houses}) — `construireParSession`
// est la MÊME fonction que la tournée réelle utilise, jamais une deuxième
// conversion qui pourrait diverger.
function depsHouseScan(boites, maisons = null) {
  const { boxes, houses } = inventaire(boites, maisons)();
  return { houses, parSession: construireParSession(boxes) };
}

// Un guichet de carton : il note ce qu'on lui tend et rend le verdict demandé.
function guichetDeCarton(verdict = { ok: true, etat: "remis-au-guichet" }) {
  const remises = [];
  const remettre = async (arg) => {
    remises.push(arg);
    return typeof verdict === "function" ? verdict(arg, remises.length) : verdict;
  };
  return { remises, remettre };
}

// Les dépendances communes : aucune maison réelle, aucune vraie pause.
function depsDeBase(extra = {}) {
  return { maisons: [], dormir: async () => {}, ...extra };
}

// Une VRAIE fausse boîte : un socket UNIX à nous, dans un répertoire jetable,
// qui compte les enveloppes qu'on lui tend.
async function fausseBoite(t, { nom = "boite.sock" } = {}) {
  const dir = decorJetable("cc2cc-facteur-uds-");
  const socketPath = path.join(dir, nom);
  const lignes = [];
  const serveur = net.createServer((flux) => {
    let tampon = "";
    flux.on("data", (bloc) => {
      tampon += bloc.toString("utf8");
      let coupure = tampon.indexOf("\n");
      while (coupure >= 0) {
        const ligne = tampon.slice(0, coupure).trim();
        tampon = tampon.slice(coupure + 1);
        if (ligne) lignes.push(ligne);
        coupure = tampon.indexOf("\n");
      }
    });
    flux.on("error", () => {});
  });
  await new Promise((resolve) => serveur.listen(socketPath, resolve));
  t.after(() => {
    try {
      serveur.close();
    } catch {
      /* boîte de carton */
    }
  });
  return {
    socketPath,
    lignes,
    enveloppes: () => lignes.map((l) => JSON.parse(l)).filter((e) => e?.msgV === 1)
  };
}

// Un porteur qui vit dans SON PROPRE processus : le seul montage qui prouve
// quoi que ce soit sur les verrous SQLite et la reprise après mort.
function ecrireLePorteur(nom, source) {
  const dir = decorJetable("cc2cc-facteur-enfant-");
  const script = path.join(dir, `${nom}.mjs`);
  fs.writeFileSync(script, source, "utf8");
  return script;
}

function porteurEnfant(nom, source, args, env = {}) {
  return spawnSync(process.execPath, [ecrireLePorteur(nom, source), ...args], {
    encoding: "utf8",
    env: { ...envPropre(), ...env }
  });
}

// ⚠️ `spawnSync` SÉRIALISE : le premier enfant meurt avant que le second ne
// naisse. Deux Facteurs lancés ainsi ne se rencontrent JAMAIS, et un banc de
// concurrence qui ne fait pas se rencontrer ses concurrents ne prouve rien.
// Ici, les deux processus vivent EN MÊME TEMPS et se donnent rendez-vous à une
// milliseconde commune.
function porteursEnMemeTemps(script, jeux, env = {}) {
  return Promise.all(
    jeux.map(
      (args) =>
        new Promise((resolve) => {
          const enfant = spawn(process.execPath, [script, ...args], {
            env: { ...envPropre(), ...env }
          });
          let sortie = "";
          let erreur = "";
          enfant.stdout.on("data", (bloc) => (sortie += bloc));
          enfant.stderr.on("data", (bloc) => (erreur += bloc));
          enfant.on("close", (status, signal) => resolve({ status, signal, stdout: sortie, stderr: erreur }));
        })
    )
  );
}

// ---------------------------------------------------------------------------
// A9 — « accusé nul ⇒ la lettre finit toujours par revenir ». Les marques du
// porteur (carried_at, delivered_at, injected_at) sont des OBSERVATIONS, jamais
// des états terminaux.
// ---------------------------------------------------------------------------

for (const marque of ["carried_at", "delivered_at", "injected_at"]) {
  test(`une lettre marquée ${marque} et jamais accusée repart en tournée`, async (t) => {
    const db = bureauDePoste(t);
    const boite = chaise(db, { lignee: "bob", session: "s-m" });
    insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "bob", body: "bonjour" });
    db.prepare(`UPDATE messages SET ${marque} = ? WHERE msg_id = 'L1'`).run(
      new Date(Date.now() - 3_600_000).toISOString()
    );

    const guichet = guichetDeCarton();
    const bilan = await faireLaTournee(
      db,
      depsDeBase({ tourHouses: inventaire([boite]), remettreAuGuichet: guichet.remettre })
    );

    assert.equal(bilan.remises, 1, `${marque} n'est PAS terminal : seul l'accusé l'est (A9)`);
    assert.equal(guichet.remises.length, 1);
  });
}

test("une lettre accusée ne repart JAMAIS, même remise il y a longtemps", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "bob", body: "bonjour" });
  db.prepare("UPDATE messages SET carried_at = ?, acked_at = ? WHERE msg_id = 'L1'").run(
    new Date(Date.now() - 3_600_000).toISOString(),
    new Date(Date.now() - 3_500_000).toISOString()
  );

  const guichet = guichetDeCarton();
  const bilan = await faireLaTournee(
    db,
    depsDeBase({ tourHouses: inventaire([boite]), remettreAuGuichet: guichet.remettre })
  );

  assert.equal(bilan.remises, 0);
  assert.equal(guichet.remises.length, 0, "l'accusé est le SEUL état terminal");
});

test("une lettre remise revient après la fenêtre d'ajournement, jamais avant", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "bob", body: "bonjour" });

  const guichet = guichetDeCarton();
  let horloge = 1_000_000;
  const deps = depsDeBase({
    tourHouses: inventaire([boite]),
    remettreAuGuichet: guichet.remettre,
    horloge: () => horloge,
    reglages: { ajournementApresRemiseMs: 600_000 }
  });

  await faireLaTournee(db, deps);
  assert.equal(guichet.remises.length, 1, "la première tournée porte la lettre");

  horloge += 60_000;
  await faireLaTournee(db, deps);
  assert.equal(
    guichet.remises.length,
    1,
    "une lettre remise il y a une minute ne se re-porte pas : un doublon, pas une avalanche (A8)"
  );

  horloge += 600_001;
  await faireLaTournee(db, deps);
  assert.equal(guichet.remises.length, 2, "sans accusé, la lettre FINIT TOUJOURS par revenir (A9)");
});

test("carried_at garde la PREMIÈRE remise — sinon un Facteur pressé affamerait le canal de repli", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });

  // ⚠️ RÉGLAGE ADVERSE, MAIS PLAUSIBLE (« livrer plus vite ») : le Facteur
  // repasse AVANT la fin de la grâce du canal de repli. Les deux seuils vivent
  // dans deux variables indépendantes, rien n'interdit ce couple.
  const ajournement = 1_000;
  assert.ok(
    ajournement < DEFAULT_CARRIED_GRACE_MS,
    "contrôle du banc : le Facteur repasse bien PLUS VITE que la grâce du repli"
  );

  const guichet = guichetDeCarton();
  let horloge = 1_000_000;
  const deps = depsDeBase({
    tourHouses: inventaire([boite]),
    remettreAuGuichet: guichet.remettre,
    horloge: () => horloge,
    reglages: { ajournementApresRemiseMs: ajournement }
  });

  await faireLaTournee(db, deps);
  const premiere = db.prepare("SELECT carried_at FROM messages WHERE msg_id='L1'").get().carried_at;
  assert.ok(premiere, "la première remise est marquée");

  horloge += 600_000;
  await faireLaTournee(db, deps);
  assert.equal(guichet.remises.length, 2, "le Facteur repasse (A9)");
  assert.equal(
    db.prepare("SELECT carried_at FROM messages WHERE msg_id='L1'").get().carried_at,
    premiere,
    "la date de la PREMIÈRE remise ne bouge pas : la grâce du repli se compte depuis elle"
  );

  // La conséquence, celle qui coûte : écraser la date à chaque repassage
  // repousserait la grâce à chaque repassage, et le repli cesserait DÉFINITIVEMENT
  // de servir cette lettre. A9 tué en silence, aux réglages seulement.
  assert.equal(
    getPendingForContext(db, "bob", { now: new Date(horloge + 1_000).toISOString() }).length,
    1,
    "le canal de repli sert TOUJOURS la lettre : c'est ça que le COALESCE achète"
  );
});

test("l'état d'une lettre se DÉRIVE : prête, réservée, différée, accusée", async (t) => {
  const db = bureauDePoste(t);
  chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "bob", body: "bonjour" });
  const reglages = reglagesDuFacteur();
  const t0 = 5_000_000;

  assert.equal(etatDuCourrier(db, "L1", { maintenant: t0 }), ETAT_PRETE);

  const prise = prendreUneLettre(db, { porteur: "porteur-1", maintenant: t0, reglages });
  assert.ok(prise, "une lettre prête se réserve");
  assert.equal(etatDuCourrier(db, "L1", { maintenant: t0 }), ETAT_RESERVEE);

  // Le bail écoulé ne « libère » rien de force : la lettre redevient prenable.
  assert.equal(etatDuCourrier(db, "L1", { maintenant: t0 + reglages.bailMs + 1 }), ETAT_PRETE);

  db.prepare("UPDATE messages SET facteur_not_before_ms = ? WHERE msg_id = 'L1'").run(t0 + 10_000_000);
  assert.equal(etatDuCourrier(db, "L1", { maintenant: t0 + reglages.bailMs + 1 }), ETAT_DIFFEREE);

  db.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = 'L1'").run(new Date(t0).toISOString());
  assert.equal(etatDuCourrier(db, "L1", { maintenant: t0 }), ETAT_ACCUSEE);
});

// ---------------------------------------------------------------------------
// L'EXCLUSION — une seule tentative active par lettre, et des états
// incohérents IMPOSSIBLES À ÉCRIRE.
// ---------------------------------------------------------------------------

test("deux tentatives actives sur la même lettre sont impossibles à écrire", async (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  const poser = (id, etat) =>
    db
      .prepare(`
        INSERT INTO facteur_attempts (attempt_id, msg_id, owner_id, state, claimed_at_ms, lease_until_ms)
        VALUES (?, 'L1', 'porteur', ?, 1000, 2000)
      `)
      .run(id, etat);

  poser("11111111-1111-1111-1111-111111111111", "reservee");
  assert.throws(
    () => poser("22222222-2222-2222-2222-222222222222", "reservee"),
    /UNIQUE|constraint/i,
    "deux Facteurs ne peuvent pas tenir la même lettre en même temps"
  );
});

test("une tentative ne peut pas naître dans un état incohérent", async (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  const brut = (colonnes, valeurs) =>
    db.prepare(`INSERT INTO facteur_attempts (${colonnes}) VALUES (${valeurs})`).run();

  assert.throws(
    () =>
      brut(
        "attempt_id, msg_id, owner_id, state, claimed_at_ms, lease_until_ms",
        "'liee-sans-cible-mais-assez-longue-1234', 'L1', 'p', 'liee', 1000, 2000"
      ),
    /constraint/i,
    "une tentative LIÉE sans cible n'a aucun sens : on ne saurait pas qui était visé"
  );

  assert.throws(
    () =>
      brut(
        "attempt_id, msg_id, owner_id, state, claimed_at_ms, lease_until_ms",
        "'bail-a-lenvers-mais-assez-longue-1234', 'L1', 'p', 'reservee', 2000, 1000"
      ),
    /constraint/i,
    "un bail qui expire avant d'avoir commencé n'est pas un bail"
  );

  assert.throws(
    () =>
      brut(
        "attempt_id, msg_id, owner_id, state, claimed_at_ms, lease_until_ms",
        "'trop-court', 'L1', 'p', 'reservee', 1000, 2000"
      ),
    /constraint/i,
    "un identifiant de tentative tronqué ferait collisionner deux tentatives"
  );

  assert.throws(
    () =>
      brut(
        "attempt_id, msg_id, owner_id, state, claimed_at_ms, lease_until_ms, finished_at_ms",
        "'remise-sans-heure-de-fin-mais-longue', 'L1', 'p', 'remise', 1000, 2000, NULL"
      ),
    /constraint/i,
    "une tentative finie sans heure de fin ment sur son propre passé"
  );
});

test("deux Facteurs RÉELS, en même temps : jamais deux porteurs sur la même lettre", async (t) => {
  const db = bureauDePoste(t);
  const COURRIER = 40;
  for (let i = 0; i < COURRIER; i += 1) {
    insertMessage(db, { msg_id: `L${i}`, sender: "a", recipient: "bob", body: `n°${i}` });
  }
  const script = ecrireLePorteur(
    "porteur",
    `
import fs from "node:fs";
const [dbFile, sortie, top] = process.argv.slice(2);
const { openDatabase } = await import("${RACINE}/src/lib/database.js");
const { prendreUneLettre } = await import("${RACINE}/src/facteur/round.js");
const { reglagesDuFacteur } = await import("${RACINE}/src/lib/config.js");
const db = openDatabase({ file: dbFile });
const reglages = reglagesDuFacteur();
const dormirUnPeu = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
// Le rendez-vous : les deux porteurs entrent dans le bureau au même instant, et
// ils y restent ENSEMBLE le temps de vider la corbeille.
while (Date.now() < Number(top)) { /* on s'aligne */ }
const prises = [];
let erreur;
try {
  for (;;) {
    const prise = prendreUneLettre(db, { porteur: "porteur-" + process.pid, maintenant: Date.now(), reglages });
    if (!prise) break;
    prises.push(prise.lettre.msg_id);
    dormirUnPeu();
  }
} catch (e) {
  erreur = String(e?.code || e?.message || e);
}
fs.writeFileSync(sortie, JSON.stringify({ prises, erreur }));
`
  );
  const dir = decorJetable("cc2cc-facteur-duo-");
  const sorties = [path.join(dir, "un.json"), path.join(dir, "deux.json")];
  const top = Date.now() + 900; // le temps que les DEUX processus soient nés
  const enfants = await porteursEnMemeTemps(
    script,
    sorties.map((sortie) => [db.fichier, sortie, String(top)]),
    { CC2CC_V2_HOME: db.racine }
  );

  for (const enfant of enfants) {
    assert.equal(enfant.status, 0, `un porteur a échoué : ${enfant.stderr}`);
  }
  const verdicts = sorties.map((s) => JSON.parse(fs.readFileSync(s, "utf8")));
  for (const verdict of verdicts) {
    assert.equal(
      verdict.erreur,
      undefined,
      `aucun porteur ne doit tomber en panne pour se départager : ${verdict.erreur}`
    );
  }
  // La preuve que les deux se sont bien rencontrés : ils ont porté tous les deux.
  for (const verdict of verdicts) {
    assert.ok(verdict.prises.length > 0, "les deux porteurs doivent avoir travaillé EN MÊME TEMPS");
  }

  const toutes = verdicts.flatMap((v) => v.prises);
  assert.equal(toutes.length, COURRIER, "tout le courrier est pris, rien n'est laissé sur place");
  assert.equal(new Set(toutes).size, COURRIER, "et AUCUNE lettre n'est partie avec deux porteurs");
  const doublons = db
    .prepare(`
      SELECT msg_id, count(*) n FROM facteur_attempts
      WHERE state IN ('reservee','liee') GROUP BY msg_id HAVING n > 1
    `)
    .all();
  assert.deepEqual(doublons, [], "une seule tentative active par lettre, quoi qu'il arrive");
});

test("le bail : personne ne reprend une lettre avant son échéance, tout le monde après", async (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  const reglages = reglagesDuFacteur();
  const t0 = 9_000_000;

  const premiere = prendreUneLettre(db, { porteur: "porteur-1", maintenant: t0, reglages });
  assert.ok(premiere);
  assert.equal(
    prendreUneLettre(db, { porteur: "porteur-2", maintenant: t0 + reglages.bailMs - 1, reglages }),
    null,
    "tant que le bail court, la lettre appartient à son porteur"
  );

  const seconde = prendreUneLettre(db, { porteur: "porteur-2", maintenant: t0 + reglages.bailMs + 1, reglages });
  assert.ok(seconde, "un porteur disparu ne bloque le courrier que le temps de son bail");
  assert.notEqual(seconde.attemptId, premiere.attemptId);
  assert.equal(
    db.prepare("SELECT state FROM facteur_attempts WHERE attempt_id = ?").get(premiere.attemptId).state,
    "expiree"
  );
});

test("un porteur périmé ne peut plus rien écrire sur la lettre d'un autre", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  const reglages = reglagesDuFacteur();
  const t0 = 3_000_000;

  const perdue = prendreUneLettre(db, { porteur: "porteur-lent", maintenant: t0, reglages });
  assert.ok(lierLaBoite(db, { attemptId: perdue.attemptId, boite, maintenant: t0, reglages }));

  const apres = t0 + reglages.bailMs + 1;
  const successeur = prendreUneLettre(db, { porteur: "porteur-frais", maintenant: apres, reglages });
  assert.ok(successeur, "le successeur reprend la lettre");

  // Le vieux porteur se réveille et croit encore posséder la lettre.
  const marque = noterLaRemise(db, {
    attemptId: perdue.attemptId,
    msgId: "L1",
    cibleSession: "s-m",
    porteur: "porteur-lent",
    maintenant: apres,
    reglages
  });
  assert.equal(marque, false, "un porteur périmé n'a plus AUCUN droit sur l'état de la lettre");
  assert.equal(db.prepare("SELECT carried_at FROM messages WHERE msg_id='L1'").get().carried_at, null);
  assert.equal(
    db.prepare("SELECT state FROM facteur_attempts WHERE attempt_id = ?").get(successeur.attemptId).state,
    "reservee",
    "la tentative du successeur est intacte"
  );
});

// ---------------------------------------------------------------------------
// LES FRONTIÈRES DE CRASH — dans de VRAIS processus.
// ---------------------------------------------------------------------------

test("mort APRÈS le dépôt et AVANT le marquage : la lettre repart, un doublon vaut mieux qu'une perte", async (t) => {
  const db = bureauDePoste(t);
  const boiteReelle = await fausseBoite(t);
  const boite = chaise(db, {
    lignee: "bob",
    session: "s-m",
    maison: "/maison/carton",
    socketPath: boiteReelle.socketPath
  });
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "bob", body: "bonjour" });

  const source = `
const [dbFile, socketPath] = process.argv.slice(2);
const { openDatabase } = await import("${RACINE}/src/lib/database.js");
const { prendreUneLettre, lierLaBoite, plierLaLettre } = await import("${RACINE}/src/facteur/round.js");
const { reglagesDuFacteur } = await import("${RACINE}/src/lib/config.js");
const { buildEnvelope, buildWrapper, remettreAuGuichet } = await import("${RACINE}/src/lib/courier.js");
const db = openDatabase({ file: dbFile });
const reglages = reglagesDuFacteur();
const prise = prendreUneLettre(db, { porteur: "porteur-condamne", maintenant: Date.now(), reglages });
if (!prise) process._exit(7);
const boite = { house: "/maison/carton", sessionId: "s-m", socketPath, procStart: null };
if (!lierLaBoite(db, { attemptId: prise.attemptId, boite, maintenant: Date.now(), reglages })) process._exit(8);
const contenu = buildWrapper({
  from: "uds:facteur", fromSession: "", hopChain: "facteur",
  fromName: prise.lettre.sender, fromMode: "default",
  text: plierLaLettre(prise.lettre, { attemptId: prise.attemptId })
});
const enveloppe = buildEnvelope({
  msgId: prise.lettre.msg_id, content: contenu, priority: "next",
  from: "uds:facteur", sessionId: "s-m"
});
const verdict = await remettreAuGuichet({
  socketPath, envelope: enveloppe,
  lingerMs: reglages.delaiDeFermetureMs, timeoutMs: reglages.delaiDeRemiseMs
});
if (!verdict.ok) process.exit(9);
// ⚠️ LA MORT EST ICI, et elle est BRUTALE : la lettre est PARTIE, et RIEN n'est
// marqué. Aucun « finally », aucune fermeture propre de SQLite.
process.kill(process.pid, "SIGKILL");
`;
  const enfant = porteurEnfant("porteur-qui-meurt", source, [db.fichier, boiteReelle.socketPath], {
    CC2CC_V2_HOME: db.racine
  });
  assert.equal(
    enfant.signal,
    "SIGKILL",
    `le porteur devait déposer puis mourir brutalement : ${enfant.status} ${enfant.stderr}`
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(boiteReelle.enveloppes().length, 1, "la lettre EST partie");
  assert.equal(
    db.prepare("SELECT carried_at FROM messages WHERE msg_id='L1'").get().carried_at,
    null,
    "le porteur est mort avant de marquer : rien n'est écrit"
  );
  assert.equal(
    db.prepare("SELECT state FROM facteur_attempts WHERE msg_id='L1'").get().state,
    "liee",
    "sa tentative reste liée, avec un bail qui va expirer"
  );

  const reglages = reglagesDuFacteur();
  const apres = Date.now() + reglages.bailMs + 1;
  const bilan = await faireLaTournee(
    db,
    depsDeBase({ tourHouses: inventaire([boite]), horloge: () => apres })
  );
  assert.equal(bilan.remises, 1, "après le bail, un autre Facteur reprend la lettre");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const recues = boiteReelle.enveloppes();
  assert.equal(recues.length, 2, "deux occurrences sont acceptables (A8) ; zéro ne l'est pas");
  assert.deepEqual([...new Set(recues.map((e) => e.msg_id))], ["L1"]);
  assert.ok(db.prepare("SELECT carried_at FROM messages WHERE msg_id='L1'").get().carried_at);
});

// ---------------------------------------------------------------------------
// LA TOURNÉE — le nominal, et tout ce qui l'empêche.
// ---------------------------------------------------------------------------

test("une lettre en attente est REMISE AU GUICHET puis marquée — jamais « livrée »", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m", token: "jeton-de-la-boite" });
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "bob", subject: "objet", body: "bonjour" });

  const guichet = guichetDeCarton();
  const bilan = await faireLaTournee(
    db,
    depsDeBase({ tourHouses: inventaire([boite]), remettreAuGuichet: guichet.remettre })
  );

  assert.equal(bilan.remises, 1);
  assert.equal(guichet.remises.length, 1);
  const remise = guichet.remises[0];
  assert.equal(remise.socketPath, "/carton.sock");
  assert.equal(remise.token, "jeton-de-la-boite");
  assert.equal(remise.envelope.msg_id, "L1");
  assert.equal(remise.envelope.priority, "next", "« now » ne veut pas dire « vu tout de suite » (A5)");
  assert.equal(remise.envelope.session_id, "s-m", "le verrou d'incarnation voyage TOUJOURS (A3)");
  assert.ok(remise.envelope.message.content.includes("bonjour"));

  const ligne = db.prepare("SELECT * FROM messages WHERE msg_id='L1'").get();
  assert.ok(ligne.carried_at, "la lettre est marquée REMISE AU GUICHET");
  assert.equal(ligne.delivered_at, null, "le Facteur ne pose JAMAIS delivered_at (A1)");
  assert.equal(ligne.acked_at, null, "et encore moins l'accusé du destinataire");
  const evenements = db
    .prepare("SELECT event_type FROM delivery_events WHERE msg_id='L1' ORDER BY id")
    .all()
    .map((e) => e.event_type);
  assert.deepEqual(evenements, ["created", "facteur_reservee", "facteur_remis"]);
});

test("les DEUX états de succès du dépôt valent remise (on se branche sur ok, jamais sur etat)", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });

  // « boîte refermée avant le délai » n'existe plus : le destinataire qui lit sa
  // lettre puis referme sa boîte est le cas NOMINAL.
  const guichet = guichetDeCarton({ ok: true, etat: "remis-au-guichet-fermeture-subie" });
  const bilan = await faireLaTournee(
    db,
    depsDeBase({ tourHouses: inventaire([boite]), remettreAuGuichet: guichet.remettre })
  );
  assert.equal(bilan.remises, 1, "une fermeture subie APRÈS des octets acceptés est un SUCCÈS");
  assert.ok(db.prepare("SELECT carried_at FROM messages WHERE msg_id='L1'").get().carried_at);
});

test("un dépôt raté ne marque RIEN, et le canal de repli reste capable de rattraper", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });

  const guichet = guichetDeCarton({ ok: false, etat: "non-remis", reason: "boite-injoignable", permanent: false });
  const bilan = await faireLaTournee(
    db,
    depsDeBase({ tourHouses: inventaire([boite]), remettreAuGuichet: guichet.remettre })
  );

  assert.equal(bilan.remises, 0);
  assert.equal(bilan.motifs["boite-injoignable"], 1);
  const ligne = db.prepare("SELECT * FROM messages WHERE msg_id='L1'").get();
  assert.equal(ligne.carried_at, null, "une lettre non portée ne doit JAMAIS être marquée");
  assert.equal(ligne.delivered_at, null);
  const dernier = db
    .prepare("SELECT event_type FROM delivery_events WHERE msg_id='L1' ORDER BY id DESC")
    .get();
  assert.equal(dernier.event_type, "facteur_echec");
  assert.equal(
    getPendingForContext(db, "bob").length,
    1,
    "le repli doit rester capable de rattraper ce que le Facteur a raté"
  );
});

test("un motif d'inacheminement qui SE RÉPÈTE écrit un événement qui COMPTE, jamais la même ligne en boucle", async (t) => {
  const db = bureauDePoste(t);
  // Destinataire inconnu : chaque tournée échoue avec le MÊME motif.
  insertMessage(db, { msg_id: "R1", sender: "a", recipient: "personne-inconnue", body: "x" });
  // L'échéance ne nous retient pas entre deux tournées : elle CROÎT (1, 2, 4 ms)
  // sans jamais approcher la seconde qui sépare nos horloges de carton.
  const deps = (maintenant) =>
    depsDeBase({
      tourHouses: inventaire([]),
      horloge: () => maintenant,
      reglages: { ajournementInacheminableMs: 1 }
    });
  await faireLaTournee(db, deps(1_000_000));
  await faireLaTournee(db, deps(2_000_000));
  await faireLaTournee(db, deps(3_000_000));

  const evenements = db
    .prepare(
      "SELECT event_type, detail_json FROM delivery_events WHERE msg_id = 'R1' AND event_type LIKE 'facteur_echec%' ORDER BY id"
    )
    .all();
  assert.equal(evenements.length, 3, "trois tournées, trois échecs — aucun n'est avalé");
  assert.equal(evenements[0].event_type, "facteur_echec", "la PREMIÈRE fois se dit plein format");
  assert.equal(evenements[1].event_type, "facteur_echec_repete", "la répétition COMPTE au lieu de répéter");
  assert.equal(evenements[2].event_type, "facteur_echec_repete");

  const deuxieme = JSON.parse(evenements[1].detail_json);
  assert.equal(deuxieme.repetitions, 2, "la série commence à DEUX : la courante plus celle d'avant");
  assert.equal(
    deuxieme.depuis,
    new Date(1_000_000).toISOString(),
    "la frontière à DEUX éléments date déjà de la PREMIÈRE tentative de la série"
  );

  const detail = JSON.parse(evenements[2].detail_json);
  assert.equal(detail.motif, "destinataire-inconnu");
  assert.equal(detail.repetitions, 3, "le compte inclut la tentative courante");
  assert.equal(detail.permanent, false);
  assert.ok(detail.attempt_id, "le reçu de la tentative reste dans le détail");
  assert.ok(detail.reprise_apres_ms > 0);
  assert.equal(
    detail.depuis,
    new Date(1_000_000).toISOString(),
    "depuis quand la série court — l'échéance a une origine, et c'est la PLUS VIEILLE"
  );

  // La ligne facteur_attempts est TOUJOURS écrite : c'est elle qui porte le
  // compte dérivé (tentativesInfructueuses). L'événement change de NOM, il ne
  // se retranche pas : trois échecs, trois lignes closes, et trois lignes au
  // journal — rien ne se compacte ici.
  const closes = db
    .prepare("SELECT count(*) AS n FROM facteur_attempts WHERE msg_id = 'R1' AND state = 'echouee'")
    .get();
  assert.equal(closes.n, 3);
});

test("un motif qui CHANGE rompt la série : l'événement redevient plein format", async (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "R2", sender: "a", recipient: "alice", body: "x" });
  const deps = (maintenant, boites) =>
    depsDeBase({
      tourHouses: inventaire(boites),
      horloge: () => maintenant,
      reglages: { ajournementInacheminableMs: 1 }
    });
  // Tournée 1 : personne au registre → destinataire-inconnu.
  await faireLaTournee(db, deps(1_000_000, []));
  // Tournées 2-3 : DEUX chaises vivantes → lignee-ambigue (le motif a changé,
  // puis se répète).
  const une = chaise(db, { lignee: "alice", session: "s-1", pid: 1 });
  const deux = chaise(db, { lignee: "alice", session: "s-2", pid: 2 });
  await faireLaTournee(db, deps(2_000_000, [une, deux]));
  await faireLaTournee(db, deps(3_000_000, [une, deux]));

  const types = db
    .prepare(
      "SELECT event_type, detail_json FROM delivery_events WHERE msg_id = 'R2' AND event_type LIKE 'facteur_echec%' ORDER BY id"
    )
    .all();
  assert.deepEqual(
    types.map((e) => e.event_type),
    ["facteur_echec", "facteur_echec", "facteur_echec_repete"]
  );
  const detail = JSON.parse(types[2].detail_json);
  assert.equal(detail.repetitions, 2, "la série repart au changement de motif");
  assert.equal(detail.motif, "lignee-ambigue");
  assert.equal(detail.depuis, new Date(2_000_000).toISOString(), "la série date du CHANGEMENT, pas du premier échec");
});

test("une remise entre deux échecs ROMPT la série : la situation a changé, elle mérite son plein format", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "R3", sender: "a", recipient: "bob", body: "x" });
  const deps = (maintenant, verdict) =>
    depsDeBase({
      tourHouses: inventaire([boite]),
      remettreAuGuichet: guichetDeCarton(verdict).remettre,
      horloge: () => maintenant,
      reglages: { ajournementTransitoireMs: 1, ajournementApresRemiseMs: 1 }
    });
  const rate = { ok: false, etat: "non-remis", reason: "boite-injoignable", permanent: false };

  await faireLaTournee(db, deps(1_000_000, rate));
  await faireLaTournee(db, deps(2_000_000, { ok: true, etat: "remis-au-guichet" }));
  await faireLaTournee(db, deps(3_000_000, rate));

  const types = db
    .prepare("SELECT event_type FROM delivery_events WHERE msg_id = 'R3' AND event_type LIKE 'facteur_echec%' ORDER BY id")
    .all()
    .map((e) => e.event_type);
  assert.deepEqual(
    types,
    ["facteur_echec", "facteur_echec"],
    "le MÊME motif de part et d'autre d'une remise n'est pas une série : le Facteur a su porter entre les deux"
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM facteur_attempts WHERE msg_id = 'R3' AND state = 'remise'").get().n,
    1
  );
});

test("l'horloge recule entre la prise et l'échec : `depuis` suit l'ordre d'INSERTION, jamais les estampilles", async (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "R4", sender: "a", recipient: "personne-inconnue", body: "x" });
  // ⚠️ UNE TOURNÉE LIT L'HORLOGE DEUX FOIS : une pour la prise, une pour
  // l'échec. Un saut vers l'ARRIÈRE entre les deux — la condition que
  // `docs/FACTEUR.md` (point 6) admet lui-même — clôt donc la tentative
  // COURANTE avec une estampille PLUS VIEILLE que celle de la précédente. Tout
  // classement par `finished_at_ms` désigne alors le mauvais bout de la série.
  const horlogeQuiRecule = (pourLaPrise, ensuite) => {
    let premiere = true;
    return () => {
      if (premiere) {
        premiere = false;
        return pourLaPrise;
      }
      return ensuite;
    };
  };
  const commun = { tourHouses: inventaire([]), reglages: { ajournementInacheminableMs: 1 } };
  await faireLaTournee(db, depsDeBase({ ...commun, horloge: () => 5_000_000 }));
  await faireLaTournee(db, depsDeBase({ ...commun, horloge: horlogeQuiRecule(5_000_001, 3_000_000) }));

  // La sonde doit avoir VRAIMENT produit le décor : deux tentatives closes,
  // dont la seconde estampillée AVANT la première.
  const estampilles = db
    .prepare("SELECT finished_at_ms FROM facteur_attempts WHERE msg_id = 'R4' AND state = 'echouee' ORDER BY rowid")
    .all()
    .map((a) => Number(a.finished_at_ms));
  assert.deepEqual(estampilles, [5_000_000, 3_000_000], "l'horloge a bien reculé entre les deux tentatives");

  const evenements = db
    .prepare(
      "SELECT event_type, detail_json FROM delivery_events WHERE msg_id = 'R4' AND event_type LIKE 'facteur_echec%' ORDER BY id"
    )
    .all();
  assert.equal(evenements[1].event_type, "facteur_echec_repete");
  const detail = JSON.parse(evenements[1].detail_json);
  assert.equal(detail.repetitions, 2);
  assert.equal(
    detail.depuis,
    new Date(5_000_000).toISOString(),
    "depuis = le plus vieux MEMBRE de la série, jamais la plus petite estampille (ici, la courante)"
  );
});

test("une expiration de bail rompt aussi la série : un porteur mort est une interruption", async (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "R5", sender: "a", recipient: "personne-inconnue", body: "x" });
  const reglages = reglagesDuFacteur();
  const deps = (maintenant) =>
    depsDeBase({
      tourHouses: inventaire([]),
      horloge: () => maintenant,
      reglages: { ajournementInacheminableMs: 1 }
    });

  await faireLaTournee(db, deps(1_000_000));
  // Un porteur prend la lettre et MEURT : personne ne clôt sa tentative.
  assert.ok(prendreUneLettre(db, { porteur: "porteur-mort", maintenant: 2_000_000, reglages }));
  // La tournée suivante périme son bail, puis reprend la lettre — même motif
  // qu'au premier échec, mais une interruption s'est glissée entre les deux.
  await faireLaTournee(db, deps(3_000_000));

  // La sonde doit avoir VRAIMENT produit l'interruption : sans ce bail périmé,
  // le test dirait « plein format » pour la mauvaise raison.
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM facteur_attempts WHERE msg_id = 'R5' AND state = 'expiree' AND reason = 'bail-expire'").get().n,
    1,
    "le bail du porteur mort a bien été périmé entre les deux échecs"
  );

  const evenements = db
    .prepare(
      "SELECT event_type, detail_json FROM delivery_events WHERE msg_id = 'R5' AND event_type LIKE 'facteur_echec%' ORDER BY id"
    )
    .all();
  assert.deepEqual(
    evenements.map((e) => e.event_type),
    ["facteur_echec", "facteur_echec"],
    "le même motif de part et d'autre d'un bail périmé n'est pas une série ININTERROMPUE"
  );
  assert.equal(JSON.parse(evenements[1].detail_json).repetitions, undefined, "aucun compte : la série a été rompue");
});

// REVUE ADVERSE F3 (passe adverse du 21/08) — LA COLLISION DE MOTIF, EXÉCUTÉE.
// `bail-expire` n'est pas un mot réservé : rien n'empêche un échec de livraison
// de porter ce motif-là. Le jour où ça arrive, la comparaison des motifs ne
// rompt PLUS la série au bail périmé — les deux disent la même chose — et un
// porteur MORT au milieu se compterait comme une répétition, c'est-à-dire un
// compte qui enjambe un trou qu'aucun Facteur n'a vu. Le test d'ÉTAT n'est donc
// pas une bretelle de confort : c'est LUI qui tient ce cas, et lui seul.
test("collision de motif : un échec dont le motif EST « bail-expire » ne prolonge pas la série du bail périmé (revue adverse F3)", (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "F3", sender: "a", recipient: "personne-inconnue", body: "x" });
  const reglages = reglagesDuFacteur();

  // ① Un porteur prend la lettre et MEURT : son bail se périme, `reason` vaut
  // 'bail-expire' — l'interruption.
  assert.ok(prendreUneLettre(db, { porteur: "porteur-mort", maintenant: 1_000_000, reglages }));
  perimerLesBaux(db, 1_000_000 + Number(reglages.bailMs) + 1);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM facteur_attempts WHERE msg_id='F3' AND state='expiree' AND reason='bail-expire'").get().n,
    1,
    "la sonde a VRAIMENT produit l'interruption — sans ce bail périmé elle ne prouverait rien"
  );

  // ② Le porteur suivant échoue avec un motif qui, LUI AUSSI, s'appelle
  // « bail-expire ». Les deux lignes closes portent désormais le même mot.
  const maintenant = 2_000_000;
  const prise = prendreUneLettre(db, { porteur: "porteur-2", maintenant, reglages });
  assert.ok(prise, "la lettre est reprenable après le bail périmé");
  noterLEchec(db, {
    attemptId: prise.attemptId,
    msgId: "F3",
    motif: "bail-expire",
    ajournementMs: 1,
    porteur: "porteur-2",
    maintenant
  });

  const evenements = db
    .prepare("SELECT event_type, detail_json FROM delivery_events WHERE msg_id='F3' AND event_type LIKE 'facteur_echec%' ORDER BY id")
    .all();
  assert.deepEqual(
    evenements.map((e) => e.event_type),
    ["facteur_echec"],
    "un porteur mort reste une INTERRUPTION, même quand les deux motifs se ressemblent mot pour mot"
  );
  assert.equal(JSON.parse(evenements[0].detail_json).repetitions, undefined, "aucune série : rien à compter");
});

test("une lignée ambiguë fait ATTENDRE la lettre — elle ne se joue pas aux dés", async (t) => {
  const db = bureauDePoste(t);
  const une = chaise(db, { lignee: "alice", session: "s-1", pid: 1 });
  const deux = chaise(db, { lignee: "alice", session: "s-2", pid: 2 });
  insertMessage(db, { msg_id: "L1", sender: "bob", recipient: "alice", body: "?" });

  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([une, deux]),
      remettreAuGuichet: async () => {
        throw new Error("le Facteur ne doit RIEN porter quand il ne sait pas à qui");
      }
    })
  );

  assert.equal(bilan.remises, 0);
  assert.equal(bilan.motifs["lignee-ambigue"], 1);
  assert.equal(db.prepare("SELECT carried_at FROM messages WHERE msg_id='L1'").get().carried_at, null);
  const echec = db.prepare("SELECT detail_json FROM delivery_events WHERE msg_id='L1' ORDER BY id DESC").get();
  assert.match(echec.detail_json, /lignee-ambigue/);
});

test("« ta maison m'est inconnue » n'est PAS « ta boîte dort »", async (t) => {
  const db = bureauDePoste(t);
  // Une chaise dans une maison que l'inventaire du démon ne connaît pas...
  chaise(db, { lignee: "exilee", session: "s-exil", maison: "/maison/hors-inventaire", pid: 7 });
  // ...et une chaise dans une maison servie, mais dont la boîte ne répond plus.
  chaise(db, { lignee: "endormie", session: "s-dodo", maison: "/maison/servie", pid: 8 });
  insertMessage(db, { msg_id: "L-exil", sender: "a", recipient: "exilee", body: "x" });
  insertMessage(db, { msg_id: "L-dodo", sender: "a", recipient: "endormie", body: "x" });

  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([], ["/maison/servie"]),
      remettreAuGuichet: async () => {
        throw new Error("aucune boîte à servir");
      }
    })
  );

  assert.equal(bilan.motifs["maison-inconnue"], 1, "une maison hors inventaire se DIT");
  assert.equal(bilan.motifs["boite-endormie"], 1, "une boîte endormie est une AUTRE situation");
  const motifDe = (msgId) =>
    JSON.parse(
      db.prepare("SELECT detail_json FROM delivery_events WHERE msg_id=? ORDER BY id DESC").get(msgId).detail_json
    ).motif;
  assert.equal(motifDe("L-exil"), "maison-inconnue");
  assert.equal(motifDe("L-dodo"), "boite-endormie");
});

// L'AVIS COMPLET (remède de la revue adverse #3, C1) — `attenteDeLaLettre` (registry.js) ne
// voit que TROIS motifs (ambigu, inconnu, chaise-sans-session) parce que ce
// sont les seuls que le registre seul sait trancher. Mais `trouverLaBoite`
// en rend TROIS DE PLUS, et jusqu'à ce remède `send`/`broadcast` ne les
// voyaient JAMAIS : sent:true sec, puis la vraie tournée différait la même
// lettre avec un motif que personne n'avait annoncé. `avisDAttente` rejoue
// `trouverLaBoite` lui-même (jamais une réimplémentation) pour les couvrir.
test("avisDAttente : maison-non-renseignee — une session vivante, mais AUCUNE maison au registre", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "sans-maison", sessionId: "s-vide", house: null, pid: 9 });
  insertMessage(db, { msg_id: "L-sans-maison", sender: "a", recipient: "sans-maison", body: "x" });

  const avis = avisDAttente(
    db,
    { recipient: "sans-maison" },
    { ...depsHouseScan([]), resoudre: resolveRecipient }
  );
  assert.equal(avis.motif, "maison-non-renseignee");
  // Un avis est une phrase : majuscule initiale, la page l'affiche après
  // « This letter will wait. » (18/10).
  assert.match(avis.message, /^Session \S+ has no house recorded/);
  assert.match(avis.message, /inbox/, "l'avis dit que le destinataire peut relever sa boîte lui-même");
});

test("avisDAttente : maison-inconnue — une maison que la tournée du Facteur ne connaît plus", (t) => {
  const db = bureauDePoste(t);
  chaise(db, { lignee: "exilee2", session: "s-exil2", maison: "/maison/hors-inventaire", pid: 10 });
  insertMessage(db, { msg_id: "L-exil2", sender: "a", recipient: "exilee2", body: "x" });

  const avis = avisDAttente(
    db,
    { recipient: "exilee2" },
    { ...depsHouseScan([], ["/maison/servie"]), resoudre: resolveRecipient }
  );
  assert.equal(avis.motif, "maison-inconnue");
  assert.match(avis.message, /^Session \S+ lives in a house /, "un avis est une phrase, majuscule comprise");
  assert.match(avis.message, /\/maison\/hors-inventaire/);
});

test("avisDAttente : boite-endormie — maison connue, mais aucune boîte n'y répond pour cette session", (t) => {
  const db = bureauDePoste(t);
  chaise(db, { lignee: "endormie2", session: "s-dodo2", maison: "/maison/servie", pid: 11 });
  insertMessage(db, { msg_id: "L-dodo2", sender: "a", recipient: "endormie2", body: "x" });

  const avis = avisDAttente(
    db,
    { recipient: "endormie2" },
    { ...depsHouseScan([], ["/maison/servie"]), resoudre: resolveRecipient }
  );
  assert.equal(avis.motif, "boite-endormie");
  assert.match(avis.message, /^Session \S+ is in a known house /, "un avis est une phrase, majuscule comprise");
  assert.match(avis.message, /session process is gone or asleep/);
  // I-4 (18/10) : une boîte muette ne prouve pas une session vivante.
  assert.doesNotMatch(avis.message, /live session|session vivante/i, "l'avis ne dit plus « session vivante » d'un processus parti");
});

test("avisDAttente : une chaise VRAIMENT vivante (session + maison + boîte) reste silencieuse", (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bienvivante", session: "s-ok", maison: "/maison/servie", pid: 12 });
  insertMessage(db, { msg_id: "L-ok", sender: "a", recipient: "bienvivante", body: "x" });

  const avis = avisDAttente(
    db,
    { recipient: "bienvivante" },
    { ...depsHouseScan([boite], ["/maison/servie"]), resoudre: resolveRecipient }
  );
  assert.equal(avis, null, "le silence des cas sains — jusqu'à la boîte, pas seulement jusqu'à la session");
});

test("avisDAttente : les trois motifs déjà connus (ambigu/inconnu/chaise-sans-session) passent par attenteDeLaLettre, inchangés", (t) => {
  const db = bureauDePoste(t);
  const deps = { ...depsHouseScan([]), resoudre: resolveRecipient };

  const inconnu = avisDAttente(db, { recipient: "personne-de-ce-nom" }, deps);
  assert.equal(inconnu.motif, "destinataire-inconnu");

  chaise(db, { lignee: "alice-avis", session: "s-a", maison: "/maison/servie", pid: 13 });
  chaise(db, { lignee: "alice-avis", session: "s-b", maison: "/maison/servie", pid: 14 });
  const ambigu = avisDAttente(db, { recipient: "alice-avis" }, deps);
  assert.equal(ambigu.motif, "lignee-ambigue");

  registerPeer(db, { id: "heritee-avis", status: "active" });
  const heritee = avisDAttente(db, { recipient: "heritee-avis" }, deps);
  assert.equal(heritee.motif, "chaise-sans-session");
});

test("un destinataire que personne ne porte : la lettre attend, elle ne meurt pas", async (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "fantome", body: "x" });
  const t0 = 4_000_000;
  const reglages = { ajournementInacheminableMs: 30_000 };

  const bilan = await faireLaTournee(
    db,
    depsDeBase({ tourHouses: inventaire([]), horloge: () => t0, reglages })
  );
  assert.equal(bilan.motifs["destinataire-inconnu"], 1);
  assert.equal(etatDuCourrier(db, "L1", { maintenant: t0 + 1 }), ETAT_DIFFEREE);
  assert.equal(
    etatDuCourrier(db, "L1", { maintenant: t0 + 30_001 }),
    ETAT_PRETE,
    "l'ajournement est une ÉCHÉANCE, jamais un cercueil (A9)"
  );
});

test("un échec DÉFINITIF ajourne longtemps, sans jamais rendre la lettre invisible", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  const t0 = 7_000_000;

  const guichet = guichetDeCarton({
    ok: false,
    etat: "non-remis",
    reason: "pli-trop-gros",
    permanent: true,
    detail: "999999/262144 unités"
  });
  const bilan = await faireLaTournee(
    db,
    depsDeBase({ tourHouses: inventaire([boite]), remettreAuGuichet: guichet.remettre, horloge: () => t0 })
  );

  assert.equal(bilan.motifs["pli-trop-gros"], 1);
  const detail = JSON.parse(
    db.prepare("SELECT detail_json FROM delivery_events WHERE msg_id='L1' ORDER BY id DESC").get().detail_json
  );
  assert.equal(detail.permanent, true, "l'échec définitif est VISIBLE, jamais silencieux");
  assert.ok(Number.isFinite(detail.reprise_apres_ms) && detail.reprise_apres_ms > 0);

  const echeance = db.prepare("SELECT facteur_not_before_ms FROM messages WHERE msg_id='L1'").get()
    .facteur_not_before_ms;
  assert.ok(echeance > t0, "on ne rejoue pas un échec définitif tout de suite");
  assert.ok(Number.isFinite(echeance), "mais l'échéance est FINIE : pas de quarantaine infinie");
  assert.equal(etatDuCourrier(db, "L1", { maintenant: echeance + 1 }), ETAT_PRETE);
  assert.equal(
    getPendingForContext(db, "bob").length,
    1,
    "et pendant tout ce temps, le canal de repli sert la lettre normalement"
  );
});

// ---------------------------------------------------------------------------
// LE BUREAU FERMÉ — aucune remise sans réservation durable.
// ---------------------------------------------------------------------------

test("bureau en LECTURE SEULE : aucune boîte n'est touchée", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  const fichier = db.fichier;
  db.close();

  const lectureSeule = new Database(fichier, { readonly: true });
  t.after(() => {
    try {
      lectureSeule.close();
    } catch {
      /* base jetable */
    }
  });

  let appels = 0;
  const bilan = await faireLaTournee(
    lectureSeule,
    depsDeBase({
      tourHouses: inventaire([boite]),
      remettreAuGuichet: async () => {
        appels += 1;
        return { ok: true, etat: "remis-au-guichet" };
      }
    })
  );
  assert.equal(appels, 0, "sans réservation durable, on ne dérange AUCUNE boîte");
  assert.equal(bilan.remises, 0);
  assert.equal(bilan.motifs["bureau-ferme"], 1, "et la panne se DIT");
});

test("bureau VERROUILLÉ par un autre : aucune boîte n'est touchée", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });

  const autre = new Database(db.fichier);
  autre.pragma("busy_timeout = 100");
  autre.exec("BEGIN EXCLUSIVE");
  t.after(() => {
    try {
      autre.exec("ROLLBACK");
      autre.close();
    } catch {
      /* base jetable */
    }
  });
  db.pragma("busy_timeout = 100");

  let appels = 0;
  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([boite]),
      remettreAuGuichet: async () => {
        appels += 1;
        return { ok: true, etat: "remis-au-guichet" };
      }
    })
  );
  assert.equal(appels, 0, "une base verrouillée interdit tout appel de socket");
  assert.equal(bilan.motifs["bureau-ferme"], 1);
});

// ---------------------------------------------------------------------------
// LA FAMINE — de vieux destinataires bloqués ne condamnent pas les autres.
// ---------------------------------------------------------------------------

test("N destinataires bloqués ne condamnent pas éternellement le courrier des autres", async (t) => {
  const db = bureauDePoste(t);
  const vivante = chaise(db, { lignee: "bob", session: "s-m" });
  // Trois vieilles lettres dont personne ne sait quoi faire...
  for (let i = 0; i < 3; i += 1) {
    insertMessage(db, { msg_id: `bloquee-${i}`, sender: "a", recipient: "fantome", body: "x" });
  }
  // ...puis une lettre saine, derrière elles dans la file.
  insertMessage(db, { msg_id: "saine", sender: "a", recipient: "bob", body: "x" });

  const guichet = guichetDeCarton();
  let horloge = 2_000_000;
  const deps = depsDeBase({
    tourHouses: inventaire([vivante]),
    remettreAuGuichet: guichet.remettre,
    horloge: () => horloge,
    // Les bloquées redeviennent prenables tout de suite : sans curseur, elles
    // rempliraient CHAQUE tournée et la saine n'arriverait jamais.
    reglages: { lettresParTournee: 2, ajournementInacheminableMs: 1 }
  });

  let tournees = 0;
  while (guichet.remises.length === 0 && tournees < 8) {
    await faireLaTournee(db, deps);
    tournees += 1;
    horloge += 10;
  }
  assert.equal(guichet.remises.length, 1, "la lettre saine finit par être portée");
  assert.ok(
    tournees <= 2,
    `elle doit l'être en un nombre BORNÉ de tournées (ceil((3+1)/2) = 2), pas en ${tournees}`
  );
});

// ⚠️ Le test ci-dessus place la saine DERRIÈRE les bloquées — la seule
// disposition où l'ordre correct ET l'ordre inversé réussissent. Il asserte donc
// la conclusion sans discriminer le mécanisme. Celui-ci met la saine DEVANT :
// un balayage qui remonte la file la laisse derrière, tournée après tournée.
test("la lettre saine DEVANT les bloquées part au PREMIER tour : le balayage descend la file", async (t) => {
  const db = bureauDePoste(t);
  const vivante = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "saine", sender: "a", recipient: "bob", body: "x" });
  for (let i = 0; i < 3; i += 1) {
    insertMessage(db, { msg_id: `bloquee-${i}`, sender: "a", recipient: "fantome", body: "x" });
  }

  const guichet = guichetDeCarton();
  let horloge = 2_000_000;
  const deps = depsDeBase({
    tourHouses: inventaire([vivante]),
    remettreAuGuichet: guichet.remettre,
    horloge: () => horloge,
    reglages: { lettresParTournee: 2, ajournementInacheminableMs: 1 }
  });

  let tournees = 0;
  while (guichet.remises.length === 0 && tournees < 8) {
    await faireLaTournee(db, deps);
    tournees += 1;
    horloge += 10;
  }
  assert.equal(guichet.remises.length, 1, "la lettre de tête est portée");
  assert.equal(
    tournees,
    1,
    `une lettre EN TÊTE de la file part au premier tour, pas en ${tournees} : sinon le curseur ne borne rien`
  );
});

test("un balayage prend le courrier dans l'ordre : le curseur avance, il ne remonte JAMAIS", async (t) => {
  const db = bureauDePoste(t);
  for (let i = 0; i < 5; i += 1) {
    insertMessage(db, { msg_id: `L${i}`, sender: "a", recipient: "bob", body: `n°${i}` });
  }
  const reglages = reglagesDuFacteur();
  const t0 = 3_000_000;

  // Quatre prises DANS LE MÊME balayage (cinq lettres, aucune rendue) : la
  // preuve anti-famine de la conception tient sur « chaque réservation fait
  // strictement croître le curseur ». Si elle n'est pas assertée, elle n'est
  // pas tenue.
  const seqs = [];
  const curseurs = [];
  for (let i = 0; i < 4; i += 1) {
    const prise = prendreUneLettre(db, { porteur: `porteur-${i}`, maintenant: t0, reglages });
    assert.ok(prise, "il reste du courrier prenable");
    seqs.push(Number(prise.lettre.seq));
    curseurs.push(Number(db.prepare("SELECT cursor_seq FROM facteur_sweep WHERE singleton=1").get().cursor_seq));
  }
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] > seqs[i - 1], `la prise n°${i + 1} descend la file : ${seqs[i]} après ${seqs[i - 1]}`);
    assert.ok(
      curseurs[i] > curseurs[i - 1],
      `et le curseur croît STRICTEMENT : ${curseurs[i]} après ${curseurs[i - 1]}`
    );
  }
});

// ---------------------------------------------------------------------------
// LE SECRET DES AUTRES — on porte le courrier des autres, on n'en répète
// rien (remède de la revue adverse #3, cinquième copie du même overclaim que FACTEUR.md:7 —
// le contrôle positif ci-dessous PROUVE que le Facteur lit le corps pour
// plier l'enveloppe ; ce que ces tests vérifient, c'est qu'il ne le RÉPÈTE
// nulle part, jamais qu'il ne le lit pas).
// ---------------------------------------------------------------------------

test("le journal ne contient JAMAIS le corps d'une lettre, quel que soit le chemin", async (t) => {
  const db = bureauDePoste(t);
  const CANARI = "SECRET-INTIME-42";
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  chaise(db, { lignee: "alice", session: "f-1", pid: 1 });
  chaise(db, { lignee: "alice", session: "f-2", pid: 2 });

  insertMessage(db, { msg_id: "L-ok", sender: "a", recipient: "bob", subject: CANARI, body: CANARI });
  insertMessage(db, { msg_id: "L-echec", sender: "a", recipient: "bob", body: `${CANARI}-echec` });
  insertMessage(db, { msg_id: "L-ambigu", sender: "a", recipient: "alice", body: `${CANARI}-ambigu` });
  insertMessage(db, { msg_id: "L-perdu", sender: "a", recipient: "fantome", body: `${CANARI}-perdu` });

  const journal = [];
  let appels = 0;
  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([boite]),
      journal: (ligne) => journal.push(ligne),
      remettreAuGuichet: async (arg) => {
        appels += 1;
        // Contrôle positif : le canari EST dans le pli qu'on porte. Si ce test
        // ne le voyait nulle part, il ne prouverait rien.
        if (appels === 1) assert.ok(arg.envelope.message.content.includes(CANARI));
        return appels === 1
          ? { ok: true, etat: "remis-au-guichet" }
          : { ok: false, etat: "non-remis", reason: "depot-refuse", permanent: false };
      }
    })
  );
  assert.ok(bilan.prises >= 3);

  const journalTexte = JSON.stringify(journal);
  assert.ok(!journalTexte.includes(CANARI), "le journal du Facteur ne répète pas le courrier qu'il a dû lire pour le porter");
  const evenements = JSON.stringify(db.prepare("SELECT * FROM delivery_events").all());
  assert.ok(!evenements.includes(CANARI), "les événements du bureau non plus");
  const tentatives = JSON.stringify(db.prepare("SELECT * FROM facteur_attempts").all());
  assert.ok(!tentatives.includes(CANARI), "et la table des tentatives ne garde ni corps ni objet");
});

test("le pli porte le reçu de la tentative, et jamais le jeton de la boîte", async (t) => {
  const lettre = { msg_id: "L1", sender: "alice", subject: "un objet", body: "un corps" };
  const pli = plierLaLettre(lettre, { attemptId: "recu-1234" });
  assert.match(pli, /^Letter L1 · from alice · subject: un objet$/m);
  assert.match(pli, /^Receipt: recu-1234$/m);
  assert.match(
    pli,
    /^— Acknowledge letter L1 with the `ack` tool; until it is acknowledged the Facteur will bring it back\.$/m,
    "la ligne du Facteur, mot pour mot (T4b-b : le Messenger parle anglais)"
  );
  assert.match(pli, /un corps/);
  assert.match(pli, /ack/, "le destinataire doit savoir comment accuser");
});

// ---------------------------------------------------------------------------
// L'INCARNATION — la lettre va à la chaise qu'on a VISÉE.
// ---------------------------------------------------------------------------

test("session remplacée entre deux tournées : l'enveloppe garde la cible visée, la suivante va à la neuve", async (t) => {
  const db = bureauDePoste(t);
  const ancienne = chaise(db, { lignee: "bob", session: "s-1", maison: "/maison/m", pid: 1 });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });

  const guichet = guichetDeCarton();
  let horloge = 6_000_000;
  await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([ancienne]),
      remettreAuGuichet: guichet.remettre,
      horloge: () => horloge
    })
  );
  assert.equal(guichet.remises[0].envelope.session_id, "s-1");
  const tentative = db.prepare("SELECT * FROM facteur_attempts WHERE msg_id='L1'").get();
  assert.equal(tentative.target_session_id, "s-1", "la cible visée reste écrite, durablement");

  // La chaise change de main : l'ancienne se retire, une neuve s'assied.
  db.prepare("UPDATE peers SET status='offline' WHERE instance_session_id='s-1'").run();
  const neuve = chaise(db, { lignee: "bob", session: "s-2", maison: "/maison/m", pid: 2 });

  horloge += REGLAGES_FACTEUR_PAR_DEFAUT.ajournementApresRemiseMs + 1;
  await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([neuve]),
      remettreAuGuichet: guichet.remettre,
      horloge: () => horloge
    })
  );
  assert.equal(guichet.remises.length, 2, "sans accusé, la lettre repart (A9)");
  assert.equal(
    guichet.remises[1].envelope.session_id,
    "s-2",
    "et elle repart vers la chaise COURANTE, jamais vers un fantôme"
  );
});

// ---------------------------------------------------------------------------
// LE RYTHME — au compte-gouttes, et jamais en dur.
// ---------------------------------------------------------------------------

test("le Facteur porte au compte-gouttes : une pause entre deux remises, venue de la configuration", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  insertMessage(db, { msg_id: "L2", sender: "a", recipient: "bob", body: "y" });

  const pauses = [];
  const guichet = guichetDeCarton();
  await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([boite]),
      remettreAuGuichet: guichet.remettre,
      dormir: async (ms) => pauses.push(ms),
      reglages: { pauseEntreRemisesMs: 1234 }
    })
  );
  assert.equal(guichet.remises.length, 2);
  assert.deepEqual(pauses, [1234, 1234], "le compte-gouttes est un RÉGLAGE, jamais un nombre en dur");
});

test("le compte-gouttes coule AUSSI sur le chemin de l'échec : un portier compte des TENTATIVES", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  for (let i = 0; i < 4; i += 1) {
    insertMessage(db, { msg_id: `L${i}`, sender: "a", recipient: "bob", body: `n°${i}` });
  }

  // ⚠️ L'horloge n'avance QUE par le sommeil : ce que ce banc mesure est donc
  // exactement ce que la pause a fait attendre, jamais la vitesse de la machine.
  let horloge = 1_000_000;
  const depots = [];
  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([boite]),
      horloge: () => horloge,
      dormir: async (ms) => {
        horloge += Number(ms);
      },
      reglages: { pauseEntreRemisesMs: 2_000, lettresParTournee: 4 },
      // QUE des échecs — c'est précisément le verdict qu'un portier saturé rend,
      // et donc le chemin qu'une rafale emprunte quand la pause n'y coule pas.
      remettreAuGuichet: async () => {
        depots.push(horloge);
        return { ok: false, etat: "non-remis", reason: "depot-refuse", permanent: false };
      }
    })
  );

  assert.equal(bilan.remises, 0, "aucune remise : ce banc ne parle que d'échecs");
  assert.equal(depots.length, 4, "les quatre lettres ont bien été présentées au guichet");
  for (let i = 1; i < depots.length; i += 1) {
    const ecart = depots[i] - depots[i - 1];
    assert.ok(
      ecart >= 2_000,
      `le portier doit souffler entre deux tentatives : écart de ${ecart} ms au dépôt n°${i + 1}`
    );
  }
});

// ---------------------------------------------------------------------------
// L'ARRIÉRÉ — A8 promet un doublon, jamais une avalanche. Un compagnon qui
// reçoit mille rappels en une heure ne peut plus travailler.
// ---------------------------------------------------------------------------

test("une lettre jamais accusée S'ÉLOIGNE à chaque repassage, sans jamais devenir infinie", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });

  const guichet = guichetDeCarton();
  let horloge = 1_000_000;
  const deps = depsDeBase({
    tourHouses: inventaire([boite]),
    remettreAuGuichet: guichet.remettre,
    horloge: () => horloge,
    reglages: { ajournementApresRemiseMs: 600_000, ajournementMaximalMs: 3_600_000 }
  });

  const attentes = [];
  for (let passage = 0; passage < 5; passage += 1) {
    await faireLaTournee(db, deps);
    const echeance = Number(
      db.prepare("SELECT facteur_not_before_ms FROM messages WHERE msg_id='L1'").get().facteur_not_before_ms
    );
    attentes.push(echeance - horloge);
    assert.ok(Number.isFinite(echeance), "une échéance infinie serait une quarantaine, et A9 l'interdit");
    assert.equal(
      etatDuCourrier(db, "L1", { maintenant: echeance + 1 }),
      ETAT_PRETE,
      "l'échéance passée, la lettre est de nouveau DUE — quel que soit le nombre de repassages"
    );
    horloge = echeance + 1; // on attend pile ce que le Facteur a demandé
  }

  assert.equal(guichet.remises.length, 5, "sans accusé, la lettre revient TOUJOURS (A9)");
  assert.deepEqual(
    attentes,
    [600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000],
    "l'attente DOUBLE à chaque tentative infructueuse, puis se pose sur son plafond et n'en bouge plus"
  );
});

test("une boîte qui a reçu son plafond n'est plus dérangée — et ses lettres restent DUES", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  for (let i = 0; i < 8; i += 1) {
    insertMessage(db, { msg_id: `L${i}`, sender: "a", recipient: "bob", body: `n°${i}` });
  }

  const guichet = guichetDeCarton();
  const journal = [];
  let horloge = 2_000_000;
  const deps = depsDeBase({
    tourHouses: inventaire([boite]),
    remettreAuGuichet: guichet.remettre,
    horloge: () => horloge,
    journal: (ligne) => journal.push(ligne),
    reglages: { plafondParBoite: 3, fenetreDuPlafondMs: 600_000, lettresParTournee: 8 }
  });

  await faireLaTournee(db, deps);
  assert.equal(guichet.remises.length, 3, "au-delà de son plafond, la boîte n'est PLUS dérangée");

  const silence = journal.find((ligne) => ligne.evenement === "facteur_plafond_boite");
  assert.ok(silence, "le silence d'une boîte se JOURNALISE — un Facteur muet sans un mot est un Facteur mort");
  assert.equal(silence.lettres_en_attente, 8, "et il écrit COMBIEN de lettres attendent, au lieu de les porter une à une");
  assert.equal(silence.lettres_ajournees, 4, "les quatre lettres encore intouchées sont ajournées d'un seul geste");

  const restantes = db
    .prepare("SELECT msg_id, carried_at, acked_at, facteur_not_before_ms FROM messages WHERE carried_at IS NULL")
    .all();
  assert.equal(restantes.length, 5, "cinq lettres n'ont pas été portées");
  for (const lettre of restantes) {
    assert.equal(lettre.carried_at, null, "une lettre qu'on n'a pas portée ne se marque PAS");
    assert.equal(lettre.acked_at, null, "et personne ne l'a accusée à la place du destinataire");
    assert.ok(
      Number(lettre.facteur_not_before_ms) > horloge,
      "elle attend la fin de la fenêtre, elle n'est ni perdue ni servie"
    );
    assert.equal(
      etatDuCourrier(db, lettre.msg_id, { maintenant: Number(lettre.facteur_not_before_ms) + 1 }),
      ETAT_PRETE,
      "le silence est BORNÉ : passée la fenêtre, la lettre est de nouveau DUE"
    );
  }

  // La fenêtre passée, le Facteur reparle à cette boîte : borné, jamais définitif.
  horloge = Number(silence.silence_jusqua_ms) + 1;
  await faireLaTournee(db, deps);
  assert.equal(guichet.remises.length, 6, "la fenêtre suivante rouvre le guichet de cette boîte");
});

test("une tournée ne prend jamais plus de lettres que son réglage", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  for (let i = 0; i < 7; i += 1) {
    insertMessage(db, { msg_id: `L${i}`, sender: "a", recipient: "bob", body: `n°${i}` });
  }
  const guichet = guichetDeCarton();
  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([boite]),
      remettreAuGuichet: guichet.remettre,
      reglages: { lettresParTournee: 3 }
    })
  );
  assert.equal(bilan.prises, 3);
  assert.equal(guichet.remises.length, 3);
});

// ---------------------------------------------------------------------------
// LE MODE UNE-LETTRE — porter CELLE-CI, et rien d'autre.
//
// ⚠️ Le défaut le plus grave que ce mode puisse avoir n'est pas de rater sa
// lettre : c'est de se rabattre en silence sur « alors je prends tout ». Un
// Facteur lancé à côté de vraies boîtes porterait alors du courrier réel que
// personne n'a demandé.
// ---------------------------------------------------------------------------

test("le mode UNE-LETTRE ne prend QUE la lettre demandée, alors que trois sont dues", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  for (const nom of ["L1", "L2", "L3"]) {
    insertMessage(db, { msg_id: nom, sender: "a", recipient: "bob", body: `corps de ${nom}` });
  }

  const guichet = guichetDeCarton();
  // L2 est au MILIEU de la file : sans filtre, le balayage prendrait L1 d'abord.
  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([boite]),
      remettreAuGuichet: guichet.remettre,
      seulementLaLettre: "L2"
    })
  );

  assert.equal(bilan.prises, 1, "une tournée filtrée ne prend RIEN d'autre");
  assert.deepEqual(
    guichet.remises.map((r) => r.envelope.msg_id),
    ["L2"],
    "une seule lettre est présentée au guichet, et c'est celle qu'on a nommée"
  );
  // Les deux autres n'ont pas bougé d'un cheveu : ni tentative, ni marque, ni
  // ajournement. Le courrier qu'on n'a pas demandé n'est pas TOUCHÉ.
  for (const autre of ["L1", "L3"]) {
    const ligne = db.prepare("SELECT * FROM messages WHERE msg_id = ?").get(autre);
    assert.equal(ligne.carried_at, null, `${autre} n'a pas été portée`);
    assert.equal(Number(ligne.facteur_not_before_ms), 0, `${autre} n'a même pas été ajournée`);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM facteur_attempts WHERE msg_id = ?").get(autre).n,
      0,
      `aucune tentative n'existe sur ${autre}`
    );
  }
});

test("la lettre filtrée est portée NORMALEMENT : réservation, compte-gouttes, marquage", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m", token: "jeton-de-la-boite" });
  for (const nom of ["L1", "L2", "L3"]) {
    insertMessage(db, { msg_id: nom, sender: "alice", recipient: "bob", body: `corps de ${nom}` });
  }

  const pauses = [];
  const guichet = guichetDeCarton();
  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([boite]),
      remettreAuGuichet: guichet.remettre,
      dormir: async (ms) => pauses.push(ms),
      reglages: { pauseEntreRemisesMs: 1234 },
      seulementLaLettre: "L2"
    })
  );

  assert.equal(bilan.remises, 1);
  // La réservation : une tentative, close en « remise », liée à la boîte visée.
  const tentative = db.prepare("SELECT * FROM facteur_attempts WHERE msg_id = 'L2'").get();
  assert.equal(tentative.state, "remise", "le filtre ne casse pas la réservation");
  assert.equal(tentative.target_session_id, "s-m", "ni la liaison au quadruplet visé");
  // Le pli : le reçu de CETTE tentative, et le jeton de la boîte au transport.
  assert.equal(guichet.remises[0].token, "jeton-de-la-boite");
  assert.ok(guichet.remises[0].envelope.message.content.includes(`Receipt: ${tentative.attempt_id}`));
  // Le compte-gouttes : la pause suit la tentative de dépôt, filtre ou pas.
  assert.deepEqual(pauses, [1234], "le compte-gouttes coule aussi en mode une-lettre");
  // Le marquage : remise au guichet, jamais « livrée », jamais « accusée ».
  const ligne = db.prepare("SELECT * FROM messages WHERE msg_id = 'L2'").get();
  assert.ok(ligne.carried_at, "la lettre filtrée est marquée REMISE AU GUICHET");
  assert.equal(ligne.delivered_at, null, "le Facteur ne pose JAMAIS delivered_at (A1)");
  assert.equal(ligne.acked_at, null);
  assert.ok(Number(ligne.facteur_not_before_ms) > 0, "et elle s'éloigne comme n'importe quelle autre");
  const evenements = db
    .prepare("SELECT event_type FROM delivery_events WHERE msg_id='L2' ORDER BY id")
    .all()
    .map((e) => e.event_type);
  assert.deepEqual(evenements, ["created", "facteur_reservee", "facteur_remis"]);
});

test("un identifiant qui ne correspond à rien ne porte RIEN, et il le DIT", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  for (const nom of ["L1", "L2", "L3"]) {
    insertMessage(db, { msg_id: nom, sender: "a", recipient: "bob", body: `corps de ${nom}` });
  }

  const lignes = [];
  const guichet = guichetDeCarton();
  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([boite]),
      remettreAuGuichet: guichet.remettre,
      journal: (ligne) => lignes.push(ligne),
      seulementLaLettre: "L-QUI-N-EXISTE-PAS"
    })
  );

  assert.equal(bilan.prises, 0, "⚠️ jamais de repli silencieux sur « alors je prends tout »");
  assert.equal(guichet.remises.length, 0, "AUCUNE boîte n'est touchée");
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM facteur_attempts").get().n,
    0,
    "et aucune lettre n'est même réservée"
  );
  for (const nom of ["L1", "L2", "L3"]) {
    const ligne = db.prepare("SELECT * FROM messages WHERE msg_id = ?").get(nom);
    assert.equal(ligne.carried_at, null);
    assert.equal(Number(ligne.facteur_not_before_ms), 0);
  }
  // « Le dire » : dans le bilan ET dans le journal — un mode qui ne porte rien
  // sans un mot est indiscernable d'un bureau vide.
  assert.equal(bilan.motifs["lettre-introuvable"], 1, "le bilan NOMME l'introuvable");
  const dit = lignes.find((l) => l.evenement === "facteur_lettre_non_prise");
  assert.ok(dit, "le journal dit que la lettre demandée n'a pas été prise");
  assert.equal(dit.msg_id, "L-QUI-N-EXISTE-PAS");
  assert.equal(dit.etat, null, "une lettre inconnue n'a aucun état à montrer");
});

test("une lettre connue mais pas PRÊTE ne se force pas : rien n'est porté, et l'état se dit", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  db.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = 'L1'").run(new Date().toISOString());

  const lignes = [];
  const guichet = guichetDeCarton();
  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([boite]),
      remettreAuGuichet: guichet.remettre,
      journal: (ligne) => lignes.push(ligne),
      seulementLaLettre: "L1"
    })
  );

  assert.equal(bilan.prises, 0);
  assert.equal(guichet.remises.length, 0, "une lettre accusée ne repart JAMAIS, filtre ou pas");
  assert.equal(bilan.motifs["lettre-non-prise"], 1);
  const dit = lignes.find((l) => l.evenement === "facteur_lettre_non_prise");
  assert.equal(dit.etat, ETAT_ACCUSEE, "l'état se DIT, il ne se devine pas");
});

test("les réglages par défaut sont prudents, et un bail trop court se refuse AU DÉMARRAGE", () => {
  const defauts = reglagesDuFacteur({});
  verifierLesReglages(defauts); // ne lève pas
  assert.ok(
    defauts.bailMs > defauts.delaiDeRemiseMs + defauts.delaiDeFermetureMs + 5_000,
    "le bail doit couvrir le dépôt le plus long, plus une marge"
  );
  assert.ok(defauts.pauseEntreRemisesMs >= 2_000, "le compte-gouttes par défaut est lent");
  assert.ok(defauts.lettresParTournee >= 1);
  for (const clef of [
    "ajournementApresRemiseMs",
    "ajournementTransitoireMs",
    "ajournementInacheminableMs",
    "ajournementEchecDefinitifMs"
  ]) {
    assert.ok(Number.isFinite(defauts[clef]) && defauts[clef] > 0, `${clef} doit être fini et positif`);
  }

  assert.throws(
    () => verifierLesReglages({ ...defauts, bailMs: 5_000 }),
    /the lease/,
    "un bail plus court que le dépôt ferait reprendre la lettre pendant qu'on l'écrit"
  );
  assert.throws(() => verifierLesReglages({ ...defauts, ajournementTransitoireMs: 0 }), /FINITE/);
  assert.throws(() => verifierLesReglages({ ...defauts, lettresParTournee: 0 }), /lettresParTournee/);

  // Le plafond de croissance et le plafond de politesse : deux seuils qui
  // décident si A9 reste un filet ou devient une avalanche.
  assert.ok(
    defauts.ajournementMaximalMs >= defauts.ajournementEchecDefinitifMs,
    "un « maximum » plus court que l'ajournement qu'il borne RACCOURCIRAIT les attentes"
  );
  assert.ok(defauts.plafondParBoite >= 1, "une boîte doit pouvoir recevoir au moins une lettre par fenêtre");
  assert.ok(defauts.fenetreDuPlafondMs > 0);
  assert.throws(() => verifierLesReglages({ ...defauts, ajournementMaximalMs: 0 }), /ajournementMaximalMs/);
  assert.throws(
    () => verifierLesReglages({ ...defauts, ajournementMaximalMs: 1_000 }),
    /cannot be shorter than/,
    "un plafond sous les ajournements qu'il borne accélérerait les repassages au lieu de les espacer"
  );
  assert.throws(
    () => verifierLesReglages({ ...defauts, plafondParBoite: 0 }),
    /plafondParBoite/,
    "un plafond à zéro rendrait une boîte muette POUR TOUJOURS — un silence sans retour, donc A9 mort"
  );
  assert.throws(() => verifierLesReglages({ ...defauts, fenetreDuPlafondMs: 0 }), /fenetreDuPlafondMs/);
});

test("un réglage se lit dans l'environnement, jamais dans le code", () => {
  const regle = reglagesDuFacteur({ CC2CC_FACTEUR_PAUSE_MS: "42", CC2CC_FACTEUR_BAIL_MS: "20000" });
  assert.equal(regle.pauseEntreRemisesMs, 42);
  assert.equal(regle.bailMs, 20_000);
  assert.equal(regle.lettresParTournee, REGLAGES_FACTEUR_PAR_DEFAUT.lettresParTournee);

  const rythme = reglagesDuFacteur({
    CC2CC_FACTEUR_AJOURNEMENT_MAX_MS: "7000",
    CC2CC_FACTEUR_PLAFOND_PAR_BOITE: "3",
    CC2CC_FACTEUR_FENETRE_PLAFOND_MS: "9000"
  });
  assert.equal(rythme.ajournementMaximalMs, 7_000);
  assert.equal(rythme.plafondParBoite, 3);
  assert.equal(rythme.fenetreDuPlafondMs, 9_000);
});

test("le bail couvre un dépôt qui consomme tout son délai et sa fermeture", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-m" });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });

  const defauts = reglagesDuFacteur({});
  let horloge = 8_000_000;
  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([boite]),
      horloge: () => horloge,
      remettreAuGuichet: async () => {
        // Le dépôt le plus lent que la configuration autorise.
        horloge += defauts.delaiDeRemiseMs + defauts.delaiDeFermetureMs;
        return { ok: true, etat: "remis-au-guichet" };
      }
    })
  );
  assert.equal(bilan.remises, 1, "le porteur doit posséder encore sa tentative au moment du verdict");
  assert.ok(db.prepare("SELECT carried_at FROM messages WHERE msg_id='L1'").get().carried_at);
});

// ---------------------------------------------------------------------------
// L'INVENTAIRE DES MAISONS — une donnée, pas une évidence (A4).
// ---------------------------------------------------------------------------

test("l'inventaire des maisons se déclare, et à défaut il est nommé", () => {
  const declare = maisonsConnues({ env: { CC2CC_MAISONS: "/a:/b" }, home: "/chez-nous" });
  assert.deepEqual(declare, ["/a", "/b"]);
  const defaut = maisonsConnues({ env: {}, home: "/chez-nous" });
  assert.equal(defaut.length, MAISONS_PAR_DEFAUT.length);
  assert.ok(defaut.every((maison) => maison.startsWith("/chez-nous/")));
});

// LE DÉFAUT NE CONNAÎT QUE `.claude` (18/10). Il listait six maisons : celles
// de la machine des auteurs, publiées comme si chaque installation les avait.
// Une machine ne connaît par défaut que `~/.claude`, plus la maison que le
// lanceur désigne (`CLAUDE_CONFIG_DIR`) quand elle en est une autre ; le reste
// se déclare (`VALXOS_MAISONS`, alias `CC2CC_MAISONS`), et une déclaration
// remplace le défaut entier, comme avant.
const CAS_DES_MAISONS = [
  ["rien de posé", {}, ["/chez-nous/.claude"]],
  ["une maison désignée ailleurs", { CLAUDE_CONFIG_DIR: "/ailleurs/cfg" }, ["/chez-nous/.claude", "/ailleurs/cfg"]],
  ["la maison désignée EST ~/.claude", { CLAUDE_CONFIG_DIR: "/chez-nous/.claude" }, ["/chez-nous/.claude"]],
  ["la même, avec sa barre finale", { CLAUDE_CONFIG_DIR: "/chez-nous/.claude/" }, ["/chez-nous/.claude"]],
  ["une désignation vide", { CLAUDE_CONFIG_DIR: "" }, ["/chez-nous/.claude"]],
  ["une déclaration remplace tout", { VALXOS_MAISONS: "/a:/b", CLAUDE_CONFIG_DIR: "/ailleurs/cfg" }, ["/a", "/b"]],
  ["l'alias historique de la déclaration", { CC2CC_MAISONS: "/c" }, ["/c"]]
];

test("le défaut des maisons est `.claude`, plus la maison désignée si elle est autre — le reste se déclare", () => {
  assert.deepEqual(MAISONS_PAR_DEFAUT, [".claude"]);
  for (const [cas, env, attendu] of CAS_DES_MAISONS) {
    assert.deepEqual(maisonsConnues({ env: { HOME: "/chez-nous", ...env } }), attendu, cas);
  }
});

test("le moniteur Python connaît les MÊMES maisons que le Node, cas par cas (HOUSES_DEFAULT = MAISONS_PAR_DEFAUT)", () => {
  const moniteur = path.join(RACINE, "src/monitor/valxos_monitor.py");
  const charger =
    "import importlib.util,sys,json; " +
    `s=importlib.util.spec_from_file_location('m',${JSON.stringify(moniteur)}); ` +
    "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);";
  const defaut = spawnSync("python3", ["-B", "-c", `${charger}print(json.dumps(m.HOUSES_DEFAULT))`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: "/chez-nous" }
  });
  assert.equal(defaut.status, 0, `SONDE IMPOSSIBLE : le moniteur ne se charge pas\n${defaut.stderr}`);
  assert.deepEqual(JSON.parse(defaut.stdout), MAISONS_PAR_DEFAUT, "HOUSES_DEFAULT est MAISONS_PAR_DEFAUT");
  for (const [cas, env] of CAS_DES_MAISONS) {
    const py = spawnSync("python3", ["-B", "-c", `${charger}print(json.dumps([str(h) for h in m.known_houses()]))`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/chez-nous", ...env }
    });
    assert.equal(py.status, 0, `${cas} : SONDE IMPOSSIBLE\n${py.stderr}`);
    assert.deepEqual(JSON.parse(py.stdout), maisonsConnues({ env: { HOME: "/chez-nous", ...env } }), cas);
  }
});

// ---------------------------------------------------------------------------
// LE DÉMON — un seul Facteur en tournée, et un verrou qui ne survit pas à son
// porteur.
// ---------------------------------------------------------------------------

test("un seul Facteur part en tournée : le second refuse", async (t) => {
  tempHome();
  const verrou = path.join(decorJetable("cc2cc-facteur-verrou-"), "facteur.verrou");
  const premier = prendreLeVerrou(verrou);
  assert.ok(premier, "le premier prend le verrou");
  assert.equal(prendreLeVerrou(verrou, { pid: 999_999 }), null, "le second refuse de partir");
  assert.ok(premier.relacher());
  assert.ok(prendreLeVerrou(verrou, { pid: 999_999 }), "le verrou relâché se reprend");
});

test("le verrou d'un Facteur MORT se reprend — sinon le courrier n'aurait plus de porteur", async (t) => {
  tempHome();
  const verrou = path.join(decorJetable("cc2cc-facteur-verrou-"), "facteur.verrou");
  fs.writeFileSync(verrou, JSON.stringify({ pid: 424_242, depuis: "2026-08-13T00:00:00.000Z" }));
  const repris = prendreLeVerrou(verrou, { pid: 7, estVivant: () => false });
  assert.ok(repris, "un verrou tenu par un mort n'est pas un verrou");
  assert.equal(lireLePid(verrou), 7);
});

function lireLePid(chemin) {
  return Number(JSON.parse(fs.readFileSync(chemin, "utf8")).pid);
}

test("un NUMÉRO DE PROCESSUS RECYCLÉ ne fige pas le Facteur : le verrou porte aussi l'heure de naissance", async (t) => {
  tempHome();
  const verrou = path.join(decorJetable("cc2cc-facteur-verrou-"), "facteur.verrou");
  const NAISSANCE_DU_FACTEUR = "Thu Aug 13 08:00:00 2026";
  const NAISSANCE_DE_LINCONNU = "Thu Aug 13 11:30:00 2026";
  const poser = () =>
    fs.writeFileSync(
      verrou,
      JSON.stringify({ pid: 4242, proc_start: NAISSANCE_DU_FACTEUR, depuis: "2026-08-13T08:00:00.000Z" })
    );

  // Le numéro 4242 est VIVANT — mais c'est un autre programme : il est né trois
  // heures après le Facteur qui a posé ce verrou. Sans l'heure de naissance, le
  // courrier s'arrêterait là POUR TOUJOURS.
  poser();
  const repris = prendreLeVerrou(verrou, {
    pid: 7,
    estVivant: () => true,
    heureDeDemarrage: (pid) => (Number(pid) === 4242 ? NAISSANCE_DE_LINCONNU : "Thu Aug 13 12:00:00 2026")
  });
  assert.ok(repris, "un numéro recyclé n'est pas le Facteur d'hier : le verrou se reprend");
  assert.equal(lireLePid(verrou), 7);
  assert.equal(
    lireLeVerrou(verrou).proc_start,
    "Thu Aug 13 12:00:00 2026",
    "et le verrou neuf inscrit SA propre heure de naissance, sinon le remède ne survit pas au premier tour"
  );

  // Contrôle positif : MÊME numéro, MÊME naissance = le vrai tenant. On ne vole pas.
  poser();
  assert.equal(
    prendreLeVerrou(verrou, {
      pid: 7,
      estVivant: () => true,
      heureDeDemarrage: () => NAISSANCE_DU_FACTEUR
    }),
    null,
    "deux Facteurs en tournée, c'est du travail en double : le tenant vivant garde son verrou"
  );

  // Le doute profite au tenant : un verrou d'avant ce remède (sans heure) ne se
  // vole pas sur une supposition.
  fs.writeFileSync(verrou, JSON.stringify({ pid: 4242, depuis: "2026-08-13T08:00:00.000Z" }));
  assert.equal(
    prendreLeVerrou(verrou, { pid: 7, estVivant: () => true, heureDeDemarrage: () => "peu importe" }),
    null,
    "sans heure inscrite, on ne peut RIEN prouver — et on ne vole pas sur un doute"
  );
});

// ---------------------------------------------------------------------------
// LA COURSE DU VERROU — trois Facteurs lancés ensemble, un seul part.
//
// ⚠️ Le défaut mesuré (6 essais sur 6, deux partis à chaque fois) : le verrou
// naissait VIDE. Le fichier était créé en exclusif PUIS écrit ; entre les deux
// il existait et ne contenait rien, et un concurrent qui lit un verrou vide
// conclut « personne » — donc efface le verrou du tenant pour poser le sien.
// Deux remèdes, deux volets ici : le verrou naît COMPLET (contenu écrit avant
// d'exister sous son nom définitif), et un verrou illisible n'est JAMAIS lu
// comme une place libre.
// ---------------------------------------------------------------------------

const PORTEUR_DE_VERROU = `
import fs from "node:fs";
const [verrou, sortie, top] = process.argv.slice(2);
const { prendreLeVerrou } = await import("${RACINE}/src/facteur/daemon.js");
// Le rendez-vous : les trois Facteurs poussent la porte à la MÊME milliseconde.
// (Et prendreLeVerrou appelle /bin/ps juste avant de poser — ce qui les colle
// pile sur la fenêtre qu'on veut fermer.)
while (Date.now() < Number(top)) { /* on s'aligne */ }
const jeton = prendreLeVerrou(verrou);
fs.writeFileSync(sortie, JSON.stringify({ parti: Boolean(jeton), pid: process.pid }));
// On reste VIVANT le temps que les concurrents nous voient vivants : un tenant
// qui meurt trop tôt rendrait son verrou légitimement reprenable, et le banc
// mesurerait autre chose que la course.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
`;

test("un verrou VIDE n'est jamais une place libre — et trois Facteurs lancés ensemble, un seul part", async (t) => {
  const racine = tempHome();

  // ── Volet 1 : la course. Trois porteurs RÉELS, en même temps.
  const script = ecrireLePorteur("porteur-de-verrou", PORTEUR_DE_VERROU);
  const dir = decorJetable("cc2cc-facteur-course-");
  const verrouCourse = path.join(dir, "facteur.verrou");
  const sorties = ["un", "deux", "trois"].map((n) => path.join(dir, `${n}.json`));
  const top = Date.now() + 900; // le temps que les TROIS processus soient nés
  const enfants = await porteursEnMemeTemps(
    script,
    sorties.map((sortie) => [verrouCourse, sortie, String(top)]),
    { CC2CC_V2_HOME: racine }
  );
  for (const enfant of enfants) {
    assert.equal(enfant.status, 0, `un Facteur a échoué : ${enfant.stderr}`);
  }
  const verdicts = sorties.map((s) => JSON.parse(fs.readFileSync(s, "utf8")));
  const partis = verdicts.filter((v) => v.parti);
  assert.equal(
    partis.length,
    1,
    `un seul Facteur peut partir en tournée, ${partis.length} sont partis (${JSON.stringify(verdicts)})`
  );
  assert.equal(lireLePid(verrouCourse), partis[0].pid, "et le verrou au sol porte le nom de celui qui est parti");

  // ── Volet 2 : le verrou vide, posé à la main. Exactement ce que « créer puis
  // écrire » laissait voir à un concurrent.
  const verrouVide = path.join(decorJetable("cc2cc-facteur-verrou-"), "facteur.verrou");
  fs.writeFileSync(verrouVide, "");
  assert.equal(
    prendreLeVerrou(verrouVide, { pid: 7, estVivant: () => true, heureDeDemarrage: () => "Thu Aug 13 12:00:00 2026" }),
    null,
    "un verrou qu'on ne sait pas LIRE n'est pas un verrou ABSENT : on ne le vole pas"
  );
  assert.equal(fs.readFileSync(verrouVide, "utf8"), "", "et le verrou du tenant n'a même pas été effacé");
});

test("un verrou TRONQUÉ ne se vole pas davantage : un demi-JSON ne dit pas « personne »", () => {
  tempHome();
  const verrou = path.join(decorJetable("cc2cc-facteur-verrou-"), "facteur.verrou");
  const moitie = '{"pid":4242,"proc_st';
  fs.writeFileSync(verrou, moitie);
  assert.equal(
    prendreLeVerrou(verrou, { pid: 7, estVivant: () => true, heureDeDemarrage: () => "Thu Aug 13 12:00:00 2026" }),
    null,
    "une écriture surprise en plein vol laisse un tenant, pas une place libre"
  );
  assert.equal(fs.readFileSync(verrou, "utf8"), moitie, "et son verrou reste au sol, intact");
});

test("contrôle positif : un verrou COMPLET dont le porteur est mort reste reprenable", () => {
  tempHome();
  const verrou = path.join(decorJetable("cc2cc-facteur-verrou-"), "facteur.verrou");
  // Complet, lisible, et son porteur n'est plus : le remède du numéro recyclé ne
  // doit pas être cassé par la prudence qu'on vient d'ajouter — sinon un Facteur
  // tué par un couperet laisserait le courrier sans porteur POUR TOUJOURS.
  fs.writeFileSync(
    verrou,
    `${JSON.stringify({ pid: 424_242, proc_start: "Thu Aug 13 08:00:00 2026", depuis: "2026-08-13T08:00:00.000Z" })}\n`
  );
  const repris = prendreLeVerrou(verrou, {
    pid: 7,
    estVivant: () => false,
    heureDeDemarrage: () => "Thu Aug 13 12:00:00 2026"
  });
  assert.ok(repris, "un verrou tenu par un mort n'est pas un verrou");
  assert.equal(lireLePid(verrou), 7);
  assert.equal(lireLeVerrou(verrou).proc_start, "Thu Aug 13 12:00:00 2026");
  assert.ok(repris.relacher(), "et son porteur sait le relâcher");
});

test("le démon fait ses tournées, puis relâche son verrou", async (t) => {
  const db = bureauDePoste(t);
  const verrou = path.join(decorJetable("cc2cc-facteur-verrou-"), "facteur.verrou");
  let tournees = 0;
  const resultat = await demarrerLeFacteur({
    db,
    verrou,
    tours: 3,
    journal: () => {},
    attendre: async () => {},
    faireLaTournee: async () => {
      tournees += 1;
      return { prises: 0, remises: 0, ajournees: 0, motifs: {} };
    }
  });
  assert.deepEqual(resultat, { parti: true, tours: 3 });
  assert.equal(tournees, 3);
  assert.equal(fs.existsSync(verrou), false, "le verrou ne survit pas à la tournée");
});

test("le démon refuse de partir si un autre Facteur tient déjà le verrou", async (t) => {
  const db = bureauDePoste(t);
  const verrou = path.join(decorJetable("cc2cc-facteur-verrou-"), "facteur.verrou");
  const tenu = prendreLeVerrou(verrou);
  t.after(() => tenu.relacher());
  let tournees = 0;
  const resultat = await demarrerLeFacteur({
    db,
    verrou,
    tours: 3,
    journal: () => {},
    attendre: async () => {},
    prendreLeVerrou: () => null,
    faireLaTournee: async () => {
      tournees += 1;
      return {};
    }
  });
  assert.deepEqual(resultat, { parti: false, tours: 0 });
  assert.equal(tournees, 0, "un second Facteur ne porte RIEN");
});

// ---------------------------------------------------------------------------
// E4 — LE JOURNAL DISCRET : le silence ne s'écrit pas, le battement le compte.
// ---------------------------------------------------------------------------

test("une tournée où rien ne bouge n'écrit pas de ligne facteur_tournee", async (t) => {
  const db = bureauDePoste(t);
  const lignes = [];
  const bilan = await faireLaTournee(db, {
    journal: (l) => lignes.push(l),
    reglages: verifierLesReglages(reglagesDuFacteur())
  });
  assert.deepEqual(bilan, { prises: 0, remises: 0, ajournees: 0, motifs: {} });
  assert.equal(
    lignes.filter((l) => l.evenement === "facteur_tournee").length,
    0,
    "une tournée vide ne laisse pas de trace — le battement s'en charge"
  );
});

test("une tournée où quelque chose bouge écrit sa ligne facteur_tournee", async (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "E4-bouge", sender: "a", recipient: "personne-sans-chaise", body: "x" });
  const lignes = [];
  await faireLaTournee(db, {
    journal: (l) => lignes.push(l),
    reglages: verifierLesReglages(reglagesDuFacteur())
  });
  const ligne = lignes.find((l) => l.evenement === "facteur_tournee");
  assert.ok(ligne, "quand quelque chose bouge, la tournée se dit");
});

test("le battement du démon compte les tournées restées silencieuses", async (t) => {
  const db = bureauDePoste(t);
  const verrou = path.join(decorJetable("cc2cc-facteur-verrou-"), "facteur.verrou");
  const lignes = [];
  let tic = 0;
  await demarrerLeFacteur({
    db,
    verrou,
    tours: 3,
    journal: (l) => lignes.push(l),
    attendre: async () => {},
    horloge: () => {
      tic += 1_000;
      return tic;
    },
    reglages: { battementChaqueMs: 2_500 },
    faireLaTournee: async () => ({ prises: 0, remises: 0, ajournees: 0, motifs: {} })
  });
  const battements = lignes.filter((l) => l.evenement === "facteur_battement");
  assert.equal(battements.length, 1, "le démon bat même quand rien ne bouge");
  assert.equal(battements[0].tournees_silencieuses, 3, "et il dit combien de tournées sont restées muettes");
});

test("le battement se règle par l'environnement et se refuse s'il est incohérent", () => {
  assert.equal(REGLAGES_FACTEUR_PAR_DEFAUT.battementChaqueMs, 60_000);
  assert.equal(reglagesDuFacteur({ CC2CC_FACTEUR_BATTEMENT_CHAQUE_MS: "60000" }).battementChaqueMs, 60_000);
  assert.throws(() => verifierLesReglages({ ...reglagesDuFacteur(), battementChaqueMs: 0 }));
});

test("à l'arrêt, les tournées muettes non dites partent dans un dernier battement", async (t) => {
  const db = bureauDePoste(t);
  const verrou = path.join(decorJetable("cc2cc-facteur-verrou-"), "facteur.verrou");
  const lignes = [];
  let tic = 0;
  await demarrerLeFacteur({
    db,
    verrou,
    tours: 2,
    journal: (l) => lignes.push(l),
    attendre: async () => {},
    horloge: () => {
      tic += 1_000;
      return tic;
    },
    reglages: { battementChaqueMs: 999_999_999 },
    faireLaTournee: async () => ({ prises: 0, remises: 0, ajournees: 0, motifs: {} })
  });
  const battements = lignes.filter((l) => l.evenement === "facteur_battement");
  assert.equal(battements.length, 1, "le dernier segment de vie ne se perd pas à l'arrêt");
  assert.equal(battements[0].tournees_silencieuses, 2);
  const ordre = lignes.map((l) => l.evenement);
  assert.ok(
    ordre.indexOf("facteur_battement") < ordre.indexOf("facteur_hors_service"),
    "le battement final précède la sortie de service"
  );
});

test("une tournée one-shot muette laisse quand même sa ligne facteur_tournee", (t) => {
  const root = decorJetable("cc2cc-facteur-oneshot-");
  const res = spawnSync("node", [path.join(RACINE, "src/bin/facteur.js"), "--une-tournee"], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root }
  });
  assert.equal(res.status, 0, res.stderr);
  const bilan = JSON.parse(res.stdout);
  assert.equal(bilan.prises, 0);
  assert.match(
    res.stderr,
    /facteur_tournee/,
    "le one-shot dit toujours sa tournée — un journal vide ressemblerait à un job cassé"
  );
});

// ---------------------------------------------------------------------------
// LE GUICHET — la ligne de commande.
// ---------------------------------------------------------------------------

test("la ligne de commande fait UNE tournée et rend son bilan, sans toucher une maison réelle", async (t) => {
  const db = bureauDePoste(t);
  const maison = decorJetable("cc2cc-facteur-maison-");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  chaise(db, { lignee: "bob", session: "s-m", maison, pid: 9 });
  insertMessage(db, { msg_id: "L1", sender: "a", recipient: "bob", body: "x" });
  const racine = db.racine;
  db.close();

  const sortie = spawnSync(
    process.execPath,
    [path.join(RACINE, "src/bin/facteur.js"), "--une-tournee", "--maisons", maison, "--silencieux"],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: racine } }
  );
  assert.equal(sortie.status, 0, sortie.stderr);
  const bilan = JSON.parse(sortie.stdout.trim());
  assert.equal(bilan.prises, 1);
  assert.equal(bilan.remises, 0, "aucune boîte vivante dans cette maison de carton");
  assert.equal(bilan.motifs["boite-endormie"], 1);
});

// La porte de la cérémonie : un Facteur lancé à côté de VRAIES boîtes ne doit
// pouvoir porter que la lettre nommée — et refuser bruyamment le reste.
test("la ligne de commande filtrée ne prend QU'UNE lettre, et rougit sur un identifiant inconnu", async (t) => {
  const db = bureauDePoste(t);
  const maison = decorJetable("cc2cc-facteur-maison-");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  chaise(db, { lignee: "bob", session: "s-m", maison, pid: 9 });
  for (const nom of ["L1", "L2", "L3"]) {
    insertMessage(db, { msg_id: nom, sender: "a", recipient: "bob", body: `corps de ${nom}` });
  }
  const racine = db.racine;
  db.close();

  const facteur = (...args) =>
    spawnSync(process.execPath, [path.join(RACINE, "src/bin/facteur.js"), ...args], {
      encoding: "utf8",
      env: { ...envPropre(), CC2CC_V2_HOME: racine }
    });

  const filtree = facteur("--une-tournee", "--maisons", maison, "--silencieux", "--seulement-la-lettre", "L2");
  assert.equal(filtree.status, 0, filtree.stderr);
  const bilanFiltre = JSON.parse(filtree.stdout.trim());
  assert.equal(bilanFiltre.prises, 1, "une seule lettre prise alors que trois sont dues");

  const inconnue = facteur(
    "--une-tournee",
    "--maisons",
    maison,
    "--silencieux",
    "--seulement-la-lettre",
    "L-QUI-N-EXISTE-PAS"
  );
  const bilanInconnu = JSON.parse(inconnue.stdout.trim());
  assert.equal(bilanInconnu.prises, 0, "⚠️ un identifiant inconnu ne porte RIEN");
  assert.equal(bilanInconnu.motifs["lettre-introuvable"], 1);
  assert.notEqual(inconnue.status, 0, "et le guichet rend un ROUGE VISIBLE, jamais un silence à zéro");

  // Un filtre SANS identifiant (oubli, ou avalé par le drapeau suivant) est la
  // faute qui porterait tout le courrier réel : elle se refuse AVANT la tournée.
  for (const args of [["--une-tournee", "--seulement-la-lettre"], ["--seulement-la-lettre", "--une-tournee"]]) {
    const vide = facteur(...args, "--maisons", maison, "--silencieux");
    assert.notEqual(vide.status, 0, `« ${args.join(" ")} » doit refuser de partir`);
    assert.equal(vide.stdout.trim(), "", "aucun bilan : la tournée n'a même pas commencé");
  }

  // Rien n'a bougé pour les lettres qu'on n'a jamais nommées.
  const rouvert = openDatabase({ file: path.join(racine, "broker.db") });
  t.after(() => {
    try {
      rouvert.close();
    } catch {
      /* base jetable */
    }
  });
  for (const nom of ["L1", "L3"]) {
    const ligne = rouvert.prepare("SELECT * FROM messages WHERE msg_id = ?").get(nom);
    assert.equal(ligne.carried_at, null, `${nom} n'a jamais été portée`);
    assert.equal(Number(ligne.facteur_not_before_ms), 0, `${nom} n'a même pas été ajournée`);
  }
  assert.equal(
    rouvert.prepare("SELECT count(*) AS n FROM facteur_attempts").get().n,
    1,
    "une seule tentative dans tout le bureau : celle de la lettre nommée"
  );
});

// ---------------------------------------------------------------------------
// facteur.js ÉTAIT LE SEUL BINAIRE À ÉCHAPPER À parseArgs (review interne,
// dernière vague, MOYEN) : sa propre boucle ne reconnaissait que des mots
// EXACTS (`mot === "--seulement-la-lettre"`), donc "--seulement-la-lettre=L2"
// ne matchait AUCUNE branche et disparaissait en silence — filtreDemande
// restait faux, la garde qui refuse « un filtre sans identifiant » ne voyait
// rien à refuser, et la tournée portait TOUT le courrier plutôt que la seule
// lettre demandée. Même défaut pour --tours=3 (restait Infinity, démon sans
// borne) et --silencieux=x (revue adverse). Ces cinq tests prouvent la fermeture.
// ---------------------------------------------------------------------------

test("--seulement-la-lettre=L2 (syntaxe =) est REFUSÉ — ne porte plus TOUT le courrier en silence", async (t) => {
  const db = bureauDePoste(t);
  const maison = decorJetable("cc2cc-facteur-maison-");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  chaise(db, { lignee: "bob", session: "s-m", maison, pid: 9 });
  for (const nom of ["L1", "L2", "L3"]) {
    insertMessage(db, { msg_id: nom, sender: "a", recipient: "bob", body: `corps de ${nom}` });
  }
  const racine = db.racine;
  db.close();

  const resultat = spawnSync(
    process.execPath,
    [
      path.join(RACINE, "src/bin/facteur.js"),
      "--une-tournee",
      "--maisons",
      maison,
      "--silencieux",
      "--seulement-la-lettre=L2"
    ],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: racine }, timeout: 5000 }
  );
  assert.equal(resultat.status, 2, "la syntaxe = est refusée, comme pour tout autre CLI de cette maison");
  assert.match(resultat.stderr, /--seulement-la-lettre/, "le refus NOMME le drapeau");
  assert.equal(resultat.stdout, "", "aucun bilan : la tournée n'a même pas commencé, aucune lettre n'a bougé");

  const rouvert = openDatabase({ file: path.join(racine, "broker.db") });
  t.after(() => {
    try {
      rouvert.close();
    } catch {
      /* base jetable */
    }
  });
  for (const nom of ["L1", "L2", "L3"]) {
    const ligne = rouvert.prepare("SELECT carried_at FROM messages WHERE msg_id = ?").get(nom);
    assert.equal(ligne.carried_at, null, `${nom} n'a jamais été portée — avant ce remède, les TROIS l'auraient été`);
  }
});

// Sans --une-tournee : AVANT ce remède, --tours=3 était ignoré (Infinity
// survivait) et le démon partait sans borne — d'où le timeout de garde ici,
// pour que la preuve RED ne puisse jamais bloquer la suite.
test("--tours=3 (syntaxe =) est refusé — ne retombe plus en silence sur Infinity (démon sans borne)", () => {
  const root = decorJetable("cc2cc-facteur-tours-egal-");
  const resultat = spawnSync(process.execPath, [path.join(RACINE, "src/bin/facteur.js"), "--tours=3"], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root },
    timeout: 5000
  });
  assert.equal(resultat.status, 2);
  assert.match(resultat.stderr, /--tours/);
});

test("--silencieux=x (syntaxe =) est refusé aussi — même garde partagée, jusqu'au drapeau que la revue adverse avait noté sans danger", () => {
  const root = decorJetable("cc2cc-facteur-silencieux-egal-");
  const resultat = spawnSync(
    process.execPath,
    [path.join(RACINE, "src/bin/facteur.js"), "--une-tournee", "--silencieux=x"],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root }, timeout: 5000 }
  );
  assert.equal(resultat.status, 2);
  assert.match(resultat.stderr, /--silencieux/);
});

test("--tours SANS valeur refuse proprement — avant ce remède, Number(undefined) rendait NaN en silence (démon qui se croit hors service tout de suite)", () => {
  const root = decorJetable("cc2cc-facteur-tours-vide-");
  const resultat = spawnSync(process.execPath, [path.join(RACINE, "src/bin/facteur.js"), "--tours"], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root },
    timeout: 5000
  });
  assert.equal(resultat.status, 2);
  assert.match(resultat.stderr, /--tours/);
});

test("--maisons SANS valeur refuse proprement — avant ce remède, un tableau VIDE (donc VRAI en JS) faisait tourner une tournée sur ZÉRO maison, en silence", () => {
  const root = decorJetable("cc2cc-facteur-maisons-vide-");
  const resultat = spawnSync(
    process.execPath,
    [path.join(RACINE, "src/bin/facteur.js"), "--une-tournee", "--maisons"],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root }, timeout: 5000 }
  );
  assert.equal(resultat.status, 2);
  assert.match(resultat.stderr, /--maisons/);
});

// RÉGRESSION du remède ci-dessus (review interne, vague suivante) :
// parseArgs consomme le mot suivant dès qu'il ne commence pas par "--" —
// correct pour un drapeau à VALEUR, faux pour --une-tournee qui n'en attend
// AUCUNE. `facteur --une-tournee BAREWORD` rendait args.une_tournee =
// "BAREWORD" (une chaîne), le test `=== true` de facteur.js échouait, et la
// ligne de commande basculait dans le démon SANS BORNE — reproduit avant ce
// remède, process tué par le garde-fou de 5 s ci-dessous, jamais rendu la
// main. `booleans: ["une_tournee", "silencieux"]` sur parseArgs ferme la
// classe à la racine plutôt que de patcher facteur.js localement.
test("facteur --une-tournee BAREWORD ne bascule jamais en démon — refusé net depuis N4 (régression d'un correctif antérieur)", () => {
  const root = decorJetable("cc2cc-facteur-boolswallow-");
  const resultat = spawnSync(
    process.execPath,
    [path.join(RACINE, "src/bin/facteur.js"), "--une-tournee", "BAREWORD"],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root }, timeout: 5000 }
  );
  assert.equal(resultat.error, undefined, "ne doit JAMAIS être tué par le garde-fou de 5s — jamais le démon");
  // N4 (seconde passe adverse, 28/09) : le mot en trop est REFUSÉ (sortie 2),
  // plus strict que le one-shot d'avant — ni démon, ni tournée sur une ligne
  // de commande que personne n'a écrite ainsi.
  assert.equal(resultat.status, 2, `le mot nu est refusé : ${resultat.stderr}`);
  assert.match(resultat.stderr, /unexpected argument: BAREWORD/);
  assert.equal(resultat.stdout, "", "aucune tournée");
});

test("facteur --une-tournee --silencieux BAREWORD : refusé, aucun journal du Facteur (N4)", () => {
  const root = decorJetable("cc2cc-facteur-boolswallow-silencieux-");
  const resultat = spawnSync(
    process.execPath,
    [path.join(RACINE, "src/bin/facteur.js"), "--une-tournee", "--silencieux", "BAREWORD"],
    { encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root }, timeout: 5000 }
  );
  assert.equal(resultat.error, undefined, "ne doit JAMAIS être tué par le garde-fou de 5s");
  // N4 : refusé avant tout — le seul texte est le refus, aucun journal du Facteur.
  assert.equal(resultat.status, 2, `le mot nu est refusé : ${resultat.stderr}`);
  assert.doesNotMatch(resultat.stderr, /facteur_/, "aucun événement du Facteur n'a été journalisé");
});

// [3, review interne] --tours NON-NUMÉRIQUE était un succès silencieux :
// Number("abc") = NaN, `faites < NaN` est toujours faux, donc le démon se
// déclarait hors service SANS AVOIR TOURNÉ — {parti:true, tours:0}, exit 0 —
// reproduit avant ce remède. Une faute de frappe (--tours trois) démarrait
// le démon, il ne tournait jamais, et rapportait un succès.
test("--tours abc (non-numérique) est refusé — avant ce remède, Number('abc') rendait NaN, tours:0, succès silencieux", () => {
  const root = decorJetable("cc2cc-facteur-tours-nan-");
  const resultat = spawnSync(process.execPath, [path.join(RACINE, "src/bin/facteur.js"), "--tours", "abc"], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root },
    timeout: 5000
  });
  assert.equal(resultat.status, 2);
  assert.match(resultat.stderr, /--tours/);
  assert.equal(resultat.stdout, "", "aucun bilan : avant ce remède, {parti:true, tours:0} sortait comme si tout allait bien");
});

// ---------------------------------------------------------------------------
// LE BUREAU QUI S'OUVRE — une version qui distingue, et une porte qui ne se
// ferme jamais sur toute la machine.
// ---------------------------------------------------------------------------

test("un bureau passé par le Facteur ANNONCE son schéma : une version qui ne distingue rien ne sert à rien", (t) => {
  const db = bureauDePoste(t);
  assert.ok(SCHEMA_VERSION >= 3, "les tables du Facteur sont une addition de schéma, pas un geste de suite");
  assert.equal(schemaVersion(db), SCHEMA_VERSION, "et la base porte le numéro qu'elle annonce");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'facteur%' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(
    tables,
    ["facteur_attempts", "facteur_sweep"],
    "un bureau porteur de ces tables ne peut pas être indiscernable d'un bureau qui ne les a jamais vues"
  );
});

test("une colonne qui ne peut pas naître ne FERME PAS le bureau à toute la machine", (t) => {
  const root = tempHome();
  const db = new Database(path.join(root, "broker.db"));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* base jetable */
    }
  });
  // Une « table » messages sur laquelle aucun ALTER ne peut réussir.
  db.exec("CREATE TABLE socle (msg_id TEXT, seq INTEGER)");
  db.exec("CREATE VIEW messages AS SELECT msg_id, seq FROM socle");

  let resultat;
  assert.doesNotThrow(() => {
    resultat = migrate(db);
  }, "openDatabase est appelé par le serveur MCP, les hooks et le moniteur : une exception ici arrête TOUT le courrier de la machine");
  assert.ok(
    resultat.colonnesRatees.some((c) => c.colonne === "messages.carried_at"),
    "et le défaut se DIT — un échec muet est un état qu'on ne saura jamais lire"
  );
  assert.equal(resultat.to, resultat.from, "aucune version ne se promet sur un schéma incomplet");
});

// ── SANS CHAISE DÉSIGNÉE : LE FACTEUR LE DIT UNE FOIS (Run 6, Task 7) ──────
// La lettre attend une désignation ; chaque tournée la ré-ajourne, mais le
// constat « aucune chaise ne la porte comme sienne » ne se dit qu'une fois par
// lettre — au journal du Facteur ET au journal de la lettre.
test("27/09 — lignée sans chaise désignée : le Facteur le journalise UNE fois par lettre, pas à chaque tournée", async (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "SCD1", sender: "a", recipient: "alice", body: "x" });
  const une = chaise(db, { lignee: "alice", session: "s-1", pid: 1 });
  const deux = chaise(db, { lignee: "alice", session: "s-2", pid: 2 });
  const lignes = [];
  for (const maintenant of [1_000_000, 2_000_000, 3_000_000]) {
    await faireLaTournee(db, depsDeBase({
      tourHouses: inventaire([une, deux]),
      horloge: () => maintenant,
      journal: (l) => lignes.push(l),
      reglages: { ajournementInacheminableMs: 1 }
    }));
  }
  const dits = lignes.filter((l) => l.evenement === "facteur_sans_chaise_designee");
  assert.equal(dits.length, 1, "un constat par lettre");
  assert.equal(dits[0].msg_id, "SCD1");
  assert.equal(dits[0].lignee, "alice");
  assert.equal(dits[0].candidats, 2);
  const marques = db.prepare("SELECT count(*) AS n FROM delivery_events WHERE msg_id = 'SCD1' AND event_type = 'sans_chaise_designee'").get();
  assert.equal(marques.n, 1);
  assert.equal(lignes.filter((l) => l.evenement === "facteur_inacheminable").length, 3, "l'ajournement, lui, reste compté à chaque tournée");
});

// ── UNE SEULE SORTIE (Run 6, Task 8, fix round 2) ───────────────────────────
// `terminer()` attendait le drain et RENDAIT la main : le one-shot tombait
// alors dans le DÉMON (`facteur_en_service`, une tournée sur un bureau fermé,
// deux JSON sur stdout). 600 lettres dues font un journal d'environ 190 Ko sur
// stderr ; un lecteur lent force le chemin du drain. `--tours 1` borne le démon
// si jamais la chute revenait, pour que ce test rougisse au lieu de pendre.
test("facteur --une-tournee par un tube lent : un seul bilan, jamais de chute dans le démon", (t) => {
  const db = bureauDePoste(t);
  const maison = decorJetable("cc2cc-facteur-tube-maison-");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  const home = decorJetable("cc2cc-facteur-tube-home-");
  chaise(db, { lignee: "bob", session: "s-m", maison, pid: 9 });
  for (let i = 0; i < 600; i++) {
    insertMessage(db, { msg_id: `T${i}`, sender: "a", recipient: "bob", body: "x".repeat(50) });
  }
  const racine = db.racine;
  db.close();

  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const sortieFichier = path.join(racine, "stdout-du-facteur");
  const rcFichier = path.join(racine, "rc-du-facteur");
  const script = `{ ${q(process.execPath)} ${q(path.join(RACINE, "src/bin/facteur.js"))} --une-tournee --tours 1 --maisons ${q(maison)}`
    + ` > ${q(sortieFichier)}; echo $? > ${q(rcFichier)}; } 2>&1 | (sleep 0.5; cat)`;
  const env = { ...envPropre(), CC2CC_V2_HOME: racine, HOME: home, CC2CC_FACTEUR_LETTRES_PAR_TOURNEE: "600" };
  delete env.CLAUDE_CONFIG_DIR;
  const res = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });

  assert.ok(res.stdout.length > 64 * 1024, "le journal doit dépasser le tampon du tube, sinon ce test ne prouve rien");
  assert.equal(Number(fs.readFileSync(rcFichier, "utf8").trim()), 0);
  assert.doesNotMatch(res.stdout, /facteur_en_service|bureau-ferme|facteur_bureau_ferme/, "aucune chute dans le démon");
  const lignes = fs.readFileSync(sortieFichier, "utf8").trim().split("\n");
  assert.equal(lignes.length, 1, "un seul document JSON sur stdout");
  assert.equal(typeof JSON.parse(lignes[0]).prises, "number");
});
