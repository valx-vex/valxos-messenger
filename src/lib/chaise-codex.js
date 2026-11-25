// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA FICHE DE CHAISE CODEX (1.1.0, spec B §2). Claude Code écrit lui-même
// `sessions/<pid>.json` dans sa maison ; Codex n'écrit rien. C'est donc NOTRE
// hook SessionStart (src/hooks/codex/codex-hook.js) qui écrit la fiche
// `<bureau>/codex/<lignée>.json`, et la porte Codex du Facteur qui la lit pour
// frapper par `codex queue --thread <thread_id>`.
// La fiche est aussi inscrite au registre des pairs, sur la carte NUE de la
// lignée (`id = <lignée>`, jamais `lignée#thread` : le client MCP de la chaise
// Codex parle en nom nu et doit pouvoir accuser), avec `instance_session_id =
// thread_id` et `house = codex_home` — ce que `resolveRecipient` (marche 1 :
// une carte à `instance_session_id` se résout en `instance`), `list_peers`,
// `listLineages` et `envoi_status` lisent.
// `pid` est INDICATIF : c'est le parent du hook (le processus Codex quand
// Codex lance la commande sans shell intermédiaire). Le docteur le lit, et la
// moisson des fiches Codex (`moissonnerLesFichesCodex`, par `valxos-doctor
// --reap`) le juge avec `proc_start` ; aucune décision de livraison ne le lit,
// et la moisson des chaises (`reapDeadPeers`) ne juge pas les cartes Codex.
// Camp B : une fiche ne s'efface jamais ici ; `doctor --reap` la marque
// `dead_at` quand son processus est parti (ou son pid recyclé) ET qu'aucun
// hook ne l'a vue depuis 24 h, et se ré-annoncer efface la marque.
import fs from "node:fs";
import path from "node:path";
import { domicile, nowIso, runtimePaths, safeAgentFileName, validateAgentId } from "./config.js";
import { garderLEcritureDuBureau, getPeer, recordEvent, registerPeer } from "./database.js";
import { isProcessAlive, procStartOf } from "./postbox.js";
// registry.js n'importe ni database.js ni ce module : aucun cycle.
import { EN_SERVICE } from "./registry.js";

// Par quelle porte la chaise parle : la CLI interactive, l'app de bureau, ou
// `codex exec`. Codex ne le dit pas à ses hooks : c'est l'environnement de la
// session qui le dit (`VALXOS_CODEX_PORTE`), posé par son lanceur — ou par la
// commande du hook quand l'installeur l'y a épinglée (`install --codex
// --porte`). ABSENTE (ou vide), c'est `app` : l'app de bureau n'a pas de
// lanceur, et un lanceur de terminal pose `cli` (round 1 de la Tâche 11).
// INCONNUE, c'est `cli`, le côté sûr : l'app ne surgit pas devant un terminal.
export const PORTES_CODEX = ["cli", "app", "exec"];

export function dossierDesFichesCodex() {
  return path.join(runtimePaths().root, "codex");
}

export function cheminDeLaFiche(lineage) {
  return path.join(dossierDesFichesCodex(), `${safeAgentFileName(lineage)}.json`);
}

// Le `CODEX_HOME` de la session, tel que Codex le donne à ses hooks ; sans lui,
// la maison Codex par défaut (`~/.codex`). Un chemin relatif ne désigne rien.
export function codexHomeDe(env = process.env) {
  const declare = String(env.CODEX_HOME || "").trim();
  if (declare && path.isAbsolute(declare)) return path.resolve(declare);
  return path.join(domicile({ env }), ".codex");
}

export function porteDeLEnvironnement(env = process.env) {
  const porte = String(env.VALXOS_CODEX_PORTE || "").trim().toLowerCase();
  if (porte === "") return "app";
  return PORTES_CODEX.includes(porte) ? porte : "cli";
}

function ficheValide(objet) {
  return Boolean(objet) && typeof objet === "object" && !Array.isArray(objet)
    && typeof objet.lineage === "string" && objet.lineage.length > 0
    && typeof objet.thread_id === "string" && objet.thread_id.length > 0;
}

