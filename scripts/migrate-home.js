#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// Copie explicite du bureau historique vers le nouveau bureau. Règles :
// - refus tant qu'un processus tient la base en écriture (lsof sur la base, -wal
//   et -shm) ; une sonde lsof qui n'a pas pu tourner refuse aussi ;
// - la base se copie par l'API de sauvegarde SQLite dès qu'un -wal ou un -shm
//   existe ; sans aucun des deux (bureau au repos, checkpointé : un seul
//   fichier, aucun état WAL à déchirer), par copyFileSync — la source n'est
//   alors jamais ouverte, car un lecteur SQLite y créerait -wal/-shm. Dans
//   les deux cas, `PRAGMA integrity_check` sur la copie ;
// - le marqueur (un FICHIER, une ligne : date ISO + source) se pose en dernier ;
// - une cible non vide refuse, sauf --force qui la met de côté datée (jamais effacée).
// Codes de sortie : 0 ok · 2 refus (écrivain, sonde impossible, cible, drapeau
// inconnu) · 1 erreur. `-h`/`--help` imprime l'usage et sort 0, avant de lire quoi
// que ce soit (F3, revue finale, 18/10 : l'aide sortait 1, « unknown argument »).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { MARQUEUR_BUREAU, homeDir } from "../src/lib/config.js";
import { optionalArg, parseArgs } from "../src/bin/cli-common.js";

const FICHIERS_DB = ["broker.db", "broker.db-wal", "broker.db-shm"];

class Refus extends Error {}

// Le parseur partagé (cli-common.js), comme `valxos-migrate-v1` : `-h`/`--help`
// → l'usage, sortie 0 ; un drapeau, un `-x` ou un mot inconnu → l'usage, sortie 2,
// avant toute lecture du bureau. `--source`/`--target` sans valeur : refus nommé
// (2). `--dry-run` et `--apply` ensemble : le plus prudent gagne (la simulation),
// comme pour `valxos-migrate-v1` — l'ancien « le dernier gagne » pouvait COPIER
// sur un `--apply --dry-run` écrit à la hâte.
function lireArguments(argv) {
  const args = parseArgs(argv, {
    booleans: ["apply", "dry_run", "force"],
    known: ["source", "target"],
    positionals: false,
    usage: "usage: valxos-migrate-home [--dry-run | --apply] [--force] [--source DIR] [--target DIR]"
  });
  const apply = args.apply === true && args.dry_run !== true;
  // Un chemin vide n'est pas « le défaut » : l'ancien parseur le refusait
  // (« requires a path »), celui-ci aussi.
  const chemin = (cle) => {
    const valeur = optionalArg(args, cle);
    if (valeur === "") {
      process.stderr.write(`Missing value for --${cle} (an empty path was given)\nNothing was done.\n`);
      process.exit(2);
    }
    return valeur ?? null;
  };
  return { mode: apply ? "apply" : "dry-run", source: chemin("source"), target: chemin("target"), force: args.force === true };
}

// Trois issues : personne, des écrivains (refus), ou sonde impossible (refus).
// Rend [{ pid, commande }] ; ne lit jamais que les pids et les noms des tenants.
export function ecrivains(source) {
  const fichiers = FICHIERS_DB.map((f) => path.join(source, f)).filter((f) => fs.existsSync(f));
  if (fichiers.length === 0) return [];
  const candidats = process.env.VALXOS_MESSENGER_LSOF ? [process.env.VALXOS_MESSENGER_LSOF] : ["lsof", "/usr/sbin/lsof"];
  for (const lsof of candidats) {
    let sortie;
    try {
      sortie = execFileSync(lsof, ["-F", "pca", "--", ...fichiers], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      if (e.code === "ENOENT") continue;
      // lsof sort en 1, sans rien dire sur stderr, quand un des fichiers nommés
      // n'est ouvert par personne : stdout porte alors les tenants des autres
      // (ou rien = personne). Toute autre sortie est une sonde impossible.
      if (e.status === 1 && !String(e.stderr || "").trim()) sortie = String(e.stdout || "");
      else {
        const detail = String(e.stderr || "").trim().split("\n")[0] || e.message;
        throw new Refus(`probe impossible (lsof failed: ${detail}): cannot prove that the office is at rest`);
      }
    }
    const tenants = new Map();
    let pid = null;
    let commande = "?";
    for (const ligne of sortie.split("\n")) {
      const champ = ligne[0];
      const valeur = ligne.slice(1);
      if (champ === "p") { pid = Number(valeur); commande = "?"; }
      else if (champ === "c") commande = valeur;
      else if (champ === "a" && /[wu]/.test(valeur) && pid !== null && pid !== process.pid) tenants.set(pid, commande);
    }
    return [...tenants].map(([p, c]) => ({ pid: p, commande: c }));
  }
  throw new Refus("probe impossible (lsof not found): cannot prove that the office is at rest");
}

function refuserSiEcrivains(source) {
  const tenants = ecrivains(source);
  if (tenants.length > 0) {
    const liste = tenants.map((t) => `pid ${t.pid} (${t.commande})`).join(", ");
    throw new Refus(`live office: writers hold the database (${liste}); stop them, or use the symlink switch (Phase A)`);
  }
  return tenants;
}

function inventaire(racine) {
  let fichiers = 0;
  let octets = 0;
  const ignores = [];
  // F5 (passe adverse, 28/09) : les liens qui SORTENT du bureau — absolus, ou
  // relatifs qui mènent hors de la racine. Copiés tels quels (verbatim), ils
  // mènent au même endroit qu'avant : pour un lien absolu dans la source,
  // c'est la SOURCE. Le plan les nomme ; rien n'est réécrit.
  const liensSortants = [];

  function marcher(dossier, relatif = "") {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const prochainRelatif = path.join(relatif, entree.name);
      const absolu = path.join(dossier, entree.name);
      if (prochainRelatif === "run") {
        ignores.push("run (sockets, pid and ephemeral locks)");
        continue;
      }
      if (entree.isDirectory()) marcher(absolu, prochainRelatif);
      else if (entree.isFile()) {
        fichiers += 1;
        octets += fs.statSync(absolu).size;
      } else if (entree.isSymbolicLink()) {
        fichiers += 1;
        const cibleDuLien = fs.readlinkSync(absolu);
        const menee = path.resolve(path.dirname(absolu), cibleDuLien);
        const sort = path.isAbsolute(cibleDuLien) || path.relative(racine, menee).startsWith("..");
        if (sort) liensSortants.push({ path: prochainRelatif, target: cibleDuLien });
      } else {
        ignores.push(`${prochainRelatif} (special entry)`);
      }
    }
  }

  marcher(racine);
  return { fichiers, octets, ignores, links_leaving_office: liensSortants };
}

