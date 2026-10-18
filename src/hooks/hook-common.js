// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import { getDatabase } from "../lib/database.js";
import { codeDeSortieSurBureauRelatif, normalizeAgentId, valeurDeLEnvironnement } from "../lib/config.js";
import {
  adressesDuRepli,
  chaiseReceptrice,
  journaliserRefusUneFois,
  resolveSelfId,
  touchSelf
} from "../lib/identity.js";

// Un hook ne bloque jamais sur un bureau mal configuré (F2) : la ligne de
// refus est dite sur stderr, et le hook sort 1 — l'erreur NON bloquante dont
// Claude Code montre le stderr (M-7 : sortie 0, il ne le montrait qu'en mode
// verbeux, et la mauvaise configuration restait muette). Jamais 2 : un Stop
// qui sortirait 2 retiendrait la session pour une variable d'environnement.
codeDeSortieSurBureauRelatif(1);

export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw_input: raw };
  }
}

// Le nom de lignée tel que l'ENVIRONNEMENT le donne, sans rien lire : c'est
// sous lui qu'un refus de sous-agent se journalise, avant toute ouverture.
function nomDeLEnvironnement() {
  return normalizeAgentId(valeurDeLEnvironnement(process.env, "CC2CC_SELF"))
    || normalizeAgentId(valeurDeLEnvironnement(process.env, "CC2CC_SESSION_NAME"))
    || "system";
}

// LA CHAISE RÉCEPTRICE (Run 6, Task 6) : seul le vrai processus de la session
// relève le courrier. Un refus rend `adresses = []` et `recoit: false` ; les
// hooks sortent alors `{}` sans rien lire ni rien marquer — muets pour le
// sous-agent ou le jumeau, dits une fois au journal du bureau.
export function hookContext(input) {
  const pid = process.ppid;
  const sessionId = input.session_id || input.sessionId || null;
  // Un sous-agent est refusé AVANT d'ouvrir la base : aucun regard, même sur
  // le registre.
  if (input.agent_id) {
    const qui = chaiseReceptrice(null, input, { pid });
    const selfId = nomDeLEnvironnement();
    journaliserRefusUneFois(selfId, { raison: qui.raison, sessionId, agentId: input.agent_id, pid });
    return { db: null, selfId, adresses: [], recoit: false, raison: qui.raison, input };
  }
  const db = getDatabase();
  const selfId = resolveSelfId(db, input);
  const qui = chaiseReceptrice(db, input, { pid });
  if (!qui.recoit) {
    // Pas de `touchSelf` : un jumeau ne réécrit pas le pid de la chaise.
    journaliserRefusUneFois(selfId, { raison: qui.raison, sessionId, agentId: null, pid });
    return { db, selfId, adresses: [], recoit: false, raison: qui.raison, input };
  }
  touchSelf(db, selfId, input);
  // `selfId` est le nom de la LIGNÉE : c'est sous ce nom qu'on journalise et
  // qu'on tient le verrou. `adresses` est la boîte qu'on relève : la lignée ET
  // les chaises de cette session — sinon une lettre nominative n'est jamais lue.
  const adresses = adressesDuRepli(db, selfId, input);
  return { db, selfId, adresses, recoit: true, raison: qui.raison, input };
}

export function writeStdoutJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeStderrJson(value) {
  process.stderr.write(`${JSON.stringify(value)}\n`);
}
