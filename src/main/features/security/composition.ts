/**
 * Path-level composition risk across the installed skill library.
 *
 * WHY THIS EXISTS (and why it is not another rule)
 * Every shipping skill scanner answers a *node-level* question: "is this one
 * skill dangerous?" That question has a structural blind spot, and the
 * published research names it: composition risk is "a path-level property
 * rather than a node-level property" — skills that each pass individually can
 * compose into a harmful workflow (ColluSkill, arXiv 2608.09732; CompoSkill,
 * arXiv 2608.16246). Both papers observe that per-skill scanners "achieve
 * limited interception", and no shipping scanner has closed the gap.
 *
 * The concrete shape of it: skill A can read a credential file (and is right to
 * — it is a credential manager), skill B can send an HTTP request (and is right
 * to — it is a webhook notifier). Both pass. Enabled in the same conversation,
 * the agent can read a key in A and post it in B, and nothing in either skill's
 * own report says so.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM
 * It does not claim an exploit exists. It reports that a *capability path*
 * exists between enabled skills, which is a statement about the library, not
 * about any one skill's intent. So:
 *
 *  - the severity is capped at `medium` and never blocks an install;
 *  - the output names the participating skills and the capability that links
 *    them, so a human can judge it;
 *  - `coverage` states how many skills were actually analysed, because a
 *    composition verdict over 6 of 60 skills is a partial answer and must not
 *    read as a complete one.
 *
 * Capabilities are derived from findings that already exist, so this layer adds
 * no new detection surface and cannot introduce a new false positive on its
 * own — it can only re-describe two clean reports as one question worth asking.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { userLocalRoot } from '../../paths';
import { readJsonSync, safeId, writeTextAtomicSync } from '../../storage';
import { skillPayloadHash } from '../skill_trust';
import { resolveRulesetVersion } from './sentry-adapter';
import { skillSecurityReport, resolveSkillForScan, type SecurityEvidence } from './security-report';

const log = createLogger('security/composition');

/** What a skill is able to do, as opposed to how risky it is. */
export type Capability =
  | 'read_credentials'
  | 'egress'
  | 'execute'
  | 'persist'
  | 'write_agent_memory'
  | 'ingest_untrusted';

export const CAPABILITY_LABELS: Record<Capability, string> = {
  read_credentials: '读取本地凭据',
  egress: '向外部地址发送数据',
  execute: '执行命令或动态代码',
  persist: '留下持久化改动',
  write_agent_memory: '改写代理身份/记忆文件',
  ingest_untrusted: '接收不可信外部内容',
};

/**
 * Category → capability map.
 *
 * Keyed on category rather than rule id so it does not drift every time a rule
 * is added. The rule id is still carried through into `evidence` so the UI can
 * say *why* a skill was assigned a capability.
 */
const CATEGORY_CAPABILITIES: Record<string, Capability[]> = {
  credential_access: ['read_credentials'],
  secret_file: ['read_credentials'],
  secret: ['read_credentials'],
  data_egress: ['egress'],
  cognitive_asset_exfil: ['egress'],
  network: ['egress'],
  ssrf: ['egress', 'ingest_untrusted'],
  dynamic_exec: ['execute'],
  command_exec: ['execute'],
  reverse_shell: ['execute'],
  deserialization: ['execute'],
  obfuscation: ['execute'],
  unauthorized_download: ['execute', 'ingest_untrusted'],
  destructive: ['persist'],
  destructive_fs: ['persist'],
  persistence: ['persist'],
  install_hook: ['persist', 'execute'],
  mcp_config: ['persist', 'write_agent_memory'],
  structural: [],
  prompt_injection: ['ingest_untrusted'],
  hidden_content: ['ingest_untrusted'],
  agent_instruction: ['ingest_untrusted'],
  system_prompt_extraction: ['ingest_untrusted'],
  supply_chain: [],
  dependency_vuln: [],
  typosquat: [],
  binary_indicator: ['execute'],
  surveillance: ['read_credentials'],
  crypto_miner: ['execute'],
  permission: [],
  privilege: ['execute'],
  sql_injection: [],
  path_traversal: [],
  install_hook_missing: [],
};

/**
 * Severities that count as a capability.
 *
 * `info` never does: `http_url` at info level matches any documented URL, and
 * treating "the README mentions an endpoint" as an egress capability would put
 * every skill in the library into the graph. `low` counts only for
 * capability-relevant categories, where the demotion came from context rather
 * than from uncertainty.
 */
const CAPABILITY_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

