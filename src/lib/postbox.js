// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// La tournée : où sont les boîtes aux lettres, et laquelle est vivante.
//
// Cette pièce ne DÉPOSE rien : elle regarde. Elle itère sur les MAISONS
// (les répertoires de configuration), jamais sur l'espace global des boîtes :
// les registres sont par maison, les boîtes vivent toutes au même endroit.
//
// ─────────────────────────────────────────────────────────────────────────
// ⚠️  AVERTISSEMENT À QUI REPRENDRA CETTE PIÈCE
//     L'heure de démarrage a DEUX écritures. Nous n'en lisons qu'une.
// ─────────────────────────────────────────────────────────────────────────
//
// ① `procStart` — une CHAÎNE, que le programme tenant les registres obtient
//    par `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`. Nous la relisons dans la
//    MÊME langue et le MÊME fuseau (voir `procStartOf`). Lue en heure locale,
//    la même seconde devient une autre chaîne : la concordance échoue pour
//    TOUTES les fiches, toutes les boîtes de la machine passent pour
//    endormies, et le Facteur ne porte plus RIEN — sans un mot d'erreur.
//    Ne retirez jamais `LC_ALL=C TZ=UTC`. Deux gardes le tiennent, dont une
//    qui force un fuseau (+14) et une langue étrangers dans un processus à
//    part : elle mord même sur une machine déjà réglée en UTC.
//
// ② `procStartFt` — LA MÊME HEURE, écrite en nombre, et validée comme une
//    CHAÎNE de chiffres par le programme natif (`procStartFt:
//    string().optional()`, `typeof l.procStartFt === "string"`). Un
//    interrupteur FIGÉ DANS LE BUILD la substitue à `procStart`
//    (`function fAo(){return!1}`, définition unique dans 2.1.229, consommée par
//    `vfe(e){if(fAo())return e.procStart!==void 0?void 0:e.procStartFt;…}`) :
//    le jour où ce build bascule, PLUS AUCUNE fiche ne portera `procStart`.
//    Ce n'est donc pas un réglage qu'on pousse à une flotte en marche — il faut
//    une mise à jour du programme, et c'est autant de délai pour nous.
//    Nous ne lisons PAS encore ce champ POUR LA VIVACITÉ (la clé de dépôt, elle,
//    le confronte déjà — voir `memeIncarnation`).
//
//    Ce qui se passe ce jour-là, et c'est TESTÉ (« la tournée dégrade en
//    sondes courtes ») : la vivacité de chaque fiche retombe sur la SONDE du
//    second recours (A5) — un coup frappé à la porte, borné par
//    DELAI_SONDE_MS et par le couperet MARGE_SONDE_MS, dans un processus
//    séparé PAR FICHE. La dégradation est donc BORNÉE et VISIBLE, jamais
//    silencieuse : la boîte rendue porte `preuve: "sonde"` et `procStart:
//    null`, et l'inventaire de la maison compte ses `sondees`.
//
//    Ce n'est pas gratuit : un fork par fiche et par tournée, et une boîte
//    qui n'ouvre pas sa porte à cet instant précis devient invisible pour
//    cette tournée-là (son courrier n'est pas perdu — rien n'est marqué,
//    le canal de repli rattrape). AVANT que ce build ne bascule, il faut lire
//    `procStartFt` ici aussi et le confronter comme on confronte `procStart`.
//
// Divergence assumée avec le programme natif : quand l'heure de démarrage
// manque, il se contente de l'existence du numéro (`if(rw(r.pid))return!0`
// — fail-open). Nous, non : sans heure, c'est la sonde qui tranche, et si
// elle ne conclut pas, la boîte est écartée.
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Une fiche de registre au-delà de ce poids n'est pas une fiche : on l'écarte
// au lieu de l'avaler (même plafond que le balayage natif).
const PLAFOND_FICHE_OCTETS = 262144;

