// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// H2 — L'EN-SOUFFRANCE : dérivée, jamais stockée, jamais un cinquième état.
//
// Une lettre que personne n'a signée doit avoir un nom, un compte et une
// échéance — sans jamais être enterrée (A9) ni cachée (Camp B). Le verdict est
// ORTHOGONAL à l'état lisible : une lettre peut être « reçue » ET en souffrance
// (les six lettres Hermes de juillet), « en attente » ET en souffrance (le
// spécimen du 20/08). Seuils accordés par l'opérateur le 21/08 : 4 h / 6
// tentatives — dérivés du cap existant (ajournementMaximalMs), pas inventés.
//
// ⚠️ Toutes les bases ici sont JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau
// de poste vivant n'est JAMAIS ouvert.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { SEUILS_SOUFFRANCE_PAR_DEFAUT, seuilsDeSouffrance } from "../src/lib/config.js";
import { ETATS_LISIBLES, enSouffrance, etatDeLaLettre } from "../src/lib/format.js";
import { insertMessage, lettresEnSouffrance, openDatabase, registerPeer } from "../src/lib/database.js";
import { tentativesInfructueuses } from "../src/facteur/round.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

// ⚠️ LE JETABLE VAUT AUSSI POUR CE PROCESSUS-CI (revue adverse F2, 21/08). Un `file`
// explicite ne protège PAS le bureau vivant : `ensureRuntimeDirs`,
// `writeHeartbeat` et le registre lisent `baseDir()` — donc l'ENV du runner,
// jamais le fichier qu'on vient de leur imposer. Sans ce plancher, les gestes
// EN PROCESSUS de ce fichier écrivaient dans le VRAI ~/.cc2cc-v2 (fiches et
// répertoires constatés le 21/08). Les tests qui posent leur propre racine la
// posent par-dessus ; l'état d'origine se restaure à la fin du fichier.
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-souffrance-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});


const repo = path.resolve(new URL("..", import.meta.url).pathname);

function maisonJetable() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-souffrance-"));
}

test("les seuils de souffrance : accordés (4 h / 6), pilotables par l'environnement, jamais en dur", () => {
  assert.deepEqual(SEUILS_SOUFFRANCE_PAR_DEFAUT, { ageMs: 14_400_000, tentatives: 6 });
  assert.deepEqual(seuilsDeSouffrance({}), { ageMs: 14_400_000, tentatives: 6 });
  assert.deepEqual(
    seuilsDeSouffrance({ CC2CC_SOUFFRANCE_AGE_MS: "1000", CC2CC_SOUFFRANCE_TENTATIVES: "2" }),
    { ageMs: 1000, tentatives: 2 }
  );
  // Une valeur illisible retombe sur le défaut — même doctrine que reglagesDuFacteur.
  assert.equal(seuilsDeSouffrance({ CC2CC_SOUFFRANCE_AGE_MS: "quatre-heures" }).ageMs, 14_400_000);
});

