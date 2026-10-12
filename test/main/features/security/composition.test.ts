/**
 * Tests for path-level composition risk.
 *
 * Two things are load-bearing here and both are easy to get wrong in a way that
 * looks fine:
 *
 *  1. **Capability derivation must not count what was dismissed.** A suppressed
 *     finding is one the user explicitly accepted; if it still feeds the graph,
 *     revoking it in the UI appears to do nothing.
 *  2. **A single skill holding both capabilities is a node-level finding, not a
 *     composition.** Reporting it here would double-count it and make the
 *     section busier than the risk — the failure mode that turns a security
 *     panel into noise.
 */
import { describe, expect, it } from 'vitest';

import {
  analyzeComposition,
  deriveCapabilities,
  type SkillCapabilities,
} from '../../../../src/main/features/security/composition';
import type { EvidenceFinding, SecurityEvidence } from '../../../../src/main/features/security/evidence';

function finding(overrides: Partial<EvidenceFinding> = {}): EvidenceFinding {
  return {
    ruleId: 'r',
    severity: 'high',
    originalSeverity: 'high',
    demoted: false,
    confidence: 'high',
    category: 'data_egress',
    file: 'a.py',
    line: 1,
    description: 'd',
    remediation: '',
    hardBlock: false,
    context: 'source',
    cwe: [],
    owaspLlm: [],
    owaspAgentic: [],
    owaspAst: [],
    references: [],
    fingerprint: 'fp',
    suppressed: false,
    ...overrides,
  };
}

function evidence(findings: EvidenceFinding[], skillId = 's'): SecurityEvidence {
  return {
    skillId,
    scannedAt: '2026-03-06T00:00:00Z',
    schemaVersion: '2.0.0',
    outcome: 'restricted',
    score: 62,
    riskClassification: 'MEDIUM',
    recommendation: 'CAUTION',
    hardBlocked: false,
    confirmedCritical: false,
    scannerVersion: '2.2.0',
    rulesetVersion: 'v1.1.0',
    isolated: false,
    scanMode: 'degraded-local',
    scanTier: 'static',
    rulesDegraded: false,
    rulesSource: '',
    severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    findings,
    attackSurface: { egressPoints: 0, dynamicExecPoints: 0, persistencePoints: 0, hasBinaries: false },
    requiredMitigations: [],
    limitations: [],
  };
}

function caps(skillId: string, capabilities: SkillCapabilities['capabilities']): SkillCapabilities {
  return { skillId, capabilities, evidence: {}, score: 90, decision: 'ALLOW', analyzed: true };
}

describe('composition › capability derivation', () => {
  it('maps categories onto capabilities', () => {
    const result = deriveCapabilities(evidence([
      finding({ category: 'credential_access' }),
      finding({ category: 'data_egress' }),
      finding({ category: 'persistence' }),
    ]));
    expect(result.capabilities).toEqual(['egress', 'persist', 'read_credentials']);
  });

  it('records the rule ids that produced each capability', () => {
    const result = deriveCapabilities(evidence([
      finding({ category: 'credential_access', ruleId: 'credential_path_read' }),
    ]));
    expect(result.evidence.read_credentials).toEqual(['credential_path_read']);
  });

  it('ignores info-level findings', () => {
    // `http_url` at info level matches any documented URL. Treating "the README
    // mentions an endpoint" as an egress capability would put the whole library
    // into the graph.
    const result = deriveCapabilities(evidence([finding({ category: 'network', severity: 'info' })]));
    expect(result.capabilities).toEqual([]);
  });

  it('ignores suppressed findings', () => {
    const result = deriveCapabilities(evidence([
      finding({ category: 'credential_access', suppressed: true }),
    ]));
    expect(result.capabilities).toEqual([]);
  });

  it('ignores categories with no capability meaning', () => {
    const result = deriveCapabilities(evidence([
      finding({ category: 'typosquat' }),
      finding({ category: 'dependency_vuln' }),
    ]));
    expect(result.capabilities).toEqual([]);
  });

  it('carries the score and decision through for display', () => {
    const result = deriveCapabilities(evidence([]));
    expect(result.score).toBe(62);
    expect(result.decision).toBe('CAUTION');
    expect(result.analyzed).toBe(true);
  });
});

