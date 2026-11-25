// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA PORTE CODEX DU FACTEUR (1.1.0, Tâche 10, spec B §2, §4, §7).
//
// Une chaise Codex n'a pas de boîte native : on la SONNE avec `codex queue` et une
// enveloppe, jamais un corps. Ici, `codex` et `open` sont des FAUX : deux scripts shell dans
// un dossier jetable, lancés par leur chemin ABSOLU (le `lancer` de ce fichier refuse toute
// autre commande) ; ils journalisent leur CODEX_HOME, leur pid et leurs arguments, puis
// jouent le mode demandé (répond, dit « No active session », dit « no rollout found »,
// refuse, inonde stderr, ou PEND). Le vrai `codex` n'est jamais lancé, le vrai `open` non
// plus, aucun ~/.codex n'est lu.
//
// ⚠️ Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau
// vivant n'est JAMAIS ouvert ici. Le plancher se pose AVANT le premier test (`openDatabase`
// lit `baseDir()`, donc l'ENV du runner — remède de la revue adverse F2).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { envPropre, poserLeBureau } from "./aide-env.js";
import { ajouterMembre, creerTable } from "../src/lib/tables.js";
import { ecrireFicheCodex, fichesCodex } from "../src/lib/chaise-codex.js";
import { REGLAGES_FACTEUR_PAR_DEFAUT, reglagesDuFacteur, verifierLesReglages } from "../src/lib/config.js";
import { getPendingForContext, insertMessage, openDatabase, registerPeer } from "../src/lib/database.js";
import { posterUneLettre } from "../src/lib/guichet.js";
import { registerInstance, resolveRecipient } from "../src/lib/registry.js";
import { demarrerLeFacteur } from "../src/facteur/daemon.js";
import {
  avisDAttente,
  boiteDeLaFicheCodex,
  construireFichesCodex,
  faireLaTournee,
  scannerLesMaisons,
  trouverLaBoite
} from "../src/facteur/round.js";
import {
  DELAI_SONNETTE_MS,
  FIL_SANS_SESSION,
  MOTIF_SONNETTE_DEJA_SONNEE,
  MOTIF_SONNETTE_IMPOSSIBLE,
  PERSONNE_NE_TIENT_LE_FIL,
  BUNDLE_APP_CODEX,
  appCodexOuverte,
  argumentsDeSonnette,
  dossierDeLaSonnette,
  lancerBorne,
  lienDuFil,
  ouvertureTentee,
  sonnerLaChaiseCodex
} from "../src/facteur/porte-codex.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-codex-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

const decors = [];
function decorJetable(prefixe = "cc2cc-porte-codex-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  decors.push(dir);
  return dir;
}
after(() => {
  for (const dir of decors) fs.rmSync(dir, { recursive: true, force: true });
});

// La fiche d'une chaise Codex, telle que la Tâche 9 l'écrit (`<bureau>/codex/<lignée>.json`).
const FICHE = Object.freeze({
  lineage: "hal-test",
  thread_id: "0199c0de-0000-7000-8000-000000000001",
  codex_home: "/codex/carton",
  pid: 4343,
  started_at: "2026-10-21T10:00:00.000Z",
  last_seen: "2026-10-21T10:00:00.000Z",
  porte: "cli"
});
// La forme réelle de sonnette.js (Tâche 9) : l'expéditeur est cité en JSON.
// La même chaise, ouverte dans l'app de bureau : seule une chaise `app` (ou sans porte) ouvre l'app
// sur son fil (round 1b). Les tests qui prouvent une OUVERTURE la prennent.
const FICHE_APP = Object.freeze({ ...FICHE, porte: "app" });
const ENVELOPPE = "📬 VALXOS Messenger: 1 letter waiting for hal-test — from \"alice\", priority \"normal\". Call the inbox tool.";

// ── LE FAUX CODEX ET LE FAUX OPEN ──────────────────────────────────────────────────────────────
// `exec sleep` dans le mode « pend » garde le MÊME pid que le script (exec remplace l'image) :
// tuer le pid lancé, c'est tuer ce qui pend. String.raw : les `\n` restent dans le script, où
// printf les lit ; aucun `${` ici, rien n'est interpolé par Node.
const SCRIPT_FAUX_CODEX = String.raw`#!/bin/sh
# Le faux codex de test/porte-codex.test.js : il journalise, puis joue le mode demande.
# Les modes petit-fils passent EN PREMIER : sous charge, un shell lent n'aurait pas pose
# son petit-enfant avant le couperet, et la sonde n'aurait rien a verifier.
case "$FAUX_CODEX_MODE" in
  pend-petit-fils)
    sleep 120 &
    echo "$!" > "$FAUX_CODEX_JOURNAL.gpid"
    wait; exit 0 ;;
  sort-petit-fils-garde)
    sleep 120 &
    echo "$!" > "$FAUX_CODEX_JOURNAL.gpid"
    echo "Queued message 0199-msg"; exit 0 ;;
  sort-tard-petit-fils-garde)
    sleep 120 &
    echo "$!" > "$FAUX_CODEX_JOURNAL.gpid"
    sleep 0.5
    echo "Queued message 0199-msg"; exit 0 ;;
esac
{
  printf 'CMD=codex\n'
  printf 'HOME=%s\n' "$CODEX_HOME"
  printf 'CWD=%s\n' "$(pwd -P)"
  printf 'PID=%s\n' "$$"
  for a in "$@"; do printf 'ARG=%s\n' "$a"; done
  printf -- '--\n'
} >> "$FAUX_CODEX_JOURNAL"
appels=$(grep -c '^CMD=codex$' "$FAUX_CODEX_JOURNAL")
fil=$3
case "$FAUX_CODEX_MODE" in
  ok) echo "Queued message 0199-msg for thread $fil"; exit 0 ;;
  sans-session-puis-ok)
    if [ "$appels" -ge 2 ]; then echo "Queued message 0199-msg for thread $fil"; exit 0; fi
    echo "Error: No active session found matching '$fil'" >&2; exit 1 ;;
  sans-session) echo "Error: No active session found matching '$fil'" >&2; exit 1 ;;
  sans-rollout) echo "thread/queue/add failed: no rollout found for thread id $fil (code -32603)" >&2; exit 1 ;;
  sans-rollout-puis-ok)
    if [ "$appels" -ge 2 ]; then echo "Queued message 0199-msg for thread $fil"; exit 0; fi
    echo "thread/queue/add failed: no rollout found for thread id $fil (code -32603)" >&2; exit 1 ;;
  sans-rollout-puis-sans-session)
    if [ "$appels" -ge 2 ]; then echo "Error: No active session found matching '$fil'" >&2; exit 1; fi
    echo "thread/queue/add failed: no rollout found for thread id $fil (code -32603)" >&2; exit 1 ;;
  bavard)
    i=0; while [ "$i" -lt 6000 ]; do echo "noise $i on stderr, long enough to fill any pipe buffer"; i=$((i+1)); done >&2
    echo "Queued message 0199-msg for thread $fil"; exit 0 ;;
  refus) echo "some other failure" >&2; exit 7 ;;
  pend) exec sleep 60 ;;
esac
exit 9
`;

const SCRIPT_FAUX_OPEN = String.raw`#!/bin/sh
# Le faux open de test/porte-codex.test.js : il journalise, puis joue le mode demande.
{
  printf 'CMD=open\n'
  printf 'PID=%s\n' "$$"
  for a in "$@"; do printf 'ARG=%s\n' "$a"; done
  printf -- '--\n'
} >> "$FAUX_CODEX_JOURNAL"
case "$FAUX_OPEN_MODE" in
  ok) exit 0 ;;
  refus) echo "LSOpenURLsWithRole() failed" >&2; exit 1 ;;
  pend) exec sleep 60 ;;
esac
exit 9
`;

// Le faux lsappinfo : il journalise, puis dit que l'app tourne, qu'elle est fermée, ou se trompe.
const SCRIPT_FAUX_LSAPPINFO = String.raw`#!/bin/sh
{
  printf 'CMD=lsappinfo
'
  for a in "$@"; do printf 'ARG=%s
' "$a"; done
  printf -- '--
'
} >> "$FAUX_CODEX_JOURNAL"
case "$FAUX_LSAPPINFO_MODE" in
  tourne) echo 'ASN:0x0-0x2f72f7-"ChatGPT":'; exit 0 ;;
  fermee) exit 0 ;;
  bavarde) echo "something unexpected"; exit 0 ;;
  erreur) echo "lsappinfo failed" >&2; exit 1 ;;
  pend) exec sleep 60 ;;
esac
exit 9
`;

function lireLeJournal(fichier) {
  const texte = fs.existsSync(fichier) ? fs.readFileSync(fichier, "utf8") : "";
  return texte
    .split("--\n")
    .filter((bloc) => bloc.trim())
    .map((bloc) => {
      const appel = { cmd: null, home: null, pid: null, args: [] };
      for (const ligne of bloc.split("\n")) {
        if (ligne.startsWith("CMD=")) appel.cmd = ligne.slice(4);
        else if (ligne.startsWith("HOME=")) appel.home = ligne.slice(5);
        else if (ligne.startsWith("CWD=")) appel.cwd = ligne.slice(4);
        else if (ligne.startsWith("PID=")) appel.pid = Number(ligne.slice(4));
        else if (ligne.startsWith("ARG=")) appel.args.push(ligne.slice(4));
      }
      return appel;
    });
}

// Les deux faux dans un dossier jetable, et le `lancer` qui les lance par leur chemin ABSOLU :
// aucune recherche sur le PATH, donc ni le vrai `codex` ni le vrai `open` ne peuvent partir.
// Toute autre commande est refusée (le `lancer` lève, la porte en fait un verdict). Les pids se
// notent AU LANCEMENT (`lances`), pas dans le journal du script : un enfant tué avant d'avoir
// écrit sa première ligne (une machine chargée, toute la suite en parallèle) reste vérifiable.
//
// LES FAUX S'ÉCRIVENT UNE FOIS PAR FICHIER (durcissement des délais, 22/10). macOS examine un
// exécutable neuf à son premier lancement : 150 à 370 ms mesurés à vide, contre 4 à 8 ms ensuite,
// et sous charge ce premier passage se fait attendre bien davantage. Chaque test écrivait ses faux
// neufs et payait ce premier lancement DANS le délai de la porte. Les trois faux s'écrivent donc une
// fois, se lancent une fois à blanc avant le premier test (`rodageDesFaux`), et chaque `fauxCodex()`
// garde son propre journal : le mode et le journal passent par l'environnement, comme avant.
let dossierDesFaux = null;
function lesFaux() {
  if (dossierDesFaux) return dossierDesFaux;
  dossierDesFaux = decorJetable("cc2cc-faux-codex-scripts-");
  fs.writeFileSync(path.join(dossierDesFaux, "codex"), SCRIPT_FAUX_CODEX, { mode: 0o755 });
  fs.writeFileSync(path.join(dossierDesFaux, "open"), SCRIPT_FAUX_OPEN, { mode: 0o755 });
  fs.writeFileSync(path.join(dossierDesFaux, "lsappinfo"), SCRIPT_FAUX_LSAPPINFO, { mode: 0o755 });
  return dossierDesFaux;
}
// Un premier lancement de chaque faux, à blanc (un journal jetable) : le premier test n'en paie pas le prix.
function roder(fichier, env) {
  const blanc = path.join(decorJetable("cc2cc-faux-codex-rodage-"), "journal.txt");
  const fin = spawnSync(fichier, ["queue"], { encoding: "utf8", timeout: 60_000, env: { ...envPropre(), FAUX_CODEX_JOURNAL: blanc, ...env } });
  assert.equal(fin.status, 0, `SONDE IMPOSSIBLE : le rodage de ${path.basename(fichier)} échoue (${fin.error?.message ?? fin.stderr})`);
}
function rodageDesFaux() {
  const dossier = lesFaux();
  roder(path.join(dossier, "codex"), { FAUX_CODEX_MODE: "ok" });
  roder(path.join(dossier, "open"), { FAUX_OPEN_MODE: "ok" });
  roder(path.join(dossier, "lsappinfo"), { FAUX_LSAPPINFO_MODE: "fermee" });
}
before(rodageDesFaux);

function fauxCodex(mode, { modeOpen = "ok", modeLsappinfo = "tourne" } = {}) {
  const scripts = lesFaux();
  const dossier = decorJetable("cc2cc-faux-codex-");
  const journal = path.join(dossier, "journal.txt");
  const lances = [];
  const lancer = (commande, args, options = {}) => {
    if (!["codex", "open", "lsappinfo"].includes(commande)) {
      throw Object.assign(new Error(`only the fakes run here, not ${commande}`), { code: "EFAUX" });
    }
    const enfant = spawn(path.join(scripts, commande), args, {
      ...options,
      env: {
        ...(options.env || {}),
        FAUX_CODEX_JOURNAL: journal,
        FAUX_CODEX_MODE: mode,
        FAUX_OPEN_MODE: modeOpen,
        FAUX_LSAPPINFO_MODE: modeLsappinfo
      }
    });
    lances.push({ commande, args, pid: enfant.pid });
    return enfant;
  };
  return {
    dossier,
    journal,
    lancer,
    lances,
    // Le pid du petit-enfant que les modes « petit-fils » laissent derrière eux.
    petitFils: () => {
      const fichier = `${journal}.gpid`;
      return fs.existsSync(fichier) ? Number(fs.readFileSync(fichier, "utf8").trim()) : null;
    },
    appels: () => lireLeJournal(journal).filter((a) => a.cmd === "codex"),
    ouvertures: () => lireLeJournal(journal).filter((a) => a.cmd === "open"),
    detections: () => lireLeJournal(journal).filter((a) => a.cmd === "lsappinfo")
  };
}

// Un processus est-il encore là ? Un petit-enfant orphelin est repris et récolté par launchd
// (ou init) un instant après la mort de son parent : on attend la récolte, une seconde au plus.
// N1 (re-revue du round 2) : sous charge, un test du couperet passe `dimensionner(1000, latence)` —
// une seconde à vide, dix latences sous charge. Jamais une attente fixe et large : un couperet qui
// tuerait trois secondes trop tard doit rougir (prouvé par mutant, voir le rapport FINAL-3).
async function mortAvant(pid, ms = 1000) {
  const fin = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (erreur) {
      if (erreur.code === "ESRCH") return true;
      throw erreur;
    }
    if (Date.now() > fin) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Le ménage : un petit-enfant qu'un test laisse vivre par dessein ne lui survit pas.
function tuerSiVivant(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* déjà parti */
  }
}

