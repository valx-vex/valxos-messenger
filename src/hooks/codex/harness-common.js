// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// LE SOCLE DU HOOK CODEX (1.1.0, spec B §2 et §4). Porté de la branche des
// hooks vivants du 03-04/10, rebasé sur la 1.0.0 et corrigé des constats 3, 4,
// 6 et 9 de la passe adverse du 18/10 :
//   3. la trace n'écrit QUE sous `<bureau>/logs/codex-hook/`, jamais à un
//      chemin de l'environnement, et ne porte aucune identité (ni argv, ni le
//      nom servi, ni le nom refusé) ; les refus sur stderr ne nomment personne ;
//   4. le budget de 8 000 caractères compte le SUJET : une lettre seule et
//      trop longue perd d'abord son sujet, puis son corps ;
//   6. stdin se vide jusqu'à 4 s, et `busy_timeout` 3 000 ms est posé
//      explicitement sur la base du hook ;
//   9. la table des événements se lit par `Object.hasOwn`.
//
// Ce fichier n'importe QUE des modules `node:` au niveau supérieur : la garde
// (identité ET liste `--serves`) se tranche avant toute bibliothèque, et une
// bibliothèque absente, un module natif cassé ou un bureau corrompu finissent
// en no-op, sortie 0. Le bureau n'est chargé que par `loadOffice()`, en
// import dynamique, APRÈS la garde. `hook-common.js` n'est pas importé : il
// pose `codeDeSortieSurBureauRelatif(1)` à l'import et `hookContext` inscrit
// une « Claude Code session » ; la chaise Codex se tient par sa fiche.
import fs from "node:fs";
import path from "node:path";

export const HARNESS = "codex";
export const NOM_DU_HOOK = "Codex";

// Le budget d'une injection, en caractères (≈ 2 000 tokens, sous le plafond
// par défaut de Codex, ≈ 2 500). Une constante, pas un réglage. Sujet compris.
export const BUDGET_CARACTERES = 8000;
// Ce qu'un sujet garde (en points de code) quand une lettre seule dépasse le budget.
export const SUJET_MAX = 200;
export const PRIORITES_URGENTES = new Set(["high", "critical"]);
// Constat 6 : 4 s pour stdin, 3 s pour le verrou de la base — sous les 5 s
// de Codex, et sous les 10 s que le gabarit d'installation donne au hook.
export const BORNE_DE_LECTURE_MS = 4000;
export const BUSY_TIMEOUT_MS = 3000;

// L'ENVELOPPE N'EST PAS UNE LIVRAISON (revue de la Tâche 12, finding 1). Pour une
// chaise Codex, `carried_at` veut dire « sonnée » : `codex queue` a pris
// l'enveloppe, et le tour qu'elle réveille démarre en moins d'une seconde. La
// grâce du canal de repli (`DEFAULT_CARRIED_GRACE_MS`, 90 s : laisser au
// destinataire le temps d'accuser une lettre qu'un autre porteur lui a déjà
// remise) écarterait la lettre de CE tour : le modèle ne verrait que
// l'enveloppe. Le hook Codex sert donc sans grâce, pour ses trois livraisons
// comme pour le filet du Stop ; le hook Claude Code garde la sienne.
export const GRACE_APRES_SONNETTE_MS = 0;

// Les trois événements qui injectent : leur plafond de lettres par appel et
// l'étiquette du journal. `livraisonDe` les lit par `Object.hasOwn`
// (constat 9) : `constructor` ou `__proto__` ne sont pas des événements.
export const LIVRAISONS = Object.freeze({
  SessionStart: Object.freeze({ limit: 50, label: "codex_session_start_delivered" }),
  UserPromptSubmit: Object.freeze({ limit: 20, label: "codex_user_prompt_delivered" }),
  PostToolUse: Object.freeze({ limit: 20, label: "codex_post_tool_use_delivered" })
});

export function livraisonDe(event) {
  return typeof event === "string" && Object.hasOwn(LIVRAISONS, event) ? LIVRAISONS[event] : null;
}

