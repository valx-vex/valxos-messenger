// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// The launchd plists of VALXOS Messenger — the Facteur and the web door —
// rendered from the templates that sit next to this file.  This module
// decides WHAT a plist should contain and whether a file found at its path
// is ours; it never writes, removes, or loads anything.  The installer
// (scripts/install.js) does the writing, with its dry-run and backups.
//
// Every plist the installer writes carries MARKER.  That marker is the only
// thing `--uninstall` trusts: a plist without it — hand-written, or left by
// another tool — is never touched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- written by valxos-messenger install -->";

// The labels and the plist paths live in src/lib (the doctor reads them too).
import { SERVICES, launchAgentsDir, legacyLabels, plistPath } from "../../src/lib/launchd-labels.js";
export { SERVICES, launchAgentsDir, legacyLabels, plistPath };

// fileURLToPath, not `.pathname`: a module URL is percent-encoded, and a
// checkout under `with space/` lost its templates to `with%20space`.
const TEMPLATES_DIR = path.dirname(fileURLToPath(import.meta.url));

// Values land inside <string> elements: a path with `&` or `<` in it must not
// break the plist, so every substitution is XML-escaped.
function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Substitutes every `__KEY__` of the template with `values[KEY]`.  The
// placeholders are read off the TEMPLATE, before anything is substituted, and
// a placeholder without a value is a template that drifted from the
// installer: refused, never written half-filled.  One pass, so a value is
// never re-read as a placeholder — an operator's path may contain `__ODD__`.
// `raw` placeholders are XML the caller already built (and escaped): they go
// in verbatim, where `values` are escaped text.
export function renderPlist(template, values, raw = {}) {
  const placeholders = [...new Set(template.match(/__[A-Z_]+__/g) || [])];
  const known = (key) => Object.hasOwn(values, key) || Object.hasOwn(raw, key);
  const missing = placeholders.filter((p) => !known(p.slice(2, -2)));
  if (missing.length > 0) throw new Error(`launchd template: no value for placeholder ${missing.join(", ")}`);
  if (!template.includes(MARKER)) throw new Error("launchd template: the installer marker is missing");
  return template.replace(/__[A-Z_]+__/g, (p) => {
    const key = p.slice(2, -2);
    return Object.hasOwn(raw, key) ? raw[key] : escapeXml(values[key]);
  });
}

// The web door's operator is PINNED in its plist only when asked for
// (`--operator`): the door reads its environment before web.env, so an
// operator written by default would override the file in silence — and
// web.env is the one place meant to configure the door.  Without it the
// plist says so in a comment, and web.env decides.
export function operatorEntry(operator) {
  if (operator === null || operator === undefined) {
    return "<!-- VALXOS_WEB_OPERATEUR: not pinned — web.env decides; pass --operator to pin one here -->";
  }
  return `<key>VALXOS_WEB_OPERATEUR</key>\n    <string>${escapeXml(operator)}</string>`;
}

// The plists the installer would write, with their final content.
export function planPlists({ home, root, runtimeHome, node, operator = null }) {
  const values = {
    HOME: home,
    REPO_ROOT: root,
    RUNTIME_HOME: runtimeHome,
    NODE: node,
    NODE_DIR: path.dirname(node)
  };
  const raw = { OPERATOR_ENTRY: operatorEntry(operator) };
  return SERVICES.map(({ label }) => ({
    label,
    path: plistPath(home, label),
    content: renderPlist(fs.readFileSync(path.join(TEMPLATES_DIR, `${label}.plist`), "utf8"), values, raw)
  }));
}

export function writtenByInstaller(text) {
  return typeof text === "string" && text.includes(MARKER);
}

// What to do with one planned plist, given the file found at its path
// (null when there is none): write it, leave it, refresh our own, or refuse.
export function verdict(plan, existing) {
  if (existing === null) return "write";
  if (!writtenByInstaller(existing)) return "conflict";
  return existing === plan.content ? "unchanged" : "update";
}

// The launchctl arguments that load one plist into the user's GUI domain.
export function bootstrapArgs(plist, uid) {
  return ["bootstrap", `gui/${uid}`, plist];
}

// The node the plists name.  process.execPath is the VERSIONED binary
// (…/Cellar/node/26.7.0/bin/node under Homebrew): a `brew upgrade node`
// removes it, launchd can no longer exec the Facteur or the door, and
// KeepAlive restarts into nothing.  Preferred: a STABLE entry point whose
// real path is that binary — the `node` found on PATH first (the shell's own
// door to node, e.g. /opt/homebrew/bin/node), then argv0 when the operator
// invoked node through an alias — and only then the binary itself.
export function stableNodePath({ execPath = process.execPath, argv0 = process.argv0, env = process.env } = {}) {
  let real;
  try {
    real = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }
  const name = path.basename(execPath);
  const onPath = String(env.PATH || "")
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, name));
  const viaArgv0 = argv0 && argv0.includes(path.sep) ? [path.resolve(argv0)] : [];
  for (const candidate of [...onPath, ...viaArgv0]) {
    if (candidate === real) continue;
    try {
      if (fs.realpathSync(candidate) === real) return candidate;
    } catch {
      /* not there: next */
    }
  }
  return execPath;
}
