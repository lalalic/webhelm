# WebHelm Skill capability evals

These cases test the **agent's decisions**, not the underlying Chrome Runtime.
They derive from the capability tree: select Session vs Platform Action, initialize
or recover Chrome, manage Session ownership and failures, extend sites through
the Actions guide, and avoid unauthorized external writes.

Each case has a user goal, expected route, essential commands/references,
forbidden commands, and authorization expectation. The eval runner passes the
current SKILL.md and task to an independently authenticated Codex harness,
requests structured JSON, and checks deterministic assertions. This is a
read-only simulation: no website is contacted and no WebHelm Session is opened.

Run one case or all cases (Codex login required):

```sh
node test/skill/evals/run.mjs --list
node test/skill/evals/run.mjs --case=inspect-signed-in-tab
node test/skill/evals/run.mjs
```

For other harnesses, use the same `cases.json` and `decision.schema.json` with
a separately implemented runner; do not assume a CLI binary is an API provider.
The regular `npm test` checks schema/fixtures and the executable lifecycle
example, not LLM behavior. Report the two suites separately. When a case fails,
classify skill ambiguity, evaluator assumptions, incorrect expected route, or
model failure before changing prompt text.