// ── Arguments ───────────────────────────────────────────────────────────────
// `--serves a,b` ou `--serves=a,b` : les identités que CE hook sert. Un
// filtre, jamais une source : l'identité vient de l'environnement.
export function parseArgs(argv = []) {
  const serves = [];
  const ajouter = (liste) => {
    for (const nom of String(liste || "").split(",")) {
      const propre = normalizeName(nom);
      if (propre) serves.push(propre);
    }
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === "--serves") {
      const suivant = argv[i + 1];
      if (suivant !== undefined && !String(suivant).startsWith("--")) {
        ajouter(suivant);
        i += 1;
      }
    } else if (a.startsWith("--serves=")) {
      ajouter(a.slice("--serves=".length));
    }
  }
  return { serves };
}

// ── Identité ────────────────────────────────────────────────────────────────
// La règle de `normalizeAgentId` (config.js), recopiée parce qu'aucune
// bibliothèque ne se charge avant la garde. test/codex-hook.test.js la tient
// contre l'original sur une table d'entrées.
export function normalizeName(valeur) {
  const v = String(valeur || "").trim();
  if (!v) return "";
  return v.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
}

// VALXOS_SELF gagne quand il est POSÉ, même vide (la règle de famille de
// `valeurDeLEnvironnement`) ; vide, il masque CC2CC_SELF et se dit. Les
// `*_SESSION_NAME` ne sont pas lus : un nom de session n'est pas une identité
// ici, et il n'existe AUCUNE identité par défaut. L'environnement est celui
// du HOOK : celui du processus Codex, ou la commande du hook elle-même
// (`env VALXOS_SELF=<nom> node … --serves <nom>`, pour l'app sans lanceur).
// m5 (re-revue du round FINAL) : une valeur dont la lignée est vide (`#foo`,
// ` @bar`) n'est pas une identité — le serveur MCP et la CLI la refusent
// (`identite-invalide`) ; ici, `{ refus: "invalide" }`, rien de livré, jamais `_foo`.
const sansLignee = (valeur) => /^\s*[#@]/.test(String(valeur ?? ""));
export function identityFromEnv(env = process.env) {
  if (Object.hasOwn(env, "VALXOS_SELF")) {
    const selfId = normalizeName(env.VALXOS_SELF);
    if (selfId && sansLignee(env.VALXOS_SELF)) return { refus: "invalide" };
    return selfId ? { selfId } : { refus: "vide" };
  }
  const selfId = normalizeName(env.CC2CC_SELF);
  if (selfId && sansLignee(env.CC2CC_SELF)) return { refus: "invalide" };
  return selfId ? { selfId } : { refus: "absent" };
}

// La garde complète : identité de l'environnement ET présence dans `--serves`.
// Rend `{ selfId }` ou `{ refus, ligne }`. Constat 3 : la ligne ne nomme NI
// l'identité refusée NI la liste servie — chaque session Codex qui n'est pas
// la chaise servie passe par ce refus à chaque PostToolUse.
export function gate(args, env = process.env) {
  const id = identityFromEnv(env);
  if (id.refus === "absent") {
    return {
      refus: "absent",
      ligne: "no identity: VALXOS_SELF and CC2CC_SELF are unset in this hook's environment; nothing delivered. " +
        "Set VALXOS_SELF to the name this hook serves, in the Codex launcher or in the hook command."
    };
  }
  if (id.refus === "vide") {
    return { refus: "vide", ligne: "VALXOS_SELF is set but empty (it masks CC2CC_SELF); nothing delivered." };
  }
  if (id.refus === "invalide") {
    return { refus: "invalide", ligne: "the identity in this hook's environment starts with # or @ (an empty lineage); nothing delivered." };
  }
  if (!args.serves.includes(id.selfId)) {
    return { refus: "non-servi", ligne: "the identity of this process is not served by this hook (--serves); nothing delivered." };
  }
  return { selfId: id.selfId };
}

// ── Les erreurs (Round 1 : le reste du constat 3) ─────────────────────────
// Une ligne d'erreur sur stderr ne recopie jamais le message brut : un message
// fs porte un chemin, et un chemin peut porter l'identité servie
// (`run/<lignée>.stop_guard.json`, un bureau ou un HOME nommés d'après elle).
// Elle dit un LIBELLÉ FIXE : une classe connue (la garde du bureau vivant), ou
// le code de l'erreur (`EISDIR`, `SQLITE_NOTADB`…), ou son nom (`TypeError`).
// Le détail va dans la trace sous le bureau, chemins masqués, identité masquée.
const CODE_LISIBLE = /^[A-Z][A-Z0-9_]{0,47}$/;
const NOM_LISIBLE = /^[A-Za-z]{1,48}$/;

export function libelleDErreur(erreur) {
  const message = String(erreur?.message ?? erreur ?? "");
  if (/^live office guard:/.test(message)) {
    return "the live office guard refused to open this office for writing (CC2CC_GARDE_BUREAU or VALXOS_GARDE_BUREAU is set)";
  }
  if (typeof erreur?.code === "string" && CODE_LISIBLE.test(erreur.code)) return erreur.code;
  if (typeof erreur?.name === "string" && NOM_LISIBLE.test(erreur.name)) return erreur.name;
  return "Error";
}

// `masquer` : l'identité servie, quand on la connaît — remplacée partout dans
// le message, en plus des chemins. La trace ne nomme jamais personne.
export function detailDErreur(erreur, { masquer = null } = {}) {
  let message = String(erreur?.message ?? erreur ?? "").replace(/(?:~|\.{0,2})?\/[^\s'"`]*/g, "<path>");
  if (masquer) message = message.split(String(masquer)).join("<self>");
  return {
    name: typeof erreur?.name === "string" && NOM_LISIBLE.test(erreur.name) ? erreur.name : null,
    code: typeof erreur?.code === "string" && CODE_LISIBLE.test(erreur.code) ? erreur.code : null,
    syscall: typeof erreur?.syscall === "string" && NOM_LISIBLE.test(erreur.syscall) ? erreur.syscall : null,
    message: Array.from(message).slice(0, 300).join("")
  };
}

export function note(ligne) {
  const texte = String(ligne).replace(/\s*\n\s*/g, " ");
  try {
    fs.writeSync(2, `VALXOS Messenger (${HARNESS} hook): ${texte}\n`);
  } catch {
    // stderr fermé : rien à dire, et rien ne doit lever.
  }
}

// ── Les gardes du processus ─────────────────────────────────────────────────
// Écriture par `fs.writeSync(1, …)` : sur macOS, une écriture dans un tube par
// `process.stdout` est asynchrone et peut se perdre à la sortie. L'écouteur
// `exit` écrit le no-op si rien n'est parti, écrit la trace si elle est
// active ET si le bureau est connu, et force la sortie 0 — même après un
// `process.exit(n)` d'une bibliothèque (un HOME introuvable, par exemple).
export function installGuards(noop, { trace = false } = {}) {
  let emis = false;
  const etat = {
    trace: trace ? { ts: new Date().toISOString(), harness: HARNESS } : null,
    traceDir: null,
    // L'identité servie, une fois la garde passée : jamais écrite, seulement
    // masquée dans le détail d'une erreur (`detailDErreur`).
    masquer: null,
    setTraceDir(dir) { etat.traceDir = dir; },
    // Une erreur : un libellé fixe sur stderr, le détail dans la trace.
    erreur(erreur, { cle = "error", ligne = (libelle) => `error: ${libelle}; nothing delivered.` } = {}) {
      note(ligne(libelleDErreur(erreur)));
      if (etat.trace) etat.trace[cle] = detailDErreur(erreur, { masquer: etat.masquer });
    },
    emitted: () => emis,
    emit(obj) {
      if (emis) return false;
      emis = true;
      if (etat.trace) etat.trace.output_keys = Object.keys(obj || {});
      try {
        fs.writeSync(1, `${JSON.stringify(obj)}\n`);
        return true;
      } catch {
        return false;
      }
    }
  };
  const auSecours = (erreur) => {
    etat.erreur(erreur);
    etat.emit(noop);
    process.exit(0);
  };
  process.on("uncaughtException", auSecours);
  process.on("unhandledRejection", auSecours);
  process.on("exit", () => {
    if (!emis) etat.emit(noop);
    if (etat.trace && etat.traceDir) ecrireLaTrace(etat.traceDir, etat.trace);
    process.exitCode = 0;
  });
  return etat;
}

// ── Trace (constat 3) ───────────────────────────────────────────────────────
// `VALXOS_HOOK_TRACE` est un INTERRUPTEUR : toute valeur non vide l'allume ;
// sa valeur n'est jamais un chemin. La trace vit sous le bureau
// (`<bureau>/logs/codex-hook/`), un fichier JSON 0600 par appel : des clefs,
// des scalaires sans nom et des comptes — jamais un texte de prompt, un corps
// de lettre, argv, ni une identité. Un appel refusé à la garde n'ouvre pas le
// bureau, donc ne laisse pas de trace.
export function traceActive(env = process.env) {
  return String(env.VALXOS_HOOK_TRACE ?? "").trim() !== "";
}

const SCALAIRES_TRACES = ["source", "stop_hook_active", "permission_mode"];

export function traceInput(trace, raw, { event }) {
  if (!trace) return;
  trace.event = typeof event === "string" ? event : null;
  trace.ppid = process.ppid;
  const objet = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  trace.stdin_keys = Object.keys(objet);
  trace.scalars = {};
  for (const clef of SCALAIRES_TRACES) {
    if (!Object.hasOwn(objet, clef)) continue;
    const v = objet[clef];
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) trace.scalars[clef] = v;
  }
  trace.markers = {
    agent_id: Object.hasOwn(objet, "agent_id"),
    session_id: Object.hasOwn(objet, "session_id"),
    turn_id: Object.hasOwn(objet, "turn_id")
  };
}

function ecrireLaTrace(dir, trace) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${Date.now()}-${process.pid}.json`), `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Une trace qui ne s'écrit pas ne change rien au hook.
  }
}