/**
 * Contexts whose text **cannot execute**, and therefore cannot confer a behaviour.
 *
 * A capability answers "what can this skill *do*". The engine's own context layer
 * draws exactly this line (`scanner_core/context.py`): `prose` is
 * 「文档散文：仅是文字描述，不可执行」 and `comment` is a source comment line.
 * The main-side red-flag scanner reaches the same conclusion in its header —
 * "Prose in SKILL.md is NOT scanned — false-positive rate is too high
 * ('this skill handles ssh config' ≠ 'reads ssh private keys')". This layer was
 * missing that filter.
 *
 * Measured on a real profile before the guard: our own packaged `agent-creator`
 * and `skill-creator` derived `read_credentials` + `execute` from their
 * **authoring prohibition list** ("do not read `.env`, `~/.ssh`, … keychains,
 * browser cookies" → `browser_data_access`/`credential_path_read`/
 * `cloud_credential_paths`; "do not use `curl | sh`" → `curl_pipe_shell`/
 * `web_content_to_shell`/`remote_code_execution`). All four "high" paths that
 * pass produced on that profile were driven by prose like this, which makes the
 * cross-skill graph report our own documentation rather than our behaviour.
 *
 * An unknown or empty context is treated as executable (fail open): dropping a
 * capability is a silent false negative, and this must not become a way for a
 * missing field to hide a real path.
 */
const NON_EXECUTABLE_CONTEXTS = new Set(['prose', 'comment']);

/**
 * Categories whose finding **is** a piece of agent-directed content.
 *
 * These are the only ones where prose is legitimate evidence, and the engine says
 * so itself: `context.py` states that the imperative rule layer's payload
 * 「只能是散文」 — an instruction to the agent can only ever appear as text. Every
 * other category describes something the skill *does*, and a description of an
 * action is not the action: "do not use `curl | sh`" is not `execute`.
 *
 * The exception is safe only because these categories map to `ingest_untrusted`
 * alone; `test/main/features/security/composition.test.ts` asserts that, so a
 * future mapping cannot quietly turn this into a hole for behaviour capabilities.
 */
const INSTRUCTION_CONTENT_CATEGORIES = new Set([
  'agent_instruction', 'prompt_injection', 'hidden_content', 'system_prompt_extraction',
]);

export interface SkillCapabilities {
  skillId: string;
  capabilities: Capability[];
  /** capability → rule ids that produced it, for an auditable "why". */
  evidence: Partial<Record<Capability, string[]>>;
  score: number | null;
  decision: string;
  /** Where the capability set came from. */
  analyzed: boolean;
  payloadHash?: string;
}

export interface CompositionPath {
  id: 'credential_exfil' | 'durable_execution' | 'untrusted_to_exec' | 'memory_poisoning';
  severity: 'high' | 'medium';
  /** Skill ids on the path, in the order the path traverses them. */
  participants: string[];
  /** The capabilities the path links. */
  capabilities: Capability[];
}

/**
 * The risk paths we look for. Deliberately a short, enumerable list.
 *
 * A graph search over every capability pair would produce a wall of "these two
 * skills could theoretically interact" and carry no information — the same
 * failure mode as a scanner that flags every skill. Each path here names a
 * *complete* harmful outcome; anything that does not complete one is not
 * reported.
 */
const PATHS: Array<{
  id: CompositionPath['id'];
  severity: CompositionPath['severity'];
  /** Capability sets that must all be present somewhere in the library. */
  requires: Capability[];
  /** True when the requirements must be met by *different* skills. */
  distinct: boolean;
}> = [
  {
    // Read a credential in one skill, send it out in another. This is the path
    // that neither skill's own report can see.
    id: 'credential_exfil',
    severity: 'high',
    requires: ['read_credentials', 'egress'],
    distinct: true,
  },
  {
    // Leave something behind that runs again, in a context that can execute.
    id: 'durable_execution',
    severity: 'high',
    requires: ['persist', 'execute'],
    distinct: true,
  },
  {
    // Untrusted content in, code execution out — indirect prompt injection
    // completing into a command.
    id: 'untrusted_to_exec',
    severity: 'medium',
    requires: ['ingest_untrusted', 'execute'],
    distinct: true,
  },
  {
    // Rewrite the agent's own identity/memory while also ingesting external
    // content: the injected text becomes durable instruction.
    id: 'memory_poisoning',
    severity: 'high',
    requires: ['write_agent_memory', 'ingest_untrusted'],
    distinct: true,
  },
];