// ── LE TEMPS SOUS CHARGE (durcissement des délais, 22/10) ──────────────────────────────────────
// Sur une machine chargée (deux suites à la fois, d'autres sessions, une CI à deux cœurs), lancer
// `sh` et le faux `codex` a pris plusieurs secondes : un délai deviné (800 ms, 1,2 s, 2 s, 5 s)
// tombait avant la fin d'un faux qui sortait normalement, et le test disait `codex-delai` d'une
// porte saine. Deux règles, et aucune propriété ne change :
//   · un test qui ne parle pas du délai donne à la porte un délai et une grâce qui ne tomberont
//     pas pendant qu'un faux se lance (`sonnerSansHate`, `appSansHate`, 60 s et 10 s) : une porte
//     qui pendrait pour de bon rendrait toujours `codex-delai`, et le test rougirait ;
//   · un test qui PROUVE un délai (le couperet, la grâce, le budget de la porte) le dimensionne
//     sur la latence MESURÉE juste avant lui (`mesurerLaLatence`, le pire de trois lancements du
//     faux) : le délai est au moins dix fois cette latence, et la marge d'une borne haute aussi
//     (`dimensionner`). À vide, la latence est de quelques millisecondes : les valeurs d'avant
//     restent les planchers, et les tests durent ce qu'ils duraient.
const DELAI_TRANQUILLE = 60_000;
const GRACE_TRANQUILLE = 10_000;
// Un bail de tentative large pour les tournées dont la porte tient un délai dimensionné : la
// clôture exige le bail encore tenu (round.js), et le bail n'est pas ce que ces tests prouvent.
const BAIL_LARGE = 10 * 60_000;
async function mesurerLaLatence(essais = 3) {
  let pire = 0;
  for (let i = 0; i < essais; i += 1) {
    const depart = performance.now();
    const fin = await lancerBorne({ commande: "codex", args: ["queue"], lancer: fauxCodex("ok").lancer, delaiMs: DELAI_TRANQUILLE, graceMs: GRACE_TRANQUILLE });
    assert.deepEqual([fin.tue, fin.code], [false, 0], "SONDE IMPOSSIBLE : le faux codex ne sort pas normalement");
    pire = Math.max(pire, performance.now() - depart);
  }
  return Math.ceil(pire);
}
// Au moins `plancher` (la valeur que le test prenait), au moins `fois` × la latence, 60 s au plus.
const dimensionner = (plancher, latence, fois = 10) => Math.min(60_000, Math.max(plancher, Math.ceil(fois * latence)));
const sonnerSansHate = (options) => sonnerLaChaiseCodex({ delaiMs: DELAI_TRANQUILLE, graceMs: GRACE_TRANQUILLE, ...options });
const appSansHate = (options) => appCodexOuverte({ delaiMs: DELAI_TRANQUILLE, graceMs: GRACE_TRANQUILLE, ...options });

// Un ouvreur de carton : il note le lien et rend le verdict demandé. Jamais le vrai `open`.
function ouvreurDeCarton(verdict = { ok: true }) {
  const liens = [];
  const ouvrir = (lien) => {
    liens.push(lien);
    return typeof verdict === "function" ? verdict(lien) : verdict;
  };
  return { liens, ouvrir };
}