// ── L'entrée du harnais ─────────────────────────────────────────────────────
// stdin se vide TOUJOURS, en premier, avec des modules natifs seulement —
// avant la garde, avant le bureau. Un hook qui sortait sans lire laissait
// Codex sur EPIPE dès que l'entrée dépassait le tampon du tube (64 Ko sur
// macOS) ; c'est le chemin courant de chaque session qui n'est pas la chaise
// servie. Un stdin qui ne se ferme pas n'est pas attendu au-delà de la borne
// (constat 6 : 4 s) : le hook rend alors son no-op, rien n'est lu comme une
// entrée. Un terminal n'est pas lu du tout.
export function drainStdin({ stream = process.stdin, borneMs = BORNE_DE_LECTURE_MS } = {}) {
  if (!stream || stream.isTTY) return Promise.resolve({ texte: "", complet: true });
  return new Promise((resolve) => {
    const morceaux = [];
    let fini = false;
    const finir = (complet) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      stream.removeListener("data", recevoir);
      stream.removeListener("end", auBout);
      stream.removeListener("error", enErreur);
      if (!complet) {
        try { stream.pause(); } catch { /* rien ne doit lever */ }
      }
      resolve({ texte: Buffer.concat(morceaux).toString("utf8"), complet });
    };
    const recevoir = (c) => { morceaux.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); };
    const auBout = () => finir(true);
    const enErreur = () => finir(false);
    const minuteur = setTimeout(() => finir(false), borneMs);
    stream.on("data", recevoir);
    stream.on("end", auBout);
    stream.on("error", enErreur);
  });
}