/** Derive capabilities from a completed detail scan. */
export function deriveCapabilities(evidence: SecurityEvidence): SkillCapabilities {
  const capabilities = new Set<Capability>();
  const evidenceMap: Partial<Record<Capability, string[]>> = {};
  for (const finding of evidence.findings || []) {
    // A suppressed finding is one the user has explicitly accepted; it must not
    // silently keep feeding the composition graph, or revoking it in the UI
    // would appear to do nothing.
    if (finding.suppressed) continue;
    if (!CAPABILITY_SEVERITIES.has(finding.severity)) continue;
    // "Do not read `~/.ssh`" is not the ability to read `~/.ssh`. Documentation
    // describing a behaviour, a prohibition list, or a source comment explaining
    // why something is rejected must not become a capability — only a finding that
    // *is* agent-directed content survives on prose (see the sets above).
    const textIsExecutable = !NON_EXECUTABLE_CONTEXTS.has(String(finding.context || ''));
    if (!textIsExecutable && !INSTRUCTION_CONTENT_CATEGORIES.has(finding.category)) continue;
    for (const capability of CATEGORY_CAPABILITIES[finding.category] || []) {
      capabilities.add(capability);
      const list = evidenceMap[capability] || (evidenceMap[capability] = []);
      if (!list.includes(finding.ruleId)) list.push(finding.ruleId);
    }
  }
  return {
    skillId: evidence.skillId,
    capabilities: [...capabilities].sort(),
    evidence: evidenceMap,
    score: evidence.score,
    decision: evidence.recommendation || evidence.outcome,
    analyzed: true,
  };
}

/**
 * Give every requirement of a `distinct` path its own skill, or report that no
 * such assignment exists.
 *
 * The obvious greedy version — walk the requirements in order, take the first
 * holder that is not used yet — is wrong, and wrong in a way that produces a
 * *plausible-looking* answer: the first requirement can consume the only skill
 * that could ever satisfy the second, and the path then collapses onto a single
 * participant. That is the node-level finding this function's contract says it
 * must not report, drawn as a "composition path". Measured on a real profile
 * after the prose guard: `durable_execution` came back with one participant
 * (`claude:writing-skills` holds both `persist` and `execute`) while a
 * persist-only skill was available and would have made the two-skill path real.
 *
 * Kuhn's matching, quadratic and trivial at four requirements. Failure to match
 * *is* the "one skill covers everything" case — the caller drops the path.
 */
function assignDistinctSkills(
  holders: Array<{ capability: Capability; skills: SkillCapabilities[] }>,
): string[] | null {
  const owner = new Map<string, number>();
  const augment = (req: number, seen: Set<string>): boolean => {
    for (const skill of holders[req].skills) {
      if (seen.has(skill.skillId)) continue;
      seen.add(skill.skillId);
      const held = owner.get(skill.skillId);
      if (held === undefined || augment(held, seen)) {
        owner.set(skill.skillId, req);
        return true;
      }
    }
    return false;
  };
  for (let req = 0; req < holders.length; req += 1) {
    if (!augment(req, new Set())) return null;
  }
  const assigned: string[] = new Array(holders.length).fill('');
  for (const [skillId, req] of owner) assigned[req] = skillId;
  return assigned;
}

/**
 * Find the risk paths present in a library.
 *
 * Returns one entry per path, with the participating skills. `distinct: true`
 * paths require the capabilities to live in different skills — a single skill
 * that both reads credentials and egresses is a *node-level* problem, already
 * reported by that skill's own scan, and reporting it again here would double
 * count it and make the section look busier than the risk. "Require" is enforced
 * by an actual assignment (`assignDistinctSkills`), so a reported path always has
 * one skill per requirement.
 */
export function analyzeComposition(skills: SkillCapabilities[]): CompositionPath[] {
  const usable = skills.filter((s) => s.analyzed);
  const out: CompositionPath[] = [];
  for (const spec of PATHS) {
    const holders = spec.requires.map((capability) => ({
      capability,
      skills: usable.filter((s) => s.capabilities.includes(capability)),
    }));
    if (holders.some((h) => h.skills.length === 0)) continue;
    let participants: string[];
    if (spec.distinct) {
      const assigned = assignDistinctSkills(holders);
      // No assignment means one skill covers every requirement on its own. That is
      // a node-level finding, already in that skill's own report, and reporting it
      // here would double count it and make this section busier than the risk.
      if (!assigned) continue;
      participants = assigned;
    } else {
      // A non-distinct path may reuse one skill for several requirements.
      participants = [];
      for (const holder of holders) {
        const pick = holder.skills[0].skillId;
        if (!participants.includes(pick)) participants.push(pick);
      }
    }
    out.push({
      id: spec.id,
      severity: spec.severity,
      participants,
      capabilities: [...spec.requires],
    });
  }
  // Highest severity first, then by how many skills are implicated.
  return out.sort((a, b) => (a.severity === b.severity
    ? b.participants.length - a.participants.length
    : a.severity === 'high' ? -1 : 1));
}