// Écriture atomique ET privée : le fichier naît en 0600 dans un dossier 0700,
// puis prend sa place d'un seul `rename`. `writeJsonAtomic` (config.js) ne
// pose pas de mode : une fiche qui nomme un fil et un pid ne se lit pas par
// les autres comptes. Un `rename` raté ne laisse pas son brouillon derrière.
function ecrireLaFiche(fichier, fiche) {
  fs.mkdirSync(path.dirname(fichier), { recursive: true, mode: 0o700 });
  const tmp = `${fichier}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(fiche, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tmp, fichier);
  } catch (erreur) {
    try { fs.unlinkSync(tmp); } catch { /* le brouillon est déjà parti */ }
    throw erreur;
  }
}

function lireLaFiche(fichier) {
  let brut;
  try {
    brut = JSON.parse(fs.readFileSync(fichier, "utf8"));
  } catch {
    return null;
  }
  return ficheValide(brut) ? brut : null;
}

// Une fiche vaut pour la lignée que son NOM DE FICHIER désigne, et pour elle
// seule : `carol.json` qui dit `bob` ne vaut ni pour l'une ni pour l'autre.
function laFicheDe(nom) {
  const fiche = lireLaFiche(cheminDeLaFiche(nom));
  return fiche && fiche.lineage === nom ? fiche : null;
}

// Le résumé de la carte au registre, pour qui lit la fiche (le Facteur, le
// docteur) : une fiche sans carte, ou dont la carte est hors service, se voit.
function resumeDuPair(db, lineage) {
  if (!db) return null;
  let row = null;
  try {
    row = getPeer(db, lineage);
  } catch {
    row = null;
  }
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    instance_session_id: row.instance_session_id,
    house: row.house,
    pid: row.pid,
    last_seen: row.last_seen,
    dead_at: row.dead_at
  };
}

// `registerPeer` n'écrit ni `lineage`, ni `instance_session_id`, ni `house` :
// ce sont les colonnes des chaises (`registerInstance`), posées ici d'un
// geste chirurgical sur la carte nue, dans la même transaction. `proc_start`
// est celui du pid de CETTE fiche, nul quand `ps` ne répond pas — jamais
// celui d'un pid d'avant : la moisson des fiches Codex lirait une naissance
// étrangère et condamnerait une chaise vivante (`processusDeLaFiche`,
// « pid-recycle »).
// La fiche s'écrit DANS la transaction, en dernier : un fichier qui ne
// s'écrit pas annule la carte, et la carte et la fiche disent la même chose.
function inscrire(db, fiche) {
  const tx = db.transaction(() => {
    registerPeer(db, {
      id: fiche.lineage,
      project_path: fiche.cwd,
      description: "Codex session",
      session_id: fiche.thread_id,
      pid: fiche.pid,
      status: "active",
      metadata: { harnais: "codex", porte: fiche.porte, codex_home: fiche.codex_home }
    });
    db.prepare(`
      UPDATE peers SET
        lineage = @lineage,
        instance_session_id = @thread_id,
        session_id = @thread_id,
        house = @house,
        proc_start = @proc_start,
        last_seen = @now,
        heartbeat_at = @now
      WHERE id = @lineage
    `).run({
      lineage: fiche.lineage,
      thread_id: fiche.thread_id,
      house: fiche.codex_home,
      proc_start: fiche.proc_start,
      now: fiche.last_seen
    });
    ecrireLaFiche(cheminDeLaFiche(fiche.lineage), fiche);
  });
  tx();
}

export function ecrireFicheCodex(db, { lineage, thread_id, codex_home = codexHomeDe(), pid, porte = "cli", cwd = null, now = nowIso() } = {}) {
  const nom = String(lineage || "").trim();
  if (!nom) throw new Error("ecrireFicheCodex requires a lineage");
  // Une lignée est un nom NU : `lignée#fil` ou `lignée@nom` serait une chaise
  // que le client MCP nu de Codex ne pourrait jamais accuser.
  if (!validateAgentId(nom)) throw new Error("ecrireFicheCodex requires a lineage that is a bare name ([A-Za-z0-9][A-Za-z0-9_.-]{0,63})");
  const thread = String(thread_id || "").trim();
  if (!thread) throw new Error("ecrireFicheCodex requires a thread_id (the Codex session_id)");
  if (!PORTES_CODEX.includes(porte)) {
    throw new Error(`ecrireFicheCodex: unknown door "${porte}" (expected one of ${PORTES_CODEX.join(", ")})`);
  }
  const numero = Number(pid);
  if (!Number.isInteger(numero) || numero <= 1) throw new Error("ecrireFicheCodex requires the pid of the Codex process");
  const maison = codex_home == null ? codexHomeDe() : String(codex_home);
  if (!path.isAbsolute(maison)) throw new Error("ecrireFicheCodex requires an absolute codex_home");
  garderLEcritureDuBureau();
  const avant = laFicheDe(nom);
  const memeFil = Boolean(avant) && avant.thread_id === thread;
  const fiche = {
    lineage: nom,
    thread_id: thread,
    codex_home: path.resolve(maison),
    pid: numero,
    proc_start: procStartOf(numero) || null,
    porte,
    cwd: cwd ? String(cwd) : null,
    started_at: memeFil && typeof avant.started_at === "string" ? avant.started_at : now,
    last_seen: now,
    dead_at: null
  };
  inscrire(db, fiche);
  return fiche;
}