// La même lecture que `readHookInput` (hook-common.js) : vide → {}, non JSON
// → { raw_input }, que `isHookObject` refuse.
export function parseHookText(texte) {
  const brut = String(texte ?? "").trim();
  if (!brut) return {};
  try {
    return JSON.parse(brut);
  } catch {
    return { raw_input: brut };
  }
}

// Vide, non JSON, ou autre chose qu'un objet : rien n'est livré.
export function isHookObject(raw) {
  return Boolean(raw) && typeof raw === "object" && !Array.isArray(raw)
    && !Object.hasOwn(raw, "raw_input") && Object.keys(raw).length > 0;
}

// ── Le bureau, chargé APRÈS la garde ────────────────────────────────────────
export async function loadOffice() {
  const config = await import("../../lib/config.js");
  // Un bureau relatif se refuse en sortie 0 ici : un Stop qui sortirait 2
  // retiendrait la session pour une variable d'environnement.
  config.codeDeSortieSurBureauRelatif(0);
  const [database, identity, registry, format, stopGuard, sonnette, chaiseCodex, budget] = await Promise.all([
    import("../../lib/database.js"),
    import("../../lib/identity.js"),
    import("../../lib/registry.js"),
    import("../../lib/format.js"),
    import("../../lib/stop-guard.js"),
    import("../../lib/sonnette.js"),
    import("../../lib/chaise-codex.js"),
    // Le mot et le plafond des annonces (`announced`, trois fois) : ceux des crochets Claude Code.
    import("../../lib/budget-courrier.js")
  ]);
  return { config, database, identity, registry, format, stopGuard, sonnette, chaiseCodex, budget };
}