// Un numéro de processus plausible. 0 désigne le GROUPE tout entier (et
// `kill(0, 0)` réussit toujours), 1 le premier-né du système : ni l'un ni
// l'autre n'est une boîte aux lettres. Le programme qui tient les registres
// pose la même borne : `function rw(e){if(e<=1)return!1;…}`.
function numeroPlausible(pid) {
  return Number.isInteger(pid) && pid > 1;
}

export function sessionsDir(configDir) {
  return path.join(String(configDir), "sessions");
}

export function keyFileName(pid, socketPath) {
  const digest = crypto
    .createHash("sha256")
    .update(path.resolve(String(socketPath)))
    .digest("hex");
  return `${pid}.${digest}.key`;
}

// Parse tolérant : une fiche abîmée fait taire UNE boîte, jamais la tournée.
//
// On REGARDE la fiche avant de l'ouvrir : sa nature et son poids. Ce n'est pas
// de la coquetterie — un `999.json` qui serait un TUBE NOMMÉ fait attendre un
// écrivain POUR TOUJOURS, et la tournée est synchrone : elle se fige, sans un
// mot. Le balayage natif prend la même précaution :
//   `let r=await lstat(e); if(!r.isFile()||r.size>t) return null; …`
export function readMailboxEntry(
  filePath,
  { readFileSync = fs.readFileSync, lstatSync = fs.lstatSync } = {}
) {
  let etat;
  try {
    etat = lstatSync(filePath);
  } catch {
    return null;
  }
  if (!etat || typeof etat.isFile !== "function" || !etat.isFile()) return null;
  if (!(etat.size <= PLAFOND_FICHE_OCTETS)) return null;

  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  // Seconde ceinture : la taille annoncée peut mentir (fiche qui grossit entre
  // le regard et la lecture, stat fournie par un appelant).
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > PLAFOND_FICHE_OCTETS) {
    return null;
  }
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.messagingSocketPath !== "string" || !entry.messagingSocketPath) return null;
  if (!numeroPlausible(entry.pid)) return null;
  // Sans session, pas de verrou d'incarnation : une lettre pourrait arriver
  // chez quelqu'un d'autre après un recyclage de numéro. On s'abstient.
  if (typeof entry.sessionId !== "string" || !entry.sessionId) return null;
  return entry;
}

// Le budget de la sonde : on frappe à la porte, on n'attend pas qu'on nous ouvre
// une deuxième fois. Une boîte muette ne doit jamais retenir la tournée.
export const DELAI_SONDE_MS = 250;

// Le couperet, par-dessus le budget : la sonde vit dans un enfant, et un
// enfant peut se coincer avant même d'avoir frappé (fork lent, machine
// chargée). La tournée étant synchrone, c'est la SEULE borne qui la sauve.
export const MARGE_SONDE_MS = 2000;

// La sonde revient avec ce code quand la boîte est OCCUPÉE — quelqu'un y est
// déjà, donc elle est vivante.
export const CODE_SONDE_OCCUPEE = 3;

export function isProcessAlive(pid, { kill = process.kill.bind(process) } = {}) {
  // Sans cette borne, `kill(0, 0)` (le groupe entier) réussit toujours et une
  // fiche à zéro passerait pour vivante à jamais.
  if (!numeroPlausible(pid)) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // vivant, mais pas à nous
  }
}

// L'environnement d'une sonde : le strict nécessaire pour qu'un enfant tourne,
// JAMAIS celui du parent (jetons, clés de modèles, identifiants de session).
// UNE fonction pour les deux sondes — rc2 disait « the probe child gets a
// minimal env », vrai pour la sonde de connexion, faux pour la lecture de
// l'heure par `ps` (re-verdict de la revue adverse, 29/08). La langue « C » et le fuseau UTC
// en font partie : voir l'avertissement en tête de cette pièce.
function envDeSonde() {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || "",
    LC_ALL: "C",
    TZ: "UTC"
  };
}