test("l'en-souffrance se dérive : l'âge OU les tentatives, jamais un état stocké", () => {
  const SEUILS = { ageMs: 14_400_000, tentatives: 6 };
  const T0 = Date.parse("2026-08-21T12:00:00Z");
  const il_y_a = (ms) => new Date(T0 - ms).toISOString();

  // Jeune et peu portée : rien à crier.
  assert.equal(
    enSouffrance({ acked_at: null, created_at: il_y_a(60_000) }, { tentatives: 1, maintenant: T0, seuils: SEUILS }),
    null
  );
  // Le seuil d'ÂGE suffit seul (les six lettres Hermes de juillet : zéro tentative Facteur).
  const parAge = enSouffrance(
    { acked_at: null, created_at: il_y_a(15_000_000) },
    { tentatives: 0, maintenant: T0, seuils: SEUILS }
  );
  assert.ok(parAge, "4 h sans signature = en souffrance, même sans aucune tentative");
  assert.equal(parAge.depuis_ms, 15_000_000);
  assert.equal(parAge.tentatives, 0);
  // Le seuil de TENTATIVES suffit seul (le spécimen du 20/08 : jeune mais re-échouée).
  const parTentatives = enSouffrance(
    { acked_at: null, created_at: il_y_a(60_000) },
    { tentatives: 6, maintenant: T0, seuils: SEUILS }
  );
  assert.ok(parTentatives, "6 tentatives closes = en souffrance, même jeune");
  assert.equal(parTentatives.tentatives, 6);
  // Un created_at illisible retombe sur le critère des tentatives seules.
  // Cas 1 : created_at NaN avec tentatives ≥ seuil → en souffrance, depuis_ms = null.
  const parNaNAvecTentatives = enSouffrance(
    { acked_at: null, created_at: "pas-une-date" },
    { tentatives: 7, maintenant: T0, seuils: SEUILS }
  );
  assert.ok(parNaNAvecTentatives, "créé_at illisible mais 7 tentatives = en souffrance");
  assert.equal(parNaNAvecTentatives.depuis_ms, null);
  assert.equal(parNaNAvecTentatives.tentatives, 7);
  // Cas 2 : created_at NaN avec tentatives < seuil → jamais en souffrance (pas de cri accidentel).
  const parNaNSansTentatives = enSouffrance(
    { acked_at: null, created_at: "pas-une-date" },
    { tentatives: 1, maintenant: T0, seuils: SEUILS }
  );
  assert.equal(parNaNSansTentatives, null, "créé_at illisible ET tentatives faibles = pas de cri");
});

test("une lettre ACCUSÉE n'est jamais en souffrance — et le verdict est orthogonal à l'état lisible", () => {
  const SEUILS = { ageMs: 14_400_000, tentatives: 6 };
  const T0 = Date.parse("2026-08-21T12:00:00Z");
  const il_y_a = (ms) => new Date(T0 - ms).toISOString();

  // Accusée il y a longtemps : signée, donc rien à crier — quel que soit l'âge.
  assert.equal(
    enSouffrance(
      { acked_at: il_y_a(1), created_at: il_y_a(90_000_000) },
      { tentatives: 50, maintenant: T0, seuils: SEUILS }
    ),
    null
  );
  // ORTHOGONALITÉ : une lettre « reçue » (delivered_at posé) peut être en
  // souffrance — c'est exactement le cas des six lettres Hermes de juillet.
  const row = { acked_at: null, delivered_at: il_y_a(15_000_000), created_at: il_y_a(15_000_000) };
  assert.equal(etatDeLaLettre(row), "reçue");
  assert.ok(enSouffrance(row, { tentatives: 0, maintenant: T0, seuils: SEUILS }));
  // Et ETATS_LISIBLES n'a PAS bougé : l'en-souffrance n'est pas un 5e état.
  assert.deepEqual(ETATS_LISIBLES, ["accusée", "reçue", "au guichet", "en attente"]);
});

function bureauJetable(t) {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  db.racine = root;
  t.after(() => db.close());
  return db;
}