export function lireFicheCodex(db, lineage) {
  const nom = String(lineage || "").trim();
  if (!nom) return null;
  const fiche = laFicheDe(nom);
  return fiche ? { ...fiche, peer: resumeDuPair(db, nom) } : null;
}

export function fichesCodex(db) {
  const dossier = dossierDesFichesCodex();
  let noms;
  try {
    noms = fs.readdirSync(dossier);
  } catch {
    return [];
  }
  return noms
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const fiche = lireLaFiche(path.join(dossier, f));
      return fiche && `${safeAgentFileName(fiche.lineage)}.json` === f ? fiche : null;
    })
    .filter(Boolean)
    .map((fiche) => ({ ...fiche, peer: resumeDuPair(db, fiche.lineage) }));
}

// Le battement de la chaise Codex (UserPromptSubmit, Stop) : `last_seen`
// avance sur la carte et sur la fiche ; se ré-annoncer, c'est ressusciter.
// `null` sans fiche — et sans CARTE : une fiche dont la carte a disparu (un
// broker.db neuf dans le même bureau) ne se rafraîchit pas en silence ;
// l'appelant la réécrit (`ecrireFicheCodex`), et la carte revient.
export function rafraichirFicheCodex(db, lineage, { now = nowIso() } = {}) {
  const nom = String(lineage || "").trim();
  if (!nom) return null;
  const fiche = laFicheDe(nom);
  if (!fiche) return null;
  garderLEcritureDuBureau();
  fiche.last_seen = now;
  fiche.dead_at = null;
  let carte = 0;
  const tx = db.transaction(() => {
    carte = db.prepare("UPDATE peers SET last_seen = ?, heartbeat_at = ?, status = 'active', dead_at = NULL WHERE id = ?")
      .run(now, now, nom).changes;
    if (carte > 0) ecrireLaFiche(cheminDeLaFiche(nom), fiche);
  });
  tx();
  return carte > 0 ? fiche : null;
}

// LA MOISSON DES FICHES CODEX (1.1.0, Tâche 11 ; `valxos-doctor --reap`).
// Une fiche est marquée `dead_at` quand son processus Codex est parti ET
// qu'aucun hook ne l'a vue depuis 24 h (`last_seen`, que UserPromptSubmit et
// Stop avancent). Pourquoi pas dès la mort du pid : une app de bureau fermée
// garde un fil que le Facteur sait encore sonner et rouvrir (sonde P10 du
// 21/10), et l'heure d'une mort ne s'observe pas — un silence de 24 h, si.
// La marque se pose sur le fichier ET sur la carte du registre ; le fichier
// reste (Camp B), et se ré-annoncer l'efface (`ecrireFicheCodex`,
// `rafraichirFicheCodex`). Trois issues par fiche, comme la moisson des
// chaises (registry.js) : vivante, candidate, ou abstenue (un `last_seen`
// illisible ne condamne personne). `dryRun` compte les candidates sans rien
// écrire : la lecture du médecin sans --reap. `valxos-chaise moissonner`
// (reapDeadPeers) laisse les chaises Codex à cette moisson-ci.
export const DELAI_MOISSON_CODEX_MS = 24 * 60 * 60 * 1000;

