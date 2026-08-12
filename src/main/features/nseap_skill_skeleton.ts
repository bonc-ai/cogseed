/**
 * NSEAP skill skeleton conversion — used on the import-dir path so an
 * imported external skill gets the missing NSEAP artifacts auto-generated
 * as templates (standard appendix A: "defaults are compliant; the author
 * only writes the 5 ★ business files").
 *
 * Pure-ish: reads the target skill dir, writes only the missing files, never
 * overwrites existing content. Templates are inlined here on purpose —
 * platform runtime code must not read `resources/builtin` (AGENTS.md), so
 * the import-time templates live in this module, mirroring the marketplace
 * nseap-skill-creator templates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface NseapSkeletonResult {
  created: string[];
  alreadyPresent: string[];
}

/** Rel paths that must exist for Level B shape (references + evals). */
const NSEAP_ARTIFACTS: Array<{ rel: string; generate: (name: string) => string }> = [
  {
    rel: 'references/input-contract.md',
    generate: (name) => `# Input contract — ${name}\n\n` +
      `The skill input is three-layer: \`task_id\` + \`owner_context\` + \`<primary>_payload\`.\n` +
      `\`owner_context\` values are **injected by the Agent layer at load time** — the skill never\n` +
      `fills owner_id or the real authorization scope.\n\n` +
      `## <primary>_payload\n` +
      `| field | meaning | unit | source |\n` +
      `|---|---|---|---|\n` +
      `| <field_a> | <business meaning> | <unit> | <source> |\n\n` +
      `## owner_context (field-positions only; values injected by Agent layer)\n` +
      `| field | meaning |\n` +
      `|---|---|\n` +
      `| \`owner_id\` | who owns this action (injected) |\n` +
      `| \`role\` | the owner's role, for policy/permission (injected) |\n` +
      `| \`authorization_scope\` | what this owner is allowed to do (injected) |\n\n` +
      `> The skill declares *what it needs*; it does not resolve identity or touch resources\n` +
      `> directly — that is the Agent/Gateway layer's job.\n`,
  },
  {
    rel: 'references/output-contract.md',
    generate: (name) => `# Output contract — ${name}\n\n` +
      `The skill output shape is stable on success and failure:\n\n` +
      `| field | meaning |\n` +
      `|---|---|\n` +
      `| \`actions\` | what was decided / attempted (string list) |\n` +
      `| \`result\` | the primary result value |\n` +
      `| \`trace\` | step trace for replay (string list) |\n` +
      `| \`audit_refs\` | audit ledger references (string list) |\n\n` +
      `\`audit_refs\` is required — the runtime appends audit entries, append-only.\n`,
  },
  {
    rel: 'references/skill-spec.yaml',
    generate: () => `# Identity / level / route. Confirm defaults; only change with reason.\n` +
      `skill_spec:\n` +
      `  standard_id: nseap-skill-creator\n` +
      `  skill_class: execution            # execution | meta_skill (if it makes skills)\n` +
      `  is_skill_of_skill: false\n` +
      `  level: L5                         # Skill-L: L0..L5 (L5 = governed skill system)\n` +
      `  risk_route: Full                  # Lite | Full\n` +
      `  promotion_ceiling: staged         # HARD CAP — never higher than staged\n` +
      `  production_release_allowed: false # HARD LOCK — never true\n` +
      `  session_role: sub_skill           # sub_skill | master_task_skill\n` +
      `  owns_session: false\n` +
      `  form: interpreted                 # interpreted | compiled\n`,
  },
  {
    rel: 'references/ontology-mapping.md',
    generate: (name) => `# Ontology slice — ${name}\n\n` +
      `## TBox (concepts + fields)\n` +
      `- <Entity>: [<field_a>, <field_b>]\n\n` +
      `## RBox (rules, structured: field/op/value + action)\n` +
      `- R1: <field_a> op <value> → <action_or_null>\n\n` +
      `## ABox (instances)\n` +
      `- (empty at authoring time)\n\n` +
      `## source_refs\n` +
      `- materials::<domain>::snapshot\n`,
  },
  {
    rel: 'references/validation-contract.md',
    generate: (name) => `# Validation contract — ${name}\n\n` +
      `## Boundary tests\n` +
      `- B1: <input A> → <expected route/decision>\n` +
      `- B2: <input B> → <expected route/decision>\n\n` +
      `## HITL policy (human-in-the-loop)\n` +
      `- Any \\\`execute\\\` (write) requires \\\`confirm\\\` (HITL) — the workflow gate.\n` +
      `- <high-risk condition> forces human review before execute.\n\n` +
      `## Invariants\n` +
      `- \\\`ΔA gates ΔR\\\`: if the executed action differs from the intended one, the outcome\n` +
      `  signal is distrusted (not used to learn).\n` +
      `- \\\`staged is not production release\\\`: a passing validation is a staged draft.\n`,
  },
  {
    rel: 'references/governance-boundaries.md',
    generate: (name) => `# Governance boundaries — ${name}\n\n` +
      `## Promotion & release caps (HARD)\n` +
      `- \\\`promotion_ceiling: staged\\\` — never higher, no automation may lift it.\n` +
      `- \\\`production_release_allowed: false\\\` — production loading requires an independent\n` +
      `  human release decision, out of this skill's scope.\n\n` +
      `## Non-claims (never violate)\n` +
      `- Does not send / deploy / charge; exposes contract field-positions only.\n` +
      `- Does not resolve identity or access real resources (\\\`binding_resolved_by: agent_layer\\\`).\n` +
      `- Symbolic decides right/wrong; neural only proposes DRAFT wording.\n`,
  },
  {
    rel: 'references/kstar-evolution.md',
    generate: (name) => `# KSTAR evolution hook — ${name}\n\n` +
      `## Loop (declared; real run needs the metaskill engine)\n` +
      `K/S/T → Â/R̂ → A/R → ΔA/ΔR → learning_hypothesis → candidate → bounded patch →\n` +
      `three gates (Validation → Governance → Canary) → K update.\n\n` +
      `## Discipline\n` +
      `- ΔR = R − R̂ is the learning signal; a positive ΔR ≠ a release instruction.\n` +
      `- ΔA gates ΔR: if the executed action ≠ intended (ΔA ≠ 0), distrust ΔR.\n` +
      `- Bounded patch: updates are size-limited and must pass all three gates.\n` +
      `- Symbolic decides right/wrong; neural only proposes DRAFT wording.\n`,
  },
  {
    rel: 'references/eval-cases.yaml',
    generate: (name) => `# Eval cases — ${name} (positive / negative examples)\n\n` +
      `positive:\n` +
      `  - "<real user phrasing 1>"\n` +
      `  - "<real user phrasing 2>"\n` +
      `negative:\n` +
      `  - "<near-miss 1 — must NOT fire>"\n` +
      `  - "<near-miss 2 — must NOT fire>"\n`,
  },
  {
    rel: 'evals/evals.json',
    generate: () => JSON.stringify({
      schema_version: 1,
      cases: [],
      notes: 'Author-owned: fill real business test cases (positive/negative/boundary).',
    }, null, 2) + '\n',
  },
];

function _hasFile(dir: string, rel: string): boolean {
  try { return fs.statSync(path.join(dir, rel)).isFile(); } catch { return false; }
}

/**
 * Ensure the missing NSEAP skeleton artifacts exist under `skillDir`.
 * Only creates missing files — existing content is never touched.
 * Returns the created rel paths.
 */
export function ensureNseapSkillSkeleton(skillDir: string, skillName: string): NseapSkeletonResult {
  const created: string[] = [];
  const alreadyPresent: string[] = [];
  for (const artifact of NSEAP_ARTIFACTS) {
    if (_hasFile(skillDir, artifact.rel)) {
      alreadyPresent.push(artifact.rel);
      continue;
    }
    const dst = path.join(skillDir, artifact.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, artifact.generate(skillName), 'utf8');
    created.push(artifact.rel);
  }
  return { created, alreadyPresent };
}

/**
 * Which NSEAP artifacts are missing from an existing skill dir (no writes).
 * Used by the quality report / import summary to show the gap.
 */
export function listMissingNseapArtifacts(skillDir: string): string[] {
  return NSEAP_ARTIFACTS
    .map((a) => a.rel)
    .filter((rel) => !_hasFile(skillDir, rel));
}