// Le registre inscrit l'heure de démarrage en UTC et en langue « C »
// (relevé dans le programme qui écrit les fiches :
//  `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`). La lire en heure locale
// donnerait une autre chaîne pour la même seconde — et toutes les boîtes de
// la machine passeraient pour endormies. On lit donc comme on écrit.
export function procStartOf(pid, { execFileSync = childProcess.execFileSync } = {}) {
  try {
    // stderr ignoré : les plaintes de ps n'ont rien à faire dans le journal.
    return String(
      execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        stdio: ["ignore", "pipe", "ignore"],
        env: envDeSonde()
      })
    ).trim();
  } catch {
    return null;
  }
}

// La sonde de connexion : on frappe, on ne dépose RIEN, on repart.
// Elle vit dans un processus séparé parce que la tournée est synchrone et que
// node n'offre aucune connexion synchrone — le budget en millisecondes est la
// seule promesse qu'on tient ici.
const SOURCE_SONDE = [
  'const net = require("node:net");',
  "const s = net.connect({ path: process.argv[1] });",
  "const t = setTimeout(() => { s.destroy(); process.exit(1); }, Number(process.argv[2]));",
  's.on("connect", () => { clearTimeout(t); s.destroy(); process.exit(0); });',
  // Une boîte OCCUPÉE est une boîte VIVANTE : c'est la lecture du client
  // officiel (`r.on("error",(o)=>n(Nt(o)==="EBUSY"))`). La classer endormie
  // ferait attendre le canal de repli pour une session qui est là.
  `s.on("error", (e) => { clearTimeout(t); process.exit(e && e.code === "EBUSY" ? ${CODE_SONDE_OCCUPEE} : 1); });`
].join("");

export function sonderLaBoite(
  socketPath,
  {
    timeoutMs = DELAI_SONDE_MS,
    margeMs = MARGE_SONDE_MS,
    execFileSync = childProcess.execFileSync,
    execPath = process.execPath
  } = {}
) {
  if (typeof socketPath !== "string" || !socketPath) return false;
  try {
    execFileSync(execPath, ["-e", SOURCE_SONDE, socketPath, String(timeoutMs)], {
      // Le budget vit DANS l'enfant ; ce couperet-ci est la seule borne si
      // l'enfant lui-même se coince. Le retirer, c'est offrir à la tournée
      // une attente sans fin — et une tournée figée ne porte plus rien.
      timeout: timeoutMs + margeMs,
      stdio: "ignore",
      // Le même environnement minimal que la lecture de l'heure : jamais
      // celui du parent.
      env: envDeSonde()
    });
    return true;
  } catch (err) {
    // On ne conclut « vivante » que sur une raison NOMMÉE. Un enfant tué par
    // le couperet n'a rien prouvé : la boîte reste écartée.
    return err?.status === CODE_SONDE_OCCUPEE;
  }
}

// La vivacité exige DEUX preuves : le processus existe, et c'est le MÊME
// processus (un numéro se recycle). Amendement A5 : quand la fiche ne porte
// pas d'heure de démarrage, on ne l'exclut pas à l'aveugle — on sonde, et si
// la sonde ne conclut pas, on s'abstient (jamais l'inverse).
//
// Le verdict dit AUSSI d'où il tient sa preuve : `registre` (l'heure de la
// fiche a été confrontée à celle du système) ou `sonde` (on a frappé et on a
// eu une réponse). La tournée en a besoin pour ne pas raconter la même chose
// dans les deux cas.
function verdictDeVivacite(entry, deps = {}) {
  const morte = { vivante: false, preuve: null };
  if (!entry || !numeroPlausible(entry.pid)) return morte;
  if (!(deps.isProcessAlive || isProcessAlive)(entry.pid)) return morte;

  if (!entry.procStart) {
    const sonde = deps.sonderLaBoite || sonderLaBoite;
    const ouverte = sonde(entry.messagingSocketPath, { timeoutMs: DELAI_SONDE_MS }) === true;
    return ouverte ? { vivante: true, preuve: "sonde" } : morte;
  }

  const observee = (deps.procStartOf || procStartOf)(entry.pid);
  if (!observee) return morte;
  const concorde = normalizeStart(observee) === normalizeStart(entry.procStart);
  return concorde ? { vivante: true, preuve: "registre" } : morte;
}

