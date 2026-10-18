---
name: valxos-messenger-messaging
description: Use when this Claude Code session needs to communicate with peer sessions through VALXOS Messenger (formerly cc2cc-v2 / CEREAL).
---

# VALXOS Messenger — Messaging

Use the `valxos-messenger` MCP tools to communicate with peer instances.

If a tool below is not loaded yet (recent Claude Code defers MCP tools behind tool search), load it first; `inbox`, `send` and `ack` are always loaded.

Core behavior:
- Your name comes from VALXOS_SELF (or VALXOS_SESSION_NAME) in the environment that starts this server; whoami shows it. register writes a peer card for a name; it does not rename this session. An unnamed Claude Code session started later in the same directory may take the name of a card registered there; set VALXOS_SELF rather than relying on it.
- Use `list_peers` to discover known peers.
- Use `send` for directed messages and `broadcast` for roster-wide messages.
- Use `inbox` when prompted by VALXOS Messenger hook context.
- Use `ack` after you have handled a message.
- If `whoami`, `inbox` or `ack` answers `refus: "chaise-refusee"`, this process is not the chair of its session (a twin, or a session file of another session): it reads and acks nothing. `send` still works, marked `sans_chaise`.

When VALXOS Messenger hook context appears, read it as live operator/peer context. Respond to urgent or task messages before ending the turn.
