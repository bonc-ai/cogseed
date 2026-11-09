/**
 * Quality validator — public API.
 *
 * Two entry levels:
 *   - File-level: `validateSkillFile({ relpath, content })` — used at the
 *     `<<<skill-file>>>` write chokepoint, called per file as the LLM emits
 *     blocks.
 *   - Dir-level: `validateSkillDir(dir)` / `validateAgentDir(dir)` — used at
 *     marketplace install, where a full spec lands at once and the
 *     frontmatter + scripts all need scanning together.
 *
 * Always-stateless: no FS reads outside the explicit `validateXDir(dir)`
 * helpers; no LLM calls; no UI side effects. Persistence is a separate
 * `report.ts` concern called by the integration points after validation.
 *
 * Outer modules must only import from this file (`PC/src/main/quality`),
 * never from `quality/rules/*` or `quality/types.ts` directly — the rule set
 * is implementation detail and should be re-organizable without breaking
 * callers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { Violation, ValidationReport, ScanKind, VALIDATOR_VERSION } from './types';
import {
  scanRedFlags,
  extractExecutableBlocks,
} from './rules/red-flags';
import {
  validateSkillFrontmatter,
  validateSkillMeta,
  validateAgentJsonShape,
  parseFailureViolation,
  skillMetaParseViolation,
} from './rules/schema';
import {
  scanAgentRunnerContract,
  scanSkillRunnerContract,
} from './rules/skill-runner';
import {
  validateSkillShape,
  validateSkillRuntimeGuards,
} from './rules/skill-shape';

// Re-export the types so callers only need one import path.
export type { Violation, ValidationReport, Level } from './types';
export { VALIDATOR_VERSION } from './types';

// ── File-level skill validation ─────────────────────────────────────────

/**
 * Validate a single skill file as it's about to be written.
 * Use this at the `writeCustomSkillFile` chokepoint.
 */
export function validateSkillFile(args: {
  relpath: string;
  content: string;
}): ValidationReport {
  const violations: Violation[] = [];
  const kind = detectSkillFileKind(args.relpath);

  if (kind === 'skill_md') {
    violations.push(..._scanSkillMd(args.content, args.relpath));
  } else if (kind === 'skill_meta') {
    violations.push(..._scanSkillMeta(args.content));
  } else if (kind === 'script') {
    violations.push(...scanRedFlags({
      content: args.content,
      kind: 'script',
      field: args.relpath,
      relpath: args.relpath,
    }));
  }
  // kind === 'other' (README / assets) → no scan

  return _finalize(violations);
}

// ── Dir-level skill validation ──────────────────────────────────────────

/**
 * Validate an on-disk skill directory. Iterates every file the validator
 * recognizes (SKILL.md + scripts) and aggregates findings.
 *
 * EXTREME if SKILL.md is missing or unparseable. Note that a structural
 * failure does NOT skip the red-flag scan of scripts: a missing or malformed
 * SKILL.md must not become a way to smuggle an unscanned payload past the
 * gate. Structure and content are independent checks, and the content scan
 * runs regardless of whether the structure check passed.
 */
export function validateSkillDir(
  skillDir: string,
  options: { enforceSkillRunner?: boolean } = {},
): ValidationReport {
  const violations: Violation[] = [];
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const hasSkillMd = fs.existsSync(skillMdPath);

  if (!hasSkillMd) {
    violations.push({
      level: 'EXTREME',
      rule: 'skill_md_missing',
      field: 'SKILL.md',
      snippet: '',
      suggested_fix: 'Every skill directory must contain a SKILL.md file.',
    });
    // Deliberately does not return: scripts are still scanned below.
  } else {
    try {
      const content = fs.readFileSync(skillMdPath, 'utf8');
      const { meta, metaViolations } = _readSkillMeta(skillDir);
      violations.push(...metaViolations);
      violations.push(..._scanSkillMd(
        content,
        'SKILL.md',
        meta,
        options.enforceSkillRunner !== false,
      ));
      violations.push(...validateSkillMeta(meta));
      violations.push(..._scanSkillShape(skillDir, content, meta));
    } catch (err) {
      violations.push(parseFailureViolation({
        kind: 'frontmatter',
        message: (err as Error).message,
      }));
      // Also does not return — an unreadable SKILL.md must not suppress the
      // script scan below. develop's version returned here; keeping the early
      // return would let a skill hide a payload in scripts/ behind a malformed
      // SKILL.md, which is the hole 46cfa1e closed.
    }
  }

  // Walk all other recognized files (scripts).
  for (const rel of _walkFiles(skillDir, '')) {
    if (rel.toUpperCase() === 'SKILL.MD') continue;
    if (rel === '_meta.json') continue;
    const kind = detectSkillFileKind(rel);
    if (kind !== 'script') continue;
    try {
      const content = fs.readFileSync(path.join(skillDir, rel), 'utf8');
      violations.push(...scanRedFlags({ content, kind: 'script', field: rel, relpath: rel }));
    } catch {
      // unreadable file (binary / permission) — skip; no violation surfaced
    }
  }

  return _finalize(violations);
}