// Une tentative close du Facteur, écrite comme le Facteur l'écrit.
function tentativeClose(db, msgId, { state = "echouee", reason = "destinataire-inconnu", finishedAtMs }) {
  db.prepare(`
    INSERT INTO facteur_attempts (attempt_id, msg_id, owner_id, state, claimed_at_ms, lease_until_ms, finished_at_ms, reason)
    VALUES (?, ?, 'facteur@test#1', ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), msgId, state, finishedAtMs - 1000, finishedAtMs, finishedAtMs, state === "remise" ? null : reason);
}

test("lettresEnSouffrance nomme la lettre PAR SON NOM, avec son compte et son dernier motif", (t) => {
  const db = bureauJetable(t);
  const T0 = Date.parse("2026-08-21T12:00:00Z");
  // La vieille jamais portée (le cas Hermes) :
  insertMessage(db, {
    msg_id: "H2-vieille", sender: "a", recipient: "bob", body: "x",
    created_at: new Date(T0 - 15_000_000).toISOString()
  });
  // La jeune re-échouée 6 fois (le cas du spécimen) :
  insertMessage(db, {
    msg_id: "H2-echouee", sender: "a", recipient: "chaise", body: "y",
    created_at: new Date(T0 - 60_000).toISOString()
  });
  for (let i = 0; i < 6; i += 1) {
    tentativeClose(db, "H2-echouee", { reason: "lignee-ambigue", finishedAtMs: T0 - 50_000 + i * 1000 });
  }
  // La saine (jeune, AUCUNE tentative) et l'accusée (vieille mais signée) :
  insertMessage(db, { msg_id: "H2-saine", sender: "a", recipient: "chaise", body: "z", created_at: new Date(T0 - 30_000).toISOString() });
  insertMessage(db, {
    msg_id: "H2-signee", sender: "a", recipient: "bob", body: "w",
    created_at: new Date(T0 - 90_000_000).toISOString()
  });
  db.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = 'H2-signee'").run(new Date(T0).toISOString());

  const rows = lettresEnSouffrance(db, { maintenant: T0, seuils: { ageMs: 14_400_000, tentatives: 6 } });
  assert.deepEqual(rows.map((r) => r.msg_id).sort(), ["H2-echouee", "H2-vieille"]);
  const echouee = rows.find((r) => r.msg_id === "H2-echouee");
  assert.equal(echouee.tentatives, 6);
  assert.equal(echouee.dernier_motif, "lignee-ambigue");
  assert.equal(typeof echouee.prochaine_reprise_ms, "number");
  const vieille = rows.find((r) => r.msg_id === "H2-vieille");
  assert.equal(vieille.tentatives, 0);
  assert.equal(vieille.dernier_motif, null, "jamais portée : aucun motif à inventer");
});

test("le compte de tentatives est CELUI du Facteur — les deux définitions ne peuvent pas diverger", (t) => {
  // database.js compte en SQL (il ne peut pas importer round.js : cycle) ; ce
  // test est le prix de la duplication — il compare les deux, terme à terme.
  const db = bureauJetable(t);
  const T0 = Date.parse("2026-08-21T12:00:00Z");
  insertMessage(db, { msg_id: "H2-compte", sender: "a", recipient: "b", body: "x", created_at: new Date(T0 - 15_000_000).toISOString() });
  tentativeClose(db, "H2-compte", { state: "remise", finishedAtMs: T0 - 9000 });
  tentativeClose(db, "H2-compte", { state: "echouee", reason: "boite-endormie", finishedAtMs: T0 - 6000 });
  tentativeClose(db, "H2-compte", { state: "expiree", reason: "bail-expire", finishedAtMs: T0 - 3000 });
  // Une tentative ACTIVE ne compte pas :
  db.prepare(`
    INSERT INTO facteur_attempts (attempt_id, msg_id, owner_id, state, claimed_at_ms, lease_until_ms)
    VALUES (?, 'H2-compte', 'facteur@test#1', 'reservee', ?, ?)
  `).run(crypto.randomUUID(), T0, T0 + 15_000);
  const [row] = lettresEnSouffrance(db, { maintenant: T0, seuils: { ageMs: 14_400_000, tentatives: 6 } });
  assert.equal(row.tentatives, tentativesInfructueuses(db, "H2-compte"), "le SQL de database.js et le compte de round.js disent le MÊME nombre");
  assert.equal(row.tentatives, 3);
});

// LE DERNIER MOTIF SUIT L'ORDRE D'INSERTION, PAS L'HORLOGE (même défaut de
// classe que la série de round.js, corrigée plus tôt). Une tournée lit
// l'horloge deux fois et `docs/FACTEUR.md` (point 6) admet les sauts en
// arrière : une tentative close APRÈS peut porter une estampille PLUS VIEILLE
// que sa devancière. Classer par estampille désignerait alors un motif PÉRIMÉ —
// et c'est le médecin, et `cc2cc-peers`, qui le répéteraient à l'opérateur.
// Le `rowid` est l'ordre de prise, rien ne s'efface de `facteur_attempts`
// (Camp B) : il EST la chronologie.
test("le dernier motif ne se laisse pas berner par un recul d'horloge : c'est le DERNIER inséré qui parle", (t) => {
  const db = bureauJetable(t);
  const T0 = Date.parse("2026-08-21T12:00:00Z");
  insertMessage(db, {
    msg_id: "H2-horloge", sender: "a", recipient: "bob", body: "x",
    created_at: new Date(T0 - 15_000_000).toISOString()
  });
  // La PREMIÈRE tentative (rowid le plus petit) porte l'estampille la PLUS
  // RÉCENTE — exactement ce que produit une horloge qui recule entre deux
  // tournées :
  tentativeClose(db, "H2-horloge", { reason: "boite-endormie", finishedAtMs: T0 - 1000 });
  // La SECONDE (rowid le plus grand), close plus tard, porte une estampille plus
  // vieille et un motif DIFFÉRENT :
  tentativeClose(db, "H2-horloge", { reason: "destinataire-inconnu", finishedAtMs: T0 - 60_000 });

  const [row] = lettresEnSouffrance(db, { maintenant: T0, seuils: { ageMs: 14_400_000, tentatives: 6 } });
  assert.equal(row.tentatives, 2);
  assert.equal(
    row.dernier_motif,
    "destinataire-inconnu",
    "le motif rendu est celui de la DERNIÈRE tentative prise, pas celui de la plus récente estampille"
  );
});

// LE FILTRE PRÉCÈDE LE CLASSEMENT, ET C'EST VOULU. `state IN ('echouee',
// 'expiree')` écarte la remise AVANT d'ordonner : une lettre remise puis jamais
// accusée reste en souffrance (A9 — « remis au guichet » n'est pas « signé »),
// et la question qu'on lui pose alors est « pourquoi a-t-elle échoué la
// dernière fois ? ». Un motif nul après une remise ne dirait rien à
// l'opérateur ; le dernier ÉCHEC, si.
test("échec, échec, puis REMISE : le dernier motif reste celui du dernier ÉCHEC — jamais un blanc", (t) => {
  const db = bureauJetable(t);
  const T0 = Date.parse("2026-08-21T12:00:00Z");
  insertMessage(db, {
    msg_id: "H2-remise-en-dernier", sender: "a", recipient: "bob", body: "x",
    created_at: new Date(T0 - 15_000_000).toISOString()
  });
  tentativeClose(db, "H2-remise-en-dernier", { reason: "boite-endormie", finishedAtMs: T0 - 9000 });
  tentativeClose(db, "H2-remise-en-dernier", { reason: "lignee-ambigue", finishedAtMs: T0 - 6000 });
  tentativeClose(db, "H2-remise-en-dernier", { state: "remise", finishedAtMs: T0 - 3000 });

  const [row] = lettresEnSouffrance(db, { maintenant: T0, seuils: { ageMs: 14_400_000, tentatives: 6 } });
  assert.equal(row.tentatives, 3, "la remise COMPTE comme tentative close");
  assert.equal(row.dernier_motif, "lignee-ambigue", "le dernier échec parle encore : la remise n'efface pas le diagnostic");
});

test("cc2cc-doctor nomme la lettre en souffrance PAR SON NOM — et le schéma existe même à zéro", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, {
    msg_id: "alice-lettre-en-souffrance", sender: "a", recipient: "bob", body: "x",
    created_at: new Date(Date.now() - 15_000_000).toISOString()
  });
  db.close();
  const rapport = JSON.parse(
    execFileSync("node", [path.join(repo, "src/bin/valxos-doctor.js")], {
      encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root }
    })
  );
  const bloc = rapport.checks.souffrance;
  assert.equal(bloc.total, 1);
  assert.equal(bloc.par_destinataire[0].recipient, "bob");
  assert.equal(bloc.par_destinataire[0].plus_vieille.msg_id, "alice-lettre-en-souffrance", "la lettre a un NOM au rapport");
  assert.deepEqual(bloc.seuils, { age_ms: 14_400_000, tentatives: 6 });
  // Le bloc `lettres` n'a pas bougé (schéma stable) :
  assert.deepEqual(Object.keys(rapport.checks.lettres), ["accusée", "reçue", "au guichet", "en attente"]);
  // Base vide : le schéma EXISTE, à zéro — « 0 en souffrance » et « pas suivi »
  // ne doivent jamais se ressembler.
  const rootVide = maisonJetable();
  const vide = JSON.parse(
    execFileSync("node", [path.join(repo, "src/bin/valxos-doctor.js")], {
      encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: rootVide }
    })
  );
  assert.deepEqual(
    { total: vide.checks.souffrance.total, par_destinataire: vide.checks.souffrance.par_destinataire, motifs: vide.checks.souffrance.motifs },
    { total: 0, par_destinataire: [], motifs: {} }
  );
});

