## What this changes

<!-- One or two sentences. What was wrong, or what is now possible. -->

## Why

<!-- The reason, not the diff. If this fixes something subtle, say what the old
     code got wrong — that comment is worth more than the patch. -->

## Evidence

<!-- Paste the output, not a summary of it. -->

```
node --test test/*.test.js
```

- [ ] `node --test test/*.test.js` is green — its summary is pasted above (if the count changed, say why)
- [ ] A test fails before this change and passes after it
- [ ] No new runtime dependency (or the reason is in "Why" above)
- [ ] No second implementation of the posting rules — surfaces call `src/lib/guichet.js`
- [ ] Committed by explicit paths, not `git add -A`

## Anything you noticed but did not fix

<!-- Optional and genuinely useful. Note it here rather than widening the PR. -->
