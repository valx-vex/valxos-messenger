#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// LE HOOK CODEX (1.1.0, spec B §2 et §4) — un seul exécutable pour quatre
// événements, choisi par `hook_event_name` sur stdin :
//   node src/hooks/codex/codex-hook.js --serves <lignée>
// SessionStart, UserPromptSubmit et PostToolUse injectent les lettres en
// attente (`hookSpecificOutput.additionalContext`, cadrées « untrusted text »)
// et les marquent livrées — jamais accusées. Stop rend `{}` quand
// `stop_hook_active`, ne bloque que pour high/critical, 3 fois au plus par
// lettre, et sa raison est l'enveloppe (src/lib/sonnette.js), jamais un corps.
// SessionStart écrit la fiche de chaise Codex (src/lib/chaise-codex.js) avec
// le `session_id` du stdin — l'identifiant du fil, celui que `codex queue`
// attend ; UserPromptSubmit et Stop la rafraîchissent.
// Toujours sortie 0, toujours un JSON valide pour le schéma de Codex (`{}`
// l'est pour chaque événement : tous ses champs sont optionnels).
//
// Seuls des modules `node:` et ./harness-common.js sont importés
// statiquement : le bureau se charge APRÈS la garde, en import dynamique.
import path from "node:path";
import {
  contexteDeLaBoite,
  deliverLetters,
  drainStdin,
  gate,
  installGuards,
  isHookObject,
  livraisonDe,
  loadOffice,
  note,
  parseArgs,
  parseHookText,
  stopSafetyNet,
  traceActive,
  traceInput
} from "./harness-common.js";

const NOOP = {};
const guards = installGuards(NOOP, { trace: traceActive(process.env) });

async function main() {
  // stdin d'abord, sur tous les chemins — le refus compris. Vider stdin
  // n'ouvre aucun bureau.
  const lu = await drainStdin();
  const args = parseArgs(process.argv.slice(2));
  const garde = gate(args, process.env);
  if (!garde.selfId) {
    note(garde.ligne);
    guards.emit(NOOP);
    return;
  }
  guards.masquer = garde.selfId;
  if (!lu.complet) {
    note("stdin did not close within the read bound; nothing delivered.");
    guards.emit(NOOP);
    return;
  }

  let office;
  try {
    office = await loadOffice();
  } catch (erreur) {
    guards.erreur(erreur, { ligne: (libelle) => `could not load the VALXOS Messenger library (${libelle}); nothing delivered.` });
    guards.emit(NOOP);
    return;
  }

  const raw = parseHookText(lu.texte);
  if (!isHookObject(raw)) {
    note("stdin was empty or not a JSON object; nothing delivered.");
    guards.emit(NOOP);
    return;
  }
  const event = raw.hook_event_name;

  // La ligne « compatibility - using historical runtime » se dit au
  // SessionStart, une fois par session (1.1.0, Tâche 8, comme les hooks Claude
  // Code) : les autres événements se taisent, AVANT le premier regard au
  // bureau (`runtimePaths`).
  if (event !== "SessionStart") office.config.taireLaLigneDeCompatibilite();
  // La trace (constat 3) ne connaît qu'un dossier : sous le bureau, une fois
  // celui-ci résolu — jamais un chemin de l'environnement. Et seulement sous
  // un bureau que la garde du bureau vivant laisse écrire (Round 1) : la trace
  // s'écrit à la sortie, sans repasser par `openDatabase` ; une garde qui
  // refuse le bureau refuse aussi sa trace, qui ne s'écrit alors nulle part.
  if (guards.trace) {
    let dossier = null;
    try {
      office.database.garderLEcritureDuBureau();
      dossier = path.join(office.config.runtimePaths().logs, "codex-hook");
    } catch {
      dossier = null;
    }
    guards.setTraceDir(dossier);
  }
  traceInput(guards.trace, raw, { event });

  // Un sous-agent ne relève pas le courrier.
  if (raw.agent_id) { guards.emit(NOOP); return; }
  const livraison = livraisonDe(event);
  if (event !== "Stop" && !livraison) { guards.emit(NOOP); return; }

  // Mode nom nu : la boîte est la lignée (et les alias qui y mènent), jamais
  // une chaise `lignée#session` — le client MCP de Codex parle en nom nu et
  // doit pouvoir accuser ce qu'on lui livre.
  const ctx = contexteDeLaBoite(office, garde.selfId);
  tenirLaFiche(office, ctx, raw, event);

  if (event === "Stop") {
    // Après un blocage, Codex rejoue le Stop de la même chaîne avec
    // `stop_hook_active: true` — on laisse alors s'arrêter, quoi que
    // contienne le bureau. `systemMessage` est un avertissement d'interface
    // pour l'opérateur, jamais un contexte du modèle (schéma Codex).
    if (raw.stop_hook_active === true) { guards.emit(NOOP); return; }
    const verdict = stopSafetyNet(office, ctx, {
      emit: guards.emit,
      wrap: (reason, urgentes, top) => ({
        decision: "block",
        reason,
        // L'expéditeur se nomme comme dans l'enveloppe : borné, cité (Round 1).
        systemMessage: `VALXOS Messenger: ${urgentes.length} urgent letter(s) for ${ctx.selfId} at Stop (most urgent: ${top.priority} from ${office.sonnette.nomCite(top.sender) || "\"\""})`
      })
    });
    if (guards.trace) {
      guards.trace.letters = { count: verdict.batch.length, msg_ids: verdict.batch.map((r) => r.msg_id), stop: verdict.block ? "block" : verdict.raison };
    }
    if (!verdict.block) guards.emit(NOOP);
    return;
  }

  const resultat = deliverLetters(office, ctx, {
    limit: livraison.limit,
    label: livraison.label,
    emit: guards.emit,
    wrap: (additionalContext) => ({ hookSpecificOutput: { hookEventName: event, additionalContext } })
  });
  if (guards.trace) {
    guards.trace.letters = {
      count: resultat.emitted ? resultat.batch.length : 0,
      msg_ids: resultat.emitted ? resultat.batch.map((r) => r.msg_id) : []
    };
  }
  if (resultat.tropLong) note("the letters did not fit the injection budget this time; they wait for the next hook or the inbox tool.");
  if (!resultat.emitted) guards.emit(NOOP);
}