test("la borne du rapport n'est jamais silencieuse : 22 destinataires, 20 lignes, l'écart est DIT", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  const vieux = new Date(Date.now() - 15_000_000).toISOString();
  for (let i = 0; i < 22; i += 1) {
    insertMessage(db, { msg_id: `H2-borne-${i}`, sender: "a", recipient: `dest-${String(i).padStart(2, "0")}`, body: "x", created_at: vieux });
  }
  db.close();
  const rapport = JSON.parse(
    execFileSync("node", [path.join(repo, "src/bin/valxos-doctor.js")], {
      encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root }
    })
  );
  assert.equal(rapport.checks.souffrance.total, 22, "le TOTAL dit tout, la borne ne mange que l'affichage");
  assert.equal(rapport.checks.souffrance.par_destinataire.length, 20);
  assert.equal(rapport.checks.souffrance.destinataires_au_dela_de_la_borne, 2, "une borne silencieuse se lit comme « tout est là » — la nôtre se nomme");
});

test("le total ne s'arrête pas à 200 : le diagnostic compte TOUT, seule l'affichage se borne", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  const vieux = new Date(Date.now() - 18_000_000).toISOString();
  for (let i = 0; i < 205; i += 1) {
    insertMessage(db, { msg_id: `H2-masse-${i}`, sender: "a", recipient: "dest-masse", body: "x", created_at: vieux });
  }
  db.close();
  const rapport = JSON.parse(
    execFileSync("node", [path.join(repo, "src/bin/valxos-doctor.js")], {
      encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root }
    })
  );
  assert.equal(rapport.checks.souffrance.total, 205, "205 lettres en souffrance, aucune ne se cache derrière une limite interne");
});