// ── LE BUREAU ET LA TOURNÉE (montage de test/facteur.test.js) ─────────────────────────────────
function bureauDePoste(t) {
  const root = decorJetable("cc2cc-porte-codex-home-");
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
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

// Une chaise Claude Code vivante : une instance au registre + la boîte que l'inventaire rend.
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

// Une chaise Codex vivante : la fiche (Tâche 9) + une ligne `peers` qui mène au même fil
// (`instance_session_id = thread_id`, `house = codex_home`), comme `ecrireFicheCodex` l'inscrit.
function ficheCodexVivante(db, { lignee = "hal-test", fil = FICHE.thread_id, codexHome = FICHE.codex_home, pid = 4343 } = {}) {
  registerInstance(db, { lineage: lignee, sessionId: fil, house: codexHome, pid });
  return { ...FICHE, lineage: lignee, thread_id: fil, codex_home: codexHome, pid };
}

// L'inventaire que rend la tournée des maisons : les boîtes ET les maisons parcourues.
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

// Un guichet de carton (la porte native) : il note ce qu'on lui tend et rend le verdict demandé.
function guichetDeCarton(verdict = { ok: true, etat: "remis-au-guichet" }) {
  const remises = [];
  const remettre = async (arg) => {
    remises.push(arg);
    return verdict;
  };
  return { remises, remettre };
}

// Une sonnette de carton (la porte Codex) : elle note ce qu'on lui demande et rend le verdict.
function sonnetteDeCarton(resultat = { ok: true, mode: "queue" }) {
  const appels = [];
  const sonner = async (arg) => {
    appels.push(arg);
    return typeof resultat === "function" ? resultat(arg, appels.length) : resultat;
  };
  return { appels, sonner };
}

// Les dépendances communes : aucune maison réelle, aucune vraie pause.
function depsDeBase(extra = {}) {
  return { maisons: [], dormir: async () => {}, ...extra };
}

// La tournée d'une chaise Codex seule : aucune boîte native à servir, une fiche, une sonnette.
function depsCodex(fiche, sonnette, extra = {}) {
  return depsDeBase({
    tourHouses: inventaire([]),
    fichesCodex: () => [fiche],
    sonnerLaChaiseCodex: sonnette.sonner,
    remettreAuGuichet: async () => {
      throw new Error("aucune boîte native à servir ici");
    },
    ...extra
  });
}

// ── LA PORTE, SEULE ────────────────────────────────────────────────────────────────────────────
test("sonnerLaChaiseCodex lance `codex queue --thread <fil> --message <enveloppe>` sous le CODEX_HOME de la fiche ; la file prend l'enveloppe : mode queue, l'app reste fermée", async () => {
  const codex = fauxCodex("ok");
  const ouvreur = ouvreurDeCarton();
  const verdict = await sonnerSansHate({
    fiche: FICHE,
    enveloppe: ENVELOPPE,
    lancer: codex.lancer,
    ouvrir: ouvreur.ouvrir,
    plateforme: "darwin",
    appOuverte: () => true
  });
  assert.deepEqual(verdict, { ok: true, mode: "queue" });
  const appels = codex.appels();
  assert.equal(appels.length, 1, "une frappe, pas deux");
  assert.equal(appels[0].home, FICHE.codex_home, "le CODEX_HOME de la fiche, jamais celui du Facteur");
  assert.deepEqual(appels[0].args, ["queue", "--thread", FICHE.thread_id, "--message", ENVELOPPE]);
  assert.deepEqual(argumentsDeSonnette(FICHE, ENVELOPPE), appels[0].args, "la commande se construit au même endroit qu'elle se lance");
  assert.deepEqual(ouvreur.liens, [], "la file a pris l'enveloppe : on n'ouvre pas l'app");
  assert.ok(FIL_SANS_SESSION.test("Error: No active session found matching 'x'"));
  assert.ok(FIL_SANS_SESSION.test("thread/queue/add failed: no rollout found for thread id x"));
  assert.ok(!FIL_SANS_SESSION.test("Queued message 0199 for thread x"));
  assert.ok(PERSONNE_NE_TIENT_LE_FIL.test("Error: No active session found matching 'x'"));
  assert.ok(!PERSONNE_NE_TIENT_LE_FIL.test("no rollout found for thread id x"), "un fil sans tour n'est pas un fil que personne ne tient");
  assert.equal(MOTIF_SONNETTE_IMPOSSIBLE, "sonnette-codex-impossible");
  assert.equal(MOTIF_SONNETTE_DEJA_SONNEE, "sonnette-codex-deja-sonnee");
});

test("le pid de la fiche n'est JAMAIS une décision : pid mort ou vivant, une file qui prend l'enveloppe ne fait pas ouvrir l'app quand l'app tourne", async () => {
  const ouvreur = ouvreurDeCarton();
  for (const pid of [process.pid, 2 ** 22 + 12345, null]) {
    const codex = fauxCodex("ok");
    const verdict = await sonnerSansHate({
      fiche: { ...FICHE, pid },
      enveloppe: ENVELOPPE,
      lancer: codex.lancer,
      ouvrir: ouvreur.ouvrir,
      // Un témoin de vie tendu à la porte (l'ancien `vivant` du brief) : elle ne l'écoute pas.
      vivant: () => false,
      // L'app tourne : c'est elle, et elle seule, qui dirait d'ouvrir (round 1, constat 1).
      appOuverte: () => true,
      plateforme: "darwin"
    });
    assert.deepEqual(verdict, { ok: true, mode: "queue" }, `pid ${pid}`);
  }
  assert.deepEqual(ouvreur.liens, [], "seule la réponse de `codex queue` dit que personne ne tient le fil");
});

test("`No active session` : une relance par l'uuid ; elle passe : l'app s'ouvre sur le fil (queue+open) — sauf ouvrirApp: false ou hors macOS ; une ouverture qui rate se dit", async () => {
  const fil = lienDuFil(FICHE.thread_id);
  assert.equal(fil, `codex://threads/${FICHE.thread_id}`);

  const codex = fauxCodex("sans-session-puis-ok");
  const ouvreur = ouvreurDeCarton();
  const base = { fiche: FICHE_APP, enveloppe: ENVELOPPE, ouvrir: ouvreur.ouvrir };
  assert.deepEqual(await sonnerSansHate({ ...base, lancer: codex.lancer, plateforme: "darwin" }), { ok: true, mode: "queue+open" });
  const appels = codex.appels();
  assert.equal(appels.length, 2, "la première frappe a dit « No active session » : une relance, une seule");
  assert.deepEqual(appels[1].args, appels[0].args, "la relance vise le même uuid, avec la même enveloppe");
  assert.deepEqual(ouvreur.liens, [fil], "la file vient de dire que personne ne tenait le fil : on ouvre l'app dessus");

  assert.deepEqual(
    await sonnerSansHate({ ...base, lancer: fauxCodex("sans-session-puis-ok").lancer, plateforme: "darwin", ouvrirApp: false }),
    { ok: true, mode: "queue" }
  );
  assert.deepEqual(
    await sonnerSansHate({ ...base, lancer: fauxCodex("sans-session-puis-ok").lancer, plateforme: "linux" }),
    { ok: true, mode: "queue" }
  );
  assert.equal(ouvreur.liens.length, 1, "ni le réglage à zéro ni une autre plateforme n'ouvrent quoi que ce soit");

  // Une ouverture qui rate ne retire rien de la file : ok reste vrai, et l'erreur se dit.
  const rate = await sonnerSansHate({
    ...base,
    lancer: fauxCodex("sans-session-puis-ok").lancer,
    plateforme: "darwin",
    ouvrir: () => ({ ok: false, erreur: "no-app" })
  });
  assert.deepEqual(rate, { ok: true, mode: "queue", erreur: "open-impossible" });
  const leve = await sonnerSansHate({
    ...base,
    lancer: fauxCodex("sans-session-puis-ok").lancer,
    plateforme: "darwin",
    ouvrir: () => {
      throw new Error("boom");
    }
  });
  assert.deepEqual(leve, { ok: true, mode: "queue", erreur: "open-impossible" }, "un ouvreur qui lève ne fait pas lever la porte");
  assert.equal(ouvertureTentee({ ok: true, mode: "queue+open" }), true);
  assert.equal(ouvertureTentee(rate), true, "une ouverture ratée a été tentée");
  assert.equal(ouvertureTentee({ ok: true, mode: "queue" }), false);
});

test("`No active session` deux fois : personne ne tient le fil et la file refuse — l'app s'ouvre sur le fil (mode open), la lettre n'est PAS en file (ok: false)", async () => {
  const codex = fauxCodex("sans-session");
  const ouvreur = ouvreurDeCarton();
  const verdict = await sonnerSansHate({ fiche: FICHE_APP, enveloppe: ENVELOPPE, lancer: codex.lancer, ouvrir: ouvreur.ouvrir, plateforme: "darwin" });
  assert.equal(verdict.ok, false, "l'enveloppe n'est dans aucune file : rien n'est porté");
  assert.equal(verdict.mode, "open");
  assert.equal(verdict.erreur, "codex-fil-sans-session");
  assert.match(verdict.detail, /No active session/);
  assert.equal(codex.appels().length, 2);
  assert.deepEqual(ouvreur.liens, [lienDuFil(FICHE.thread_id)], "l'app s'ouvre sur le fil : la prochaine tournée y trouvera une session");
  assert.equal(ouvertureTentee(verdict), true);

  // Réglage à zéro : la file refuse, rien ne s'ouvre.
  const eteint = await sonnerSansHate({ fiche: FICHE_APP, enveloppe: ENVELOPPE, lancer: fauxCodex("sans-session").lancer, ouvrir: ouvreur.ouvrir, plateforme: "darwin", ouvrirApp: false });
  assert.deepEqual(Object.keys(eteint).sort(), ["detail", "erreur", "mode", "ok"]);
  assert.equal(eteint.mode, null);
  assert.equal(eteint.erreur, "codex-fil-sans-session");
  assert.equal(ouvertureTentee(eteint), false);
  assert.equal(ouvreur.liens.length, 1);

  // L'ouverture rate aussi : la cause reste la file ; l'ouverture ratée se dit à côté.
  const deuxFois = await sonnerSansHate({
    fiche: FICHE_APP,
    enveloppe: ENVELOPPE,
    lancer: fauxCodex("sans-session").lancer,
    ouvrir: () => ({ ok: false }),
    plateforme: "darwin"
  });
  assert.equal(deuxFois.ok, false);
  assert.equal(deuxFois.mode, null);
  assert.equal(deuxFois.erreur, "codex-fil-sans-session");
  assert.equal(deuxFois.ouverture, "open-impossible");
  assert.equal(ouvertureTentee(deuxFois), true);
});

test("un fil sans tour (`no rollout found`) : relance ; refusée encore, rien n'est ouvert (codex-fil-sans-session) ; passée, c'est une session en plein premier tour : mode queue, l'app reste fermée", async () => {
  const ouvreur = ouvreurDeCarton();
  const codex = fauxCodex("sans-rollout");
  const verdict = await sonnerSansHate({ fiche: FICHE_APP, enveloppe: ENVELOPPE, lancer: codex.lancer, ouvrir: ouvreur.ouvrir, plateforme: "darwin" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.mode, null);
  assert.equal(verdict.erreur, "codex-fil-sans-session");
  assert.match(verdict.detail, /no rollout found/);
  assert.equal(codex.appels().length, 2, "la relance a eu lieu, et elle a refusé aussi");

  const puisOk = fauxCodex("sans-rollout-puis-ok");
  let detecte = 0;
  assert.deepEqual(
    await sonnerSansHate({
      fiche: FICHE_APP,
      enveloppe: ENVELOPPE,
      lancer: puisOk.lancer,
      ouvrir: ouvreur.ouvrir,
      plateforme: "darwin",
      appOuverte: () => {
        detecte += 1;
        return false;
      }
    }),
    { ok: true, mode: "queue" }
  );
  assert.equal(puisOk.appels().length, 2);
  assert.equal(detecte, 0, "après un « no rollout found », on ne demande même pas si l'app tourne");

  // La relance seule décide : « no rollout » puis « No active session » → personne ne tient le fil.
  const puisSansSession = await sonnerSansHate({
    fiche: FICHE_APP,
    enveloppe: ENVELOPPE,
    lancer: fauxCodex("sans-rollout-puis-sans-session").lancer,
    ouvrir: ouvreur.ouvrir,
    plateforme: "darwin"
  });
  assert.equal(puisSansSession.mode, "open");
  assert.deepEqual(ouvreur.liens, [lienDuFil(FICHE.thread_id)], "un fil sans tour ne s'ouvre jamais : rien ne l'y recevrait");
});

test("un refus d'une autre nature (code 7, sans les mots connus) : { ok: false, erreur: \"codex-refus\" }, une seule frappe", async () => {
  const codex = fauxCodex("refus");
  const verdict = await sonnerSansHate({ fiche: FICHE, enveloppe: ENVELOPPE, lancer: codex.lancer, ouvrir: ouvreurDeCarton().ouvrir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.mode, null);
  assert.equal(verdict.erreur, "codex-refus");
  assert.match(verdict.detail, /some other failure/);
  assert.equal(codex.appels().length, 1);
});

test("`codex` introuvable sur le PATH : { ok: false, erreur: \"codex-introuvable\" } — un verdict, jamais une exception ; un lancer qui lève : codex-injoignable", async () => {
  const vide = decorJetable("cc2cc-sans-codex-");
  // La vraie recherche sur un PATH qui ne contient RIEN : ENOENT, et aucun binaire ne part.
  const lancer = (commande, args, options = {}) => spawn(commande, args, { ...options, env: { ...(options.env || {}), PATH: vide } });
  assert.deepEqual(
    await sonnerSansHate({
      fiche: FICHE,
      enveloppe: ENVELOPPE,
      lancer,
      ouvrir: () => {
        throw new Error("rien à ouvrir sans codex");
      },
      plateforme: "darwin"
    }),
    { ok: false, mode: null, erreur: "codex-introuvable" }
  );
  const leve = await sonnerSansHate({
    fiche: FICHE,
    enveloppe: ENVELOPPE,
    lancer: () => {
      throw Object.assign(new Error("spawn refused"), { code: "EACCES" });
    }
  });
  assert.deepEqual(leve, { ok: false, mode: null, erreur: "codex-injoignable", detail: "EACCES" });
});

test("une fiche sans fil ou sans CODEX_HOME ne lance rien : { erreur: \"fiche-incomplete\" }", async () => {
  const codex = fauxCodex("ok");
  assert.deepEqual(
    await sonnerSansHate({ fiche: { lineage: "hal-test", thread_id: FICHE.thread_id }, enveloppe: ENVELOPPE, lancer: codex.lancer }),
    { ok: false, mode: null, erreur: "fiche-incomplete" }
  );
  assert.deepEqual(
    await sonnerSansHate({ fiche: { lineage: "hal-test", codex_home: FICHE.codex_home }, enveloppe: ENVELOPPE, lancer: codex.lancer }),
    { ok: false, mode: null, erreur: "fiche-incomplete" }
  );
  assert.deepEqual(await sonnerSansHate({ fiche: null, enveloppe: ENVELOPPE, lancer: codex.lancer }), { ok: false, mode: null, erreur: "fiche-incomplete" });
  assert.equal(codex.appels().length, 0, "aucune frappe sans fiche entière");
});

test("sans ouvreur injecté, la porte lance `open <lien du fil>` par le même lanceur (ici le faux open, jamais le vrai)", async () => {
  const codex = fauxCodex("sans-session-puis-ok");
  assert.deepEqual(await sonnerSansHate({ fiche: FICHE_APP, enveloppe: ENVELOPPE, lancer: codex.lancer, plateforme: "darwin" }), { ok: true, mode: "queue+open" });
  const ouvertures = codex.ouvertures();
  assert.equal(ouvertures.length, 1);
  assert.deepEqual(ouvertures[0].args, [lienDuFil(FICHE.thread_id)]);

  const refus = fauxCodex("sans-session-puis-ok", { modeOpen: "refus" });
  assert.deepEqual(
    await sonnerSansHate({ fiche: FICHE_APP, enveloppe: ENVELOPPE, lancer: refus.lancer, plateforme: "darwin" }),
    { ok: true, mode: "queue", erreur: "open-impossible" },
    "un `open` qui sort en erreur est une ouverture ratée"
  );
});

// ── POINT DE REVUE 4 — LA PORTE NE PEND JAMAIS ─────────────────────────────────────────────────
test("point de revue 4 — un `codex` qui pend est tué au délai : { erreur: \"codex-delai\" } dans la marge du délai, et l'enfant est MORT", async () => {
  // Délai et marge suivent la latence mesurée : 800 ms et 2,2 s au moins (les valeurs d'avant).
  const latence = await mesurerLaLatence();
  const DELAI = dimensionner(800, latence);
  const MARGE = dimensionner(2200, latence);
  const codex = fauxCodex("pend");
  const depart = Date.now();
  const verdict = await sonnerLaChaiseCodex({ fiche: FICHE, enveloppe: ENVELOPPE, lancer: codex.lancer, delaiMs: DELAI, ouvrir: ouvreurDeCarton().ouvrir });
  const duree = Date.now() - depart;
  assert.deepEqual(verdict, { ok: false, mode: null, erreur: "codex-delai" });
  assert.ok(duree < DELAI + MARGE, `la porte a rendu la main en ${duree} ms (délai ${DELAI} ms, marge ${MARGE} ms, latence ${latence} ms)`);
  assert.ok(duree >= DELAI - 50, `…mais pas avant le délai (${duree} ms)`);
  assert.equal(codex.lances.length, 1, "un `codex` tué au délai ne se relance pas");
  const [lance] = codex.lances;
  assert.ok(lance.pid > 0, "SONDE IMPOSSIBLE : aucun pid au lancement");
  assert.ok(await mortAvant(lance.pid, dimensionner(1000, latence)), "l'enfant est mort : la tournée ne traîne aucun processus derrière elle");
  assert.equal(DELAI_SONNETTE_MS, 5000, "le délai par défaut est celui de la spec : 5 s");
});

test("point de revue 4 — un `codex` qui inonde stderr (plus qu'un tube ne contient) n'est pas bloqué : sa sortie est bue, le verdict reste ok", async () => {
  const codex = fauxCodex("bavard");
  const depart = Date.now();
  // Le délai sans hâte : un enfant bloqué sur un tube plein ne sortirait jamais seul, le couperet
  // tomberait, et le verdict serait `codex-delai` — c'est ce verdict qui prouve qu'il a fini seul.
  const verdict = await sonnerSansHate({ fiche: FICHE, enveloppe: ENVELOPPE, lancer: codex.lancer, ouvrir: ouvreurDeCarton().ouvrir });
  assert.deepEqual(verdict, { ok: true, mode: "queue" });
  assert.ok(Date.now() - depart < DELAI_TRANQUILLE, "l'enfant a fini seul : il n'a pas attendu le couperet sur un tube plein");
  const borne = await lancerBorne({ commande: "codex", args: ["queue"], lancer: fauxCodex("bavard").lancer, delaiMs: DELAI_TRANQUILLE, graceMs: GRACE_TRANQUILLE });
  assert.ok(borne.sortie.length <= 4096, `la sortie gardée est bornée (${borne.sortie.length})`);
  assert.equal(borne.code, 0);
  assert.equal(borne.tue, false);
});

test("point de revue 4 — la porte entière tient dans deux délais : un `open` ou un ouvreur qui pend ne la retient pas au-delà", async () => {
  // Délai, grâce et marge suivent la latence mesurée (1,2 s, la grâce de production et un délai
  // au moins) : deux frappes de `codex` tiennent dans un délai, et le budget reste deux délais.
  const latence = await mesurerLaLatence();
  const DELAI = dimensionner(1200, latence);
  const GRACE = dimensionner(200, latence);
  const MARGE = dimensionner(1200, latence);
  // Un ouvreur injecté qui ne répond jamais.
  let depart = Date.now();
  const silencieux = await sonnerLaChaiseCodex({
    fiche: FICHE_APP,
    enveloppe: ENVELOPPE,
    lancer: fauxCodex("sans-session-puis-ok").lancer,
    delaiMs: DELAI,
    graceMs: GRACE,
    ouvrir: () => new Promise(() => {}),
    plateforme: "darwin"
  });
  let duree = Date.now() - depart;
  assert.deepEqual(silencieux, { ok: true, mode: "queue", erreur: "open-impossible" });
  assert.ok(duree < 2 * DELAI + MARGE, `la porte a rendu la main en ${duree} ms (budget : 2 × ${DELAI} ms, marge ${MARGE} ms, latence ${latence} ms)`);

  // Le vrai chemin de production (sans ouvreur) avec un faux `open` qui pend : tué, et mort.
  const codex = fauxCodex("sans-session-puis-ok", { modeOpen: "pend" });
  depart = Date.now();
  const pendu = await sonnerLaChaiseCodex({ fiche: FICHE_APP, enveloppe: ENVELOPPE, lancer: codex.lancer, delaiMs: DELAI, graceMs: GRACE, plateforme: "darwin" });
  duree = Date.now() - depart;
  assert.deepEqual(pendu, { ok: true, mode: "queue", erreur: "open-impossible" });
  assert.ok(duree < 2 * DELAI + MARGE, `la porte a rendu la main en ${duree} ms`);
  const ouverture = codex.lances.find((l) => l.commande === "open");
  assert.ok(ouverture?.pid > 0, "SONDE IMPOSSIBLE : aucun `open` lancé");
  assert.deepEqual(ouverture.args, [lienDuFil(FICHE.thread_id)]);
  assert.ok(await mortAvant(ouverture.pid, dimensionner(1000, latence)), "le `open` qui pendait est mort");
});

// ── ROUND 1, CONSTAT 1 — LA FILE PREND L'ENVELOPPE, L'APP EST FERMÉE ─────────────────────────────
// Sonde P10 : app fermée, `codex queue --thread <uuid>` accepte la lettre (le fil reste actif sur le
// démon partagé), et seule `open codex://threads/<uuid>` la fait partir. « No active session » ne
// suffit donc pas : la porte demande si l'app tourne (`appOuverte`, par défaut `lsappinfo` sur le
// bundle id de l'app). `false` — et lui seul — fait ouvrir ; `true` ou « on ne sait pas » (null,
// une erreur, un détecteur qui pend) n'ouvrent rien.
test("round 1 — la file prend l'enveloppe et l'app est fermée (appOuverte: false) : l'app s'ouvre sur le fil (queue+open) ; ouverte ou inconnue : rien", async () => {
  const fil = lienDuFil(FICHE.thread_id);
  const sonner = (extra) => sonnerSansHate({ fiche: FICHE_APP, enveloppe: ENVELOPPE, lancer: fauxCodex("ok").lancer, plateforme: "darwin", ...extra });

  const fermee = ouvreurDeCarton();
  assert.deepEqual(await sonner({ ouvrir: fermee.ouvrir, appOuverte: () => false }), { ok: true, mode: "queue+open" });
  assert.deepEqual(fermee.liens, [fil]);
  assert.deepEqual(
    await sonner({ ouvrir: () => ({ ok: false }), appOuverte: async () => false }),
    { ok: true, mode: "queue", erreur: "open-impossible" },
    "une ouverture qui rate se dit ; la file garde l'enveloppe"
  );

  const rien = ouvreurDeCarton();
  for (const [nom, appOuverte] of [
    ["ouverte", () => true],
    ["inconnue", () => null],
    ["qui-leve", () => {
      throw new Error("detector broke");
    }],
    ["non-booleen", () => "maybe"]
  ]) {
    assert.deepEqual(await sonner({ ouvrir: rien.ouvrir, appOuverte }), { ok: true, mode: "queue" }, nom);
  }
  assert.deepEqual(rien.liens, [], "seul `false` fait ouvrir l'app");

  // Un détecteur qui pend : on ne sait pas, et la porte tient dans ses deux délais (dimensionnés
  // sur la latence mesurée, 1,2 s au moins ; la grâce aussi).
  const latence = await mesurerLaLatence();
  const DELAI = dimensionner(1200, latence);
  const MARGE = dimensionner(1200, latence);
  const depart = Date.now();
  assert.deepEqual(
    await sonner({ ouvrir: rien.ouvrir, appOuverte: () => new Promise(() => {}), delaiMs: DELAI, graceMs: dimensionner(200, latence) }),
    { ok: true, mode: "queue" }
  );
  assert.ok(Date.now() - depart < 2 * DELAI + MARGE, `un détecteur qui pend ne retient pas la porte (latence ${latence} ms)`);
  assert.deepEqual(rien.liens, []);
});

test("round 1 — VALXOS_CODEX_OUVRIR_APP=0 (ouvrirApp: false) ou hors macOS : le détecteur n'est même pas appelé", async () => {
  let appels = 0;
  const appOuverte = () => {
    appels += 1;
    return false;
  };
  const ouvreur = ouvreurDeCarton();
  for (const extra of [{ ouvrirApp: false, plateforme: "darwin" }, { plateforme: "linux" }]) {
    assert.deepEqual(
      await sonnerSansHate({ fiche: FICHE_APP, enveloppe: ENVELOPPE, lancer: fauxCodex("ok").lancer, ouvrir: ouvreur.ouvrir, appOuverte, ...extra }),
      { ok: true, mode: "queue" }
    );
  }
  assert.equal(appels, 0);
  assert.deepEqual(ouvreur.liens, []);
});

test("round 1 — le détecteur par défaut lance `lsappinfo find bundleid=com.openai.codex` par le lanceur : ASN → ouverte, vide → fermée, erreur ou absent → inconnue", async () => {
  assert.equal(BUNDLE_APP_CODEX, "com.openai.codex");
  const tourne = fauxCodex("ok", { modeLsappinfo: "tourne" });
  assert.equal(await appSansHate({ lancer: tourne.lancer, plateforme: "darwin" }), true);
  assert.deepEqual(tourne.detections()[0].args, ["find", "bundleid=com.openai.codex"]);
  assert.equal(await appSansHate({ lancer: fauxCodex("ok", { modeLsappinfo: "fermee" }).lancer, plateforme: "darwin" }), false);
  assert.equal(await appSansHate({ lancer: fauxCodex("ok", { modeLsappinfo: "bavarde" }).lancer, plateforme: "darwin" }), null);
  assert.equal(await appSansHate({ lancer: fauxCodex("ok", { modeLsappinfo: "erreur" }).lancer, plateforme: "darwin" }), null);
  const vide = decorJetable("cc2cc-sans-lsappinfo-");
  const sansCommande = (commande, args, options = {}) => spawn(commande, args, { ...options, env: { ...(options.env || {}), PATH: vide } });
  assert.equal(await appSansHate({ lancer: sansCommande, plateforme: "darwin" }), null, "commande absente : on ne sait pas");
  const pend = fauxCodex("ok", { modeLsappinfo: "pend" });
  const latence = await mesurerLaLatence();
  const DELAI = dimensionner(500, latence);
  const MARGE = dimensionner(1500, latence);
  const depart = Date.now();
  assert.equal(await appCodexOuverte({ lancer: pend.lancer, plateforme: "darwin", delaiMs: DELAI }), null, "un lsappinfo qui pend : on ne sait pas");
  assert.ok(Date.now() - depart < DELAI + MARGE, `un lsappinfo qui pend est tué au délai (${DELAI} ms, marge ${MARGE} ms)`);
  let lance = false;
  assert.equal(
    await appSansHate({
      lancer: () => {
        lance = true;
        throw new Error("never on linux");
      },
      plateforme: "linux"
    }),
    null,
    "hors macOS : inconnue, rien n'est lancé"
  );
  assert.equal(lance, false);

  // Et la porte s'en sert quand on ne lui tend rien : l'app fermée fait ouvrir, l'app qui tourne non.
  const ouvreur = ouvreurDeCarton();
  const fermee = fauxCodex("ok", { modeLsappinfo: "fermee" });
  assert.deepEqual(
    await sonnerSansHate({ fiche: FICHE_APP, enveloppe: ENVELOPPE, lancer: fermee.lancer, ouvrir: ouvreur.ouvrir, plateforme: "darwin" }),
    { ok: true, mode: "queue+open" }
  );
  assert.equal(fermee.detections().length, 1);
  assert.deepEqual(
    await sonnerSansHate({ fiche: FICHE_APP, enveloppe: ENVELOPPE, lancer: fauxCodex("ok", { modeLsappinfo: "tourne" }).lancer, ouvrir: ouvreur.ouvrir, plateforme: "darwin" }),
    { ok: true, mode: "queue" }
  );
  assert.equal(ouvreur.liens.length, 1);
});

// ── ROUND 1b — L'APP NE SURGIT JAMAIS POUR UNE CHAISE DE TERMINAL ─────────────────────────────────
// La fiche dit par quelle porte la chaise parle (`porte`, chaise-codex.js). Une chaise `cli` (ou
// `exec`) vit dans un terminal : ouvrir l'app de bureau sur son fil ferait surgir une fenêtre devant
// quelqu'un qui tape ailleurs, et donnerait peut-être à la file un second lecteur. Pour elle,
// jamais d'ouverture : l'enveloppe reste en file et part au prochain prompt du terminal. Seule une
// fiche `app` — ou une fiche sans porte, écrite avant que la porte ne se dise — peut ouvrir l'app.
test("round 1b — une chaise `cli` ou `exec` n'ouvre JAMAIS l'app, quoi que dise la file ; une chaise `app` ou sans porte l'ouvre une fois", async () => {
  for (const porte of ["cli", "exec"]) {
    const ouvreur = ouvreurDeCarton();
    let detecte = 0;
    const base = {
      fiche: { ...FICHE, porte },
      enveloppe: ENVELOPPE,
      ouvrir: ouvreur.ouvrir,
      plateforme: "darwin",
      appOuverte: () => {
        detecte += 1;
        return false;
      }
    };
    assert.deepEqual(await sonnerSansHate({ ...base, lancer: fauxCodex("ok").lancer }), { ok: true, mode: "queue" }, `${porte} : file acceptée, app fermée`);
    assert.deepEqual(
      await sonnerSansHate({ ...base, lancer: fauxCodex("sans-session-puis-ok").lancer }),
      { ok: true, mode: "queue" },
      `${porte} : « No active session » puis file acceptée`
    );
    const refusee = await sonnerSansHate({ ...base, lancer: fauxCodex("sans-session").lancer });
    assert.equal(refusee.ok, false, porte);
    assert.equal(refusee.mode, null, `${porte} : la file refuse, et l'app ne s'ouvre pas non plus`);
    assert.equal(refusee.erreur, "codex-fil-sans-session");
    assert.equal(ouvertureTentee(refusee), false);
    assert.deepEqual(ouvreur.liens, [], `${porte} : ouvrir n'est jamais appelé`);
    assert.equal(detecte, 0, `${porte} : on ne demande même pas si l'app tourne`);
  }

  for (const fiche of [{ ...FICHE, porte: "app" }, (({ porte, ...sans }) => sans)(FICHE)]) {
    const ouvreur = ouvreurDeCarton();
    assert.deepEqual(
      await sonnerSansHate({ fiche, enveloppe: ENVELOPPE, lancer: fauxCodex("ok").lancer, ouvrir: ouvreur.ouvrir, plateforme: "darwin", appOuverte: () => false }),
      { ok: true, mode: "queue+open" },
      `porte ${fiche.porte ?? "absente"}`
    );
    assert.deepEqual(ouvreur.liens, [lienDuFil(FICHE.thread_id)], `porte ${fiche.porte ?? "absente"} : une ouverture`);
  }
});

// ── ROUND 1, CONSTAT 3 — UN PETIT-ENFANT QUI TIENT LES TUBES ───────────────────────────────────
// Node n'émet `close` qu'une fois stdout et stderr fermés : un petit-enfant qui en a hérité (un
// enveloppeur qui lance le binaire natif, par exemple) retenait la porte jusqu'à sa propre fin.
// L'enfant naît chef de son groupe de processus ; au couperet, c'est le GROUPE qui meurt, les
// tubes se ferment, et la porte conclut sur `exit`.
test("round 1 — un `codex` dont le petit-enfant garde les tubes est tué AVEC lui au délai : la porte rend codex-delai dans la marge du délai, et aucun orphelin ne survit", async (t) => {
  const codex = fauxCodex("pend-petit-fils");
  t.after(() => tuerSiVivant(codex.petitFils()));
  // Le délai laisse au faux le temps de poser son petit-enfant (dix latences, 2 s au moins) ; la
  // marge suit la latence (500 ms au moins).
  const latence = await mesurerLaLatence();
  const DELAI = dimensionner(2000, latence);
  const MARGE = dimensionner(500, latence);
  const depart = Date.now();
  const verdict = await sonnerLaChaiseCodex({ fiche: FICHE, enveloppe: ENVELOPPE, lancer: codex.lancer, delaiMs: DELAI, ouvrir: ouvreurDeCarton().ouvrir });
  const duree = Date.now() - depart;
  assert.deepEqual(verdict, { ok: false, mode: null, erreur: "codex-delai" });
  assert.ok(duree < DELAI + MARGE, `la porte a rendu la main en ${duree} ms (délai ${DELAI} ms, marge ${MARGE} ms, latence ${latence} ms)`);
  const [lance] = codex.lances;
  const petitFils = codex.petitFils();
  assert.ok(petitFils > 0, "SONDE IMPOSSIBLE : le faux n'a pas noté son petit-enfant");
  assert.ok(await mortAvant(lance.pid, dimensionner(1000, latence)), "l'enfant est mort");
  assert.ok(await mortAvant(petitFils, dimensionner(1000, latence)), "le petit-enfant est mort avec lui : aucun orphelin");
});

test("round 1 — un `codex` qui SORT en laissant un petit-enfant sur les tubes : la porte conclut sur la sortie (quelques centaines de ms), pas à la fin du petit-enfant", async (t) => {
  const codex = fauxCodex("sort-petit-fils-garde");
  t.after(() => tuerSiVivant(codex.petitFils()));
  // Le couperet reste loin (vingt latences, 5 s au moins, 60 s au plus) et sous les 120 s du
  // petit-enfant ; la grâce est celle de la production. Conclure avant le couperet, sans être tué,
  // c'est avoir conclu sur la sortie de l'enfant — ni au couperet, ni à la fin du petit-enfant.
  const latence = await mesurerLaLatence();
  const DELAI = dimensionner(5000, latence, 20);
  const depart = Date.now();
  const verdict = await sonnerLaChaiseCodex({
    fiche: FICHE,
    enveloppe: ENVELOPPE,
    lancer: codex.lancer,
    delaiMs: DELAI,
    ouvrir: ouvreurDeCarton().ouvrir,
    appOuverte: () => true
  });
  const duree = Date.now() - depart;
  assert.deepEqual(verdict, { ok: true, mode: "queue" });
  assert.ok(duree < DELAI, `la porte a conclu sur la sortie de l'enfant (${duree} ms, couperet à ${DELAI} ms), pas sur celle du petit-enfant (120 s)`);
});

// ── ROUND 1c — LE COUPERET N'ÉCRASE PAS LA GRÂCE D'UNE SORTIE NORMALE ─────────────────────────────
// Un `codex` qui SORT en code 0 (la file a pris l'enveloppe) en laissant un petit-enfant sur les
// tubes : la porte attend ses dernières lignes le temps d'une grâce. Si le couperet tombait pendant
// cette grâce, il marquait `tue`, tuait le groupe d'un enfant déjà sorti, et la porte disait
// `codex-delai` d'une enveloppe en file — une seconde enveloppe partait à la tournée suivante.
// Une grâce PLUS LONGUE que le délai (`graceMs`, injectable comme `delaiMs`) met chaque sortie
// dans cette fenêtre, sans compter sur l'horloge d'une machine chargée.
test("round 1c — un `codex` qui sort en code 0 avec un petit-enfant sur les tubes, la grâce courant au-delà du délai : { tue: false, code: 0 }, conclu au délai, le petit-enfant épargné", async (t) => {
  const codex = fauxCodex("sort-tard-petit-fils-garde");
  t.after(() => tuerSiVivant(codex.petitFils()));
  // L'enfant dort 0,5 s puis sort : le délai lui laisse dix latences de plus (1,5 s au moins), et
  // la grâce (deux délais) dépasse toujours ce qui reste du délai à sa sortie. Non bornée, elle
  // conclurait après 0,5 s + deux délais, bien au-delà du délai et de sa marge.
  const latence = await mesurerLaLatence();
  const DELAI = 500 + dimensionner(1500, latence);
  const GRACE = 2 * DELAI;
  const MARGE = dimensionner(500, latence);
  const depart = Date.now();
  const fin = await lancerBorne({ commande: "codex", args: ["queue"], lancer: codex.lancer, delaiMs: DELAI, graceMs: GRACE });
  const duree = Date.now() - depart;
  assert.equal(fin.tue, false, "l'enfant est sorti de lui-même : le couperet n'avait plus rien à trancher");
  assert.equal(fin.code, 0);
  assert.match(fin.sortie, /Queued message/);
  assert.ok(duree < DELAI + MARGE, `la grâce ne déborde pas le délai de l'enfant (${duree} ms ; délai ${DELAI} ms, marge ${MARGE} ms, latence ${latence} ms)`);
  const petitFils = codex.petitFils();
  assert.ok(petitFils > 0, "SONDE IMPOSSIBLE : le faux n'a pas noté son petit-enfant");
  assert.doesNotThrow(() => process.kill(petitFils, 0), "un enfant sorti de lui-même : son groupe n'est pas tué");
});

test("round 1c — à travers la tournée : la même sortie normale près du délai porte la lettre (sonnee-codex), jamais codex-delai", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L-tard", sender: "alice", recipient: "hal-test", body: "ring" });
  const codex = fauxCodex("sort-tard-petit-fils-garde");
  t.after(() => tuerSiVivant(codex.petitFils()));
  // Les mêmes délai et grâce que le test précédent, sur la latence mesurée.
  const latence = await mesurerLaLatence();
  const DELAI = 500 + dimensionner(1500, latence);
  const bilan = await faireLaTournee(
    db,
    depsCodex(fiche, {
      sonner: (arg) =>
        sonnerLaChaiseCodex({ ...arg, lancer: codex.lancer, delaiMs: DELAI, graceMs: 2 * DELAI, appOuverte: () => true, ouvrir: ouvreurDeCarton().ouvrir })
    }, { reglages: { bailMs: BAIL_LARGE } })
  );
  assert.equal(bilan.motifs["sonnee-codex"], 1, JSON.stringify(bilan));
  assert.ok(lettreDe(db, "L-tard").carried_at, "la file a pris l'enveloppe : la lettre est portée");
});

// ── LE RÉGLAGE ─────────────────────────────────────────────────────────────────────────────────
test("VALXOS_CODEX_OUVRIR_APP=0 (ou CC2CC_CODEX_OUVRIR_APP=0) désactive l'ouverture de l'app ; sinon elle est permise", () => {
  assert.equal(REGLAGES_FACTEUR_PAR_DEFAUT.ouvrirLAppCodex, true);
  assert.equal(reglagesDuFacteur({}).ouvrirLAppCodex, true);
  assert.equal(reglagesDuFacteur({ VALXOS_CODEX_OUVRIR_APP: "0" }).ouvrirLAppCodex, false);
  assert.equal(reglagesDuFacteur({ CC2CC_CODEX_OUVRIR_APP: "0" }).ouvrirLAppCodex, false);
  assert.equal(reglagesDuFacteur({ VALXOS_CODEX_OUVRIR_APP: " 0 " }).ouvrirLAppCodex, false, "les blancs ne comptent pas");
  assert.equal(reglagesDuFacteur({ VALXOS_CODEX_OUVRIR_APP: "1" }).ouvrirLAppCodex, true);
  assert.equal(reglagesDuFacteur({ VALXOS_CODEX_OUVRIR_APP: "" }).ouvrirLAppCodex, true, "vide, c'est le défaut");
  assert.equal(
    reglagesDuFacteur({ VALXOS_CODEX_OUVRIR_APP: "1", CC2CC_CODEX_OUVRIR_APP: "0" }).ouvrirLAppCodex,
    true,
    "la famille VALXOS gagne quand les deux clefs sont là (config.js, valeurDeLEnvironnement)"
  );
  assert.doesNotThrow(() => verifierLesReglages({ ...REGLAGES_FACTEUR_PAR_DEFAUT, ouvrirLAppCodex: false }));
});

// ── L'ACHEMINEMENT ─────────────────────────────────────────────────────────────────────────────
test("trouverLaBoite rend { type: \"codex\", fiche } pour une chaise dont la fiche est connue par son FIL ; sans fiche, c'est une maison inconnue ; l'avis se tait", (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  const lettre = { recipient: "hal-test" };
  const sans = trouverLaBoite(db, lettre, { parSession: new Map(), houses: [], resoudre: resolveRecipient });
  assert.equal(sans.motif, "maison-inconnue", "sans fiche, le CODEX_HOME n'est pas une maison de la tournée");

  const fiches = construireFichesCodex([fiche]);
  const avec = trouverLaBoite(db, lettre, { parSession: new Map(), houses: [], resoudre: resolveRecipient, fichesCodex: fiches });
  assert.equal(avec.type, "codex");
  assert.deepEqual(avec.fiche, fiche);
  assert.equal(avec.session, fiche.thread_id);
  assert.equal(avec.cible.lineage, "hal-test");
  assert.equal(avec.boite, undefined, "une chaise Codex n'a pas de boîte native");
  assert.equal(
    avisDAttente(db, lettre, { parSession: new Map(), houses: [], resoudre: resolveRecipient, fichesCodex: fiches }),
    null,
    "livrable : le silence des cas sains"
  );
  assert.equal(
    avisDAttente(db, lettre, { parSession: new Map(), houses: [], resoudre: resolveRecipient, fichesCodex: new Map() })?.motif,
    "maison-inconnue",
    "le contrôle : sans les fiches, l'avis parlait"
  );

  // La fiche se cherche par le FIL (= la session du registre), jamais par le nom ; et elle ne vaut
  // que pour la lignée qu'elle nomme.
  assert.equal(construireFichesCodex([{ ...fiche, thread_id: "autre-fil" }]).get(fiche.thread_id), undefined);
  const etrangere = construireFichesCodex([{ ...fiche, lineage: "carol" }]);
  assert.equal(trouverLaBoite(db, lettre, { parSession: new Map(), houses: [], resoudre: resolveRecipient, fichesCodex: etrangere }).motif, "maison-inconnue");
  assert.equal(construireFichesCodex([{ ...fiche, dead_at: "2026-10-21T11:00:00.000Z" }]).size, 0, "une fiche moissonnée ne sonne plus");
  assert.equal(construireFichesCodex([{ ...fiche, codex_home: null }]).size, 0, "sans CODEX_HOME, aucune porte (lierLaBoite exige une maison)");
  assert.equal(construireFichesCodex(null).size, 0);

  assert.deepEqual(boiteDeLaFicheCodex(fiche), {
    house: fiche.codex_home,
    sessionId: fiche.thread_id,
    procStart: null,
    socketPath: `codex://threads/${fiche.thread_id}`,
    token: null,
    name: "hal-test",
    pid: fiche.pid,
    kind: "codex"
  });
});

test("la forme courte ambiguë (`lignée#<préfixe>` à deux candidates) se dit chaise-ambigue à la tournée, pas lignee-ambigue (Tâche 8)", (t) => {
  const db = bureauDePoste(t);
  chaise(db, { lignee: "alice", session: "deadbeef-0000-7000-8000-000000000001" });
  chaise(db, { lignee: "alice", session: "deadbeef-0000-7000-8000-000000000002" });
  const deps = { parSession: new Map(), houses: [], resoudre: resolveRecipient };
  const courte = trouverLaBoite(db, { recipient: "alice#deadbeef" }, deps);
  assert.equal(courte.motif, "chaise-ambigue");
  assert.equal(courte.candidats, 2);
  assert.equal(trouverLaBoite(db, { recipient: "alice" }, deps).motif, "lignee-ambigue", "le contrôle : la lignée nue reste lignee-ambigue");
});

test("scannerLesMaisons embarque les fiches Codex du bureau, avec ou sans base ; des fiches illisibles n'en donnent aucune — jamais une exception", (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  const scan = scannerLesMaisons({ db, maisons: [], tourHouses: inventaire([]), fichesCodex: () => [fiche] });
  assert.deepEqual(scan.fichesCodex.get(fiche.thread_id), fiche);
  assert.ok(scan.parSession instanceof Map);
  assert.deepEqual(scan.houses, []);
  // Sans base, les fiches se lisent quand même — au bureau du processus, celui de la base.
  let baseRecue = "jamais lue";
  const sansBase = scannerLesMaisons({
    maisons: [],
    tourHouses: inventaire([]),
    fichesCodex: (base) => {
      baseRecue = base;
      return [fiche];
    }
  });
  assert.equal(sansBase.fichesCodex.size, 1);
  assert.equal(baseRecue, null);
  assert.equal(
    scannerLesMaisons({
      db,
      maisons: [],
      tourHouses: inventaire([]),
      fichesCodex: () => {
        throw new Error("fiches illisibles");
      }
    }).fichesCodex.size,
    0,
    "des fiches illisibles ne cassent pas le scan"
  );
  // Le lecteur réel, sur une fiche réelle (Tâche 9).
  ecrireFicheCodex(db, { lineage: "carol", thread_id: "0199c0de-0000-7000-8000-0000000000c0", codex_home: "/codex/carol", pid: process.pid });
  const reel = scannerLesMaisons({ maisons: [], tourHouses: inventaire([]) });
  assert.equal(reel.fichesCodex.get("0199c0de-0000-7000-8000-0000000000c0")?.codex_home, "/codex/carol");
});

// ── LE GUICHET (src/lib/guichet.js n'est pas touché) ───────────────────────────────────────────
// `send` vers une chaise Codex ne doit pas dire « maison inconnue » : la prochaine tournée va
// sonner. `avisDAttente`, à qui le guichet ne tend que {houses, parSession}, lit les fiches du
// bureau elle-même. Le contrôle : la même chaise sans fiche au bureau fait parler l'avis.
test("l'avis du guichet se tait pour une chaise Codex dont la fiche est au bureau ; sans fiche, il parle (contrôle) ; une carte réécrite par le serveur MCP nu n'y change rien", async (t) => {
  const reveiller = async (agentId) => ({ ok: false, socketPath: `/carton/${agentId}.sock`, error: "ENOENT" });
  const scanner = () => ({ houses: [], parSession: new Map() });

  const temoin = bureauDePoste(t);
  registerInstance(temoin, { lineage: "hal-test", sessionId: FICHE.thread_id, house: FICHE.codex_home, pid: 4343 });
  const avant = await posterUneLettre(temoin, { sender: "alice", recipient: "hal-test", body: "ring the chair" }, { reveiller, scanner });
  assert.equal(avant.attente?.motif, "maison-inconnue", "le contrôle : sans fiche au bureau, l'avis parle");

  const db = bureauDePoste(t);
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: FICHE.thread_id, codex_home: FICHE.codex_home, pid: process.pid });
  assert.equal(fichesCodex(db).length, 1, "SONDE IMPOSSIBLE : la fiche n'est pas au bureau");
  const poste = await posterUneLettre(db, { sender: "alice", recipient: "hal-test", body: "ring the chair" }, { reveiller, scanner });
  assert.equal(poste.attente, null, "livrable par la porte Codex : aucun avis");
  assert.equal(avisDAttente(db, { recipient: "hal-test" }, { parSession: new Map(), houses: [], resoudre: resolveRecipient }), null);

  // Le serveur MCP nu de la chaise réécrit sa carte (pid, description) : la fiche fait foi.
  registerPeer(db, { id: "hal-test", description: "VALXOS Messenger MCP session", status: "active", pid: 777 });
  const encore = await posterUneLettre(db, { sender: "alice", recipient: "hal-test", body: "ring again" }, { reveiller, scanner });
  assert.equal(encore.attente, null);
});