// LA FICHE DE CHAISE (spec B §2). SessionStart l'écrit avec `session_id` ;
// UserPromptSubmit et Stop rafraîchissent `last_seen` — et l'écrivent si elle
// manque, si sa carte a disparu, ou si elle nomme un autre fil (hook posé en
// cours de session, fil neuf). PostToolUse ne la touche pas : un par outil, ce
// serait une écriture par geste. Une fiche qui ne s'écrit pas ne retient
// aucune lettre, et sa ligne stderr ne nomme pas l'identité (constat 3).
function tenirLaFiche(office, ctx, raw, event) {
  const thread = typeof raw.session_id === "string" ? raw.session_id.trim() : "";
  if (!thread) return;
  if (event !== "SessionStart" && event !== "UserPromptSubmit" && event !== "Stop") return;
  const { codexHomeDe, ecrireFicheCodex, porteDeLEnvironnement, rafraichirFicheCodex } = office.chaiseCodex;
  try {
    if (event !== "SessionStart") {
      const fiche = rafraichirFicheCodex(ctx.db, ctx.selfId);
      if (fiche && fiche.thread_id === thread) return;
    }
    ecrireFicheCodex(ctx.db, {
      lineage: ctx.selfId,
      thread_id: thread,
      codex_home: codexHomeDe(process.env),
      pid: process.ppid,
      porte: porteDeLEnvironnement(process.env),
      cwd: typeof raw.cwd === "string" ? raw.cwd : null
    });
  } catch (erreur) {
    guards.erreur(erreur, { cle: "chair_card_error", ligne: (libelle) => `chair card not written (${libelle}); letters are still delivered.` });
  }
}

try {
  await main();
} catch (erreur) {
  guards.erreur(erreur);
  guards.emit(NOOP);
}
process.exit(0);
