---
name: valxos-messenger-messaging
description: Use when this Claude Code session needs to communicate with peer sessions through VALXOS Messenger (formerly cc2cc-v2 / CEREAL).
---

# VALXOS Messenger — Messaging

Use the `valxos-messenger` MCP tools to communicate with peer instances.

If a tool below is not loaded yet (recent Claude Code defers MCP tools behind tool search), load it first; `inbox`, `send`, `ack` and `reply` are always loaded.

Core behavior:
- Your name comes from VALXOS_SELF (or VALXOS_SESSION_NAME) in the environment that starts this server; whoami shows it. register writes a peer card for a name; it does not rename this session. An unnamed Claude Code session started later in the same directory may take the name of a card registered there; set VALXOS_SELF rather than relying on it.
- Use `list_peers` to discover known peers.
- Use `send` for directed messages and `broadcast` for roster-wide messages.
- Use `inbox` when prompted by VALXOS Messenger hook context.
- Use `ack` after you have handled a message.
- Use `reply` with a letter's `msg_id` to answer it: the answer goes back to its author (its chair when known) in the same thread; `toute_la_table: true` answers the whole table of a table letter (the default in a `direct` table).
- Use `send` with `to: "table:<name>"` to write one letter to every member of a table; `tables` lists the tables you belong to and the open ones you can join, `table_manage` joins or leaves an open table, and `envoi_status` shows, member by member, what became of one table send (there is no "read" state: only `ack` means handled). A letter of a `prochain-tour` table or member, a `low` one, or a reaction in a `direct` table wakes nobody: it arrives at the next turn.
- If `whoami`, `inbox` or `ack` answers `refus: "chaise-refusee"`, this process is not the chair of its session (a twin, or a session file of another session): it reads and acks nothing. `send` still works, marked `sans_chaise`.

When VALXOS Messenger hook context appears, read it as live operator/peer context. Respond to urgent or task messages before ending the turn.