test("cc2cc-peers --all porte l'en-souffrance par fiche — MORTES COMPRISES (« à qui écrit-on dans le vide ? »)", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerPeer(db, { id: "morte-en-dette" });
  registerPeer(db, { id: "vivante-sans-dette" });
  db.prepare("UPDATE peers SET status = 'dead' WHERE id = 'morte-en-dette'").run();
  insertMessage(db, {
    msg_id: "H2-au-vide", sender: "a", recipient: "morte-en-dette", body: "x",
    created_at: new Date(Date.now() - 15_000_000).toISOString()
  });
  db.close();
  const rapport = JSON.parse(
    execFileSync("node", [path.join(repo, "src/bin/valxos-peers.js"), "--all"], {
      encoding: "utf8", env: { ...envPropre(), CC2CC_V2_HOME: root }
    })
  );
  const morte = rapport.peers.find((p) => p.id === "morte-en-dette");
  const vivante = rapport.peers.find((p) => p.id === "vivante-sans-dette");
  assert.ok(morte, "la fiche morte est là (--all, Camp B)");
  assert.equal(morte.en_souffrance, 1, "on écrit dans le vide vers cette chaise, et ça se VOIT");
  assert.equal(vivante.en_souffrance, 0, "zéro se dit — « 0 » et « pas suivi » ne se ressemblent pas");
});