// ── LA TOURNÉE ─────────────────────────────────────────────────────────────────────────────────
const lettreDe = (db, id) => db.prepare("SELECT * FROM messages WHERE msg_id = ?").get(id);

test("deux lettres pour la même chaise Codex dans une tournée : UNE enveloppe, carried_at sur les deux, deux tentatives remises sur le fil, une seule pause", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", subject: "Beat 1", body: "SECRET-ONE" });
  insertMessage(db, { msg_id: "L2", sender: "alice", recipient: "hal-test", subject: "Beat 2", body: "SECRET-TWO" });
  const sonnette = sonnetteDeCarton();
  const journal = [];
  let pauses = 0;
  const bilan = await faireLaTournee(
    db,
    depsCodex(fiche, sonnette, {
      journal: (l) => journal.push(l),
      dormir: async () => {
        pauses += 1;
      }
    })
  );

  assert.equal(bilan.prises, 2);
  assert.equal(bilan.remises, 2);
  assert.equal(bilan.motifs["sonnee-codex"], 2);
  assert.equal(sonnette.appels.length, 1, "une sonnerie pour les deux lettres, jamais deux");
  assert.equal(pauses, 1, "la pause suit la frappe ; la deuxième lettre n'a frappé à aucune porte");
  const [appel] = sonnette.appels;
  assert.deepEqual(appel.fiche, fiche);
  assert.equal(appel.ouvrirApp, true);
  assert.equal(appel.delaiMs, 5000, "le couperet est celui de la spec, borné par le délai de remise");
  assert.equal(
    appel.enveloppe,
    "📬 VALXOS Messenger: 2 letters waiting for hal-test — from \"alice\", subject \"Beat 1\", priority \"normal\". Call the inbox tool."
  );
  assert.ok(!appel.enveloppe.includes("SECRET"), "jamais un corps dans la sonnette");

  for (const id of ["L1", "L2"]) assert.ok(lettreDe(db, id).carried_at, `${id} est marquée portée`);
  const lien = `codex://threads/${fiche.thread_id}`;
  assert.deepEqual(
    db.prepare("SELECT msg_id, state, target_session_id, target_house, target_socket_path, target_proc_start FROM facteur_attempts ORDER BY rowid").all(),
    [
      { msg_id: "L1", state: "remise", target_session_id: fiche.thread_id, target_house: fiche.codex_home, target_socket_path: lien, target_proc_start: null },
      { msg_id: "L2", state: "remise", target_session_id: fiche.thread_id, target_house: fiche.codex_home, target_socket_path: lien, target_proc_start: null }
    ]
  );
  const sonneries = journal.filter((l) => l.evenement === "facteur_sonnette_codex");
  assert.equal(sonneries.length, 1);
  assert.deepEqual(sonneries[0], {
    evenement: "facteur_sonnette_codex",
    lignee: "hal-test",
    thread_id: fiche.thread_id,
    porte: "cli",
    lettres: 2,
    autres_non_lues: 0,
    ouvrir_app: true,
    ok: true,
    mode: "queue",
    erreur: null
  });
  assert.equal(journal.filter((l) => l.evenement === "facteur_remis").length, 2);
  const tout = JSON.stringify([journal, db.prepare("SELECT * FROM delivery_events").all(), db.prepare("SELECT * FROM facteur_attempts").all()]);
  assert.ok(!tout.includes("SECRET"), "ni le journal, ni les événements, ni les tentatives ne répètent le courrier");
  assert.ok(!tout.includes("Beat 1"), "…ni son sujet");
});

