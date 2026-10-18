# Contributing

Thanks for looking. This document says what the project expects, and—more
usefully—what it will not accept, so you do not spend an evening on a patch
that gets declined.

## Language: read this first

**Public surfaces are in English. Internals are in French.**

The README, the CLI help, the error messages a user sees, and this file are in
English. Identifiers, code comments, and test names are in French
(`posterUneLettre`, `avisDAttente`, `scannerSansCasser`). That is a fact about
the codebase, not an oversight: the project was written that way, and a full
translation was costed at roughly 30 000 lines of churn against working,
tested code. It was declined in favour of keeping the history readable.

The practical consequence: **you can use this project without a word of
French, but patching the internals needs some.** If that blocks you, open an
issue describing what you wanted to change and it can be discussed in English.

## Running the tests

```bash
npm ci
node --test test/*.test.js
```

That command is the gate. `npm test` runs exactly that command (it is
`scripts.test` in `package.json`), so either spelling measures the same suite.
Do not run a bare `node --test`: it walks the whole tree and counts helper
files and stray copies as tests.

The number of tests is deliberately written nowhere in the documentation: it
changes with every test added, and the suite prints it. Paste the summary
(`ℹ tests … pass … fail …`) in a pull request.

Node is pinned in the workflow. `better-sqlite3` is a native module, so the
Node version is part of the contract, not decoration.

## What a good patch looks like

- **A test that fails before your change and passes after.** The suite is the
  only argument that travels.
- **Small.** One concern per pull request.
- **Honest comments.** This codebase documents its own past mistakes next to
  the code that made them. If your change fixes something subtle, write down
  what the old code got wrong—not just what the new code does.
- **No new runtime dependency** without a reason in the pull request body.
  There are three. That is a feature; treat it as one.

## Before filing a bug

Several rough edges are known and documented on purpose: read the README's
[Known limitations](README.md#known-limitations) and [SECURITY.md](SECURITY.md)
first. A report of one of those is closed as known.

## What will be declined

- Large refactors of `src/web/serveur.js`, `src/web/public/app.js`, or
  `faireLaTournee` in `src/facteur/round.js`. They are the three known heavy
  spots and they are on the list. A rewrite that lands with the same tests is
  risk without evidence.
- Translation of internals to English (see above).
- Formatting-only changes across many files. They bury real diffs.
- Anything that adds a second implementation of the delivery rules.
  `src/lib/guichet.js` is the single place where posting a letter is defined,
  and surfaces call it. A copy in a new surface will drift and lose a guard.

## Vocabulary the code is strict about

The code never says *delivered* when it means *handed over*. Handing bytes to
a recipient's mailbox is `remis-au-guichet`; the only proof of arrival is the
acknowledgement the recipient sends back. Delivery is **at least once**: a
duplicate is preferred to a lost letter, and every ambiguous boundary is
resolved in that direction. Patches are expected to keep that distinction.

## Commits

- Commit by explicit paths. Do not use `git add -A`.
- History is not rewritten on `main`.
- One commit message per concern, describing the change and the reason.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
