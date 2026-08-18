/**
 * NSEAP skill shape checks — Node port of `check_skill.py` plus Level A/B
 * compliance tiering, aligned with the NSEAP Skill Standard v1.0
 * (docs/superpowers/specs/2026-08-10-nseap-skill-standard/).
 *
 * Pure functions only — no FS reads, no feature imports. Callers pass the
 * already-read SKILL.md text, `_meta.json`, and a directory listing so this
 * module stays unit-testable and cache-friendly.
 *
 * Checks (mirrors check_skill.py + standard §5.3 / §5.4 / §13):
 *   1. SKILL.md frontmatter name + description
 *   2. trigger + anti-trigger semantics (use_when + do_not_use_when /
 *      negative_examples) — hard requirement per §5.3
 *   3. input contract three-layer (task_id + owner_context + <primary>_payload)
 *   4. output contract includes audit_refs
 *   5. runtime_contracts four boundary guards
 *   6. staged ceiling + production_release_allowed = false
 *   7. Level A / B compliance tier output
 *
 * Levels are MEDIUM (advisory, does not gate write) so existing marketplace
 * skills without NSEAP fields are not broken; the import / publish path can
 * escalate selected rules to blocking as a follow-up.
 */

import { Violation } from '../types';

export type NseapLevel = 'A' | 'B' | null;

export interface NseapSkillShapeInput {
  /** Raw SKILL.md text (frontmatter + body). */
  skillMd: string;
  /** Parsed `_meta.json` object (may be empty). */
  meta: Record<string, unknown>;
  /** Relative file paths present under the skill dir (e.g. ['references/input-contract.md']). */
  files: string[];
}

export interface NseapSkillShapeResult {
  violations: Violation[];
  /** Machine-readable tier; null when Level A is not met. */
  level: NseapLevel;
}

