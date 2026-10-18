// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import { appendLog, nowIso, readJsonIfExists, runtimePaths, writeJsonAtomic } from "./config.js";

// LA CLEF DU VERROU EST LA CHAISE (F4, passe adverse, 28/09). Tenu sous la
// LIGNÉE, le verrou était partagé par toutes les chaises d'une lignée : chacune
// réécrivait `last_msg_id` avec SA lettre, le compteur de l'autre retombait à
// 1, et la promesse du filet (« jamais plus de 3 blocages pour une lettre »)
// disparaissait exactement là où plusieurs chaises servent. Avec une session :
// `lignée#session`. Sans session (un client nu, le CLI) : la lignée, comme
// avant.
export function cleDuVerrouDArret(lignee, sessionId = null) {
  const nom = String(lignee || "");
  if (!sessionId || nom.includes("#")) return nom;
  return `${nom}#${sessionId}`;
}

export function readStopGuard(agentId) {
  return readJsonIfExists(runtimePaths(agentId).stopGuard, {
    block_count: 0,
    last_msg_id: null,
    last_block_ts: null
  });
}

export function resetStopGuard(agentId) {
  writeJsonAtomic(runtimePaths(agentId).stopGuard, {
    block_count: 0,
    last_msg_id: null,
    last_block_ts: null
  });
}

// `journal` : le nom sous lequel le « stop loop » se journalise — la lignée,
// comme chaque journal des hooks, même quand la clef est une chaise.
export function evaluateStopGuard(agentId, msgId, { journal = agentId } = {}) {
  const guard = readStopGuard(agentId);
  if (guard.last_msg_id !== msgId) {
    const next = {
      block_count: 1,
      last_msg_id: msgId,
      last_block_ts: nowIso()
    };
    writeJsonAtomic(runtimePaths(agentId).stopGuard, next);
    return { shouldBlock: true, guard: next };
  }

  if (Number(guard.block_count || 0) >= 3) {
    appendLog(journal, "stop loop detected, allowing stop", { msg_id: msgId, guard, verrou: agentId });
    return { shouldBlock: false, guard };
  }

  const next = {
    block_count: Number(guard.block_count || 0) + 1,
    last_msg_id: msgId,
    last_block_ts: nowIso()
  };
  writeJsonAtomic(runtimePaths(agentId).stopGuard, next);
  return { shouldBlock: true, guard: next };
}
