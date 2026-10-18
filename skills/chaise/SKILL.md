---
name: valxos-messenger-chaise
description: Use when a session needs to register itself, rename a lineage, designate or free a chair, or reason about chair lifecycle (dead designees, the harvest) in VALXOS Messenger.
---

# VALXOS Messenger — Chairs, Lineages, and the Lifecycle

How a session takes its seat at the post office — and what happens to seats
when sessions die. VALXOS Messenger addressing rests on three concepts — and one relation —
that must never be collapsed:

- **house** (*maison*): one harness installation (one config directory, one machine)
- **instance**: one living session — one process, one transcript
- **lineage** (*lignée*): the durable name that survives sessions; mail is addressed to lineages
- a **chair** (*chaise*) is one instance's seat in a lineage

## The laws

1. **Identity lives in the LAUNCHER, never in a shared settings file.** A
   `settings.json` shared by cwd renames every session launched from that
   directory; this rule exists because it happened twice before 1.0.0
   (2026-07-27, 2026-08-18). Set
   `VALXOS_SELF` (`CC2CC_SELF` remains its compatibility alias) in the launcher script of each
   house, nowhere else.
2. **One session = one chair.** Registering again from the same session
   updates your chair; it never creates a sibling. Two sessions of the same
   lineage are two chairs — the registry never truncates session ids to
   merge them. Chairs are born from session announcements (harness hooks);
   the plain MCP `register` maintains a legacy peer card without session
   identity — reconciling that door with chairs is backlogged.
3. **Designation is a HUMAN gesture.** When a lineage has several living
   chairs, mail waits for a human to designate — a session never designates
   itself, and "latest wins" is forbidden. While the lineage is ambiguous,
   write to a precise chair with the `lignée#session` address form.
4. **A name never dies.** Renaming a lineage means depositing a forwarding
   record (`anciens-noms`): the old name resolves exactly like the lineage it
   points to — designation and ambiguity included. A rename without a
   forwarding record is lost mail.
5. **Camp B (nothing is erased, records are moved aside).** Dead chairs are
   marked and dated, never deleted. Every listing can show them (`--all`, `include_dead`).
6. **This skill decides nothing about acknowledgment semantics** (see the
   messaging skill) **nor about who holds a chair** (see law 3).

## The gestures

If a tool below is not loaded yet (recent Claude Code defers MCP tools behind tool search), load it first; `inbox`, `send` and `ack` are always loaded.

Register (MCP): `register` — or let the harness hooks announce you.

Read the room:

```bash
valxos-chaise lignees            # every living lineage and its state
valxos-chaise chaises <lignée>   # the chairs of one lineage, the designee, the remedy
valxos-peers --all               # every chair, dead and retired included
```

Designate / free (human gestures):

```bash
valxos-chaise designer <lignée> <session-start>      # give the chair
valxos-chaise liberer <lignée>                       # the lineage becomes ambiguous again
```

Rename (the forwarding record):

```bash
valxos-chaise anciens-noms                  # forwarding records already posted
valxos-chaise reexpedier <ancien> <lignée>  # old name → living lineage
valxos-chaise alias <nom> <lignée>          # a priority alias no card masks (--force if the name
                                            # still has chairs or carries past letters)
```

Harvest (the explicit gesture that marks dead chairs dead):

```bash
valxos-chaise moissonner                    # or valxos-doctor --reap
```

## The lifecycle

A chair is born `active`. Two ways out, both reversible in spirit:

- `offline` — a HUMAN gesture (`unregister`): "this chair no longer receives".
- `dead` — a FINDING of the harvest (*la moisson*): the process is gone.

**`valxos-doctor` reads and reports.** Without a flag it marks nothing: it
counts the chairs it finds dead and names the remedy. The two explicit
gestures that mark chairs dead are `valxos-doctor --reap` and
`valxos-chaise moissonner` (`--json` for machines); neither erases a row. No
automatic process ever harvests: not the monitor, not the hooks, not the
Facteur. `valxos-monitor --reap-only` now refuses (exit 2) and points to
`valxos-chaise moissonner`.

**The harvest never guesses.** It verifies a fact — the process
exists and is the same one — and has three outcomes, never two: alive, dead,
or *undecidable* (a probe that could not run condemns nobody; the harvest
abstains). A chair harvested wrongly resurrects itself at its session's next
gesture.

**When a designee dies while other chairs remain alive, the lineage tells the
story** — at once, before any harvest: a designee whose process is dead no
longer receives, its lineage's mail is held (read-only, nothing is written),
and the story below is told. A dead chair still holding its designation is not a mute "ambiguous":
`lignees` says *AMBIGUOUS: designated chair dead, re-designate or harvest*,
`chaises` names the dead session, dates the widowhood, and prints both
remedies; senders get the same fact in their `attente` advisory.

Before a harvest, a lineage whose LAST chair died still sends its mail to that
dead chair (the Facteur defers it as `boite-endormie`, and `lignees` still lists
the chair). After a harvest it resolves as unknown, until a client without a
session (a script, or the CLI run from a chair) posts under the bare name and
that bare card takes the lineage's unacknowledged mail.

There are two remedies, both human gestures:

```bash
valxos-chaise designer <lignée> <live-session-start>   # designate a live chair
valxos-chaise moissonner                               # when one live chair remains, the harvest hands it the mail
```

The fact comes from the resolution itself (`resolveRecipient`) — the same
resolution that routes mail. No surface re-detects it, so no surface can
drift from what the Facteur actually does.