test("la lettre de tête de l'enveloppe est la plus urgente, puis la plus ancienne ; les calmes et les lettres déjà en main n'y entrent pas", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", subject: "first", body: "x" });
  insertMessage(db, { msg_id: "L2", sender: "bob", recipient: "hal-test", subject: "urgent", priority: "high", body: "x" });
  insertMessage(db, { msg_id: "L3", sender: "carol", recipient: "hal-test", subject: "also urgent", priority: "high", body: "x" });
  insertMessage(db, { msg_id: "L4", sender: "carol", recipient: "hal-test", subject: "calm", body: "x" });
  db.prepare("UPDATE messages SET sans_reveil = 1 WHERE msg_id = 'L4'").run();
  const sonnette = sonnetteDeCarton();
  const bilan = await faireLaTournee(db, depsCodex(fiche, sonnette));
  assert.equal(sonnette.appels.length, 1);
  assert.equal(
    sonnette.appels[0].enveloppe,
    "📬 VALXOS Messenger: 3 letters waiting for hal-test — from \"bob\", subject \"urgent\", priority \"high\"; 1 other unread. Call the inbox tool."
  );
  assert.equal(bilan.remises, 3);
  assert.equal(lettreDe(db, "L4").carried_at, null, "la lettre calme ne se porte pas, ne sonne pas, mais se compte parmi les autres non lues");
});

test("la sonnette ne passe pas : motif sonnette-codex-impossible, aucune lettre portée, une seule frappe par tournée, le canal de repli sert toujours (A9)", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", body: "one" });
  insertMessage(db, { msg_id: "L2", sender: "bob", recipient: "hal-test", body: "two" });
  const sonnette = sonnetteDeCarton({ ok: false, mode: null, erreur: "codex-delai" });
  const journal = [];
  const avant = Date.now();
  const bilan = await faireLaTournee(db, depsCodex(fiche, sonnette, { journal: (l) => journal.push(l) }));

  assert.equal(bilan.remises, 0);
  assert.equal(bilan.ajournees, 2);
  assert.equal(bilan.motifs["sonnette-codex-impossible"], 2);
  assert.equal(sonnette.appels.length, 1, "un codex qui pend ne se refrappe pas pour chaque lettre de la tournée");
  for (const id of ["L1", "L2"]) assert.equal(lettreDe(db, id).carried_at, null, `${id} n'est pas marquée portée`);
  assert.deepEqual(
    db.prepare("SELECT msg_id, state, reason FROM facteur_attempts ORDER BY rowid").all(),
    [
      { msg_id: "L1", state: "echouee", reason: "sonnette-codex-impossible" },
      { msg_id: "L2", state: "echouee", reason: "sonnette-codex-impossible" }
    ]
  );
  const echecs = journal.filter((l) => l.evenement === "facteur_echec");
  assert.equal(echecs.length, 2);
  assert.equal(echecs[0].motif, "sonnette-codex-impossible");
  assert.equal(echecs[0].detail, "codex-delai");
  assert.equal(echecs[0].permanent, false);
  const sonneries = journal.filter((l) => l.evenement === "facteur_sonnette_codex");
  assert.equal(sonneries.length, 1);
  assert.equal(sonneries[0].ok, false);
  assert.equal(sonneries[0].erreur, "codex-delai");

  // A9 : la lettre attend, les hooks la servent au prochain tour ; l'échéance du Facteur est FINIE.
  assert.deepEqual(getPendingForContext(db, "hal-test").map((r) => r.msg_id), ["L1", "L2"]);
  const echeance = Number(lettreDe(db, "L1").facteur_not_before_ms);
  assert.ok(echeance > avant, "ajournée…");
  assert.ok(echeance <= Date.now() + REGLAGES_FACTEUR_PAR_DEFAUT.ajournementMaximalMs, "…mais jamais au-delà du plafond");

  // Une porte qui LÈVE est un échec de sonnette, pas une tournée interrompue.
  insertMessage(db, { msg_id: "L3", sender: "carol", recipient: "hal-test", body: "three" });
  db.prepare("UPDATE messages SET facteur_not_before_ms = 0 WHERE msg_id IN ('L1', 'L2')").run();
  const quiLeve = sonnetteDeCarton(() => {
    throw new Error("porte cassée");
  });
  const second = await faireLaTournee(db, depsCodex(fiche, quiLeve));
  assert.equal(second.motifs["sonnette-codex-impossible"], 3);
  assert.equal(second.motifs["bureau-ferme"], undefined, "la tournée n'est pas interrompue");
  assert.equal(quiLeve.appels.length, 1);
  assert.ok(quiLeve.appels[0].enveloppe.startsWith("📬 VALXOS Messenger: 3 letters waiting for hal-test"), "les lettres qui attendent ensemble sonnent ensemble");
});