export function isEntryAlive(entry, deps = {}) {
  return verdictDeVivacite(entry, deps).vivante;
}

function normalizeStart(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

// La clé de dépôt porte, elle aussi, l'heure de démarrage de la boîte qu'elle
// ouvre. Si elle parle d'une AUTRE incarnation, c'est une clé périmée.
// Deux preuves ici comme ailleurs — et un silence n'est pas un refus : une
// clé qui n'inscrit aucune heure reste la clé publiée pour cette boîte.
function memeIncarnation(entry, cle) {
  if (entry?.procStart && cle?.procStart) {
    return normalizeStart(entry.procStart) === normalizeStart(cle.procStart);
  }
  if (entry?.procStartFt !== undefined && cle?.procStartFt !== undefined) {
    return String(entry.procStartFt) === String(cle.procStartFt);
  }
  return true;
}

// La clé de dépôt se lit dans la maison DU DESTINATAIRE : c'est son jeton
// qu'on présente au guichet, pas le nôtre.
export function readDeliveryToken(configDir, entry, { readFileSync = fs.readFileSync } = {}) {
  const file = path.join(
    sessionsDir(configDir),
    keyFileName(entry.pid, entry.messagingSocketPath)
  );
  let cle;
  try {
    cle = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof cle?.peerToken !== "string") return null;
  // Une clé périmée ne fait perdre aucune lettre : la boîte reste rendue,
  // simplement sans jeton (l'authentification est optionnelle sur cette
  // plateforme, et un jeton périmé se ferait refuser de toute façon).
  if (!memeIncarnation(entry, cle)) return null;
  return cle.peerToken;
}

// Une maison seule reste une maison : passée en texte, elle ne doit pas être
// épelée lettre par lettre (une tournée vide et silencieuse serait pire qu'une
// panne — on ne la verrait pas).
//
// Et la MÊME maison nommée deux fois (barre finale, chemin non résolu,
// raccourci) ne se parcourt qu'une fois : sans cela, chaque boîte de cette
// maison serait rendue deux fois, donc chaque lettre portée deux fois. On
// garde l'orthographe de l'inventaire, on ne dédouble que le CHEMIN.
// Le CHEMIN d'une maison, sous la seule forme qui compte : celle qu'on
// compare. Une maison et son raccourci ont le même chemin réel ; une maison
// absente n'en a pas, on la nomme quand même. Cette règle sert des DEUX côtés
// (dédup de la tournée, reconnaissance de l'inventaire) : deux règles
// différentes feraient passer pour inconnue une maison qu'on vient de servir.
function cheminDeMaison(house, realpathSync) {
  try {
    return realpathSync(house); // un raccourci mène à la même maison
  } catch {
    return path.resolve(house); // maison absente : on la nomme quand même
  }
}

function asHouseList(configDirs, { realpathSync = fs.realpathSync } = {}) {
  const brut =
    typeof configDirs === "string"
      ? configDirs
        ? [configDirs]
        : []
      : Array.isArray(configDirs)
        ? configDirs.filter((house) => typeof house === "string" && house)
        : [];

  const vues = new Set();
  const liste = [];
  for (const house of brut) {
    const cle = cheminDeMaison(house, realpathSync);
    if (vues.has(cle)) continue;
    vues.add(cle);
    liste.push(house);
  }
  return liste;
}

// La tournée complète. Elle rend DEUX choses : les boîtes vivantes, et
// l'inventaire des maisons qu'elle vient de parcourir (amendement A4) — sans
// cet inventaire, « ta maison m'est inconnue » et « ta boîte dort » se
// ressemblent, et le Facteur mentirait à celui qui attend.
export function tourHouses(configDirs, deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const boxes = [];
  const houses = [];
  // Une session n'a qu'UNE boîte dans une tournée. Un registre se salit
  // (fiche recopiée, maison clonée) et deux fiches peuvent décrire la même
  // session : la rendre deux fois ferait porter la même lettre deux fois,
  // pour rien. La promesse du chantier ne change pas — on préfère un doublon
  // à une lettre perdue — mais un doublon qu'on peut éviter à la source, on
  // l'évite.
  const sessionsServies = new Set();

  for (const house of asHouseList(configDirs, deps)) {
    const rapport = {
      house,
      readable: false,
      fiches: 0,
      boxes: 0,
      sondees: 0,
      endormies: 0,
      illisibles: 0,
      doublons: 0
    };
    houses.push(rapport);

    const registre = sessionsDir(house);
    let files;
    try {
      files = readdirSync(registre);
    } catch {
      continue; // une maison sans registre lisible n'est pas une panne de tournée
    }
    rapport.readable = true;

    // Ordre stable : à registre égal, deux tournées servent la même fiche.
    for (const file of Array.from(files).sort()) {
      if (!/^\d+\.json$/.test(file)) continue;
      rapport.fiches += 1;
      const entry = readMailboxEntry(path.join(registre, file), deps);
      if (!entry) {
        rapport.illisibles += 1;
        continue;
      }
      const verdict = verdictDeVivacite(entry, deps);
      if (!verdict.vivante) {
        rapport.endormies += 1;
        continue;
      }
      if (sessionsServies.has(entry.sessionId)) {
        rapport.doublons += 1;
        continue;
      }
      sessionsServies.add(entry.sessionId);
      rapport.boxes += 1;
      if (verdict.preuve === "sonde") rapport.sondees += 1;
      boxes.push({
        house,
        pid: entry.pid,
        sessionId: entry.sessionId,
        name: entry.name || null,
        socketPath: entry.messagingSocketPath,
        kind: entry.kind || null,
        status: entry.status || null,
        // A5 contre A12 — l'arbitrage, écrit une fois pour toutes : une boîte
        // prouvée par la SONDE est rendue (sinon le second recours ne servirait
        // à rien et une session vivante attendrait le canal de repli), mais son
        // heure de démarrage reste NULLE : on ne fabrique pas une preuve qu'on
        // n'a pas lue. `preuve` dit laquelle des deux a conclu, pour que la
        // tâche 4 sache ce qu'elle tient. Ce que A12 exige vraiment — le verrou
        // d'incarnation — est intact : `sessionId` est toujours là (une fiche
        // sans session n'est jamais lue) et c'est LUI qui voyage dans
        // l'enveloppe, pas `procStart`.
        procStart: entry.procStart || null,
        preuve: verdict.preuve,
        token: readDeliveryToken(house, entry, deps)
      });
    }
  }

  return { boxes, houses };
}

export function listMailboxes(configDirs, deps = {}) {
  return tourHouses(configDirs, deps).boxes;
}

// « Cette maison est-elle seulement dans l'inventaire ? » — la question que le
// Facteur doit pouvoir poser avant de dire qu'une boîte dort.
//
// On compare avec la MÊME règle que la tournée (`cheminDeMaison`) : elle ne
// retient qu'une orthographe par maison, et laquelle dépend de l'ordre de
// l'inventaire. Comparer autrement rendrait « inconnue » une maison servie une
// ligne plus haut.
export function isKnownHouse(houses, house, { realpathSync = fs.realpathSync } = {}) {
  if (typeof house !== "string" || !house) return false;
  const cherchee = cheminDeMaison(house, realpathSync);
  for (const connue of houses || []) {
    const nom = typeof connue === "string" ? connue : connue?.house;
    if (typeof nom === "string" && nom && cheminDeMaison(nom, realpathSync) === cherchee) return true;
  }
  return false;
}
