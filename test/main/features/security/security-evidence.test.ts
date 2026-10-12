/**
 * Tests for the security evidence mapper and its export formats.
 *
 * `evidence.ts` is the boundary between an engine payload (snake_case, open
 * shape) and the renderer (camelCase, closed interface). Two failure modes
 * matter and neither throws:
 *
 *  1. a field silently not mapped, which renders as an empty panel;
 *  2. a field mapped that should not be, which puts matched text — possibly a
 *     leaked credential — into the UI and into any exported report.
 *
 * So the tests are mostly about completeness and about what must NOT be there.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SARIF_LEVEL,
  SARIF_SECURITY_SEVERITY,
  sarifResultCount,
  exportSecurityPayload,
  toCsv,
  toEvidence,
  toMarkdown,
  toSarif,
} from '../../../../src/main/features/security/evidence';
import type { SentryScanResult } from '../../../../src/main/features/security/sentry-adapter';

function baseScan(overrides: Partial<SentryScanResult> = {}): SentryScanResult {
  return {
    outcome: 'restricted',
    score: 62,
    riskClassification: 'MEDIUM',
    recommendation: 'CAUTION',
    isolated: false,
    scanMode: 'degraded-local',
    hardBlocked: false,
    confirmedCritical: false,
    requiredMitigations: [{ id: 'SR-04', name: '外部网络与数据外发' }],
    vulnerabilityCount: 0,
    scannerVersion: '2.2.0',
    rulesetVersion: 'v1.1.0',
    attackSurface: { egressPoints: 1, dynamicExecPoints: 0, persistencePoints: 2, hasBinaries: false },
    ...overrides,
  };
}

const FINDING = {
  ruleId: 'requests_post',
  severity: 'medium' as const,
  originalSeverity: 'medium',
  demoted: false,
  confidence: 'high' as const,
  category: 'data_egress',
  file: 'scripts/collect.py',
  line: 12,
  description: '命中规则 requests_post（network_egress）',
  remediation: '外发前必须显式征得用户同意',
  hardBlock: false,
  context: 'source',
  cwe: ['CWE-200'],
  owaspLlm: ['LLM02'],
  owaspAgentic: ['ASI03'],
  owaspAst: ['AST01'],
  references: ['https://cwe.mitre.org/data/definitions/200.html'],
  fingerprint: 'abcdef0123456789abcd',
  suppressed: false,
};

describe('security › evidence › mapping', () => {
  it('maps a full engine payload onto the renderer shape', () => {
    const scan = baseScan({
      findings: [FINDING],
      severityCounts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
      scoreBreakdown: {
        score: 62, rawPenalty: 4.8, penalty: 4.8, scale: 55,
        byCategory: [{ category: 'data_egress', count: 1, raw: 4.8, cap: 65, penalty: 4.8, capped: false }],
        floors: [],
      },
      coverage: {
        filesScanned: 3, filesSeen: 4, bytesScanned: 1200, ruleCount: 176,
        ruleGroups: ['network_egress'], hardBlockRules: 2,
        contexts: { source: 2, doc: 1 },
        externalTools: { gitleaks: 'SKIPPED', osv_scanner: 'SKIPPED', binary_strings: 'static-only' },
        rulesSource: 'ruleset v1.1.0: text-rules.yaml', rulesetResolved: true,
        rulesetVersion: 'v1.1.0', invalidRules: [],
      },
      frameworkSummary: {
        owaspLlm: [{ id: 'LLM02', title: '敏感信息泄露', count: 1, rules: ['requests_post'] }],
        owaspAgentic: [],
        owaspAst: [{ id: 'AST01', title: '恶意技能', count: 1, rules: ['requests_post'] }],
      },
      structuralSummary: { fileCount: 3, totalBytes: 1200, executableCount: 0, archiveCount: 0, symlinkCount: 0, topExtensions: [{ ext: '.py', count: 1 }] },
      dependencyManifests: { runtime_packages: ['requests'] },
      baseline: { acceptedTotal: 1, acceptedActive: 0, acceptedExpired: 1, suppressedFindings: 0 },
      limitations: ['仅静态分析'],
      scannedAt: '2026-03-06T00:00:00Z',
      schemaVersion: '2.0.0',
    });

    const e = toEvidence('my-skill', scan);

    expect(e.skillId).toBe('my-skill');
    expect(e.score).toBe(62);
    expect(e.severityCounts.medium).toBe(1);
    expect(e.findings).toHaveLength(1);
    expect(e.findings[0]).toMatchObject({
      ruleId: 'requests_post',
      file: 'scripts/collect.py',
      line: 12,
      confidence: 'high',
      cwe: ['CWE-200'],
      owaspLlm: ['LLM02'],
      suppressed: false,
    });
    expect(e.scoreBreakdown?.byCategory[0].cap).toBe(65);
    expect(e.coverage?.ruleCount).toBe(176);
    expect(e.frameworkSummary?.owaspLlm[0].id).toBe('LLM02');
    expect(e.frameworkSummary?.owaspAst[0].id).toBe('AST01');
    expect(e.structuralSummary?.fileCount).toBe(3);
    expect(e.dependencyManifests).toEqual({ runtime_packages: ['requests'] });
    expect(e.baseline?.acceptedExpired).toBe(1);
    expect(e.scannedAt).toBe('2026-03-06T00:00:00Z');
    expect(e.schemaVersion).toBe('2.0.0');
  });

  it('derives severity counts from findings when the engine omitted them', () => {
    const e = toEvidence('s', baseScan({
      findings: [FINDING, { ...FINDING, ruleId: 'r2', severity: 'critical' }],
    }));
    expect(e.severityCounts.medium).toBe(1);
    expect(e.severityCounts.critical).toBe(1);
  });

  it('keeps unmapped fields out of the evidence object', () => {
    // The engine dict may gain fields; nothing without an explicit mapping here
    // may reach the renderer.
    const scan = baseScan({
      findings: [{ ...FINDING, snippet: 'cat ~/.aws/credentials' } as never],
    });
    const e = toEvidence('s', scan);
    expect(JSON.stringify(e)).not.toContain('aws/credentials');
    expect(Object.keys(e.findings[0])).not.toContain('snippet');
  });

  it('reports a null score as null rather than zero', () => {
    const e = toEvidence('s', baseScan({ score: undefined, outcome: 'unknown' }));
    expect(e.score).toBeNull();
  });

  it('defaults the attack surface instead of leaving it undefined', () => {
    const e = toEvidence('s', baseScan({ attackSurface: undefined }));
    expect(e.attackSurface).toEqual({
      egressPoints: 0, dynamicExecPoints: 0, persistencePoints: 0, hasBinaries: false,
    });
  });
});

describe('security › evidence › sarif export', () => {
  const evidence = toEvidence('my-skill', baseScan({ findings: [FINDING] }));

  it('emits SARIF 2.1.0 with a rules table and results', () => {
    const doc = toSarif(evidence) as Record<string, never>;
    expect(doc.version).toBe('2.1.0');
    const run = (doc.runs as unknown[])[0] as Record<string, never>;
    const driver = (run.tool as Record<string, never>).driver as Record<string, never>;
    expect(driver.name).toBe('skill-sentry');
    expect((driver.rules as unknown[]).length).toBe(1);
    const result = (run.results as unknown[])[0] as Record<string, never>;
    expect(result.ruleId).toBe('requests_post');
    expect(result.level).toBe('warning');
    expect(result.partialFingerprints).toEqual({
      'skillSentryFingerprint/v1': 'abcdef0123456789abcd',
    });
  });

  it('maps severities onto the three SARIF levels', () => {
    const levels: Record<string, string> = {};
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
      const e = toEvidence('s', baseScan({ findings: [{ ...FINDING, severity }] }));
      const doc = toSarif(e) as never as { runs: Array<{ results: Array<{ level: string }> }> };
      levels[severity] = doc.runs[0].results[0].level;
    }
    // `info` is filtered out entirely — see the dedicated test below.
    expect(levels).toEqual({ critical: 'error', high: 'error', medium: 'warning', low: 'note' });
    expect(SARIF_LEVEL.info).toBe('note');
  });

  it('never emits an absolute path', () => {
    const e = toEvidence('s', baseScan({ findings: [{ ...FINDING, file: 'a/b.py' }] }));
    const doc = toSarif(e) as never as {
      runs: Array<{ results: Array<{ locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }> }>;
    };
    const uri = doc.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe('a/b.py');
    expect(uri.startsWith('/')).toBe(false);
  });

  it('deduplicates rules and tags them with CWE / OWASP identifiers', () => {
    const e = toEvidence('s', baseScan({
      findings: [FINDING, { ...FINDING, line: 40 }, { ...FINDING, ruleId: 'other' }],
    }));
    const doc = toSarif(e) as never as {
      runs: Array<{ tool: { driver: { rules: Array<{ id: string; properties: { tags: string[] } }> } } }>;
    };
    const rules = doc.runs[0].tool.driver.rules;
    expect(rules.map((r) => r.id)).toEqual(['other', 'requests_post']);
    expect(rules[1].properties.tags).toContain('CWE-200');
    expect(rules[1].properties.tags).toContain('OWASP-LLM-LLM02');
    expect(rules[1].properties.tags).toContain('OWASP-AST01');
    expect(rules[1].properties.securitySeverity).toBe(5.5);
    expect(rules[1].properties.tags).toContain('category:data_egress');
  });
});

describe('security › evidence › other exports', () => {
  const evidence = toEvidence('my-skill', baseScan({ findings: [FINDING] }));

  it('csv escapes separators, quotes and newlines', () => {
    const e = toEvidence('s', baseScan({
      findings: [{ ...FINDING, description: 'has, a comma and "quotes"\nand a newline' }],
    }));
    const csv = toCsv(e);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"has, a comma and ""quotes""\nand a newline"');
    // Header plus one row plus the trailing newline's empty segment.
    expect(csv.trim().split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('markdown names the verdict, the score and the top remediation', () => {
    const md = toMarkdown(toEvidence('my-skill',
      baseScan({ findings: [FINDING], limitations: ['仅静态分析，未接入动态沙箱'] })));
    expect(md).toContain('# 安全扫描报告 — my-skill');
    expect(md).toContain('CAUTION');
    expect(md).toContain('62/100');
    expect(md).toContain('外发前必须显式征得用户同意');
    expect(md).toContain('已知局限');
  });

  it('markdown distinguishes a clean scan from an unscanned one', () => {
    expect(toMarkdown(toEvidence('s', baseScan({ findings: [] }))))
      .toContain('未发现需要处理的问题');
    expect(toMarkdown(toEvidence('s', baseScan({ score: undefined, findings: [] }))))
      .toContain('—/100');
  });

  it('json export round-trips the evidence object', () => {
    const parsed = JSON.parse(exportSecurityPayload(evidence, 'json'));
    expect(parsed.skillId).toBe('my-skill');
    expect(parsed.findings).toHaveLength(1);
  });

  it('carries the scan tier so a static pass is not read as a sandboxed one', () => {
    expect(toEvidence('s', baseScan({ scanTier: 'sandboxed' })).scanTier).toBe('sandboxed');
    // Unmeasured must fall back to the weaker claim, never the stronger one.
    expect(toEvidence('s', baseScan({ scanTier: undefined, isolated: false })).scanTier).toBe('static');
    expect(toEvidence('s', baseScan({ scanTier: undefined, isolated: true })).scanTier).toBe('sandboxed');
  });

  it('maps severity onto GitHub security-severity buckets', () => {
    expect(SARIF_SECURITY_SEVERITY.critical).toBeGreaterThan(9.0);
    expect(SARIF_SECURITY_SEVERITY.high).toBeGreaterThanOrEqual(7.0);
    expect(SARIF_SECURITY_SEVERITY.high).toBeLessThan(9.0);
    expect(SARIF_SECURITY_SEVERITY.medium).toBeGreaterThanOrEqual(4.0);
    expect(SARIF_SECURITY_SEVERITY.medium).toBeLessThan(7.0);
    expect(SARIF_SECURITY_SEVERITY.low).toBeGreaterThan(0);
    expect(SARIF_SECURITY_SEVERITY.low).toBeLessThan(4.0);
  });

  it('carries suppression refusal so the UI can explain why an acceptance did nothing', () => {
    const e = toEvidence('s', baseScan({
      findings: [{ ...FINDING, suppressionRefused: true, severity: 'high' }],
    }));
    expect(e.findings[0].suppressionRefused).toBe(true);
  });

  it('carries the anti-evasion view a finding came from', () => {
    const e = toEvidence('s', baseScan({
      findings: [{ ...FINDING, derived: 'b64_1' }],
    }));
    expect(e.findings[0].derived).toBe('b64_1');
    const doc = toSarif(e) as never as {
      runs: Array<{ results: Array<{ properties: Record<string, unknown> }> }>;
    };
    expect(doc.runs[0].results[0].properties.derived).toBe('b64_1');
  });

  it('keeps info-level clues out of the SARIF triage queue', () => {
    const e = toEvidence('s', baseScan({
      findings: [FINDING, { ...FINDING, ruleId: 'http_url', severity: 'info' }],
    }));
    const doc = toSarif(e) as never as { runs: Array<{ results: unknown[] }> };
    expect(doc.runs[0].results).toHaveLength(1);
    expect(sarifResultCount(e)).toBe(1);
    // The clue is still present in the full exports.
    expect(JSON.parse(exportSecurityPayload(e, 'json')).findings).toHaveLength(2);
    expect(toMarkdown(e)).toContain('http_url');
  });

  it('every format returns a non-empty string', () => {
    for (const format of ['json', 'sarif', 'csv', 'markdown'] as const) {
      expect(exportSecurityPayload(evidence, format).length).toBeGreaterThan(10);
    }
  });
});

/**
 * The Python and TypeScript SARIF exporters must agree on the parts that would
 * drift silently. They cannot be a single implementation (the Python one serves
 * `python3 -m engine.scanner_core.report --format sarif` in CI; this one serves
 * the app's export button without spawning a second process), so the contract
 * is pinned here instead.
 */