test("une sonnerie par lettre au plus : une lettre déjà portée ne resonne pas (sonnette-codex-deja-sonnee, sans pause) ; une lettre neuve sonne, et compte les autres non lues", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", body: "one" });
  insertMessage(db, { msg_id: "L2", sender: "alice", recipient: "hal-test", body: "two" });
  const sonnette = sonnetteDeCarton();
  let horloge = 1_000_000;
  let pauses = 0;
  const deps = depsCodex(fiche, sonnette, {
    horloge: () => horloge,
    dormir: async () => {
      pauses += 1;
    }
  });

  await faireLaTournee(db, deps);
  assert.equal(sonnette.appels.length, 1);
  const portees = db.prepare("SELECT msg_id, carried_at FROM messages ORDER BY seq").all();

  horloge += REGLAGES_FACTEUR_PAR_DEFAUT.ajournementApresRemiseMs + 1;
  pauses = 0;
  const seconde = await faireLaTournee(db, deps);
  assert.equal(seconde.prises, 2, "les deux lettres, non accusées, reviennent (A9)…");
  assert.equal(sonnette.appels.length, 1, "…mais le Facteur ne resonne pas : une sonnette qui insiste devient du bruit");
  assert.equal(seconde.motifs["sonnette-codex-deja-sonnee"], 2);
  assert.equal(pauses, 0, "aucune porte frappée, aucune pause");
  assert.deepEqual(db.prepare("SELECT msg_id, carried_at FROM messages ORDER BY seq").all(), portees, "carried_at garde la PREMIÈRE sonnerie");
  assert.deepEqual(
    db.prepare("SELECT state, reason FROM facteur_attempts WHERE msg_id = 'L1' ORDER BY rowid").all(),
    [{ state: "remise", reason: null }, { state: "echouee", reason: "sonnette-codex-deja-sonnee" }]
  );
  const echeance = Number(lettreDe(db, "L1").facteur_not_before_ms);
  assert.ok(echeance >= horloge + REGLAGES_FACTEUR_PAR_DEFAUT.ajournementApresRemiseMs, "au rythme d'une remise (puis croissant), pas d'un échec passager");
  assert.ok(echeance <= horloge + REGLAGES_FACTEUR_PAR_DEFAUT.ajournementMaximalMs, "et jamais au-delà du plafond");

  horloge += REGLAGES_FACTEUR_PAR_DEFAUT.ajournementMaximalMs + 1;
  insertMessage(db, { msg_id: "L3", sender: "carol", recipient: "hal-test", subject: "new", priority: "high", body: "three" });
  const troisieme = await faireLaTournee(db, deps);
  assert.equal(sonnette.appels.length, 2, "une lettre neuve sonne");
  assert.equal(
    sonnette.appels[1].enveloppe,
    "📬 VALXOS Messenger: 1 letter waiting for hal-test — from \"carol\", subject \"new\", priority \"high\"; 2 other unread. Call the inbox tool."
  );
  assert.equal(troisieme.motifs["sonnee-codex"], 1);
  assert.equal(troisieme.motifs["sonnette-codex-deja-sonnee"], 2);
});

test("VALXOS_CODEX_OUVRIR_APP=0 (ou ouvrirLAppCodex: false) arrive à la porte comme ouvrirApp: false ; par défaut true ; le couperet suit le délai de remise ; une app ouverte se compte à part", async (t) => {
  for (const [nom, extra, attendu] of [
    ["defaut", {}, true],
    ["reglages", { reglages: { ouvrirLAppCodex: false } }, false],
    ["env-valxos", { env: { ...envPropre(), VALXOS_CODEX_OUVRIR_APP: "0" } }, false],
    ["env-cc2cc", { env: { ...envPropre(), CC2CC_CODEX_OUVRIR_APP: "0" } }, false]
  ]) {
    const db = bureauDePoste(t);
    const fiche = ficheCodexVivante(db);
    insertMessage(db, { msg_id: `L-${nom}`, sender: "alice", recipient: "hal-test", body: "ring" });
    const sonnette = sonnetteDeCarton();
    await faireLaTournee(db, depsCodex(fiche, sonnette, extra));
    assert.equal(sonnette.appels.length, 1, nom);
    assert.equal(sonnette.appels[0].ouvrirApp, attendu, nom);
  }

  {
    const db = bureauDePoste(t);
    const fiche = ficheCodexVivante(db);
    insertMessage(db, { msg_id: "L-court", sender: "alice", recipient: "hal-test", body: "ring" });
    const sonnette = sonnetteDeCarton();
    await faireLaTournee(db, depsCodex(fiche, sonnette, { reglages: { delaiDeRemiseMs: 1000 } }));
    assert.equal(sonnette.appels[0].delaiMs, 1000, "la porte entière (deux délais) tient dans le bail de la tentative");
  }

  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L-app", sender: "alice", recipient: "hal-test", body: "ring" });
  const journal = [];
  const bilan = await faireLaTournee(db, depsCodex(fiche, sonnetteDeCarton({ ok: true, mode: "queue+open" }), { journal: (l) => journal.push(l) }));
  assert.equal(bilan.remises, 1);
  assert.equal(bilan.motifs["sonnee-codex-app-ouverte"], 1);
  assert.equal(journal.find((l) => l.evenement === "facteur_sonnette_codex").mode, "queue+open");
  assert.ok(lettreDe(db, "L-app").carried_at);
  const ouvertures = db.prepare("SELECT msg_id, detail_json FROM delivery_events WHERE event_type = 'facteur_codex_app_ouverte'").all();
  assert.deepEqual(ouvertures.map((o) => [o.msg_id, JSON.parse(o.detail_json)]), [["L-app", { thread_id: fiche.thread_id, ok: true }]]);
});

test("une ouverture de l'app au plus par lettre : la file refuse et l'app s'est ouverte — la lettre n'est pas portée, et la tournée suivante ne rouvre pas l'app pour elle", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", body: "one" });
  let horloge = 1_000_000;
  const sonnette = sonnetteDeCarton((arg) =>
    arg.ouvrirApp
      ? { ok: false, mode: "open", erreur: "codex-fil-sans-session", detail: "Error: No active session" }
      : { ok: false, mode: null, erreur: "codex-fil-sans-session", detail: "Error: No active session" }
  );
  const journal = [];
  const deps = depsCodex(fiche, sonnette, { horloge: () => horloge, journal: (l) => journal.push(l) });

  const premiere = await faireLaTournee(db, deps);
  assert.equal(premiere.motifs["sonnette-codex-impossible"], 1);
  assert.equal(lettreDe(db, "L1").carried_at, null, "rien n'est en file : rien n'est porté");
  assert.equal(sonnette.appels[0].ouvrirApp, true);
  assert.equal(journal.find((l) => l.evenement === "facteur_sonnette_codex").mode, "open");
  const ouvertes = () => db.prepare("SELECT msg_id FROM delivery_events WHERE event_type = 'facteur_codex_app_ouverte' ORDER BY id").all().map((r) => r.msg_id);
  assert.deepEqual(ouvertes(), ["L1"]);

  // La lettre revient (échec passager, échéance finie) : la file est retentée, l'app ne se rouvre pas.
  horloge += REGLAGES_FACTEUR_PAR_DEFAUT.ajournementMaximalMs + 1;
  await faireLaTournee(db, deps);
  assert.equal(sonnette.appels.length, 2, "la file se retente…");
  assert.equal(sonnette.appels[1].ouvrirApp, false, "…mais l'app s'est déjà ouverte pour cette lettre");

  // A4 (passe adverse) : le droit d'ouvrir se juge PAR LETTRE NEUVE. Une lettre neuve qui voyage
  // avec L1 garde le sien — une ouverture au plus pour elle. S11 (seconde passe adverse) : la
  // sonnerie ne la note QUE sur la lettre neuve ; L1 a déjà eu sa tentative, elle n'en a pas une
  // seconde. Le journal du Facteur dit l'ouverture de l'app une fois par enveloppe, et pour qui.
  insertMessage(db, { msg_id: "L2", sender: "bob", recipient: "hal-test", body: "two" });
  horloge += REGLAGES_FACTEUR_PAR_DEFAUT.ajournementMaximalMs + 1;
  await faireLaTournee(db, deps);
  assert.equal(sonnette.appels[2].ouvrirApp, true, "L2 n'a jamais ouvert l'app : elle y a droit, même groupée avec L1");
  assert.ok(sonnette.appels[2].enveloppe.startsWith("📬 VALXOS Messenger: 2 letters"));
  assert.deepEqual(ouvertes(), ["L1", "L2"], "une tentative par lettre");
  const ouverturesAuJournal = journal.filter((l) => l.evenement === "facteur_codex_app_ouverte");
  assert.deepEqual(
    ouverturesAuJournal.map((l) => [l.pour, l.lettres, l.ok]),
    [[["L1"], 1, true], [["L2"], 2, true]],
    "une ligne par enveloppe qui ouvre l'app : la lettre qui y avait droit, et combien l'enveloppe en couvre"
  );

  // Puis plus personne n'y a droit : L1 et L2 ont chacune eu la leur.
  horloge += REGLAGES_FACTEUR_PAR_DEFAUT.ajournementMaximalMs + 1;
  await faireLaTournee(db, deps);
  assert.equal(sonnette.appels[3].ouvrirApp, false, "chaque lettre de l'enveloppe a déjà eu son ouverture");

  // Seule, L2 non plus : son ouverture a eu lieu.
  db.prepare("UPDATE messages SET acked_at = '2026-10-21T12:00:00.000Z' WHERE msg_id = 'L1'").run();
  horloge += REGLAGES_FACTEUR_PAR_DEFAUT.ajournementMaximalMs + 1;
  await faireLaTournee(db, deps);
  assert.equal(sonnette.appels[4].ouvrirApp, false);
  assert.deepEqual(ouvertes(), ["L1", "L2"]);
  assert.equal(getPendingForContext(db, "hal-test").map((r) => r.msg_id).join(","), "L2", "A9 : la lettre attend et le repli la sert");
});

// A4 (passe adverse), DE BOUT EN BOUT avec la vraie porte : l'ouverture de L1 a ÉCHOUÉ (personne
// ne tenait le fil, `open` a raté) ; la lettre neuve L2 arrive, voyage avec L1, la file l'accepte et
// l'app est fermée. Avant, l'événement de L1 supprimait le droit de L2 : rien ne s'ouvrait, L2 était
// portée sans réveil visible. Maintenant `ouvrir` est appelé, une fois.
test("A4 — ancienne ouverture échouée + lettre neuve + file acceptée + app fermée : `ouvrir` est appelé une fois pour la lettre neuve", async (t) => {
  const db = bureauDePoste(t);
  const fiche = { ...ficheCodexVivante(db), porte: "app" };
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", body: "one" });
  let horloge = 1_000_000;
  const refus = fauxCodex("sans-session");
  const ouvreurRate = ouvreurDeCarton({ ok: false });
  let porte = (arg) => sonnerLaChaiseCodex({ ...arg, delaiMs: DELAI_TRANQUILLE, graceMs: GRACE_TRANQUILLE, lancer: refus.lancer, ouvrir: ouvreurRate.ouvrir, plateforme: "darwin" });
  const deps = depsCodex(fiche, { sonner: (arg) => porte(arg) }, { horloge: () => horloge });

  const premiere = await faireLaTournee(db, deps);
  assert.equal(premiere.motifs["sonnette-codex-impossible"], 1);
  assert.equal(ouvreurRate.liens.length, 1, "contrôle : la première sonnerie a tenté l'app, et l'ouverture a raté");
  const ouvertures = () => db.prepare("SELECT msg_id, detail_json FROM delivery_events WHERE event_type = 'facteur_codex_app_ouverte' ORDER BY id").all()
    .map((r) => [r.msg_id, JSON.parse(r.detail_json).ok]);
  assert.deepEqual(ouvertures(), [["L1", false]]);

  insertMessage(db, { msg_id: "L2", sender: "bob", recipient: "hal-test", body: "two" });
  horloge += REGLAGES_FACTEUR_PAR_DEFAUT.ajournementMaximalMs + 1;
  const accepte = fauxCodex("ok");
  const ouvreur = ouvreurDeCarton({ ok: true });
  porte = (arg) => sonnerLaChaiseCodex({ ...arg, delaiMs: DELAI_TRANQUILLE, graceMs: GRACE_TRANQUILLE, lancer: accepte.lancer, ouvrir: ouvreur.ouvrir, appOuverte: () => false, plateforme: "darwin" });
  const seconde = await faireLaTournee(db, deps);
  assert.equal(ouvreur.liens.length, 1, "la lettre neuve a gardé son droit : l'app fermée s'ouvre sur le fil, une fois");
  assert.deepEqual(ouvreur.liens, [`codex://threads/${fiche.thread_id}`]);
  assert.equal(seconde.motifs["sonnee-codex-app-ouverte"], 2, "les deux lettres de l'enveloppe sont portées, app ouverte");
  assert.ok(lettreDe(db, "L2").carried_at);
  assert.deepEqual(ouvertures(), [["L1", false], ["L2", true]], "S11 : une tentative par lettre — L1 avait déjà la sienne");
});

test("le mode une-lettre ne sonne que pour la lettre demandée : les autres restent des « other unread »", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", body: "one" });
  insertMessage(db, { msg_id: "L2", sender: "bob", recipient: "hal-test", subject: "only this", body: "two" });
  const sonnette = sonnetteDeCarton();
  const bilan = await faireLaTournee(db, depsCodex(fiche, sonnette, { seulementLaLettre: "L2" }));
  assert.equal(bilan.remises, 1);
  assert.equal(
    sonnette.appels[0].enveloppe,
    "📬 VALXOS Messenger: 1 letter waiting for hal-test — from \"bob\", subject \"only this\", priority \"normal\"; 1 other unread. Call the inbox tool."
  );
  assert.equal(lettreDe(db, "L1").carried_at, null, "la lettre qu'on n'a pas demandée n'est ni sonnée ni portée");
});