// La boîte en mode nom nu : la lignée (`adressesDuRepli` sans session rend
// `[selfId]`), élargie aux alias qui y mènent — jamais une chaise
// `lignée#session`, que le client MCP nu de Codex ne pourrait pas accuser.
// `busy_timeout` est posé ici, explicitement (constat 6).
export function contexteDeLaBoite(office, selfId) {
  const db = office.database.getDatabase();
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const adresses = office.identity.adressesDuRepli(db, selfId, {});
  return withAliases(office, { db, selfId, adresses });
}

// Les noms dont la chaîne d'alias mène à `selfId`, lus au registre : la même
// boîte que `listInbox` (l'outil `inbox`). Ne lève jamais : un registre
// illisible laisse la boîte telle quelle.
export function withAliases(office, ctx) {
  let alias;
  try {
    alias = office.registry.aliasQuiMenentA(ctx.db, ctx.selfId);
  } catch {
    return ctx;
  }
  if (!Array.isArray(alias) || alias.length === 0) return ctx;
  return { ...ctx, adresses: [...new Set([...ctx.adresses, ...alias.map(String).filter(Boolean)])] };
}

// ── Budget (constat 4) ──────────────────────────────────────────────────────
// Dans l'ordre, jusqu'au budget ; le reste attend, non marqué, le hook
// suivant. Au moins UNE lettre part toujours : seule et trop longue, elle
// perd d'abord son sujet (SUJET_MAX points de code gardés, puis ` […]`), puis
// son corps, coupé avec le marqueur qui dit comment la lire en entier — sa
// place est comptée exactement, jamais estimée. Les lignes de la base sont
// clonées, jamais modifiées.
// UNE LETTRE COUPÉE N'EST PAS LIVRÉE (1.1.0, Tâche 7, tour des réserves ; la loi des
// crochets Claude Code, budget-courrier.js) : la copie coupée porte `coupee` (`{ taille }`),
// et `deliverLetters` l'ANNONCE (`announced`, trois fois au plus) au lieu de la marquer
// livrée. Elle reste en attente : `inbox` la lit entière. Le marqueur est de la famille de
// la phrase des crochets Claude Code ; la coupe elle-même ne change pas.
function rognerLeSujet(row) {
  const sujet = row.subject == null ? null : String(row.subject);
  const points = sujet ? Array.from(sujet) : [];
  if (points.length <= SUJET_MAX) return { ...row };
  return { ...row, subject: `${points.slice(0, SUJET_MAX).join("")} […]` };
}

function marqueurDeCoupe(reste, msgId, taille) {
  return `\n[… ${reste} more characters — this letter is long (${taille} characters); it is not marked delivered. Read it in full with the VALXOS Messenger inbox tool, msg_id=${msgId}]`;
}

