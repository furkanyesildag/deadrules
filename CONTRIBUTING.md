# Contributing

```sh
npm ci
npm test        # builds first, so a type error fails the run
```

## What the tests cover

The suite runs without a network connection and without any model calls. The
end-to-end tests build a temporary git repo, plant a `CLAUDE.md` in which
exactly one rule is load-bearing, and drive the real ablation loop with a fake
agent that obeys that rule and ignores the rest. That makes the ground truth
known, so the assertions are about the search finding the right rule rather
than about how any particular model behaves.

If you change the search strategy, the test to watch is
`bisecting scales better than testing every rule alone` — it fails if the
bisect degrades toward one sweep per rule.

## Things worth knowing

- **No runtime dependencies.** Dev dependencies are fine; anything the
  published package would load at runtime is not.
- **Statistics claims need a test with a known answer.** The Fisher exact
  implementation is checked against Fisher's own tea-tasting table and the
  false-discovery correction against the Benjamini-Hochberg worked example.
  Add the same kind of anchor for anything new.
- **Never say "no effect".** The report is allowed to say there is no evidence
  of an effect, and must say how large an effect the run could have detected.
- **Agent runs happen in throwaway worktrees.** Nothing may write to the user's
  checkout.

## Adding a grader

Graders live in `src/grade/graders.ts`. Add the variant to the `Grader` union in
`src/types.ts`, a `label()` case, and the branch that runs it. Graders that look
at what changed should read added diff lines only, so a pre-existing match in
the repo is not blamed on the agent.