// ── Agent validation ────────────────────────────────────────────────────

/**
 * Validate an already-parsed agent.json object. Use this when the caller
 * already has the JSON in memory (e.g. marketplace install detail.agent_json).
 */
export function validateAgentSpec(args: {
  agentJson: unknown;
  enforceSkillRunner?: boolean;
}): ValidationReport {
  const violations: Violation[] = [];
  if (!args.agentJson || typeof args.agentJson !== 'object') {
    violations.push(parseFailureViolation({
      kind: 'agent_json',
      message: 'agent.json must be a JSON object',
    }));
    return _finalize(violations);
  }
  const obj = args.agentJson as Record<string, unknown>;
  violations.push(...validateAgentJsonShape(obj));
  if (args.enforceSkillRunner !== false) {
    violations.push(...scanAgentRunnerContract(obj));
  }

  // Scan string fields for red flags (path-style strings in workflow /
  // description fields). Cheap pass over the serialized form keeps the rule
  // application uniform — we don't need per-field traversal at this scope.
  try {
    const serialized = JSON.stringify(obj);
    violations.push(...scanRedFlags({
      content: serialized,
      kind: 'agent_json',
      field: 'agent.json',
    }));
  } catch {
    // unserializable (cyclic) → not worth surfacing here, the shape check
    // above would have already failed on the broken structure
  }

  return _finalize(violations);
}

/**
 * Validate an on-disk agent directory (reads `agent.json` from `<dir>/agent.json`).
 */
export function validateAgentDir(
  agentDir: string,
  options: { enforceSkillRunner?: boolean } = {},
): ValidationReport {
  const file = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(file)) {
    return _finalize([{
      level: 'EXTREME',
      rule: 'agent_json_missing',
      field: 'agent.json',
      snippet: '',
      suggested_fix: 'Agent directory must contain an agent.json spec file.',
    }]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return _finalize([parseFailureViolation({
      kind: 'agent_json',
      message: (err as Error).message,
    })]);
  }
  return validateAgentSpec({
    agentJson: parsed,
    enforceSkillRunner: options.enforceSkillRunner,
  });
}

// ── Internals ───────────────────────────────────────────────────────────

function detectSkillFileKind(relpath: string): ScanKind {
  const norm = relpath.replace(/\\/g, '/');
  if (norm.toUpperCase() === 'SKILL.MD') return 'skill_md';
  if (norm === '_meta.json') return 'skill_meta';
  const ext = path.extname(norm).toLowerCase();
  if (['.py', '.sh', '.bash', '.zsh', '.ts', '.mjs', '.js', '.rb', '.ps1', '.cmd', '.bat'].includes(ext)) {
    return 'script';
  }
  // Anything else (README.md, .json, .yaml, images, …) is skipped.
  return 'other';
}