// ── Cache ───────────────────────────────────────────────────────────────
//
// Deriving capabilities needs a detail scan per skill, which is a Python spawn
// each. The library can hold dozens of skills, and the security page is opened
// repeatedly — so results are cached under `local/` (machine-private, never
// synced) keyed by the skill's payload hash plus the ruleset version. A content
// edit or a ruleset upgrade invalidates the entry, which is the only correct
// invalidation: a cached capability set describes specific bytes under specific
// rules.

const CACHE_FILE = 'security_capabilities.json';
/**
 * Bumped when the *derivation* changes, not just the key.
 *
 * 1 → 2: capabilities now require executable evidence for behavioural
 * capabilities. Entries written under v1 were derived from prose as well, so
 * keying on payload + ruleset alone would keep serving the pre-guard answer for
 * every unchanged skill — the fix would apply to nothing until each skill's
 * bytes happened to change.
 */
const CACHE_VERSION = 2;
/**
 * How many skills one analysis pass will scan.
 *
 * A pass is resumable and cached, so this is a latency guard rather than a
 * correctness one: measured, a fresh detail scan costs 0.45–1.1 s, so 48 skills
 * is roughly 25–50 s of work. The time budget below usually binds first.
 */
export const ANALYSIS_BUDGET = 48;

/**
 * Wall-clock ceiling for the scanning part of one pass.
 *
 * There is no total-time limit on a *scan*, and this is not one: it bounds how
 * long the settings page will hold a request before returning partial results
 * plus an honest "N remaining" note. The work is not lost — the cache keeps
 * every completed skill, so the next activation continues where this one
 * stopped.
 */
export const ANALYSIS_TIME_BUDGET_MS = 25_000;

interface CacheEntry {
  payloadHash: string;
  rulesetVersion: string;
  capabilities: Capability[];
  evidence: Partial<Record<Capability, string[]>>;
  score: number | null;
  decision: string;
  analyzedAt: string;
}

function cachePath(uid: string): string {
  return path.join(userLocalRoot(uid), CACHE_FILE);
}

function readCache(uid: string): Record<string, CacheEntry> {
  try {
    const raw = readJsonSync(cachePath(uid)) as { version?: number; entries?: Record<string, CacheEntry> };
    if (!raw || raw.version !== CACHE_VERSION || !raw.entries) return {};
    return raw.entries;
  } catch {
    return {};
  }
}

function writeCache(uid: string, entries: Record<string, CacheEntry>): void {
  try {
    writeTextAtomicSync(cachePath(uid),
      `${JSON.stringify({ version: CACHE_VERSION, entries }, null, 2)}\n`);
  } catch (err) {
    // A cache write failure must not fail the analysis; the next run just
    // rescans. Logged because a permanently unwritable cache means every
    // analysis pass pays the full cost.
    log.warn('capability cache write failed', { error: (err as Error).message });
  }
}

/**
 * The skill ids this analysis covers.
 *
 * `listSkills()` walks the *catalog* (custom + the user's marketplace mirror).
 * It does not include the packaged `builtin/system/skills` tree, and those are
 * the skills most likely to matter here: `agent-creator` and `skill-creator`
 * are the two entries in this library that can read credentials *and* execute
 * code. Measured before this was added — the composition pass analysed 58 of 89
 * skills and silently omitted exactly the interesting ones.
 *
 * Enumerated from disk rather than from the catalog so a skill present in the
 * build but not yet mirrored into the user directory is still covered.
 */
