#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getDatabase,
  insertMessage,
  registerPeer
} from "../src/lib/database.js";
import { parseArgs, printJson } from "../src/bin/cli-common.js";
import { homeDir } from "../src/lib/config.js";

// N4 (seconde passe adverse, 28/09) : le parseur partagé — un argument
// inconnu, un `-x` ou un mot nu sortent 2 au lieu d'être ignorés.
function lireLesArguments(argv) {
  const args = parseArgs(argv, {
    booleans: ["apply", "dry_run"],
    known: ["v1_root"],
    positionals: false,
    usage: "usage: valxos-migrate-v1 [--dry-run | --apply] [--v1-root DIR]"
  });
  const apply = args.apply === true && args.dry_run !== true;
  return { apply, dryRun: !apply, ...(typeof args.v1_root === "string" ? { v1Root: args.v1_root } : {}) };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function walkMessages(root) {
  const messages = [];
  if (!fs.existsSync(root)) return messages;
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !dirent.name.startsWith("to-")) continue;
    const recipient = dirent.name.slice(3);
    for (const box of ["inbox", "done"]) {
      const boxDir = path.join(root, dirent.name, box);
      if (!fs.existsSync(boxDir)) continue;
      for (const file of fs.readdirSync(boxDir).filter((name) => name.endsWith(".json")).sort()) {
        const filePath = path.join(boxDir, file);
        const raw = readJson(filePath);
        if (!raw) continue;
        messages.push({ recipient, box, filePath, raw });
      }
    }
  }
  return messages;
}

function normalizeMessage(item) {
  const raw = item.raw;
  return {
    msg_id: raw.id || raw.msg_id || `v1-${path.basename(item.filePath, ".json")}`,
    sender: raw.from || raw.sender || "unknown",
    recipient: raw.to || raw.recipient || item.recipient,
    thread_id: raw.thread_id || raw.threadId || raw.replyTo || null,
    subject: raw.subject || null,
    body: raw.body || raw.text || raw.content?.text || "",
    priority: raw.priority || "normal",
    msg_type: raw.msg_type || raw.type || "message",
    created_at: raw.created_at || raw.timestamp || null,
    source: `cc2cc-v1:${item.box}`,
    raw_json: JSON.stringify({ filePath: item.filePath, raw })
  };
}

function migrateHeartbeats(db, root, apply) {
  const statusDir = path.join(root, "status");
  const peers = [];
  if (!fs.existsSync(statusDir)) return peers;
  for (const file of fs.readdirSync(statusDir).filter((name) => name.endsWith("-heartbeat.json")).sort()) {
    const raw = readJson(path.join(statusDir, file));
    if (!raw) continue;
    const id = raw.agent || raw.name || file.replace(/-heartbeat\.json$/, "");
    const peer = {
      id,
      project_path: raw.project_path || null,
      description: raw.context || "migrated from cc2cc v1 heartbeat",
      session_id: raw.session_id || null,
      pid: Number(raw.pid || raw.parent_pid || 0) || null,
      hostname: raw.hostname || os.hostname(),
      status: raw.status || "offline",
      metadata: { source: "cc2cc-v1-heartbeat", raw }
    };
    peers.push(peer);
    if (apply) registerPeer(db, peer);
  }
  return peers;
}

const args = lireLesArguments(process.argv.slice(2));
const v1Root = args.v1Root || path.join(homeDir(), ".cc2cc");
const db = getDatabase();
const sourceMessages = walkMessages(v1Root);
const normalized = sourceMessages.map(normalizeMessage).filter((msg) => msg.body);
const peers = migrateHeartbeats(db, v1Root, args.apply);
const imported = [];
if (args.apply) {
  for (const msg of normalized) {
    imported.push(insertMessage(db, msg));
  }
}

printJson({
  mode: args.apply ? "apply" : "dry-run",
  v1Root,
  discoveredMessages: sourceMessages.length,
  importableMessages: normalized.length,
  discoveredPeers: peers.length,
  importedMessages: imported.length,
  sampleMessages: normalized.slice(0, 5),
  peers
});