/**
 * A capability is a statement about what a skill can *do*.
 *
 * The engine's own context layer defines `prose` as 「文档散文：仅是文字描述，
 * 不可执行」, and the main-side red-flag scanner says the same thing in its header
 * ("Prose in SKILL.md is NOT scanned — false-positive rate is too high"). This
 * block is where the composition layer has to agree with both of them.
 *
 * Measured on a real profile before the guard: our packaged `agent-creator` and
 * `skill-creator` derived `read_credentials` and `execute` from their authoring
 * prohibition list ("do not read `.env`, `~/.ssh`, … keychains, browser cookies";
 * "do not use `curl | sh`"), which is what put all four reported paths there.
 */
describe('composition › capability derivation requires executable evidence', () => {
  it('does not turn a documented prohibition into a capability', () => {
    const result = deriveCapabilities(evidence([
      // "Credentials and private context: do not read `.env`, `~/.ssh`,
      //  `~/.aws/credentials`, shell history, keychains, browser cookies…"
      finding({ category: 'credential_access', context: 'prose', ruleId: 'browser_data_access' }),
      finding({ category: 'credential_access', context: 'prose', ruleId: 'credential_path_read' }),
      // "Download-and-execute: do not use `curl | sh`…"
      finding({ category: 'unauthorized_download', context: 'prose', ruleId: 'curl_pipe_shell' }),
      finding({ category: 'command_exec', context: 'prose', ruleId: 'remote_code_execution' }),
    ]));
    expect(result.capabilities).toEqual([]);
    expect(result.evidence.read_credentials).toBeUndefined();
    expect(result.evidence.execute).toBeUndefined();
  });

  it('treats a source comment the same way as prose', () => {
    // "…this is the address we reject" — the engine marks comment lines for the
    // same reason it marks prose.
    const result = deriveCapabilities(evidence([
      finding({ category: 'network', context: 'comment' }),
    ]));
    expect(result.capabilities).toEqual([]);
  });

  it('keeps capabilities that come from code', () => {
    const result = deriveCapabilities(evidence([
      finding({ category: 'credential_access', context: 'source' }),
      finding({ category: 'dynamic_exec', context: 'source' }),
    ]));
    expect(result.capabilities).toEqual(['execute', 'read_credentials']);
  });

  it('counts a fenced code block, which a user can run', () => {
    // `doc` is the engine's "documentation fenced code block" — copy-pasteable,
    // unlike surrounding prose. The line is drawn at executability, not at file.
    const result = deriveCapabilities(evidence([
      finding({ category: 'data_egress', context: 'doc' }),
    ]));
    expect(result.capabilities).toEqual(['egress']);
  });

  it('still takes injected instructions from prose', () => {
    // The deliberate exception: these categories *are* the instruction content,
    // and prose is exactly where an injected instruction lives. Filtering them
    // would blind untrusted_to_exec / memory_poisoning to their own vector.
    const result = deriveCapabilities(evidence([
      finding({ category: 'agent_instruction', context: 'prose', ruleId: 'covert_execution' }),
      finding({ category: 'prompt_injection', context: 'prose', ruleId: 'fake_role_tag' }),
      finding({ category: 'hidden_content', context: 'prose' }),
    ]));
    expect(result.capabilities).toEqual(['ingest_untrusted']);
    expect(result.evidence.ingest_untrusted).toEqual(['covert_execution', 'fake_role_tag', 'r']);
  });

  it('keeps the prose exception confined to ingest_untrusted', () => {
    // The exception is only sound while these categories map to the content
    // capability alone. If one ever grows a behaviour mapping, prose would start
    // conferring that behaviour — so the invariant is asserted, not assumed.
    const proseCapable = ['agent_instruction', 'prompt_injection', 'hidden_content',
      'system_prompt_extraction'];
    for (const category of proseCapable) {
      const result = deriveCapabilities(evidence([finding({ category, context: 'prose' })]));
      expect(result.capabilities, category).toEqual(['ingest_untrusted']);
    }
    // And the mixed categories — behaviour plus content — must not be on the list.
    for (const category of ['unauthorized_download', 'ssrf']) {
      const result = deriveCapabilities(evidence([finding({ category, context: 'prose' })]));
      expect(result.capabilities, category).toEqual([]);
    }
  });

  it('fails open when a finding carries no context', () => {
    // A missing field must not become a way to hide a real path: dropping a
    // capability is a silent false negative.
    const result = deriveCapabilities(evidence([
      finding({ category: 'credential_access', context: '' }),
    ]));
    expect(result.capabilities).toEqual(['read_credentials']);
  });

  it('stops a prose-only pair from forming a path end to end', () => {
    const reader = deriveCapabilities(evidence([
      finding({ category: 'credential_access', context: 'prose', ruleId: 'browser_data_access' }),
    ], 'agent-creator'));
    const poster = deriveCapabilities(evidence([
      finding({ category: 'data_egress', context: 'source', ruleId: 'requests_post' }),
    ], 'notifier'));
    expect(analyzeComposition([reader, poster])).toEqual([]);
  });
});