function _scanSkillMd(
  content: string,
  field: string,
  skillMeta: Record<string, unknown> = {},
  enforceSkillRunner = true,
): Violation[] {
  const violations: Violation[] = [];

  // Frontmatter: parse with a minimal YAML-subset (same shape as
  // `features/skills.ts::parseSkillFrontmatter`). We intentionally don't
  // import that function — quality/ must not depend on features/.
  const { meta, body, parseError } = _splitSkillMd(content);
  if (parseError) {
    violations.push(parseFailureViolation({
      kind: 'frontmatter',
      message: parseError,
    }));
    return violations;
  }
  violations.push(...validateSkillFrontmatter(meta, skillMeta));
  if (enforceSkillRunner) {
    violations.push(...scanSkillRunnerContract({ content, field }));
  }

  // Embedded executable code blocks: scan each for red flags.
  for (const block of extractExecutableBlocks(body)) {
    violations.push(...scanRedFlags({
      content: block.content,
      kind: 'script',  // executable block → treat as script
      field: `${field}:${block.startLine} (\`\`\`${block.lang})`,
      // Inline blocks are first-party regardless of the enclosing path.
      relpath: 'SKILL.md',
    }));
  }

  return violations;
}

function _scanSkillMeta(content: string): Violation[] {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [skillMetaParseViolation('_meta.json must be a JSON object')];
    }
    return validateSkillMeta(parsed as Record<string, unknown>);
  } catch (err) {
    return [skillMetaParseViolation((err as Error).message)];
  }
}

/**
 * Skill shape scan — MEDIUM-level advisory (does not gate writes) so
 * existing marketplace skills without these fields keep importing. Combines
 * the pure shape checks with the runtime_contracts guard check when a
 * schemas.json carrying `runtime_contracts` is present.
 */
function _scanSkillShape(
  skillDir: string,
  skillMd: string,
  meta: Record<string, unknown>,
): Violation[] {
  const files: string[] = [..._walkFiles(skillDir, '')];
  const out: Violation[] = [];
  const { violations, level } = validateSkillShape({ skillMd, meta, files });
  out.push(...violations);

  const schemaRel = files.find((f) => /schemas\.json$/.test(f.replace(/\\/g, '/')));
  if (schemaRel) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(skillDir, schemaRel), 'utf8'));
      out.push(...validateSkillRuntimeGuards(parsed, schemaRel));
    } catch {
      // unreadable / non-JSON schemas.json → skip guard check silently
    }
  }

  // Record the computed tier as an informational violation so persisted
  // reports carry the Level A/B result (level 'LOW' keeps it non-gating).
  if (level) {
    out.push({
      level: 'LOW',
      rule: 'shape_tier',
      field: 'SKILL.md',
      snippet: `Level ${level}`,
      suggested_fix: `Skill shape reaches Level ${level}. Fill the author-owned files to reach Level B; C (release) is governance work.`,
    });
  }
  return out;
}

function _readSkillMeta(skillDir: string): { meta: Record<string, unknown>; metaViolations: Violation[] } {
  const file = path.join(skillDir, '_meta.json');
  if (!fs.existsSync(file)) return { meta: {}, metaViolations: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        meta: {},
        metaViolations: [skillMetaParseViolation('_meta.json must be a JSON object')],
      };
    }
    return { meta: parsed as Record<string, unknown>, metaViolations: [] };
  } catch (err) {
    return {
      meta: {},
      metaViolations: [skillMetaParseViolation((err as Error).message)],
    };
  }
}

interface SplitResult { meta: Record<string, string>; body: string; parseError?: string }

function _splitSkillMd(text: string): SplitResult {
  if (!text.startsWith('---')) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf('---', 3);
  if (end === -1) {
    return { meta: {}, body: text, parseError: 'unterminated frontmatter (missing closing ---)' };
  }
  const fm = text.slice(3, end);
  const body = text.slice(end + 3);
  const meta: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    if (!line || !line.trim() || line.startsWith('#')) continue;
    if (/^\s/.test(line) || line.trim().startsWith('-')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (!key || !raw) continue;
    meta[key] = _unquote(raw);
  }
  return { meta, body };
}

function _unquote(raw: string): string {
  if (raw[0] === '"' && raw[raw.length - 1] === '"' && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\(.)/g, (_, ch) => {
      if (ch === 'n') return '\n';
      if (ch === 't') return '\t';
      if (ch === 'r') return '\r';
      return ch;
    });
  }
  if (raw[0] === "'" && raw[raw.length - 1] === "'" && raw.length >= 2) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function* _walkFiles(root: string, rel: string): Generator<string> {
  const dir = rel ? path.join(root, rel) : root;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules' || e.name === '__pycache__') continue;
    if (e.name === '_install.json' || e.name === '_cache.json') continue;
    const subRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      yield* _walkFiles(root, subRel);
    } else if (e.isFile()) {
      yield subRel;
    }
  }
}

