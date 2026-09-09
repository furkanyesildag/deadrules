<h1 align="center">deadrules</h1>

<p align="center">
  <strong>You have 40 rules in your CLAUDE.md. How many of them does the agent obey?</strong><br>
  <code>deadrules</code> removes each one, runs real tasks, and measures which rules changed the outcome.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/deadrules"><img alt="npm" src="https://img.shields.io/npm/v/deadrules.svg"></a>
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

## What it looks like

```
  deadrules

  rules    CLAUDE.md · 39 rules
  tasks    12
  agent    claude (haiku-4.5) · 3 trials per variant
  spent    288 runs · $6.42

  DOES THE FILE MATTER?
  all rules   ##############......   72% (26/36)  95% CI 56%-84%
  no rules    ##########..........   50% (18/36)  95% CI 34%-66%
              p=0.090  no measurable difference with or without the file

  LOAD-BEARING  removing this rule made the agent worse
    id    removed
    R07   -39pp  q=0.004     Always add a test alongside a behaviour change.
    R22   -28pp  q=0.031     Never edit files under `generated/` — they come from …

  HARMFUL       removing this rule made the agent better
    id    removed
    R31   +22pp  q=0.022     Think step by step before writing any code.

  NO EVIDENCE   8 rules changed nothing that was measured
    R01 R02 R03 R04 R05 R11 R12 R13
    0 tested alone, 8 in groups
    --all to list them

  UNTESTED      2 rules · budget ran out
    R38 R39

  ────────────────────────────────────────────────────────────────────────────
  2 load-bearing · 1 harmful · 8 no evidence · 2 untested
  "No evidence" is not "no effect": at 36 trials this run could only
  detect a swing of about 33pp or larger. Raise trials to shrink that.
```

The **HARMFUL** section is usually the surprising one.

## Install

```sh
npm install -g deadrules
```

Or run it without installing:

```sh
npx deadrules rules
```

## Start here — it is free

`deadrules rules` makes no agent calls and costs nothing. It parses your rules
files and shows you what is actually in them:

```
$ deadrules rules

  CLAUDE.md / Build and test
    R01  Run `npm test` before claiming anything works.
    R02  Never edit files under `dist/`.
  CLAUDE.md / Style
    R03  Write comments that explain why, not what.
    ...

  39 rules across 1 file(s).
```

Most people are surprised by the count.

## Measuring

```sh
deadrules init      # write a config, mine draft tasks from your git history
deadrules ablate    # remove each rule, measure, report
```

`init` turns recent commits into tasks. A commit is a task whose accepted
answer is already in your repo, which is why mining beats writing tasks by
hand — but the prompts are commit subjects written for people who had the
surrounding context, so **read them before you trust any number they produce**.
A task looks like this:

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

Graders available: `run` (any shell command, pass on exit 0), `file-contains`,
`file-absent`, `no-new-pattern` (matched against added diff lines only),
`diff-files-max`, `touched`.

## Did my last edit help?

```sh
deadrules diff HEAD~1        # the rules as they were, against the rules now
deadrules diff main          # your branch's changes to CLAUDE.md
```

Same machinery, two variants instead of forty. This is the one to put in CI on
pull requests that touch `CLAUDE.md`.

## How it works

**One variable.** Each trial runs in a throwaway `git worktree` checked out at
the task's base commit, with exactly one thing different: the rules file. Your
working tree is never touched, and trials run in parallel without colliding.

**Bisection, not brute force.** Testing 40 rules one at a time costs 40 sweeps.
Instead `deadrules` removes groups and only splits the ones that moved the
needle — a group that changes nothing when removed wholesale contains no rule
that changes anything on its own. On a 16-rule fixture with one load-bearing
rule, the search finds it in 50 agent runs where the exhaustive sweep needs 90.

**Statistics that admit their limits.** Pass rates are compared with a
two-tailed Fisher exact test, because at these sample sizes the normal
approximation means nothing. Intervals are Wilson score intervals. Testing 40
rules is 40 simultaneous hypotheses, so p-values are corrected with
Benjamini-Hochberg and reported as q-values. Every report ends with the
smallest effect the run could have detected.

The tool never says a rule has no effect. It says there is no evidence of one,
and tells you how hard it looked.

## What it costs

One "sweep" is `tasks × trials` agent runs. The defaults (12 tasks, 3 trials)
make a sweep 36 runs, and a full ablation of a 40-rule file needs roughly
10–12 sweeps.

Keep it cheap:

- Use a small fast model. `claude-haiku-4-5-20251001` is the default for a reason.
- Start with `--budget-runs 60` and a handful of tasks.
- Everything is written to `.deadrules/runs/ledger.jsonl` as it completes, so
  `--resume` picks up where an interrupted run stopped and replays what it
  already paid for, free.

Both caps are hard, checked before each invocation rather than after:

```json
{ "budget": { "maxRuns": 80, "maxUsd": 15 } }
```

## What it cannot tell you

This is a measurement tool, and measurements have edges. The honest list:

- **Interaction effects.** Two rules that cover for each other get removed in
  the same group, the group looks load-bearing, and the bisect blames whichever
  half happened to fail. Rules that only matter together are the known blind
  spot.
- **Your tasks are the whole world.** A rule about writing commit messages will
  read as dead if nothing you measure looks at commit messages. `deadrules`
  measures rules against *your* graders, not against good taste.
- **Agents are not seedable.** A "trial" is a plain repetition. Run-to-run
  variance is real and the confidence intervals are the only defence; three
  trials is enough to notice a large effect and nothing else.
- **A null at this budget is weak.** With 36 trials per arm you can detect a
  30-point swing, not a 5-point one. Deleting every rule the report calls "no
  evidence" is not what the report is telling you to do — it is telling you
  which rules you have no reason to believe in.
- **Model-specific.** Results hold for the model you measured. A rule that is
  dead weight for one model may be load-bearing for a smaller one.

## Other agents

Anything that takes a prompt and edits files in a directory works:

```json
{
  "agent": {
    "kind": "command",
    "cmd": "cursor-agent -p {{prompt}} --force",
    "costUsd": 0.03
  }
}
```

`{{prompt}}`, `{{cwd}}` and `{{model}}` are substituted, shell-quoted. Set
`"promptOnStdin": true` for CLIs that read the prompt from stdin. Whether the
task succeeded is decided by your graders, never by the exit code.

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
