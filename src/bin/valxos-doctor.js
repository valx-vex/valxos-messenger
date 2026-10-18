#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { lettresEnSouffrance, listPeers, openDatabase } from "../lib/database.js";
import { SCHEMA_VERSION, schemaVersion } from "../lib/migrations.js";
import { reapDeadPeers } from "../lib/registry.js";
import { homeDir, pluginTargetPath, repoRoot, runtimePaths, seuilsDeSouffrance } from "../lib/config.js";
import { SERVICES, labelsDesactives, launchctlUtilise, legacyLabels, plistPath } from "../lib/launchd-labels.js";
import { parseArgs, printJson } from "./cli-common.js";
import { ETATS_LISIBLES, etatDeLaLettre } from "../lib/format.js";

// N4 : les arguments se tranchent AVANT le bureau — un drapeau inconnu ou un
// mot nu ne crée rien, n'ouvre rien.
const argsDuDocteur = parseArgs(process.argv.slice(2), {
  booleans: ["reap"],
  known: [],
  positionals: false,
  usage: "usage: valxos-doctor [--reap]   (--reap: mark dead chairs dead, an explicit gesture)"
});

// LE MÉDECIN NE CRÉE PAS LE BUREAU QU'IL DIAGNOSTIQUE (Q3, revue qualité, 18/10).
// Il appelait `ensureRuntimeDirs()` puis `getDatabase()` avant tout constat : sur
// une machine sans bureau il créait la base et les dossiers, puis rapportait
// `dbExists: true` — un constat qui ne pouvait jamais être faux. Trois issues :
//   · pas de bureau → `dbExists: false`, rien n'est créé (même avec --reap : il
//     n'y a rien à moissonner) ;
//   · un bureau, sans --reap → ouvert en LECTURE SEULE : aucune ligne, aucune
//     migration, aucun dossier ;
//   · un bureau, avec --reap → ouvert en écriture, comme tout geste explicite
//     (la migration additive se joue à l'ouverture, la moisson ensuite).
const paths = runtimePaths();
const reap = argsDuDocteur.reap === true;
const dbExists = fs.existsSync(paths.db);
const db = dbExists ? openDatabase({ file: paths.db, readonly: !reap }) : null;

// Un bureau d'une version plus ancienne n'a pas les colonnes que ce médecin
// compte, et l'ouvrir en lecture seule ne les crée pas (une migration est une
// écriture). Il le DIT au lieu de planter ou de compter des zéros qui auraient
// l'air vrais : une sonde qui n'a pas pu tourner n'est jamais un pass. Toute
// autre commande qui ouvre le bureau le migre ; --reap aussi.
const versionDuSchema = db === null ? null : schemaVersion(db);
const schemaEnRetard = versionDuSchema !== null && versionDuSchema < SCHEMA_VERSION;
const lisible = db !== null && !schemaEnRetard;

// Le médecin passe : il constate les morts avant de compter les vivants. Une
// moisson qui échoue ne fait pas échouer le diagnostic — elle se DIT.
// Ruling 11 : le médecin lit ; il n'écrit que sur --reap, un geste humain.
let moisson = { checked: 0, reaped: 0, abstained: 0, moissonnees: [], abstenues: [], mode: reap ? "moisson" : "rapport" };
let moissonErreur = null;
if (lisible) {
  try {
    moisson = reapDeadPeers(db, { dryRun: !reap });
  } catch (erreur) {
    moissonErreur = String(erreur?.message || erreur);
  }
}
// LE BILAN DE LA MOISSON, UNE FOIS : `checks.moisson` est la source ;
// peersChecked / peersReaped / peersAbstained (plus anciens que lui) en
// sont des alias de compatibilité, lus ICI et nulle part ailleurs, pour
// que les deux formes ne puissent pas diverger.
const bilanMoisson = { mode: moisson.mode, checked: moisson.checked, reaped: moisson.reaped, abstained: moisson.abstained };
let claudeVersion = null;
try {
  // `claude` inherits the whole environment on purpose: it is the operator's
  // own harness, the same trust domain as this process — unlike the probes of
  // the postbox, which get a minimal env (rev-t7, B10).
  claudeVersion = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
} catch {
  claudeVersion = "unavailable";
}