function horodatage() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function cheminDeCote(cible) {
  const base = `${cible}.aside-${horodatage()}`;
  let candidat = base;
  for (let n = 1; fs.existsSync(candidat) || estUnLien(candidat); n += 1) candidat = `${base}-${n}`;
  return candidat;
}

function estUnLien(chemin) {
  try { return fs.lstatSync(chemin).isSymbolicLink(); } catch { return false; }
}

function realOuNull(chemin) {
  try { return fs.realpathSync(chemin); } catch { return null; }
}

// La cible : absente ou dossier vide → on copie ; non vide → refus, ou mise de côté avec --force.
function etatDeLaCible(cible) {
  if (!fs.existsSync(cible) && !estUnLien(cible)) return "absente";
  if (!estUnLien(cible) && fs.statSync(cible).isDirectory() && fs.readdirSync(cible).length === 0) return "vide";
  return "occupee";
}

async function copier(source, cible, sourceDb) {
  fs.mkdirSync(cible, { recursive: true, mode: 0o700 });
  let integrity = "absente";
  let copyMode = null;
  const sidecarsAvant = FICHIERS_DB.slice(1).filter((f) => fs.existsSync(path.join(source, f)));
  if (sourceDb) {
    if (sidecarsAvant.length === 0) {
      // Bureau au repos prouvé par lsof, sans -wal ni -shm : broker.db est un
      // fichier complet. On ne l'ouvre pas (un lecteur y poserait -wal/-shm).
      copyMode = "file";
      fs.copyFileSync(path.join(source, "broker.db"), path.join(cible, "broker.db"), fs.constants.COPYFILE_EXCL);
    } else {
      copyMode = "backup-api";
      const lecteur = new Database(path.join(source, "broker.db"), { readonly: true, fileMustExist: true });
      try {
        await lecteur.backup(path.join(cible, "broker.db"));
      } finally {
        lecteur.close();
      }
    }
    const copie = new Database(path.join(cible, "broker.db"), { readonly: true, fileMustExist: true });
    try {
      integrity = String(copie.pragma("integrity_check", { simple: true }));
    } finally {
      copie.close();
    }
    if (integrity !== "ok") {
      throw new Error(`integrity_check of the copy: ${integrity}; marker not set, ${cible} is not an office`);
    }
  }
  // Un lecteur SQLite en lecture seule sur une base WAL crée -wal/-shm vides ;
  // on le dit plutôt que d'effacer quoi que ce soit dans la source.
  const sidecarsCrees = FICHIERS_DB.slice(1).filter((f) => !sidecarsAvant.includes(f) && fs.existsSync(path.join(source, f)));
  // Copie par entrée de premier niveau, jamais `cpSync(source, cible, …)` sur
  // la racine : depuis Node 26.10.0, `{ force: false, errorOnExist: true }`
  // lève ERR_FS_CP_EEXIST dès que la racine cible existe déjà — même vide,
  // même pour une copie légitime (`cible` vient d'être créée juste au-dessus).
  // Node 26.9.0 l'acceptait ; le correctif ne dépend plus de la version.
  // Le même filtre qu'avant, appliqué à chaque entrée puis récursivement en
  // dessous : il exclut `run/`, les fichiers de la base et le marqueur à la
  // racine de la source, à toute profondeur.
  const filtre = (entree) => {
    const relatif = path.relative(source, entree);
    if (relatif === "") return true;
    if (relatif === "run" || relatif.startsWith(`run${path.sep}`)) return false;
    if (FICHIERS_DB.includes(relatif)) return false;
    return relatif !== MARQUEUR_BUREAU;
  };
  const entrees = fs.readdirSync(source, { withFileTypes: true })
    .map((entree) => entree.name)
    .sort();
  for (const nom of entrees) {
    const cheminSource = path.join(source, nom);
    if (!filtre(cheminSource)) continue;
    fs.cpSync(cheminSource, path.join(cible, nom), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      // F5 (passe adverse, 28/09) : sans lui, `logs/current.log -> facteur.log`
      // devenait un lien ABSOLU vers la source, et écrire par le nouveau bureau
      // modifiait l'ancien. Un lien se copie tel qu'il est écrit.
      verbatimSymlinks: true,
      filter: filtre
    });
  }
  return { integrity, sidecarsCrees, copyMode };
}