describe('security › evidence › sarif parity with the engine', () => {
  const GUARDRAIL = path.resolve(__dirname, '../../../../resources/guardrail');
  const ENGINE = path.join(GUARDRAIL, 'skill-sentry');
  const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
  const pythonAvailable = spawnSync(PYTHON, ['--version'], { stdio: 'ignore' }).status === 0;
  const itWithPython = pythonAvailable && fs.existsSync(ENGINE) ? it : it.skip;

  itWithPython('agrees on version, driver name and fingerprint key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarif-parity-'));
    fs.writeFileSync(path.join(dir, 'SKILL.md'),
      '---\nname: parity\ndescription: Parity fixture.\n---\n\n# Parity\n\n```sh\nchmod 777 /tmp/x\n```\n');

    const r = spawnSync(PYTHON, ['-m', 'engine.scanner_core.report', '--artifact', dir, '--format', 'sarif'], {
      cwd: ENGINE,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: [path.join(ENGINE, 'vendor'), process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
      },
    });
    expect(r.status, r.stderr).toBe(0);
    const py = JSON.parse(r.stdout) as {
      version: string;
      runs: Array<{
        tool: { driver: { name: string } };
        results: Array<{ partialFingerprints: Record<string, string>; level: string }>;
      }>;
    };

    const ts = toSarif(toEvidence('parity', baseScan({ findings: [FINDING] }))) as never as {
      version: string;
      runs: Array<{
        tool: { driver: { name: string } };
        results: Array<{ partialFingerprints: Record<string, string>; level: string }>;
      }>;
    };

    expect(ts.version).toBe(py.version);
    expect(ts.runs[0].tool.driver.name).toBe(py.runs[0].tool.driver.name);
    const pyKey = Object.keys(py.runs[0].results[0].partialFingerprints)[0];
    const tsKey = Object.keys(ts.runs[0].results[0].partialFingerprints)[0];
    expect(tsKey).toBe(pyKey);
    expect(tsKey).toBe('skillSentryFingerprint/v1');
  }, 200_000);
});
