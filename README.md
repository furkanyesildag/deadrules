<h1 align="center">deadrules</h1>

<p align="center">
  <strong>You have 40 rules in your CLAUDE.md. How many of them does the agent obey?</strong><br>
  <code>deadrules</code> removes each one, runs real tasks, and measures which rules changed the outcome.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/deadrules"><img alt="npm" src="https://img.shields.io/npm/v/deadrules.svg"></a>
  <a href="https://github.com/furkanyesildag/deadrules/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/furkanyesildag/deadrules/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="zero runtime dependencies" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen">
  <img alt="works with Claude Code, Cursor, Codex" src="https://img.shields.io/badge/agents-claude%20%C2%B7%20cursor%20%C2%B7%20codex-blue">
</p>

---

Everyone maintains a `CLAUDE.md`. Nobody measures it.

A rule goes in because the agent did something annoying once. It never comes
out, because removing it feels risky and there is no way to check. Two years
later the file is 300 lines, every line is load-bearing folklore, and the only
evidence any of it works is that things have not obviously got worse.

Linters can tell you the file is well-formed. They cannot tell you the agent
reads it.

`deadrules` treats the question as an experiment. It deletes one rule, runs
your tasks, and compares the pass rate against the same tasks with the rule in
place. Rules that change nothing show up as exactly that.

<p align="center">
  <img src="https://raw.githubusercontent.com/furkanyesildag/deadrules/main/docs/report.png" alt="A deadrules ablation report: two load-bearing rules, one harmful rule, eight with no measurable effect" width="100%">
</p>

The **HARMFUL** section — rules that make the agent measurably worse — is
usually the surprising one.

## Three ways in, cheapest first

| | costs | what it answers |
|---|---|---|
| `deadrules rules` | nothing | what is actually in my rules files? |
| `deadrules diff <ref>` | one comparison | did the edit I just made help? |
| `deadrules ablate` | a full sweep | which of my rules do anything at all? |

Start at the top.

## 1. `deadrules rules` — free

No agent calls, no cost, instant. It parses your rules files and shows you what
is in them:

<p align="center">
  <img src="https://raw.githubusercontent.com/furkanyesildag/deadrules/main/docs/rules.png" alt="deadrules rules listing eleven parsed rules grouped by heading" width="100%">
</p>

Most people are surprised by the count.

```sh
npx deadrules rules
```

## 2. `deadrules diff` — the one to put in CI

This is the cheapest useful thing the tool does, and the only one that asks
nothing new of you. Someone edits `CLAUDE.md` in a pull request; this says
whether the edit helped.

```sh
deadrules diff HEAD~1        # the rules as they were, against the rules now
deadrules diff main          # your branch's changes to CLAUDE.md
```