async function scopedSkillIds(): Promise<string[]> {
  const packaged = new Set<string>();
  const ids = new Set<string>();
  try {
    const skills = await import('../skills');
    for (const listing of await skills.listSkills()) {
      if (listing && listing.id && !listing.ownerAgent) ids.add(listing.id);
    }
  } catch (err) {
    log.warn('skill catalog unavailable for composition scope', {
      error: (err as Error).message,
    });
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const paths = require('../../paths') as { packagedBuiltinDir?: () => string };
    const root = paths.packagedBuiltinDir?.();
    if (root) {
      for (const sub of ['system/skills', 'marketplace/skills']) {
        const base = path.join(root, ...sub.split('/'));
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(base, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (!fs.existsSync(path.join(base, entry.name, 'SKILL.md'))) continue;
          ids.add(entry.name);
          // The packaged tree goes first. These are the skills that ship with
          // the product and several of them run commands by design
          // (`agent-creator`, `skill-creator`), so a budget-limited pass should
          // spend its budget where capabilities are most likely to exist.
          // Measured without this ordering: a fresh 24-skill pass analysed
          // 18 skills with `ingest_untrusted` and none with `execute`.
          packaged.add(entry.name);
        }
      }
    }
  } catch { /* packaged resources unavailable */ }
  return [...packaged].sort().concat([...ids].filter((id) => !packaged.has(id)).sort());
}

export interface CompositionReport {
  skills: SkillCapabilities[];
  paths: CompositionPath[];
  coverage: {
    analyzedSkills: number;
    /**
     * Skills that could be located on disk.
     *
     * Not the catalog size: measured on a real profile, 31 of the catalog's
     * entries are names with no directory behind them (`claude:comet` and
     * friends), which no code path — including the skills feature's own
     * `getSkillForEdit` — can resolve. Counting them would make the coverage
     * line read "48 of 97" and imply the analysis skipped half the library when
     * it actually covered everything that exists.
     */
    resolvableSkills: number;
    /** Catalog entries with no directory behind them. Reported, not hidden. */
    unresolvedSkills: number;
    /** True when the budget stopped the pass before covering the library. */
    budgetLimited: boolean;
    cacheHits: number;
    rulesetVersion: string;
  };
}

/**
 * Analyse the library's composition risk.
 *
 * Bounded on purpose: at most `ANALYSIS_BUDGET` fresh scans per call, cache
 * first. `coverage` reports exactly how much of the library the verdict covers,
 * so a partial answer cannot be read as a complete one.
 */
export async function libraryComposition(uid: string): Promise<CompositionReport> {
  const empty: CompositionReport = {
    skills: [],
    paths: [],
    coverage: {
      analyzedSkills: 0, resolvableSkills: 0, unresolvedSkills: 0, budgetLimited: false,
      cacheHits: 0, rulesetVersion: resolveRulesetVersion(),
    },
  };
  if (!safeId(uid)) return empty;

  const ids = await scopedSkillIds();
  const rulesetVersion = resolveRulesetVersion();
  const cache = readCache(uid);
  const nextCache: Record<string, CacheEntry> = {};
  const results: SkillCapabilities[] = [];
  let scanned = 0;
  let cacheHits = 0;
  let budgetLimited = false;
  let unresolved = 0;
  let skippedForBudget = 0;
  const passStarted = Date.now();

  for (const id of ids) {
    const resolved = await resolveSkillForScan(id);
    if (!resolved) {
      unresolved += 1;
      continue;
    }
    const payloadHash = skillPayloadHash(resolved.dir) || '';
    const cached = cache[id];
    if (cached && payloadHash && cached.payloadHash === payloadHash
      && cached.rulesetVersion === rulesetVersion) {
      cacheHits += 1;
      nextCache[id] = cached;
      results.push({
        skillId: id,
        capabilities: cached.capabilities || [],
        evidence: cached.evidence || {},
        score: cached.score,
        decision: cached.decision,
        analyzed: true,
        payloadHash,
      });
      continue;
    }
    if (scanned >= ANALYSIS_BUDGET || Date.now() - passStarted > ANALYSIS_TIME_BUDGET_MS) {
      budgetLimited = true;
      skippedForBudget += 1;
      continue;
    }
    scanned += 1;
    try {
      const evidence = await skillSecurityReport(resolved.dir, id);
      const derived = deriveCapabilities(evidence);
      derived.payloadHash = payloadHash;
      results.push(derived);
      nextCache[id] = {
        payloadHash,
        rulesetVersion,
        capabilities: derived.capabilities,
        evidence: derived.evidence,
        score: derived.score,
        decision: derived.decision,
        analyzedAt: new Date().toISOString(),
      };
    } catch (err) {
      unresolved += 1;
      log.warn('composition scan failed for skill', {
        skillId: id, error: (err as Error).message,
      });
    }
  }

  writeCache(uid, nextCache);
  return {
    skills: results,
    paths: analyzeComposition(results),
    coverage: {
      analyzedSkills: results.length,
      resolvableSkills: results.length + skippedForBudget,
      unresolvedSkills: unresolved,
      budgetLimited,
      cacheHits,
      rulesetVersion,
    },
  };
}
