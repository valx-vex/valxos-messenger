// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// The launchd LABELS of VALXOS Messenger and where their plists live — the
// part the doctor (src/bin) reads as well as the installer (scripts/).  It
// lives under src/lib so a bin never imports from scripts/ (a copy of src/
// alone must still run its doctor).  scripts/launchd/plists.js re-exports it:
// one list, never two that drift.
import os from "node:os";
import path from "node:path";

export const SERVICES = [
  { label: "com.valxos.messenger.facteur", program: "src/bin/facteur.js" },
  { label: "com.valxos.messenger.web", program: "src/bin/valxos-web.js" }
];

// LEGACY (cc2cc-v2 era): the labels the Facteur and the web door ran under
// before the rename.  On a machine that migrates they may still be loaded and
// still hold port 8790, so the installer asks launchctl about them before it
// loads anything and names them on uninstall.  They carry the account name,
// so they are derived at runtime and never written as literals in the tree.
// VALXOS_LEGACY_LABELS (colon-separated) replaces the derived pair — the
// tests use it so they never probe the real services of the machine.
// SET BUT EMPTY COUNTS AS UNSET (F6, adversarial pass, 28/09): an empty value
// probed ZERO labels and the installer reported a green "ok" that had probed
// nothing.  A value that names no label falls back to the derived pair.
export function legacyLabels(env = process.env) {
  const declares = String(env.VALXOS_LEGACY_LABELS ?? "").split(":").map((l) => l.trim()).filter(Boolean);
  if (declares.length > 0) return declares;
  return ["facteur", "web"].map((j) => `com.${os.userInfo().username}.cc2cc-${j}`);
}

export function launchAgentsDir(home) {
  return path.join(home, "Library", "LaunchAgents");
}

export function plistPath(home, label) {
  return path.join(launchAgentsDir(home), `${label}.plist`);
}

// The launchctl in use: VALXOS_MESSENGER_LAUNCHCTL (tests point it at a fake),
// else the system one.  Read by the installer and the doctor alike.
export function launchctlUtilise(env = process.env) {
  return env.VALXOS_MESSENGER_LAUNCHCTL || "launchctl";
}

// `launchctl print-disabled gui/<uid>` (read-only) lists the override of each
// label: `"label" => disabled|enabled` on current macOS, `=> true|false` on
// older ones.  Returns the set of labels marked disabled (N2, adversarial pass
// 2, 28/09: a legacy plist present on disk and NOT disabled is loaded again by
// launchd at the next login, loaded right now or not).
export function labelsDesactives(sortie) {
  const desactives = new Set();
  for (const ligne of String(sortie || "").split("\n")) {
    const m = ligne.match(/"([^"]+)"\s*=>\s*(disabled|enabled|true|false)\b/);
    if (m && (m[2] === "disabled" || m[2] === "true")) desactives.add(m[1]);
  }
  return desactives;
}

// The legacy labels whose plist sits in ~/Library/LaunchAgents.
export function plistsHistoriquesPresents(home, fsLike, env = process.env) {
  return legacyLabels(env).filter((label) => fsLike.existsSync(plistPath(home, label)));
}