```yaml
# .github/workflows/rules.yml
on:
  pull_request:
    paths: ['CLAUDE.md', 'AGENTS.md', '.cursor/rules/**']
jobs:
  measure:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: npm install -g @anthropic-ai/claude-code deadrules
      - run: deadrules diff origin/main --trials 5 --yes
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

It exits non-zero when the new rules measure *worse* than the old ones. Two
variants instead of forty, so it is a fraction of the cost of a full ablation.

## 3. `deadrules ablate` — the full sweep

```sh
deadrules init      # write a config, mine draft tasks from your git history
deadrules ablate    # remove each rule, measure, report
```

`init` mines twelve draft tasks from your recent commits. A commit is a task
whose accepted answer is already in your repo, which is why mining beats writing
tasks by hand. Twelve rather than a handful because tasks are what buy
statistical power — see below.

The prompts are commit subjects, written for people who had the surrounding
context, so **read them before you trust any number they produce**.

## Tasks and graders

```md
---
{
  "base": "a1b2c3d^",
  "grade": [
    { "type": "run", "cmd": "npm test", "label": "tests pass" },
    { "type": "touched", "paths": ["src/routes/users.ts"] },
    { "type": "no-new-pattern", "pattern": "@ts-ignore" }
  ]
}
---
Add a DELETE /users/:id endpoint that soft-deletes and returns 204.
```

| grader | passes when |
|---|---|
| `run` | the shell command exits 0 |
| `file-contains` | a file matches a pattern |
| `file-absent` | a file does not exist |
| `no-new-pattern` | the pattern appears in no *added* diff line |
| `diff-files-max` | at most N files changed |
| `touched` | the named paths were all modified |
| `judge` | a model says the change meets a written rubric |

### The `judge` grader

The graders above measure behaviour: did the tests pass, did the right file
move. Most rules in a real `CLAUDE.md` are not about behaviour — they are about
style, tone, comment quality, commit-message shape. Measured with behavioural
graders alone, every one of those reads as "no evidence", which is a fact about
the graders and not about the rules.

`judge` closes that gap:

```json
{
  "type": "judge",
  "rubric": "Every new exported function has a comment saying why it exists, not what it does."
}
```

It costs one model call per trial, so it is opt-in. Two things about how it
works are deliberate:

- **The judge is blinded.** It sees the diff and the rubric, and nothing else —
  never the repository, never the rules file. If it could read `CLAUDE.md` it
  would be scoring the rule by looking the rule up, and every variant that
  still contained the rule would pass for free.
- **It fails closed.** A timeout, an error, or an answer that is not `PASS` or
  `FAIL` counts as a failure. A judge that did not answer is not evidence that
  the change was good.

A judge is itself a noisy instrument. Its verdicts are one more measurement
subject to the same statistics as everything else here, not ground truth.

## How it works

**One variable.** Each trial runs in a throwaway `git worktree` checked out at
the task's base commit, with exactly one thing different: the rules file. Your
working tree is never touched, and trials run in parallel without colliding.

**Bisection, not brute force.** Testing 40 rules one at a time costs 40 sweeps.
Instead `deadrules` removes groups and only splits the ones that moved the
needle. On a 16-rule fixture with one load-bearing rule, the search finds it in
50 agent runs where the exhaustive sweep needs 90.

**Statistics that admit their limits.** Pass rates are compared with a
two-tailed Fisher exact test, because at these sample sizes the normal
approximation means nothing. Intervals are Wilson score intervals. Testing 40
rules is 40 simultaneous hypotheses, so p-values are corrected with
Benjamini-Hochberg and reported as q-values. Every report ends with the
smallest effect the run could have detected.

The tool never says a rule has no effect. It says there is no evidence of one,
and tells you how hard it looked.

## Statistical power, and how to buy more of it

This is the honest sharp edge. A default run pools 36 trials per arm, which can
detect a swing of about 33 percentage points. Plenty of real rules have smaller
effects than that, and they will come back "no evidence" — not because they do
nothing, but because 36 trials cannot see them.

Power accumulates across runs. Every trial is appended to
`.deadrules/runs/ledger.jsonl` as it completes, and `--resume` replays what is
already there for free:

```sh
deadrules ablate --trials 3            # a first look
deadrules ablate --trials 9 --resume   # pays for six more trials, not nine
```

The second run pools all nine trials, so the detectable effect drops from 33pp
to 19pp and you only paid for the difference. Halving the detectable effect
costs four times the trials — that is the arithmetic, and no tool can talk you
out of it.

If you have to choose, **more tasks beat more trials**: tasks add independent
evidence, repetitions only average out noise on evidence you already have.

## What it costs

One sweep is `tasks × trials` agent runs. The defaults (12 tasks, 3 trials)
make a sweep 36 runs, and a full ablation of a 40-rule file needs roughly 10–12
sweeps.

**Budget the wall clock, not just the money.** 288 agent runs, each with a turn
budget and a test suite, is hours. This is a thing you start before you stop for
the day and read in the morning, not something you run between commits. `diff`
is the one that fits in a coffee break.

Both caps are hard, checked before each invocation rather than after:

```json
{ "budget": { "maxRuns": 80, "maxUsd": 15 } }
```

Keep it cheap: use a small fast model (`claude-haiku-4-5-20251001` is the
default for a reason), start with `--budget-runs 60` and a handful of tasks, and
let the ledger do the rest.

## What it cannot tell you

This is a measurement tool, and measurements have edges. The honest list:

- **A null at this budget is weak.** See above. "No evidence" means you have no
  reason to believe in a rule, not that deleting it is safe.
- **Your graders are the whole world.** A rule about commit messages reads as
  dead if nothing you measure looks at commit messages. The `judge` grader
  widens this, but only as far as you write rubrics for.
- **Cancelling rules hide inside a group.** The bisect assumes a group that
  changes nothing contains nothing that matters. That breaks when a group holds
  one helpful rule and one harmful one: the effects cancel, the group looks
  inert, and it is never split. This is more common than the interaction case
  below, and it is the reason a `no-evidence` verdict measured *in a group* is
  weaker than one measured alone — the report distinguishes them, and `--all`
  shows you which is which.
- **Interaction effects.** Two rules that only work together get removed in the
  same group, the group looks load-bearing, and the bisect blames whichever half
  happened to fail.
- **Agents are not seedable.** A "trial" is a plain repetition. Run-to-run
  variance is real, and the confidence intervals are the only defence.
- **Model-specific.** Results hold for the model you measured. A rule that is
  dead weight for a large model may be load-bearing for a small one.

## Other agents

Anything that takes a prompt and edits files in a directory works:

```json
{
  "agent": {
    "kind": "command",
    "cmd": "cursor-agent -p {{prompt}} --force",
    "askCmd": "llm -m gpt-4o-mini",
    "costUsd": 0.03
  }
}
```

`{{prompt}}`, `{{cwd}}` and `{{model}}` are substituted, shell-quoted. Set
`"promptOnStdin": true` for CLIs that read the prompt from stdin, and `askCmd`
to enable `judge` graders. Whether a task succeeded is decided by your graders,
never by the exit code.

## Configuration

`.deadrules/config.json`, all fields optional:

```json
{
  "base": "HEAD",
  "rules": ["CLAUDE.md"],
  "agent": {
    "kind": "claude",
    "model": "claude-haiku-4-5-20251001",
    "maxTurns": 30,
    "timeoutMs": 600000,
    "permissionMode": "acceptEdits"
  },
  "trials": 3,
  "concurrency": 2,
  "gradeTimeoutMs": 300000,
  "judgeTimeoutMs": 120000,
  "budget": { "maxRuns": 80, "maxUsd": 15 },
  "alpha": 0.05
}
```

Rules files are auto-detected: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
`GEMINI.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.claude/rules/*`, and
`.github/copilot-instructions.md`. Override with `--rules <path>`.

Trials happen in disposable worktrees, so `"permissionMode": "bypassPermissions"`
is defensible here and is often what an unattended task needs in order to run
your test suite.

## Related

- [unasked](https://github.com/furkanyesildag/unasked) — same author. Tells you
  which parts of an agent's diff were out of scope. `deadrules` asks whether
  your instructions work; `unasked` asks whether the output does.

## License

MIT
