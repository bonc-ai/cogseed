/**
 * Quality validator — shared types.
 *
 * No dependencies on storage / paths / features. Pure data shapes.
 */

export type Level = 'EXTREME' | 'MEDIUM' | 'LOW';

export interface Violation {
  level: Level;
  /** Stable rule id, e.g. "no_credential_path_read" — used by the LLM retry
   *  feedback loop and by the persisted report. */
  rule: string;
  /** Where the violation was found. Format: "<relpath>" or "<relpath>:<line>"
   *  for file-scoped findings; "frontmatter:<key>" for SKILL.md frontmatter;
   *  "agent.json:<jsonPath>" for agent specs. */
  field: string;
  /** Quoted excerpt of the offending content. Trimmed to ≤ 200 chars to keep
   *  the report compact and the LLM feedback JSON cache-friendly. */
  snippet: string;
  /** One-line repair guidance — written for the LLM author + human reader. */
  suggested_fix: string;
  /**
   * Level this rule would have reported in first-party source. Present only
   * when file context lowered the level, so a reviewer can see what was
   * downgraded rather than the downgrade being invisible.
   */
  original_level?: Level;
  /** Where the match was found: first-party source, test, vendor, generated. */
  context?: 'source' | 'test' | 'vendor' | 'generated' | 'comment';
}

export interface ValidationReport {
  /** True iff no EXTREME violation. MEDIUM / LOW do not gate write. */
  ok: boolean;
  violations: Violation[];
  /** ISO timestamp of the validation pass. */
  validated_at: string;
  validator_version: string;
}

/** What kind of artifact is being scanned. Determines which red-flag patterns
 *  apply (a Python script gets pattern set A, a SKILL.md body gets set B's
 *  embedded code-block extraction first, etc.). */
export type ScanKind =
  | 'skill_md'      // SKILL.md (frontmatter + embedded code blocks)
  | 'skill_meta'    // CogSeed _meta.json sidecar
  | 'script'        // executable file under scripts/ (.py / .sh / .ts / ...)
  | 'agent_json'    // agent.json spec
  | 'other';        // README / assets — skipped

export interface RuleDef {
  id: string;
  level: Level;
  /** File kinds this rule applies to. Empty = applies to all scannable kinds
   *  (excluding 'other'). */
  appliesTo: ScanKind[];
  pattern: RegExp;
  suggested_fix: string;
  /**
   * When true, file context never lowers this rule's level. For findings whose
   * meaning is location-independent: a real credential committed in a test
   * fixture is still a real credential.
   */
  neverDemote?: boolean;
  /**
   * When true, a match inside a comment or docstring is demoted.
   *
   * For rules whose patterns name things a *defensive* implementation must
   * legitimately mention — an SSRF guard has to name the metadata address it
   * blocks, and its docstring explains the attack. Only set this where the
   * literal is descriptive; where the literal is itself the payload (a
   * hardcoded credential, say), a comment is not mitigating.
   */
  demoteInComments?: boolean;
  /**
   * Languages this rule applies to. Omitted = language-agnostic.
   *
   * Prevents applying a language's semantics to another's syntax: JavaScript's
   * `re.exec()` is a regex call, not Python's dynamic `exec()`. Narrowing this
   * corrects a misapplied rule rather than weakening detection.
   */
  langs?: Array<'python' | 'javascript' | 'shell' | 'ruby' | 'powershell'>;
}

/** Bumped on every rule list change so persisted reports record the schema
 *  they were produced under. Loosely follows the validator module version.
 *
 *  0.6.1 — `skill_meta_category_missing` MEDIUM → LOW. Bumping invalidates every
 *  stored receipt, so each skill is rescanned on next load and picks up both the
 *  new level and the `topLevel` field added alongside it. That rescan is the
 *  intended mechanism, not a side effect. */
export const VALIDATOR_VERSION = '0.6.1';