describe('composition › path detection', () => {
  it('finds credential read + egress across two skills', () => {
    const paths = analyzeComposition([
      caps('reader', ['read_credentials']),
      caps('poster', ['egress']),
    ]);
    const exfil = paths.find((p) => p.id === 'credential_exfil');
    expect(exfil).toBeDefined();
    expect(exfil?.severity).toBe('high');
    expect(exfil?.participants.sort()).toEqual(['poster', 'reader']);
  });

  it('does not report a path held entirely by one skill', () => {
    // That is a node-level finding, already in that skill's own report.
    const paths = analyzeComposition([caps('solo', ['read_credentials', 'egress'])]);
    expect(paths.find((p) => p.id === 'credential_exfil')).toBeUndefined();
  });

  it('gives every requirement its own skill instead of starving the last one', () => {
    // The real shape measured after the prose guard: several `persist` holders,
    // exactly one `execute` holder, and that same skill happens to come first in
    // the `persist` list. Picking greedily in requirement order consumed it for
    // `persist` and then could not satisfy `execute` distinctly, emitting a
    // "path" with a single participant — the node-level finding the contract
    // above says must never be reported.
    const paths = analyzeComposition([
      caps('both', ['persist', 'execute']),
      caps('persist-only', ['persist']),
    ]);
    const durable = paths.find((p) => p.id === 'durable_execution');
    expect(durable).toBeDefined();
    expect(durable?.participants).toHaveLength(2);
    expect(new Set(durable?.participants).size).toBe(2);
    // 两个需求各由一个**不同**技能承担：execute 只能给 both。
    expect(durable?.participants).toContain('both');
    expect(durable?.participants).toContain('persist-only');
  });

  it('reports no path when one skill is the only holder of everything', () => {
    const paths = analyzeComposition([
      caps('both', ['persist', 'execute']),
      caps('unrelated', ['egress']),
    ]);
    expect(paths.find((p) => p.id === 'durable_execution')).toBeUndefined();
  });

  it('finds durable execution and memory poisoning', () => {
    const paths = analyzeComposition([
      caps('a', ['persist']),
      caps('b', ['execute']),
      caps('c', ['write_agent_memory']),
      caps('d', ['ingest_untrusted']),
    ]);
    const ids = paths.map((p) => p.id).sort();
    expect(ids).toContain('durable_execution');
    expect(ids).toContain('memory_poisoning');
  });

  it('reports nothing for a library with no completable path', () => {
    expect(analyzeComposition([caps('a', ['egress']), caps('b', ['persist'])])).toEqual([]);
  });

  it('ignores skills that were not analysed', () => {
    const paths = analyzeComposition([
      caps('reader', ['read_credentials']),
      { ...caps('poster', ['egress']), analyzed: false },
    ]);
    expect(paths).toEqual([]);
  });

  it('sorts high severity before medium', () => {
    const paths = analyzeComposition([
      caps('a', ['read_credentials']), caps('b', ['egress']),
      caps('c', ['ingest_untrusted']), caps('d', ['execute']),
    ]);
    expect(paths[0].severity).toBe('high');
    expect(paths[paths.length - 1].severity).toBe('medium');
  });

  it('names the capabilities that form the path', () => {
    const paths = analyzeComposition([
      caps('a', ['write_agent_memory']), caps('b', ['ingest_untrusted']),
    ]);
    const poisoning = paths.find((p) => p.id === 'memory_poisoning');
    expect(poisoning?.capabilities.sort()).toEqual(['ingest_untrusted', 'write_agent_memory']);
  });
});