// PRÉSENT n'est pas EXÉCUTABLE — S1 (remède de la revue adverse) : facteur.js était un lien
// bien PRÉSENT, mode 644, et cliCommands disait quand même « ok » : existsSync
// ne voit pas le bit d'exécution. accessSync(X_OK) le voit, et ne lève que
// pour dire non — ce doctor aurait vu S1 s'il avait posé cette question-là.
function estExecutable(chemin) {
  try {
    fs.accessSync(chemin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────── THE FACTEUR LOCK ───────────────────────────
//
// The doctor reports whether the Facteur daemon is running, but does NOT
// make `ok` depend on it — the Facteur is a separate service that the
// operator starts independently. A green install with a stopped Facteur is
// a complete install, not a sick one. The doctor says what IS, not what
// SHOULD be.
function etatDuFacteur() {
  const verrou = path.join(paths.run, "facteur.verrou");
  try {
    const brut = fs.readFileSync(verrou, "utf8");
    const tenant = JSON.parse(brut);
    return { running: true, pid: tenant.pid || null, since: tenant.depuis || null, verrou };
  } catch (erreur) {
    if (erreur?.code === "ENOENT") return { running: false, pid: null, since: null, verrou };
    return { running: false, pid: null, since: null, verrou, illisible: true };
  }
}

// ─────────────────────────── THE WEB DOOR ENV ───────────────────────────
//
// The web door refuses to start without VALXOS_WEB_OPERATEUR in web.env.
// The doctor reports the file's existence, not its contents — the operator
// name is private.
function webEnvExists() {
  const envFile = path.join(paths.root, "web.env");
  return fs.existsSync(envFile);
}


// LES PLISTS HISTORIQUES RESTÉS DANS LaunchAgents (F1, passe adverse, 28/09).
// Camp B les garde sur le disque ; launchd charge tout ce dossier à la
// connexion, et un label historique non désactivé redémarre la vieille porte
// sur 8790 à côté de la nôtre. Le doctor les NOMME, à côté des nôtres ; il ne
// sonde pas launchctl et ne touche rien — le geste (`disable`) est dit.
function plistsHistoriques() {
  const home = homeDir();
  const plists = legacyLabels()
    .map((label) => ({ label, path: plistPath(home, label) }))
    .filter((p) => fs.existsSync(p.path));
  const aCoteDesNotres = plists.length > 0 && SERVICES.some(({ label }) => fs.existsSync(plistPath(home, label)));
  // N2 (seconde passe adverse, 28/09) : présent ne dit pas activé. On lit
  // l'état avec `launchctl print-disabled gui/<uid>` (lecture seule). Trois
  // issues : désactivé (calme), activé (rouge à côté des nôtres), sonde
  // impossible (rouge aussi : une sonde qui n'a pas tourné n'est jamais un pass).
  let sonde = "ok";
  let nonDesactives = [];
  if (plists.length > 0) {
    try {
      const sortie = execFileSync(launchctlUtilise(), ["print-disabled", `gui/${process.getuid()}`], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
      });
      const desactives = labelsDesactives(sortie);
      nonDesactives = plists.map((p) => p.label).filter((l) => !desactives.has(l));
    } catch {
      sonde = "impossible";
      nonDesactives = plists.map((p) => p.label);
    }
  }
  return {
    plists,
    aCoteDesNotres,
    sonde,
    nonDesactives,
    ...(nonDesactives.length > 0
      ? {
        remede: `launchd will load them at the next login: ${
          nonDesactives.map((l) => `launchctl disable gui/$(id -u)/${l}`).join(" ; ")}`
      }
      : {})
  };
}

const checks = {
  repoRoot: repoRoot(),
  runtimeRoot: paths.root,
  dbExists,
  pluginManifestExists: fs.existsSync(`${repoRoot()}/.claude-plugin/plugin.json`),
  pluginTarget: pluginTargetPath(),
  pluginTargetExists: fs.existsSync(pluginTargetPath()),
  // TOUS les liens que l'installeur pose : les clefs de `bin` du manifeste, lues
  // au même endroit que lui (scripts/install.js) — une liste écrite à la main
  // oubliait `valxos-messenger` et les dix alias `cc2cc-*` (Q19, revue qualité).
  cliCommands: Object.fromEntries(
    Object.keys(JSON.parse(fs.readFileSync(path.join(repoRoot(), "package.json"), "utf8")).bin).map((name) => [
      name,
      estExecutable(`${homeDir()}/.local/bin/${name}`)
    ])
  ),
  claudeVersion,
  // The Facteur daemon: the doctor reports its state honestly. The lock
  // file's existence is the best local signal; verifying the PID is alive
  // requires /bin/ps which may not be available in all environments.
  facteur: etatDuFacteur(),
  // The web door: reports whether web.env exists (required to start).
  webEnvExists: webEnvExists(),
  // N2 : rouge quand un plist historique non désactivé est à côté des nôtres.
  launchdLegacy: plistsHistoriques(),
  // Un bureau d'une version plus ancienne, lu en lecture seule : le médecin n'a
  // pas pu compter, et il le dit ici (absent quand le schéma est à jour).
  ...(schemaEnRetard
    ? {
      schemaBehind: {
        version: versionDuSchema,
        expected: SCHEMA_VERSION,
        remede: "this office predates the schema this version counts; any command that opens it for writing " +
          "(valxos-peers, valxos-doctor --reap) migrates it in place, additively and without erasing anything — then run valxos-doctor again"
      }
    }
    : {}),
  // « peers » compte ce qui REÇOIT. Le total dit ce que la base garde. En
  // rapport (sans --reap), `moisson.reaped` compte les CANDIDATES : rien n'est
  // marqué, et `remede` nomme le geste qui le ferait.
  peers: lisible ? listPeers(db).length : 0,
  peersTotal: lisible ? listPeers(db, { includeDead: true }).length : 0,
  moisson: bilanMoisson,
  ...(bilanMoisson.reaped > 0 && bilanMoisson.mode === "rapport" ? { remede: "valxos-chaise moissonner" } : {}),
  // Alias de compatibilité (la forme d'avant `moisson`) : ils MIROITENT
  // bilanMoisson, ils ne comptent rien eux-mêmes. `peersAbstained` : les
  // chaises sur lesquelles la sonde n'a pas conclu — ni vivantes ni mortes.
  peersChecked: bilanMoisson.checked,
  peersReaped: bilanMoisson.reaped,
  peersAbstained: bilanMoisson.abstained,
  // Les lettres par ÉTAT LISIBLE — dérivé au comptage, jamais stocké, par la
  // même fonction que l'affichage (une seule vérité, format.js).
  lettres: (lisible ? db.prepare("SELECT acked_at, delivered_at, injected_at, carried_at FROM messages").all() : [])
    .reduce(
      (comptes, row) => {
        const etat = etatDeLaLettre(row);
        comptes[etat] = (comptes[etat] || 0) + 1;
        return comptes;
      },
      Object.fromEntries(ETATS_LISIBLES.map((etat) => [etat, 0]))
    ),
  // L'EN-SOUFFRANCE (H2) : une lettre que personne n'a signée a un nom, un
  // compte et une échéance — c'est ICI qu'on les lit. Dérivé au passage du
  // médecin, jamais stocké ; la base suffit (facteur_attempts porte motifs et
  // comptes), le journal du démon n'est pas requis. La borne d'affichage se
  // NOMME : une borne silencieuse se lirait « tout est là ». Le diagnostic
  // compte TOUT — la seule borne est celle de l'AFFICHAGE (les 20
  // destinataires), et elle se nomme ; le total, lui, ne s'arrête jamais.
  souffrance: (() => {
    const seuils = seuilsDeSouffrance();
    const rows = lisible ? lettresEnSouffrance(db, { seuils, limit: Number.MAX_SAFE_INTEGER }) : [];
    const parDestinataire = new Map();
    const motifs = {};
    for (const row of rows) {
      if (row.dernier_motif) motifs[row.dernier_motif] = (motifs[row.dernier_motif] || 0) + 1;
      const entree = parDestinataire.get(row.recipient) || {
        recipient: row.recipient,
        lettres: 0,
        plus_vieille: null,
        tentatives_max: 0,
        dernier_motif: null,
        prochaine_reprise_ms: 0
      };
      entree.lettres += 1;
      if (!entree.plus_vieille || row.created_at < entree.plus_vieille.created_at) {
        entree.plus_vieille = { msg_id: row.msg_id, created_at: row.created_at, depuis_ms: row.depuis_ms };
      }
      entree.tentatives_max = Math.max(entree.tentatives_max, row.tentatives);
      if (row.dernier_motif) entree.dernier_motif = row.dernier_motif;
      entree.prochaine_reprise_ms = Math.max(entree.prochaine_reprise_ms, row.prochaine_reprise_ms);
      parDestinataire.set(row.recipient, entree);
    }
    const lignes = [...parDestinataire.values()].sort((a, b) => b.lettres - a.lettres || (a.recipient < b.recipient ? -1 : 1));
    const BORNE = 20;
    return {
      seuils: { age_ms: seuils.ageMs, tentatives: seuils.tentatives },
      total: rows.length,
      // La clef du RAPPORT est en snake_case comme ses voisines (`age_ms`,
      // `destinataires_au_dela_de_la_borne`) : une surface neuve n'a aucune
      // raison de porter deux conventions. La Map locale garde son nom JS.
      par_destinataire: lignes.slice(0, BORNE),
      motifs,
      destinataires_au_dela_de_la_borne: Math.max(0, lignes.length - BORNE)
    };
  })(),
  reaped: moisson.moissonnees,
  abstained: moisson.abstenues,
  reapError: moissonErreur
};

// Le diagnostic dit vrai : ok se DÉRIVE des faits qu'il vient de constater,
// jamais un littéral qui prétendrait la santé sans l'avoir vérifiée. Tous
// les faits booléens de `checks` entrent dans la conjonction — un manifeste
// absent ne doit pas moins faire mentir ok qu'une cible plugin absente.
//
// The Facteur daemon and the web door are SEPARATE SERVICES. The doctor
// reports their state (checks.facteur.running, checks.webEnvExists) but
// does NOT include them in `ok`. A green `ok` means the INSTALLATION is
// complete — the operator starts the Facteur and the web door separately.
// N2 : un plist historique activé (ou d'état inconnu) à côté des nôtres
// relancerait la vieille porte sur 8790 à la connexion suivante.
checks.launchdLegacyOk = !(checks.launchdLegacy.aCoteDesNotres && checks.launchdLegacy.nonDesactives.length > 0);
const ok = checks.dbExists
  && !schemaEnRetard
  && checks.launchdLegacyOk
  && checks.pluginManifestExists
  && checks.pluginTargetExists
  && Object.values(checks.cliCommands).every(Boolean)
  && checks.reapError === null;
// Tout est constaté : la base se referme avant d'imprimer (un lecteur WAL n'a
// plus de raison de la tenir).
db?.close();
printJson({ product: "VALXOS Messenger (formerly cc2cc-v2 / CEREAL)", ok, checks });
