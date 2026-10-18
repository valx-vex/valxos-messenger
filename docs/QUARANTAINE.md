# Test quarantine

A test that cannot run on a given machine, or that is too slow for the
five-minute suite, is put in quarantine. It is never deleted. The rule is
enforced by `test/quarantaine.test.js`.

How it works:

- The test passes `quarantaine("RUN6-Q<n>", "<one-line reason>", <condition>)`
  (from `test/aide-quarantaine.js`) as its `node:test` options. The condition
  detects the absence the test needs, so the test still runs wherever it can.
- Every tag gets one row in the table below: the tag, the file and test, the
  reason, and how to lift it.
- A slow test is skipped only unless `VALXOS_TESTS_LENTS=1` is set, so
  `VALXOS_TESTS_LENTS=1 npm test` still runs it.
- Lifting a quarantine removes the call from the test and moves its row to
  "Lifted" as a bullet, with the date and the commit.

## Active

| tag | file:test | reason | how to lift |
|-----|-----------|--------|-------------|
| RUN6-Q1 | `test/install-launchd.test.js` : les plists écrits sont lisibles par le système (plutil) | Needs `plutil`, which only macOS ships. Skipped where it is absent, the Linux CI included. | Run on macOS, or give the test a portable plist parser that proves the same structure. |
| RUN6-Q3 | `test/ci-etranger.test.js` : la marche de l'inconnu tourne vraiment (stranger.sh) | Slow and networked: packs, downloads npm 12 and installs globally on a throwaway prefix. Skipped unless `VALXOS_TESTS_LENTS=1`; the CI job `stranger` runs the same script on every push. | Run with `VALXOS_TESTS_LENTS=1`, or keep it as the CI job's local twin. |
| RUN6-Q2 | `test/attente-visible.test.js` : chaise-sans-session ET wake.ok:true peuvent coexister | Needs a temporary directory short enough for a Unix socket path (104 bytes). Skipped when `$TMPDIR` is too long. | Run with a shorter `TMPDIR`, or let the test choose a short socket directory itself. |

A triage on 2026-09-27 went through every red test of the suite. Each one was
a bug and was fixed. Two of the three quarantines above (RUN6-Q1 and RUN6-Q2)
were in-body skips that already existed without a tag; they became named,
conditional quarantines. RUN6-Q3, the stranger's walk, was added later as a
slow test that is skipped by default. On the machine this was written on, the
conditions of RUN6-Q1 and RUN6-Q2 are false, so those two tests run.

## Lifted

None yet.