function _finalize(violations: Violation[]): ValidationReport {
  const hasExtreme = violations.some((v) => v.level === 'EXTREME');
  return {
    ok: !hasExtreme,
    violations,
    validated_at: new Date().toISOString(),
    validator_version: VALIDATOR_VERSION,
  };
}

// ── Verdict interpretation ──────────────────────────────────────────────

/**
 * Does this violation refuse an install/marketplace admission?
 *
 * Reads through the context demotion (`original_level`) because a `tests/` or
 * `vendor/` path is a place a payload can still run from — the effective level is
 * the right answer for "how loudly do we report this", the pre-demotion level for
 * "may this install".
 *
 * With one exception, and it is positional rather than locational: a hit inside a
 * **comment or docstring** cannot execute. Recovering its pre-demotion level does
 * not close a hole; it re-opens the false positive the demotion existed to fix.
 *
 * Verified on our own product content: `seo-crawl`'s SSRF guard names
 * `169.254.169.254` in a comment and a docstring *because it rejects it*. The
 * validator demoted it correctly, the old predicate promoted it back to EXTREME,
 * and 1 of 83 official skills could not be imported or edited (red-team F-13).
 *
 * `test` context needs one more thing, and it is the other half of that same
 * finding: **corroboration**. Reading through the demotion is what stops a
 * payload from simply moving into `tests/`, so it cannot be dropped wholesale —
 * but a lone indicator there is usually the opposite of a payload. `seo-crawl`
 * names the metadata address inside a negative assertion
 * (`assertFalse(is_safe_ip("169.254.169.254"))`) to prove it is *rejected*; the
 * demotion was right, the read-through turned it into a second EXTREME, and
 * import broke again (retest 2026-11-05, N-04).
 *
 * The measured separator is how many distinct escalating rules the report holds:
 *
 *   * `seo-crawl`                     1 rule  (`no_cloud_metadata_access`)
 *   * `tests/t.sh` with a real payload 2 rules (`no_credential_path_read`
 *                                              + `no_exfiltration_of_local_files`)
 *
 * A lone indicator is descriptive; two independent rules firing together is the
 * composition that has no benign reading. Mirrors `scan_gate.py`'s
 * instruction-corroboration rule rather than inventing a new policy.
 *
 * The default keeps the strict answer for a single-violation caller with no
 * report context — failing closed is the right default for a gate, and the
 * refinement belongs to the one function that can actually count. This lives
 * here, as one function, because the same expression had been copied into six
 * call sites and only some of them were gates. A copy that disagrees with this
 * one is how the same skill gets admitted by one door and refused by another.
 */
export function isInstallBlockingViolation(
  violation: Violation,
  /** Distinct escalating rules in the same report (this one included). */
  escalatingRuleCount: number = Number.POSITIVE_INFINITY,
): boolean {
  if (violation.context === 'comment') return false;
  if ((violation.original_level || violation.level) !== 'EXTREME') return false;
  if (violation.context !== 'test') return true;
  return escalatingRuleCount >= TEST_CORROBORATION_RULES;
}

/**
 * Distinct escalating rules a `test`-context hit needs before it may gate.
 *
 * Two means "one other rule corroborates it". Raising it would let a real
 * composition hide behind a short report; lowering it to 1 is the F-13/N-04
 * regression.
 */
const TEST_CORROBORATION_RULES = 2;

/** Every violation that should refuse an install, in report order. */
export function installBlockingViolations(report: ValidationReport): Violation[] {
  const escalatingRules = new Set(
    report.violations
      // Comment hits are excluded from the count as well as from the verdict: a
      // docstring naming an address cannot corroborate a test-file finding when
      // it could not block on its own.
      .filter((v) => v.context !== 'comment')
      .filter((v) => (v.original_level || v.level) === 'EXTREME')
      .map((v) => v.rule),
  );
  return report.violations.filter((v) => isInstallBlockingViolation(v, escalatingRules.size));
}
