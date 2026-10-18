// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import net from "node:net";
import { runtimePaths } from "./config.js";

export function pokeAgentSocket(agentId, payload = "wake") {
  const socketPath = runtimePaths(agentId).socket;
  return new Promise((resolve) => {
    const client = net.createConnection({ path: socketPath }, () => {
      client.end(`${payload}\n`);
      resolve({ ok: true, socketPath });
    });
    client.setTimeout(500);
    client.on("error", (error) => resolve({ ok: false, socketPath, error: error.code || error.message }));
    client.on("timeout", () => {
      client.destroy();
      resolve({ ok: false, socketPath, error: "timeout" });
    });
  });
}