test("à la tournée, une forme courte ambiguë attend sous chaise-ambigue : ni sonnerie, ni constat « sans chaise désignée »", async (t) => {
  const db = bureauDePoste(t);
  const a = chaise(db, { lignee: "alice", session: "deadbeef-0000-7000-8000-000000000001" });
  const b = chaise(db, { lignee: "alice", session: "deadbeef-0000-7000-8000-000000000002" });
  insertMessage(db, { msg_id: "L-court", sender: "bob", recipient: "alice#deadbeef", body: "which one" });
  const guichet = guichetDeCarton();
  const bilan = await faireLaTournee(db, depsDeBase({ tourHouses: inventaire([a, b]), fichesCodex: () => [], remettreAuGuichet: guichet.remettre }));
  assert.equal(bilan.motifs["chaise-ambigue"], 1);
  assert.equal(bilan.motifs["lignee-ambigue"], undefined);
  assert.equal(guichet.remises.length, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM delivery_events WHERE event_type = 'sans_chaise_designee'").get().n, 0);
  assert.equal(db.prepare("SELECT reason FROM facteur_attempts").get().reason, "chaise-ambigue");
});

test("de bout en bout avec la vraie fiche (Tâche 9) et la vraie porte : la tournée lit le fil et le CODEX_HOME dans la FICHE, même quand la carte a été réécrite", async (t) => {
  const db = bureauDePoste(t);
  const codexHome = path.join(db.racine, "codex-home-carton");
  const fil = "0199c0de-0000-7000-8000-0000000000e2";
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: fil, codex_home: codexHome, pid: process.pid, porte: "app" });
  // Le serveur MCP nu réécrit la carte (pid, description) ; et même la maison de la carte change.
  registerPeer(db, { id: "hal-test", description: "VALXOS Messenger MCP session", status: "active", pid: 777 });
  db.prepare("UPDATE peers SET house = '/somewhere/else' WHERE id = 'hal-test'").run();
  insertMessage(db, { msg_id: "L-vraie", sender: "alice", recipient: "hal-test", subject: "hello", body: "SECRET" });
  const codex = fauxCodex("ok");
  const journal = [];
  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([]),
      journal: (l) => journal.push(l),
      sonnerLaChaiseCodex: (arg) => sonnerLaChaiseCodex({ ...arg, delaiMs: DELAI_TRANQUILLE, graceMs: GRACE_TRANQUILLE, lancer: codex.lancer, ouvrir: ouvreurDeCarton().ouvrir })
    })
  );
  assert.equal(bilan.remises, 1);
  assert.equal(bilan.motifs["sonnee-codex"], 1);
  const [appel] = codex.appels();
  assert.equal(appel.home, codexHome, "le CODEX_HOME de la fiche, pas la maison de la carte");
  assert.deepEqual(appel.args.slice(0, 3), ["queue", "--thread", fil]);
  assert.equal(appel.args[4], "📬 VALXOS Messenger: 1 letter waiting for hal-test — from \"alice\", subject \"hello\", priority \"normal\". Call the inbox tool.");
  assert.equal(journal.find((l) => l.evenement === "facteur_sonnette_codex").porte, "app");
  assert.ok(lettreDe(db, "L-vraie").carried_at);
});

// ── POINT DE REVUE 4, DE BOUT EN BOUT ──────────────────────────────────────────────────────────
// La vraie porte (`sonnerLaChaiseCodex`, le couperet à 800 ms ici, 5 s en production) et un
// `codex` qui PEND : la tournée rend la main, la lettre Codex attend avec son motif, et la
// lettre de la boîte native voisine est portée dans la MÊME tournée. Un `codex` qui inonde
// stderr : la lettre est sonnée.
test("point de revue 4 — à travers la tournée : un `codex` qui pend ne bloque pas le Facteur ; la lettre attend (sonnette-codex-impossible), la boîte native voisine est servie", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  const boite = chaise(db, { lignee: "bob", session: "s-bob" });
  insertMessage(db, { msg_id: "L-codex", sender: "alice", recipient: "hal-test", body: "ring" });
  insertMessage(db, { msg_id: "L-bob", sender: "alice", recipient: "bob", body: "native" });
  const codex = fauxCodex("pend");
  const guichet = guichetDeCarton();
  // Délai et marge sur la latence mesurée (800 ms et 3,2 s au moins, les valeurs d'avant).
  const latence = await mesurerLaLatence();
  const DELAI = dimensionner(800, latence);
  const MARGE = dimensionner(3200, latence);
  const depart = Date.now();
  const bilan = await faireLaTournee(
    db,
    depsDeBase({
      tourHouses: inventaire([boite]),
      fichesCodex: () => [fiche],
      sonnerLaChaiseCodex: (arg) => sonnerLaChaiseCodex({ ...arg, lancer: codex.lancer, delaiMs: DELAI, ouvrir: ouvreurDeCarton().ouvrir }),
      remettreAuGuichet: guichet.remettre,
      reglages: { bailMs: BAIL_LARGE }
    })
  );
  assert.ok(Date.now() - depart < DELAI + MARGE, `la tournée a rendu la main (délai ${DELAI} ms, marge ${MARGE} ms)`);
  assert.equal(bilan.prises, 2);
  assert.equal(bilan.motifs["sonnette-codex-impossible"], 1);
  assert.equal(lettreDe(db, "L-codex").carried_at, null, "la lettre Codex n'est pas marquée portée");
  assert.equal(guichet.remises.length, 1, "la boîte native a reçu sa lettre dans la même tournée");
  assert.ok(lettreDe(db, "L-bob").carried_at);
  assert.equal(bilan.remises, 1);
  const detail = JSON.parse(
    db.prepare("SELECT detail_json FROM delivery_events WHERE msg_id = 'L-codex' AND event_type = 'facteur_echec'").get().detail_json
  );
  assert.equal(detail.motif, "sonnette-codex-impossible");
  assert.equal(codex.lances.length, 1, "un `codex` tué au délai ne se relance pas");
  const [lance] = codex.lances;
  assert.match(lance.args[4], /^📬 VALXOS Messenger: 1 letter waiting for hal-test — from "alice", priority "normal"\. Call the inbox tool\.$/);
  assert.ok(await mortAvant(lance.pid, dimensionner(1000, latence)), "l'enfant qui pendait est mort");
});

test("point de revue 4 — à travers la tournée : un `codex` qui inonde stderr n'empêche pas la sonnerie", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L-codex", sender: "alice", recipient: "hal-test", body: "ring" });
  const codex = fauxCodex("bavard");
  const bilan = await faireLaTournee(
    db,
    depsCodex(fiche, { sonner: (arg) => sonnerLaChaiseCodex({ ...arg, lancer: codex.lancer, delaiMs: DELAI_TRANQUILLE, graceMs: GRACE_TRANQUILLE, ouvrir: ouvreurDeCarton().ouvrir }) })
  );
  assert.equal(bilan.remises, 1);
  assert.equal(bilan.motifs["sonnee-codex"], 1);
  assert.ok(lettreDe(db, "L-codex").carried_at);
  assert.equal(codex.appels()[0].home, fiche.codex_home);
});

// ── QUI TEND LA PORTE ──────────────────────────────────────────────────────────────────────────
// round.js ne charge pas la porte (la porte web le charge par le guichet, et ne lance rien) :
// le démon et le one-shot du Facteur la lui TENDENT. Sans elle, la tournée ne lance rien et le
// dit. Pour prouver que les deux points d'entrée tendent la VRAIE porte sans jamais lancer le
// vrai `codex`, le PATH ne contient QUE le dossier d'un faux minimal (des builtins du shell,
// rien d'autre) : le vrai binaire est hors d'atteinte, et `open` aussi.
const SCRIPT_FAUX_MINIMAL = String.raw`#!/bin/sh
printf 'HOME=%s\n' "$CODEX_HOME" >> "$FAUX_CODEX_JOURNAL"
for a in "$@"; do printf 'ARG=%s\n' "$a" >> "$FAUX_CODEX_JOURNAL"; done
echo "Queued message 0199-msg"
exit 0
`;

function fauxMinimal() {
  const dossier = decorJetable("cc2cc-faux-codex-minimal-");
  const journal = path.join(dossier, "journal.txt");
  fs.writeFileSync(path.join(dossier, "codex"), SCRIPT_FAUX_MINIMAL, { mode: 0o755 });
  // Rodé à blanc (voir `lesFaux`) : le démon et le one-shot le lancent sous le délai de production.
  roder(path.join(dossier, "codex"), {});
  const lire = () => (fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").split("\n").filter(Boolean) : []);
  return { dossier, journal, lire };
}

test("une tournée à qui personne n'a tendu la porte Codex ne lance rien : sonnette-codex-impossible, détail porte-codex-absente", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", body: "one" });
  const journal = [];
  const bilan = await faireLaTournee(
    db,
    depsDeBase({ tourHouses: inventaire([]), fichesCodex: () => [fiche], journal: (l) => journal.push(l) })
  );
  assert.equal(bilan.motifs["sonnette-codex-impossible"], 1);
  assert.equal(journal.find((l) => l.evenement === "facteur_echec").detail, "porte-codex-absente");
  assert.equal(lettreDe(db, "L1").carried_at, null);
});

test("le démon tend la VRAIE porte à la tournée : une chaise Codex est sonnée par `codex queue` (un faux, seul sur le PATH)", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L-demon", sender: "alice", recipient: "hal-test", body: "SECRET" });
  const faux = fauxMinimal();
  const avant = { PATH: process.env.PATH, FAUX_CODEX_JOURNAL: process.env.FAUX_CODEX_JOURNAL };
  process.env.PATH = faux.dossier;
  process.env.FAUX_CODEX_JOURNAL = faux.journal;
  let rendu;
  try {
    rendu = await demarrerLeFacteur({
      db,
      verrou: path.join(decorJetable("cc2cc-porte-codex-verrou-"), "facteur.verrou"),
      tours: 1,
      journal: () => {},
      attendre: async () => {},
      reglages: { ouvrirLAppCodex: false, pauseEntreRemisesMs: 0 },
      depsDeTournee: { maisons: [], tourHouses: inventaire([]), fichesCodex: () => [fiche] }
    });
  } finally {
    process.env.PATH = avant.PATH;
    if (avant.FAUX_CODEX_JOURNAL === undefined) delete process.env.FAUX_CODEX_JOURNAL;
    else process.env.FAUX_CODEX_JOURNAL = avant.FAUX_CODEX_JOURNAL;
  }
  assert.equal(rendu.tours, 1);
  const lignes = faux.lire();
  assert.equal(lignes[0], `HOME=${fiche.codex_home}`, `le faux codex a été lancé sous le CODEX_HOME de la fiche (journal : ${lignes.join(" | ")})`);
  assert.deepEqual(lignes.slice(1, 4), ["ARG=queue", "ARG=--thread", `ARG=${fiche.thread_id}`]);
  assert.ok(lettreDe(db, "L-demon").carried_at, "la lettre est portée");
});

test("le one-shot (`facteur --une-tournee`) tend la VRAIE porte : la vraie fiche au bureau, un faux `codex` seul sur le PATH", (t) => {
  const db = bureauDePoste(t);
  const maison = decorJetable("cc2cc-porte-codex-maison-");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  const fil = "0199c0de-0000-7000-8000-0000000000f1";
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: fil, codex_home: "/codex/carton-cli", pid: process.pid });
  insertMessage(db, { msg_id: "L-cli", sender: "alice", recipient: "hal-test", body: "SECRET" });
  const racine = db.racine;
  db.close();
  const faux = fauxMinimal();
  const sortie = spawnSync(
    process.execPath,
    [path.join(path.resolve(new URL("..", import.meta.url).pathname), "src/bin/facteur.js"), "--une-tournee", "--maisons", maison, "--silencieux"],
    {
      encoding: "utf8",
      env: { ...envPropre(), CC2CC_V2_HOME: racine, PATH: faux.dossier, FAUX_CODEX_JOURNAL: faux.journal, VALXOS_CODEX_OUVRIR_APP: "0" }
    }
  );
  assert.equal(sortie.status, 0, sortie.stderr);
  const bilan = JSON.parse(sortie.stdout.trim());
  assert.equal(bilan.motifs["sonnee-codex"], 1, JSON.stringify(bilan));
  const lignes = faux.lire();
  assert.equal(lignes[0], "HOME=/codex/carton-cli");
  assert.deepEqual(lignes.slice(1, 4), ["ARG=queue", "ARG=--thread", `ARG=${fil}`]);
});

test("round 1 — à travers la tournée : un `codex` dont le petit-enfant garde les tubes ne fige pas le Facteur ; la lettre attend (sonnette-codex-impossible), aucun orphelin", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L-petit-fils", sender: "alice", recipient: "hal-test", body: "ring" });
  const codex = fauxCodex("pend-petit-fils");
  t.after(() => tuerSiVivant(codex.petitFils()));
  const latence = await mesurerLaLatence();
  const DELAI = dimensionner(2000, latence);
  const MARGE = dimensionner(500, latence);
  const depart = Date.now();
  const bilan = await faireLaTournee(
    db,
    depsCodex(fiche, { sonner: (arg) => sonnerLaChaiseCodex({ ...arg, lancer: codex.lancer, delaiMs: DELAI, ouvrir: ouvreurDeCarton().ouvrir }) }, { reglages: { bailMs: BAIL_LARGE } })
  );
  const duree = Date.now() - depart;
  assert.ok(duree < DELAI + MARGE, `la tournée a rendu la main en ${duree} ms (délai ${DELAI} ms, marge ${MARGE} ms)`);
  assert.equal(bilan.motifs["sonnette-codex-impossible"], 1);
  assert.equal(lettreDe(db, "L-petit-fils").carried_at, null, "la lettre n'est pas marquée portée");
  assert.equal(db.prepare("SELECT reason FROM facteur_attempts WHERE msg_id = 'L-petit-fils'").get().reason, "sonnette-codex-impossible");
  assert.ok(await mortAvant(codex.lances[0].pid, dimensionner(1000, latence)), "l'enfant est mort");
  assert.ok(await mortAvant(codex.petitFils(), dimensionner(1000, latence)), "le petit-enfant est mort : aucun orphelin derrière la tournée");
});

test("round 1 — à travers la tournée, app fermée : la première sonnerie ouvre l'app ; la lettre portée revient sans rouvrir l'app ; une lettre neuve y a droit une fois", async (t) => {
  const db = bureauDePoste(t);
  // Une chaise ouverte dans l'app de bureau : c'est elle que l'app fermée fait rouvrir.
  const fiche = { ...ficheCodexVivante(db), porte: "app" };
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", body: "one" });
  const codex = fauxCodex("ok");
  const ouvreur = ouvreurDeCarton();
  let horloge = 1_000_000;
  const deps = depsCodex(fiche, {
    sonner: (arg) => sonnerLaChaiseCodex({ ...arg, delaiMs: DELAI_TRANQUILLE, graceMs: GRACE_TRANQUILLE, lancer: codex.lancer, ouvrir: ouvreur.ouvrir, appOuverte: () => false, plateforme: "darwin" })
  }, { horloge: () => horloge });

  const premiere = await faireLaTournee(db, deps);
  assert.equal(premiere.motifs["sonnee-codex-app-ouverte"], 1);
  assert.ok(lettreDe(db, "L1").carried_at);
  assert.equal(ouvreur.liens.length, 1);

  horloge += REGLAGES_FACTEUR_PAR_DEFAUT.ajournementApresRemiseMs + 1;
  const seconde = await faireLaTournee(db, deps);
  assert.equal(seconde.motifs["sonnette-codex-deja-sonnee"], 1);
  assert.equal(ouvreur.liens.length, 1, "la lettre portée ne resonne pas : l'app ne se rouvre pas pour elle");
  assert.equal(codex.appels().length, 1);

  horloge += REGLAGES_FACTEUR_PAR_DEFAUT.ajournementMaximalMs + 1;
  insertMessage(db, { msg_id: "L2", sender: "bob", recipient: "hal-test", body: "two" });
  await faireLaTournee(db, deps);
  assert.equal(ouvreur.liens.length, 2, "une lettre neuve, une sonnerie neuve : une ouverture au plus pour elle");
});

