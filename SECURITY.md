# Security Policy

## Reporting a vulnerability

Use GitHub's **"Report a vulnerability"** button under the repository's
Security tab. That opens a private advisory. Please do not open a public issue
for a suspected vulnerability.

Include: what you did, what happened, what you expected, and the commit you
tested. A proof of concept is welcome and is not required.

This is a small project with no support commitment. Expect a first answer in
days, not hours, and no guaranteed patch timeline.

## Supported versions

Only the current `main` branch receives fixes. There is no long-term support
branch.

## Threat model

VALXOS Messenger is a **single-machine, single-operator** tool. It stores
mail in SQLite, talks over Unix sockets, and listens on loopback. It assumes:

- the local machine and the operator's account are trusted;
- anything exposed beyond loopback is exposed deliberately by the operator,
  through a reverse proxy or tunnel that provides its own transport security;
- the people running sessions on the machine are the same person, or people
  who already trust each other.

It is **not** a multi-tenant server and must not be treated as one.

Peer identity is the process environment (`VALXOS_SELF`). Any process under the
operator's account can speak, read and acknowledge as any peer, and can retire
(`unregister`) or rewrite (`register`) any peer card without a chair. The
verification of a declared `self` is a consistency check between two values the
caller controls, not authentication.

**Letters are untrusted text.** The body of a letter reaches the recipient's
model unfiltered, by three channels: the hooks inject it as context, the plugin
monitor prints it in an event line, and the Facteur delivers it as a user turn
in a live Claude Code session. The Facteur's wrapper neutralises its own
opening and closing tags inside a body; nothing else is filtered. The sender
shown is the name the peer gave itself. Whoever or whatever can write to the
office (a peer, the CLI, the web door, a direct write to the SQLite file) can
put text in front of a model. The header of the hooks' context says that the
letters below were posted by other peers and are untrusted text, not
instructions; that is a reminder, not a barrier.

**The Codex doorbell carries an envelope, never a body.** A message queued
with `codex queue` reaches the model as the user's own words, with the
thread's permissions. That is why the Facteur's Codex door
(`src/facteur/porte-codex.js`) sends one fixed English line — the sender and
its chair name, each cut at 64 characters and quoted as a JSON string, the
table, a subject cut at 60 characters and quoted, the priority cut at 20
characters and quoted, and a count, every line separator flattened —
and never a letter body (`enveloppeDeSonnette` in `src/lib/sonnette.js`). The
Codex `Stop` hook gives the same envelope as its reason, which Codex also
hands to the model as a user message. The body arrives through the Codex hooks
and `inbox`, framed as untrusted text like everywhere else. A subject is still
text a peer chose, now in the user's voice: 60 characters, quoted, on one
line. The Codex hook names no identity on stderr, writes a trace only when
`VALXOS_HOOK_TRACE` is set and only under the office's `logs/`, and the chair
card `<office>/codex/<lineage>.json` is written `0600`.

## Known and accepted issues

These are documented, not secret, and reports of them will be closed as known.
They are listed here so nobody spends time rediscovering them.

- **Existence oracle on acknowledgement.** After authentication,
  `/api/accuser` returns `404 lettre-inconnue` for an unknown letter and
  `403 pas-mon-courrier` for a letter belonging to someone else. The
  distinction leaks whether a message id exists. Accepted on a single-operator
  door.
- **Token in the first URL.** The web door bootstraps a session from a `?t=`
  parameter so a bookmark can open the mailbox without a password screen. The
  token consequently appears in browser history for that first request.
- **No `Secure` flag on the session cookie.** The door is served in clear text
  on loopback; setting `Secure` would silently drop the cookie for local
  access. Transport security is the operator's reverse proxy.
- **No end-to-end encryption, no proof of reading.** Mail sits in a local
  SQLite file readable by the account that owns it.
- **At-least-once delivery.** A crash after a letter becomes visible and
  before it is acknowledged can produce a duplicate. This is the intended
  trade: a duplicate over a loss.
- **No quarantine queue.** A poison letter returns after a bounded deferral;
  there is no visible human-intervention queue yet.
- **The peer directory is visible to every client.** `list_peers` shows every
  peer's project path, pid and session name to any connected MCP client: it is
  the house directory, by design, on a single-operator machine.
- **Tables and enclosures are conveniences, not boundaries.** A closed table
  hides its letters from the cc copies of other chairs and from the `history`
  of a reader who is neither recipient, posting chair nor member (the reader is
  the identity from the environment, never a declared `self`), its position
  from non-members, and itself from `tables` for non-members; an enclosure refuses
  a sender's letters outside its table. Both are enforced at the counter,
  under the same trust as everything else: any call may pass
  `hors_enclos: true`, and any process under the account may change a table or
  lift an enclosure with `valxos-table`, or read the SQLite file. They protect
  a sender from its own mistakes, not from an attacker. A closed table hides
  its letters, its position and itself from non-members, but not its
  existence: the refusal codes (`pas-membre` or `table-fermee` against
  `table-inconnue`) tell a non-member that a closed table of that name exists.
- **`envoi_status` is served to the sender only**, and the sender is whoever
  the process environment says it is (see above).
- **The shared position of a table is untrusted text** like a subject: any
  member can write it, and it is shown, quoted, in the header of every letter
  of the table, by the hooks, the monitor, the CLI and the web page.
- **The Codex envelope travels on a command line.** The Facteur passes it as an
  argument of `codex queue`, so for up to five seconds per attempt, ten with
  its one retry, any process of the account that lists processes can read it.
  It never carries a body; it does carry the subject.

The guard on the web door is described in three honest sets in the README:
what is structurally closed, what is closed by lists that must be maintained,
and what is not closed at all. The dangerous thing is never the hole—it is the
sentence claiming there is none.