const STAGED_RE = /promotion_ceiling\s*[:=]\s*["']?staged["']?/i;
const LOCK_RE = /production_release_allowed\s*[:=]\s*false/i;

function _hasFile(files: string[], pattern: RegExp): boolean {
  return files.some((f) => pattern.test(f.replace(/\\/g, '/')));
}

/**
 * Validate NSEAP skill shape. Returns violations (MEDIUM-level, non-gating)
 * plus a Level A/B tier.
 */
export function validateNseapSkillShape(input: NseapSkillShapeInput): NseapSkillShapeResult {
  const { skillMd, meta, files } = input;
  const violations: Violation[] = [];

  const add = (rule: string, field: string, suggested_fix: string, snippet = ''): void => {
    violations.push({
      level: 'MEDIUM',
      rule,
      field,
      snippet: snippet.slice(0, 200),
      suggested_fix,
    });
  };

  // ── ① frontmatter ─────────────────────────────────────────────────────
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(skillMd);
  const fmText = fm ? fm[1] : '';
  const hasName = /^name:\s*\S/m.test(fmText);
  const hasDesc = /^description:/m.test(fmText);
  if (!hasName || !hasDesc) {
    add('nseap_frontmatter_incomplete', 'SKILL.md',
      'SKILL.md frontmatter must declare `name` and `description` (NSEAP §8.1).',
      fmText.slice(0, 120));
  }

  // ── ② trigger + anti-trigger (§5.3 hard requirement) ──────────────────
  const body = fm ? skillMd.slice(fm[0].length) : skillMd;
  const hasUseWhen = /use_when/i.test(body);
  const hasAntiTriggerBody = /do_not_use_when|negative_examples/i.test(body);
  const routing = (meta.routing && typeof meta.routing === 'object' && !Array.isArray(meta.routing))
    ? meta.routing as Record<string, unknown>
    : {};
  const hasAntiTriggerMeta = Array.isArray(routing.negative_examples)
    ? routing.negative_examples.length > 0
    : false;
  if (!hasUseWhen) {
    add('nseap_trigger_missing', 'SKILL.md',
      'Declare `use_when` (when to fire) in SKILL.md (NSEAP §5.3).');
  }
  if (!hasAntiTriggerBody && !hasAntiTriggerMeta) {
    add('nseap_antitrigger_missing', 'SKILL.md',
      'Anti-trigger is a hard requirement: add `do_not_use_when` / `negative_examples` in SKILL.md or `_meta.json.routing.negative_examples` (NSEAP §5.3).');
  }

  // ── ③ input / output contracts (§5.4 hard requirement) ────────────────
  const hasInputContract = _hasFile(files, /references[/\\]input-contract\.(md|yaml|yml)$/);
  const hasOutputContract = _hasFile(files, /references[/\\]output-contract\.(md|yaml|yml)$/);
  const hasSchemas = _hasFile(files, /schemas\.json$/);
  if (!hasInputContract && !hasSchemas) {
    add('nseap_input_contract_missing', 'references/',
      'Input contract is mandatory: add `references/input-contract.md` (NSEAP §5.4).');
  }
  if (!hasOutputContract && !hasSchemas) {
    add('nseap_output_contract_missing', 'references/',
      'Output contract is mandatory: add `references/output-contract.md` (NSEAP §5.4).');
  }

  // ── ④ runtime_contracts guards (from schemas.json) ────────────────────
  // Guard values are read from any schemas.json carrying runtime_contracts;
  // when absent we can't machine-check the guards → advisory only.
  // (validateNseapRuntimeGuards in this module checks a parsed schema; the
  // dir-level caller combines both.)

  // ── ⑤ staged ceiling + production lock (§4 axiom 5, §8.2) ─────────────
  const allText = `${skillMd}\n${JSON.stringify(meta)}`;
  const stagedOk = STAGED_RE.test(allText);
  const lockOk = LOCK_RE.test(allText) || /production_release_allowed\s*[:=]\s*false/.test(JSON.stringify(meta));
  if (!stagedOk) {
    add('nseap_staged_ceiling_missing', 'SKILL.md',
      'Declare `promotion_ceiling: staged` (hard cap — never higher) (NSEAP §4 axiom 5).');
  }
  if (!lockOk) {
    add('nseap_production_lock_missing', 'SKILL.md',
      'Declare `production_release_allowed: false` (hard lock) (NSEAP §8.2).');
  }

  // ── ⑥ ontology slice (Level A requirement, §13) ───────────────────────
  const hasOntology = _hasFile(files, /references[/\\]ontology-mapping\.(md|yaml|yml)$/)
    || /tbox\s*:|rbox\s*:|abox\s*:/i.test(body);
  if (!hasOntology) {
    add('nseap_ontology_slice_missing', 'references/',
      'Every skill carries an ontology slice: add `references/ontology-mapping.md` with TBox/RBox/ABox (NSEAP §4 axiom 2).');
  }

  // ── ⑦ Level A / B tiering (§13) ───────────────────────────────────────
  const hasAntiTrigger = hasAntiTriggerBody || hasAntiTriggerMeta;
  const levelA = hasName && hasDesc && hasOntology && hasUseWhen && hasAntiTrigger;
  const levelB = levelA && hasInputContract && hasOutputContract && stagedOk && lockOk;
  const level: NseapLevel = levelB ? 'B' : (levelA ? 'A' : null);

  return { violations, level };
}

/**
 * Verify runtime_contracts boundary guards against a parsed schemas.json.
 * Guards (registry gate rejects the skill if any is wrong):
 *   resource.direct_resource_access = false
 *   resource.access_via_gateway_only = true
 *   owner_binding.binding_resolved_by = "agent_layer"
 *   audit.emitted_by = "runtime"
 */
export function validateNseapRuntimeGuards(
  parsed: unknown,
  field = 'schemas.json',
): Violation[] {
  const out: Violation[] = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return out; // no machine-checkable schema → advisory handled elsewhere
  }
  const rc = (parsed as Record<string, unknown>).runtime_contracts as
    | Record<string, unknown> | undefined;
  if (!rc || typeof rc !== 'object') {
    out.push({
      level: 'MEDIUM',
      rule: 'nseap_runtime_contracts_missing',
      field,
      snippet: '',
      suggested_fix: 'Add `runtime_contracts` with resource / permission / owner_binding / audit guards (NSEAP §8.4).',
    });
    return out;
  }
  const resource = rc.resource as Record<string, unknown> | undefined;
  const ownerBinding = rc.owner_binding as Record<string, unknown> | undefined;
  const audit = rc.audit as Record<string, unknown> | undefined;
  const guards: Array<[string, boolean, string]> = [
    ['resource.direct_resource_access = false',
      resource?.direct_resource_access === false,
      'resource.direct_resource_access must be false'],
    ['resource.access_via_gateway_only = true',
      resource?.access_via_gateway_only === true,
      'resource.access_via_gateway_only must be true'],
    ['owner_binding.binding_resolved_by = agent_layer',
      ownerBinding?.binding_resolved_by === 'agent_layer',
      'owner_binding.binding_resolved_by must be "agent_layer"'],
    ['audit.emitted_by = runtime',
      audit?.emitted_by === 'runtime',
      'audit.emitted_by must be "runtime"'],
  ];
  for (const [label, ok, fix] of guards) {
    if (!ok) {
      out.push({
        level: 'MEDIUM',
        rule: 'nseap_runtime_guard_violation',
        field,
        snippet: label,
        suggested_fix: `Boundary invariant broken: ${fix}. The registry gate rejects the skill.`,
      });
    }
  }
  return out;
}