// ── ROUND 1, CONSTAT 4 — LE VERDICT EN CACHE NE VAUT QUE POUR LES LETTRES NOMMÉES ──────────────────
// L1 sonne ; pendant la pause qui suit la frappe, L2 arrive ; la même tournée rouvre son balayage
// et prend L2. Le verdict de L1 dit « sonnée » — mais l'enveloppe ne nommait pas L2. Marquée
// portée, L2 ne sonnerait plus jamais (`deja-sonnee` à chaque passage). Elle attend donc la
// tournée suivante (`sonnette-codex-differee`), et y sonne dans son enveloppe à elle.
test("round 1 — une lettre arrivée pendant la sonnerie n'est pas portée sur le verdict d'une enveloppe qui ne la nommait pas : elle sonne à la tournée suivante", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", subject: "first", body: "one" });
  const sonnette = sonnetteDeCarton();
  let horloge = 1_000_000;
  let arrivees = 0;
  const deps = depsCodex(fiche, sonnette, {
    horloge: () => horloge,
    dormir: async () => {
      if (arrivees > 0) return;
      arrivees += 1;
      // Pendant la pause qui suit la frappe : une lettre neuve, et une autre sous l'adresse
      // ENTIÈRE de la même chaise (la même session, donc le même fil).
      insertMessage(db, { msg_id: "L2", sender: "bob", recipient: "hal-test", subject: "second", body: "two" });
      insertMessage(db, { msg_id: "L3", sender: "carol", recipient: `hal-test#${fiche.thread_id}`, subject: "third", body: "three" });
    }
  });

  const premiere = await faireLaTournee(db, deps);
  assert.equal(sonnette.appels.length, 1, "une sonnerie dans cette tournée");
  assert.match(sonnette.appels[0].enveloppe, /^📬 VALXOS Messenger: 1 letter waiting for hal-test — from "alice", subject "first"/);
  assert.equal(premiere.prises, 3, "la tournée a bien pris L2 et L3 après la sonnerie");
  assert.equal(premiere.remises, 1);
  assert.equal(premiere.motifs["sonnee-codex"], 1);
  assert.equal(premiere.motifs["sonnette-codex-differee"], 2);
  assert.ok(lettreDe(db, "L1").carried_at);
  for (const id of ["L2", "L3"]) assert.equal(lettreDe(db, id).carried_at, null, `${id} n'est pas portée : aucune enveloppe ne l'a nommée`);

  horloge += REGLAGES_FACTEUR_PAR_DEFAUT.ajournementMaximalMs + 1;
  const seconde = await faireLaTournee(db, deps);
  assert.equal(sonnette.appels.length, 2, "L2 et L3 sonnent à la tournée suivante, dans UNE enveloppe : la même chaise, sous deux adresses");
  assert.equal(
    sonnette.appels[1].enveloppe,
    "📬 VALXOS Messenger: 2 letters waiting for hal-test — from \"bob\", subject \"second\", priority \"normal\"; 1 other unread. Call the inbox tool."
  );
  assert.equal(seconde.motifs["sonnee-codex"], 2);
  for (const id of ["L2", "L3"]) assert.ok(lettreDe(db, id).carried_at, `${id} est portée par l'enveloppe qui la nomme`);
});

test("round 1 — l'enveloppe d'une chaise réunit ses lettres sous toutes ses adresses, jamais celles d'une autre chaise ni d'une lignée ambiguë", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  const autre = chaise(db, { lignee: "bob", session: "s-bob" });
  insertMessage(db, { msg_id: "L-nue", sender: "alice", recipient: "hal-test", subject: "bare", body: "x" });
  insertMessage(db, { msg_id: "L-entiere", sender: "carol", recipient: `hal-test#${fiche.thread_id}`, priority: "high", subject: "full", body: "x" });
  insertMessage(db, { msg_id: "L-bob", sender: "alice", recipient: "bob", body: "x" });
  const sonnette = sonnetteDeCarton();
  const guichet = guichetDeCarton();
  const bilan = await faireLaTournee(
    db,
    depsCodex(fiche, sonnette, { tourHouses: inventaire([autre]), remettreAuGuichet: guichet.remettre })
  );
  assert.equal(sonnette.appels.length, 1);
  assert.equal(
    sonnette.appels[0].enveloppe,
    "📬 VALXOS Messenger: 2 letters waiting for hal-test — from \"carol\", subject \"full\", priority \"high\". Call the inbox tool."
  );
  assert.equal(bilan.motifs["sonnee-codex"], 2);
  assert.equal(guichet.remises.length, 1, "la lettre de bob part par SA porte, jamais dans l'enveloppe de hal-test");
});

test("round 1 — un verdict d'ÉCHEC en cache se reprend pour toute lettre du fil : un `codex` qui pend ne se refrappe pas, même pour une lettre arrivée pendant la sonnerie", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", body: "one" });
  const sonnette = sonnetteDeCarton({ ok: false, mode: null, erreur: "codex-delai" });
  let arrivees = 0;
  const bilan = await faireLaTournee(
    db,
    depsCodex(fiche, sonnette, {
      dormir: async () => {
        if (arrivees++ === 0) insertMessage(db, { msg_id: "L2", sender: "bob", recipient: "hal-test", body: "two" });
      }
    })
  );
  assert.equal(sonnette.appels.length, 1);
  assert.equal(bilan.motifs["sonnette-codex-impossible"], 2);
  assert.equal(bilan.motifs["sonnette-codex-differee"], undefined);
});

// ── ROUND 1, CONSTAT 2 — envoi_status MONTRE LA DERNIÈRE TENTATIVE DE LA TOURNÉE ─────────────────
// Une lettre de table vers une chaise Codex dont la sonnette rate : l'avis se tait (la chaise est
// livrable), `sonne` reste nul — et sans ce champ, l'expéditeur ne voyait nulle part pourquoi.
test("round 1 — envoi_status porte, par lettre, la dernière tentative du Facteur (tournee) : sonnette-codex-impossible quand la sonnette rate, remise quand elle passe, null avant toute tournée", async (t) => {
  const db = bureauDePoste(t);
  creerTable(db, { nom: "office-test", creeePar: "alice" });
  for (const membre of ["alice", "hal-test"]) ajouterMembre(db, "office-test", membre, { ajoutePar: "alice" });
  const fil = "0199c0de-0000-7000-8000-0000000000d5";
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: fil, codex_home: "/codex/carton-status", pid: process.pid });

  const client = new Client({ name: "porte-codex-envoi-status", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(path.resolve(new URL("..", import.meta.url).pathname), "src/mcp-server/server.js")],
      env: { ...envPropre(), CC2CC_V2_HOME: db.racine, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: "alice" }
    })
  );
  t.after(() => client.close());
  const outil = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  const rate = await outil("send", { to: "table:office-test", subject: "status", body: "SECRET" });
  assert.equal(rate.sent, true, JSON.stringify(rate));
  const avant = await outil("envoi_status", { envoi_id: rate.envoi_id });
  assert.equal(avant.lettres.length, 1);
  assert.equal(avant.lettres[0].tournee, null, "avant toute tournée : null");
  assert.equal(avant.lettres[0].attente, undefined, "la chaise Codex est livrable : l'avis se tait");

  // La tournée lit la vraie fiche au bureau (aucun lecteur injecté) ; la sonnette est de carton.
  const tournee0 = (sonnette) => faireLaTournee(db, depsDeBase({ tourHouses: inventaire([]), sonnerLaChaiseCodex: sonnette.sonner }));
  await tournee0(sonnetteDeCarton({ ok: false, mode: null, erreur: "codex-delai" }));
  const apres = await outil("envoi_status", { envoi_id: rate.envoi_id });
  const tournee = apres.lettres[0].tournee;
  assert.equal(tournee.state, "echouee");
  assert.equal(tournee.reason, "sonnette-codex-impossible");
  assert.ok(!Number.isNaN(Date.parse(tournee.at)), `at est une date : ${tournee.at}`);
  assert.equal(apres.lettres[0].etats.sonne, null);

  // Le contrôle : une sonnette qui passe se lit « remise », sans raison.
  const passe = await outil("send", { to: "table:office-test", subject: "status again", body: "SECRET" });
  await tournee0(sonnetteDeCarton());
  const vue = (await outil("envoi_status", { envoi_id: passe.envoi_id })).lettres[0];
  assert.deepEqual({ state: vue.tournee.state, reason: vue.tournee.reason }, { state: "remise", reason: null });
  assert.ok(vue.etats.sonne, "la remise se voit aussi dans sonne");
});

// B17 (marche Codex) — UNE ENVELOPPE, UN INSTANT. Deux lettres qui partent dans la même sonnerie
// étaient marquées portées chacune à son tour de remise : la seconde après la pause entre remises,
// deux secondes après la vraie sonnerie (08:53:47.931 contre 08:53:49.935, marche du 22/10). Chaque
// lettre de l'enveloppe porte maintenant l'instant de la sonnerie commune.
test("B17 — deux lettres d'une même enveloppe : carried_at = l'instant de la sonnerie commune, pas celui de chaque remise", async (t) => {
  const db = bureauDePoste(t);
  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hal-test", subject: "TA", body: "one" });
  insertMessage(db, { msg_id: "L2", sender: "alice", recipient: "hal-test", subject: "TB", body: "two" });
  let horloge = Date.parse("2026-10-22T08:53:47.000Z");
  const sonnette = sonnetteDeCarton(async () => {
    horloge += 931; // la frappe prend son temps : la sonnerie a lieu à 08:53:47.931
    return { ok: true, mode: "queue" };
  });
  const bilan = await faireLaTournee(db, depsCodex(fiche, sonnette, {
    horloge: () => horloge,
    reglages: { pauseEntreRemisesMs: 2000 },
    dormir: async (ms) => {
      horloge += ms;
    }
  }));
  assert.equal(sonnette.appels.length, 1, "une seule sonnerie pour les deux");
  assert.equal(bilan.motifs["sonnee-codex"], 2);
  assert.deepEqual(
    db.prepare("SELECT msg_id, carried_at FROM messages ORDER BY seq").all(),
    [{ msg_id: "L1", carried_at: "2026-10-22T08:53:47.931Z" }, { msg_id: "L2", carried_at: "2026-10-22T08:53:47.931Z" }]
  );
});

// B18 (marche Codex) — `codex queue` NE REGARDE AUCUN DÉPÔT. Lancé dans le dossier du Facteur (un
// dépôt, souvent), Codex y avait un dépôt à inspecter ; la marche a vu chaque `codex queue` laisser un
// `$CODEX_HOME/.tmp/git-XXXXXX`. La porte le lance maintenant dans un dossier du bureau qui n'est pas
// un dépôt : `<bureau>/run/`, créé s'il manque. Le faux `codex` journalise son dossier de travail.
test("B18 — codex queue est lancé dans <bureau>/run/ (un dossier non-git du bureau), ou dans le dossier donné", async (t) => {
  const db = bureauDePoste(t);
  const bureau = db.racine;
  const codex = fauxCodex("ok");
  const verdict = await sonnerSansHate({ fiche: FICHE, enveloppe: ENVELOPPE, lancer: codex.lancer, plateforme: "darwin", appOuverte: () => true });
  assert.deepEqual(verdict, { ok: true, mode: "queue" });
  const [appel] = codex.appels();
  assert.equal(appel.cwd, fs.realpathSync(path.join(bureau, "run")), "le dossier run/ du bureau");
  assert.notEqual(appel.cwd, fs.realpathSync(process.cwd()), "jamais le dossier du processus qui sonne");
  assert.equal(fs.existsSync(path.join(bureau, "run", ".git")), false);

  const ailleurs = decorJetable("cc2cc-sonnette-cwd-");
  const autre = fauxCodex("ok");
  await sonnerSansHate({ fiche: FICHE, enveloppe: ENVELOPPE, lancer: autre.lancer, plateforme: "darwin", appOuverte: () => true, cwd: ailleurs });
  assert.equal(autre.appels()[0].cwd, fs.realpathSync(ailleurs), "un dossier donné gagne");
});

// S12 (seconde passe adverse) — UN `run/` QU'ON NE PEUT PAS ASSURER NE REND JAMAIS LE DOSSIER DU
// FACTEUR. `dossierDeLaSonnette` rendait `null` et `codex queue` héritait du dossier courant (un
// dépôt, souvent : ce que B18 écarte). La sonnerie se dit maintenant impossible (`run-inaccessible`),
// `codex` ne part pas, et la lettre reste aux hooks et à une tournée suivante. Le bureau dont `run/`
// est un FICHIER (posé après l'ouverture de la base) en tient lieu : aucune permission touchée.
test("S12 — run/ est un fichier : codex ne part pas, la sonnerie rend run-inaccessible ; la tournée note sonnette-codex-impossible et ne porte pas la lettre", async (t) => {
  const db = bureauDePoste(t);
  const run = path.join(db.racine, "run");
  fs.rmSync(run, { recursive: true, force: true });
  fs.writeFileSync(run, "");
  assert.equal(dossierDeLaSonnette(), null, "sonde impossible sinon : run/ ne peut pas être assuré");
  const codex = fauxCodex("ok");
  const seule = await sonnerSansHate({ fiche: FICHE, enveloppe: ENVELOPPE, lancer: codex.lancer, plateforme: "darwin", appOuverte: () => true });
  assert.deepEqual(seule, { ok: false, mode: null, erreur: "run-inaccessible" });
  assert.deepEqual(codex.appels(), [], "aucun codex lancé, ni du dossier du Facteur ni d'ailleurs");

  const fiche = ficheCodexVivante(db);
  insertMessage(db, { msg_id: "S12", sender: "alice", recipient: "hal-test", body: "waits" });
  const journal = [];
  const porte = { sonner: (arg) => sonnerLaChaiseCodex({ ...arg, delaiMs: DELAI_TRANQUILLE, graceMs: GRACE_TRANQUILLE, lancer: codex.lancer, plateforme: "darwin", appOuverte: () => true }) };
  const bilan = await faireLaTournee(db, depsCodex(fiche, porte, { journal: (ligne) => journal.push(ligne) }));
  assert.equal(bilan.motifs[MOTIF_SONNETTE_IMPOSSIBLE], 1, JSON.stringify(bilan));
  assert.equal(lettreDe(db, "S12").carried_at, null, "la lettre n'est pas portée : les hooks et la tournée suivante la servent");
  assert.deepEqual(codex.appels(), []);
  assert.equal(journal.find((ligne) => ligne.evenement === "facteur_sonnette_codex")?.erreur, "run-inaccessible");
});
