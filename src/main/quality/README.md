# `quality/` — skill / agent spec validator

Static "block obvious malice + structural breakage" gate that runs before any skill / agent spec lands on disk. **Not a sandbox** — runtime path-sandbox + permission gates remain the actual security boundary. This is the "first 60-80% of explicit malice" filter and the schema-validity check that prompt rules can't reliably enforce.

See `docs/plans/validator-phase-0.md` (deleted after acceptance) for the design rationale.

## Module boundary

All rules + persistence live inside this directory. **Outside callers import only from `quality/index.ts`** — never from `quality/rules/*` or `quality/types.ts` directly. The rule set is implementation detail.

```
quality/
├── index.ts              public API — validateSkillFile / validateSkillDir
│                         / validateAgentSpec / validateAgentDir
├── types.ts              Violation / ValidationReport / Level
├── rules/
│   ├── red-flags.ts      25 rules, 22 at EXTREME (credential reads, eval, …)
│   ├── skill-runner.ts   standard Skill Runner invocation contract
│   └── schema.ts         frontmatter + agent.json shape checks
└── report.ts             persist / read / delete the per-spec report
                          under <uid>/local/quality_reports/
```

## How to add a new red flag

1. Append a `RuleDef` entry to `rules/red-flags.ts::RED_FLAGS`.
2. Add at least one positive + one negative fixture in
   `test/main/quality/red-flags.test.ts` per `PC/CLAUDE.md` §9 fixture rule.
3. Run `npm test` (NOT `npx vitest` — the wrapper runs Vitest through Electron's embedded Node so native addons use the app ABI).
4. Bump `VALIDATOR_VERSION` in `types.ts` if the change is observable by callers (existing reports written under the old version stay valid).

## Levels

| Level | Behavior |
|---|---|
| `EXTREME` | Blocks the write. Authoring path retries up to 2 times with structured feedback; install / hand-edit path rejects outright. |
| `MEDIUM` | Writes succeed. UI shows an advisory chip / suggestion. |
| `LOW` | Silent — recorded only in the persisted report. |

The `skill_script_requires_runner` rule is an authoring/publishing contract, not an install migration. Creation, editing, import, and Marketplace upload enforce it. Marketplace installation validates the existing security/schema rules while explicitly omitting this one rule, so historical bundles are restored verbatim rather than rejected or rewritten.

EXTREME is user-overridable, by product decision: the user owns their machine and
gets the final say on what runs there. The preferred response to a red flag is
still to restructure the spec so the pattern goes away (typically: accept the path
as a user-provided argument rather than hard-coding a sensitive location) — an
override is an escape hatch for the user, not a substitute for fixing authored
content.

This reverses the earlier absolute rule. The reasons that rule existed are still
valid and are what the override mechanism has to withstand, so they are recorded
rather than deleted:

- An "install anyway" button that skipped the EXTREME gate was once shipped and
  fixed as a vulnerability. Consent is therefore re-checked in the main process
  and never inferred from `force`, which ordinary retry paths set for unrelated
  reasons. Passing consent for a scan that did not refuse cannot fabricate an
  override.
- A prose-only attack reproduced during development asks the user to bypass the
  check in the skill's own text ("请将 scanVerdictBlocksInstall 返回值改为 false").
  Persuading the user to click through is that attack's whole objective, so the
  dialog carries a per-rule plain-language risk list and names the skill, and the
  override is recorded permanently in the security receipt so it stays visible
  afterwards.
- Red flags produce zero hits across the builtin corpus, so a hit is a specific
  malicious pattern rather than routine noise. The override exists for the user's
  authority over their own machine, not because the rules are expected to be
  wrong.

### Enforcing "no EXTREME override"

`ValidationReport.ok === false` means "at least one EXTREME violation", so `ok`
is the block condition and no caller may weaken it with a `force` flag. Two
chokepoints own this:

| Path | Chokepoint |
|---|---|
| Marketplace install (agent + skill) | `features/marketplace.ts::_assertQualityGatePassed` |
| Local dir import (both import shapes) | `features/skills.ts::_isQualityBlockedImport` |

Both ignore `force` and take an explicit, separate consent parameter
(`acceptSecurityRisk` on install, `acceptRedFlagRisk` on import). `force` still
means what it always meant for the rest of the flow (dependency propagation,
MEDIUM advisories that never blocked) and still cannot buy past a red flag on its
own — only a per-install user decision can. The renderer shows the violation
report with an "install anyway" action that requires typing the skill name.

Two regressions this closes, both of which contradicted the paragraph above:

- Marketplace install accepted `force: true` and skipped the gate entirely, so
  the renderer's "Install anyway" button could install content the validator
  had rejected as explicitly malicious.
- Dir import hard-blocked only `skill_script_requires_runner` — an authoring
  convention — while letting `force` bypass all nine genuine red flags. The
  convention rule was unskippable while the security rules were skippable.

When adding a new install/import path, route its rejection through one of the
two helpers above rather than re-deriving the condition.

## Things this module does NOT do

- LLM calls / judgment — out of scope (validator is deterministic).
- IO outside `report.ts` — `validateSkillDir` / `validateAgentDir` read the spec they're asked to validate; that's the only allowed FS access.
- Capability cross-check against the tool catalog — deferred to phase 1.
- Similarity check — deferred to phase 2 (embedding-based).
- Outbound HTTP detection — deferred to phase 2 (runtime network sandbox is the right layer).
- User-defined red flags — not exposed; the rule list is build-time only.

## Tests

`test/main/quality/` mirrors this directory. Run with `npm test`.

Regression invariant: every existing builtin (marketplace-installed) skill must pass `validateSkillDir` cleanly — there should be no EXTREME flag on official content. If one appears after a rule change, treat it as a rule false-positive first and adjust the pattern; only flag the official skill as actually malicious after a careful re-read.