// La coupe ne sépare jamais les deux moitiés d'un point de code (un emoji).
function couper(texte, longueur) {
  let fin = Math.max(0, Math.min(longueur, texte.length));
  const code = texte.charCodeAt(fin - 1);
  if (fin > 0 && code >= 0xd800 && code <= 0xdbff) fin -= 1;
  return texte.slice(0, fin);
}

export function selectWithinBudget(rows, budget = BUDGET_CARACTERES, measure = (r) => String(r.body ?? "").length) {
  const batch = [];
  let total = 0;
  for (const row of rows) {
    const cout = measure(row);
    if (batch.length === 0 && cout > budget) {
      const copie = rognerLeSujet(row);
      const corps = String(copie.body ?? "");
      if (measure(copie) <= budget) return { batch: [copie], truncated: copie.subject !== row.subject };
      const enveloppe = measure({ ...copie, body: "" });
      // La place du marqueur, pour le plus grand reste possible (le corps entier).
      const place = marqueurDeCoupe(corps.length, row.msg_id, corps.length).length;
      const debut = couper(corps, Math.max(0, budget - enveloppe - place));
      copie.body = `${debut}${marqueurDeCoupe(corps.length - debut.length, row.msg_id, corps.length)}`;
      copie.coupee = { taille: corps.length };
      return { batch: [copie], truncated: true };
    }
    if (total + cout > budget) break;
    batch.push({ ...row });
    total += cout;
  }
  return { batch, truncated: false };
}

// ── Textes ──────────────────────────────────────────────────────────────────
// `minutes` : la fenêtre de retour, un nombre, ou `[la plus courte, la plus
// longue]` d'un lot (B2) — « in about 10 minutes », « in about 10 to 40 minutes ».
export function preamble(selfId, minutes) {
  const [court, long] = Array.isArray(minutes) ? minutes : [minutes, minutes];
  const quand = court === long ? `${court}` : `${court} to ${long}`;
  return [
    `[VALXOS Messenger — letters for ${selfId}, delivered by the ${NOM_DU_HOOK} hook. Your operator did not type this.]`,
    "Reply with the VALXOS Messenger `send` or `reply` tool. When a letter is handled, call `ack` with its msg_id: that is yours to do, the hook never acks.",
    `An unacked letter comes back in about ${quand} minutes.`
  ].join("\n");
}

const enMinutes = (ms) => Math.max(1, Math.round(Number(ms) / 60_000));

// LA FENÊTRE DE RETOUR, PAR LETTRE (B2, passe adverse). Les rappels s'espacent
// (10, 20, 40, puis 60 minutes : `fenetreDeReService`, sur `reservices`) ;
// annoncer toujours la constante de base décrivait une règle que la base ne
// tient plus. Les lettres arrivent ici APRÈS la marque, l'en-tête relu
// (`affichage.rappel` = le `reservices` en base) : la fenêtre dite est celle
// au bout de laquelle CE service reviendra. Sans lettre (la mesure d'avant le
// lot), la plus longue fenêtre possible, deux fois : une mesure conservatrice.
function minutesDeRetour(office, lettres = null) {
  const fenetre = (rappels) => office.database.fenetreDeReService(rappels);
  if (!lettres || lettres.length === 0) {
    const plafond = enMinutes(fenetre(31));
    return [plafond, plafond];
  }
  const minutes = lettres.map((row) => enMinutes(fenetre(Number(row.affichage?.rappel ?? row.reservices) || 0)));
  return [Math.min(...minutes), Math.max(...minutes)];
}

// Le rappel que CE service va nommer : `markDelivered` compte un re-service
// quand la lettre était déjà livrée (`reservices + (delivered_at IS NOT
// NULL)`, database.js). Pour la MESURE seulement — l'en-tête, lui, se lit en
// base après la marque (`enrichirPourAffichage`) : une mesure qui prévoit
// trop est conservatrice, un en-tête ne prévoit jamais.
function avecLeRappelAVenir(row) {
  if (!row.delivered_at) return row;
  const affichage = row.affichage || {};
  return { ...row, affichage: { ...affichage, rappel: (Number(affichage.rappel) || 0) + 1 } };
}