async function executer() {
  const args = lireArguments(process.argv.slice(2));
  const home = homeDir(); // N5 : jamais un HOME vide ou relatif
  const source = path.resolve(args.source || path.join(home, ".cc2cc-v2"));
  const target = path.resolve(args.target || path.join(home, ".valxos-messenger"));

  if (source === target || target.startsWith(`${source}${path.sep}`)) {
    throw new Error("the target must differ from the source and cannot live inside it");
  }
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`historical office missing or unreadable: ${source}`);
  }
  const reelleSource = fs.realpathSync(source);
  const reelleCible = realOuNull(target);
  if (reelleCible && (reelleCible === reelleSource || reelleCible.startsWith(`${reelleSource}${path.sep}`))) {
    throw new Refus(`the target ${target} leads to the source ${source} (a Phase A symlink?): nothing to copy, nothing to move aside`);
  }

  const etat = etatDeLaCible(target);
  if (etat === "occupee" && !args.force) {
    throw new Refus(`the target already exists and is not empty: ${target}; two offices are never merged implicitly (--force moves it aside, dated, erasing nothing)`);
  }
  const aside = etat === "occupee" ? cheminDeCote(target) : null;

  const writers = refuserSiEcrivains(source);
  const sourceDb = fs.existsSync(path.join(source, "broker.db"));
  const compte = inventaire(source);
  const marker = path.join(target, MARQUEUR_BUREAU);
  let integrity = null;
  let sidecarsCrees = [];
  let copyMode = null;

  if (args.mode === "apply") {
    if (aside) fs.renameSync(target, aside);
    ({ integrity, sidecarsCrees, copyMode } = await copier(source, target, sourceDb));
    // Un écrivain arrivé pendant la copie : la copie reste cohérente (sauvegarde
    // SQLite) mais elle n'est plus le bureau — pas de marqueur.
    refuserSiEcrivains(source);
    fs.writeFileSync(marker, `${new Date().toISOString()} ${source}\n`, { mode: 0o600, flag: "wx" });
  }

  // The door refuses to start without an operator. If web.env travelled without
  // one (the operator lived in the launcher's env), say it now, not tomorrow.
  const webEnv = path.join(args.mode === "apply" ? target : source, "web.env");
  let operatorMissing = false;
  if (fs.existsSync(webEnv)) {
    const texte = fs.readFileSync(webEnv, "utf8");
    operatorMissing = !/^\s*(VALXOS_WEB_OPERATEUR|CC2CC_WEB_OPERATEUR)=\S/m.test(texte);
  }
  if (operatorMissing) {
    process.stderr.write("note: web.env carries no VALXOS_WEB_OPERATEUR — set it in web.env or in the door's environment before launching valxos-web\n");
  }

  // En dry-run, le plan annonce le chemin que prendrait la copie à cet instant.
  const modeEffectif = args.mode === "apply"
    ? copyMode
    : (sourceDb ? (FICHIERS_DB.slice(1).some((f) => fs.existsSync(path.join(source, f))) ? "backup-api" : "file") : null);
  process.stdout.write(`${JSON.stringify({
    mode: args.mode,
    source,
    target,
    aside,
    copied: args.mode === "apply",
    source_preserved: true,
    writers,
    copy_mode: modeEffectif,
    db_copied_by: { file: "file-copy", "backup-api": "sqlite-backup" }[modeEffectif] ?? null,
    integrity: args.mode === "apply" ? integrity : null,
    marker: args.mode === "apply" ? marker : null,
    source_sidecars_created: sidecarsCrees,
    operator_missing_in_web_env: operatorMissing,
    ...compte
  }, null, 2)}\n`);
}

const lanceDirectement = (() => {
  try { return fs.realpathSync(process.argv[1] || "") === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (lanceDirectement) {
  executer().catch((erreur) => {
    const refus = erreur instanceof Refus;
    process.stderr.write(`office migration ${refus ? "refused" : "failed"}: ${erreur.message}\n`);
    process.exitCode = refus ? 2 : 1;
  });
}