const normaliserNaissance = (valeur) => String(valeur).replace(/\s+/g, " ").trim();

// LE PROCESSUS D'UNE FICHE (round 1 de la Tâche 11), la règle de
// `verdictDeChaise` (registry.js) appliquée à la fiche : `parti` (le pid ne vit
// plus), `pid-recycle` (il vit, sous une autre naissance que celle de la
// fiche : un autre processus a pris le numéro), ou `vivant` (il vit, et rien ne
// dit le contraire : `ps` muet ou naissance inconnue ne condamnent personne).
// Le médecin en tire `pid_vivant`, la moisson ses candidates.
export function processusDeLaFiche(fiche, { vivant = isProcessAlive, naissance = procStartOf } = {}) {
  if (!vivant(fiche?.pid)) return "parti";
  const inscrite = fiche?.proc_start ? normaliserNaissance(fiche.proc_start) : "";
  if (!inscrite) return "vivant";
  const observee = naissance(fiche.pid);
  if (!observee) return "vivant";
  return normaliserNaissance(observee) === inscrite ? "vivant" : "pid-recycle";
}

export function moissonnerLesFichesCodex(
  db,
  { now = nowIso(), dryRun = false, vivant = isProcessAlive, naissance = procStartOf, delaiMs = DELAI_MOISSON_CODEX_MS } = {}
) {
  const mode = dryRun ? "rapport" : "moisson";
  const fiches = fichesCodex(db);
  const reaped = [];
  const abstained = [];
  const maintenant = Date.parse(now);
  for (const fiche of fiches) {
    if (fiche.dead_at) continue;
    const processus = processusDeLaFiche(fiche, { vivant, naissance });
    if (processus === "vivant") continue;
    const vue = Date.parse(fiche.last_seen);
    if (!Number.isFinite(vue) || !Number.isFinite(maintenant)) {
      abstained.push({ lineage: fiche.lineage, raison: "last-seen-illisible" });
      continue;
    }
    if (maintenant - vue <= delaiMs) continue;
    const constat = { lineage: fiche.lineage, thread_id: fiche.thread_id, pid: fiche.pid ?? null, last_seen: fiche.last_seen, processus };
    if (dryRun) {
      reaped.push(constat);
      continue;
    }
    garderLEcritureDuBureau();
    const chemin = cheminDeLaFiche(fiche.lineage);
    // La carte, la trace et la fiche d'un seul geste, la fiche en dernier (la
    // règle d'`inscrire`) : un fichier qui ne s'écrit pas annule la carte. La
    // fiche se RELIT dans la transaction, sous le verrou d'écriture (BEGIN
    // IMMEDIATE) : un hook qui l'a rafraîchie avant gagne (sa vue n'est plus
    // celle qu'on a jugée) ; un hook qui arrive pendant attend le verrou, puis
    // la ressuscite (`rafraichirFicheCodex`). Jamais une mort posée sur une vue
    // périmée.
    let marquee = false;
    db.transaction(() => {
      const actuelle = lireLaFiche(chemin);
      if (!actuelle || actuelle.lineage !== fiche.lineage || actuelle.last_seen !== fiche.last_seen || actuelle.dead_at) return;
      db.prepare(`UPDATE peers SET status = 'dead', dead_at = ? WHERE id = ? AND instance_session_id IS ? AND ${EN_SERVICE}`)
        .run(now, fiche.lineage, fiche.thread_id);
      recordEvent(db, null, fiche.lineage, "peer_reaped", {
        raison: "codex-parti-24h", processus, pid: fiche.pid ?? null, thread_id: fiche.thread_id, dead_at: now
      });
      ecrireLaFiche(chemin, { ...actuelle, dead_at: now });
      marquee = true;
    }).immediate();
    if (marquee) reaped.push({ ...constat, dead_at: now });
  }
  return { mode, checked: fiches.length, reaped, abstained };
}