function mesure(office) {
  // Le coût d'une lettre est son bloc formaté complet (en-tête, sujet et
  // rappel compris) : conservateur, jamais sous-estimé.
  return (row) => office.format.formatAdditionalContext([avecLeRappelAVenir(row)]).length;
}

export function injectedText(office, ctx, batch) {
  return `${preamble(ctx.selfId, minutesDeRetour(office, batch))}\n\n${office.format.formatAdditionalContext(batch)}`;
}

// ── Livraison (la marque, la forme, l'écriture — d'un seul tenant) ──────────
// Deux lois à tenir ensemble. Celle de la branche d'origine : jamais une
// marque sans une écriture réussie. Celle de la 1.1.0 (Tâche 8, les hooks
// Claude Code) : la marque AVANT la forme, parce que `markDelivered` compte le
// re-service et que `enrichirPourAffichage` lit ce compte en base pour
// nommer le rappel (`Reminder: n`) — formée avant la marque, la lettre dirait
// un rappel de moins, et le premier ne se nommerait jamais. D'où UNE
// transaction : marquer, relire l'en-tête, former, écrire ; une écriture qui
// échoue annule la marque. Jamais d'accusé.
// `enrichirPourAffichage` : la table, le nom de chaise et le rappel dans
// l'en-tête ; le lecteur est cette boîte (`adresses`) — la position d'une
// table fermée ne se montre qu'à un membre.
// LE BUDGET SE MESURE SUR LA CHAÎNE FINALE (Round 1) : `additionalContext`,
// préambule compris, ne dépasse jamais `budget`. Les lettres reçoivent ce que
// le préambule laisse ; la chaîne formée APRÈS la marque est mesurée avant
// d'être écrite. Si elle dépasse (l'en-tête relu a grandi entre-temps : un nom
// de chaise renommé par un autre processus), la marque est annulée et la
// livraison se refait une fois, plus petite du dépassement ; une forme qui ne
// tient toujours pas n'émet rien et ne marque rien — les lettres attendent.
const ECRITURE_RATEE = Symbol("ecriture-ratee");
const DEPASSEMENT = Symbol("depassement");
const ESSAIS_DE_LIVRAISON = 2;

export function deliverLetters(office, ctx, { limit, label, emit, wrap, budget = BUDGET_CARACTERES }) {
  const { getPendingForContext, enrichirPourAffichage, markDelivered, journaliserLesAliasLus, recordEvent } = office.database;
  const lecteur = ctx.adresses;
  const releve = enrichirPourAffichage(ctx.db, getPendingForContext(ctx.db, ctx.adresses, { limit, carriedGraceMs: GRACE_APRES_SONNETTE_MS }), { lecteur });
  if (releve.length === 0) return { emitted: false, batch: [] };
  const { EVENEMENT_ANNONCE, ANNONCES_AU_PLUS } = office.budget;
  const compterLesAnnonces = ctx.db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE msg_id = ? AND event_type = ?");
  const via = String(label).replace(/_delivered$/, "");
  // La place du préambule et de sa ligne blanche (`injectedText`) : sa forme la
  // plus longue (« P to P », P la plus longue fenêtre), avant de savoir quelles
  // lettres partent (B2).
  const [, plafond] = minutesDeRetour(office);
  const entete = preamble(ctx.selfId, [plafond, plafond]).length + ` to ${plafond}`.length + 2;
  let marge = 0;
  for (let essai = 0; essai < ESSAIS_DE_LIVRAISON; essai += 1) {
    const pourLesLettres = Math.max(0, budget - entete - marge);
    // Une lettre qui ne partirait que coupée se tait quand elle a déjà été annoncée trois fois,
    // ou quand même coupée elle ne tient pas (un en-tête démesuré) : elle attend, et `inbox` la
    // lit ; les suivantes passent.
    const rows = releve.filter((row) => {
      const [seule] = selectWithinBudget([row], pourLesLettres, mesure(office)).batch;
      if (!seule.coupee) return true;
      return compterLesAnnonces.get(row.msg_id, EVENEMENT_ANNONCE).n < ANNONCES_AU_PLUS
        && mesure(office)(seule) <= pourLesLettres;
    });
    if (rows.length === 0) return { emitted: false, batch: [] };
    const { batch, truncated } = selectWithinBudget(rows, pourLesLettres, mesure(office));
    const entieres = batch.filter((row) => !row.coupee);
    const annoncees = batch.filter((row) => row.coupee);
    let exces = 0;
    try {
      ctx.db.transaction(() => {
        markDelivered(ctx.db, entieres, ctx.selfId, label);
        for (const row of annoncees) recordEvent(ctx.db, row.msg_id, ctx.selfId, EVENEMENT_ANNONCE, { taille: row.coupee.taille, via });
        journaliserLesAliasLus(ctx.db, batch, ctx.selfId);
        const lettres = enrichirPourAffichage(ctx.db, batch, { lecteur });
        const texte = injectedText(office, ctx, lettres);
        if (texte.length > budget) {
          exces = texte.length - budget;
          throw DEPASSEMENT;
        }
        if (!emit(wrap(texte, lettres))) throw ECRITURE_RATEE;
      })();
    } catch (erreur) {
      if (erreur === DEPASSEMENT) {
        marge += exces;
        continue;
      }
      if (erreur !== ECRITURE_RATEE) throw erreur;
      return { emitted: false, batch, failed: true };
    }
    return { emitted: true, batch, truncated, livrees: entieres, annoncees };
  }
  return { emitted: false, batch: [], tropLong: true };
}

// ── Le filet du Stop ────────────────────────────────────────────────────────
// Il ne bloque que pour une lettre high/critical qui RÉVEILLE (les calmes sont
// écartées en SQLite : `sansLesCalmes`), au plus 3 fois par lettre (le verrou
// d'arrêt, clef = la lignée en mode nom nu), et sa raison est l'ENVELOPPE :
// elle arrive au modèle comme une parole de l'utilisateur (prouvé le 21/10),
// jamais un corps. Une enveloppe n'est pas une livraison : rien n'est marqué
// `delivered_at` ici — le corps arrive par `inbox` ou par le PostToolUse qui
// suit, et c'est là qu'il se marque. L'événement `codex_stop_rung` garde le
// reçu de la sonnerie. `{}` sur `stop_hook_active` se tranche AVANT, dans le
// hook : ceci ne connaît que le bureau.
export function stopSafetyNet(office, ctx, { emit, wrap, label = "codex_stop_rung" }) {
  const { getPendingForContext, enrichirPourAffichage, recordEvent } = office.database;
  const { evaluateStopGuard, resetStopGuard } = office.stopGuard;
  const rows = enrichirPourAffichage(
    ctx.db,
    getPendingForContext(ctx.db, ctx.adresses, { limit: 50, parUrgence: true, sansLesCalmes: true, carriedGraceMs: GRACE_APRES_SONNETTE_MS }),
    { lecteur: ctx.adresses }
  );
  if (rows.length === 0) {
    resetStopGuard(ctx.selfId);
    return { block: false, raison: "vide", batch: [] };
  }
  const urgentes = rows.filter((row) => PRIORITES_URGENTES.has(row.priority));
  if (urgentes.length === 0) return { block: false, raison: "pas-urgent", batch: [] };
  const [top] = urgentes;
  const verrou = evaluateStopGuard(ctx.selfId, top.msg_id);
  if (!verrou.shouldBlock) return { block: false, raison: "plafond", batch: [] };
  const reason = office.sonnette.enveloppeDeSonnette(urgentes, {
    destinataire: ctx.selfId,
    autresNonLues: rows.length - urgentes.length
  });
  if (!emit(wrap(reason, urgentes, top))) return { block: false, raison: "ecriture", batch: urgentes, failed: true };
  for (const row of urgentes) {
    recordEvent(ctx.db, row.msg_id, ctx.selfId, label, { blocage: verrou.guard.block_count, top: top.msg_id });
  }
  return { block: true, batch: urgentes, top };
}
