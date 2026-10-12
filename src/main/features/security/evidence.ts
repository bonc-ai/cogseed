/**
 * Evidence assembly for the 安全与信任 panel.
 *
 * WHY THIS IS SEPARATE FROM `sentry-adapter`
 * The adapter is a gate: it answers "may this be installed" and is optimised to
 * be cheap on that path (verdict only, no per-finding list). This module is the
 * evidence path — it asks the same engine for the full report and maps it into
 * a renderer-safe shape. Keeping them apart means the install gate cannot
 * accidentally start carrying 150 KB of findings through a 60 s decision, and
 * the panel cannot accidentally start deciding admission.
 *
 * SANITIZATION IS ENFORCED TWICE
 * The engine's `make_finding` never puts matched text in the dict (the snippet
 * is used only to derive a fingerprint, then dropped), and `scan_gate.py`
 * re-applies a field whitelist. This module maps onto a closed TypeScript
 * interface, so a new engine field cannot reach the renderer without someone
 * adding it here on purpose. Three independent chances to notice is the right
 * number for a field that may hold a leaked credential.
 */
import { createLogger } from '../../logger';
import {
  scanSkillDir,
  type FrameworkSummary,
  type ScanCoverage,
  type ScoreBreakdown,
  type SentryScanResult,
  type StructuralSummary,
  type BaselineSummary,
} from './sentry-adapter';

const log = createLogger('security/evidence');

export interface EvidenceFinding {
  ruleId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  originalSeverity: string;
  demoted: boolean;
  confidence: 'high' | 'medium' | 'low';
  category: string;
  file: string;
  line: number | null;
  description: string;
  remediation: string;
  hardBlock: boolean;
  context: string;
  cwe: string[];
  owaspLlm: string[];
  owaspAgentic: string[];
  owaspAst: string[];
  references: string[];
  /** Anti-evasion view this finding came from; absent for a direct hit. */
  derived?: string;
  /** True when the user accepted this risk but the severity forbids it. */
  suppressionRefused?: boolean;
  /** True when the hit sits inside a documented example/negative-example block. */
  example?: boolean;
  fingerprint: string;
  suppressed: boolean;
  suppressedReason?: string;
}

export interface EvidenceAttackSurface {
  egressPoints: number;
  dynamicExecPoints: number;
  persistencePoints: number;
  hasBinaries: boolean;
}

export interface SecurityEvidence {
  skillId: string;
  scannedAt: string;
  schemaVersion: string;
  outcome: string;
  score: number | null;
  riskClassification: string;
  recommendation: string;
  hardBlocked: boolean;
  confirmedCritical: boolean;
  scannerVersion: string;
  rulesetVersion: string;
  isolated: boolean;
  /**
   * True for an external agent skill (`claude:` / `codex:`).
   *
   * Such a skill is scanned READ-ONLY: the risk-acceptance baseline is written
   * inside the skill directory, and for an external skill that directory belongs
   * to the user's own tooling (e.g. `~/.claude/skills/<name>/`), not to us. The
   * renderer uses this to withhold actions the main process would refuse, instead
   * of offering a button that always fails.
   */
  externalSkill?: boolean;
  scanMode: string;
  rulesDegraded: boolean;
  rulesSource: string;
  warning?: string;
  unavailableReason?: string;
  severityCounts: Record<string, number>;
  findings: EvidenceFinding[];
  scoreBreakdown?: ScoreBreakdown;
  coverage?: ScanCoverage;
  frameworkSummary?: FrameworkSummary;
  structuralSummary?: StructuralSummary;
  dependencyManifests?: Record<string, unknown>;
  baseline?: BaselineSummary;
  attackSurface: EvidenceAttackSurface;
  requiredMitigations: Array<{ id: string; name: string }>;
  limitations: string[];
  instructionRisk?: SentryScanResult['instructionRisk'];
  localRedLines?: string[];
  blockingRules?: string[];
  /** `sandboxed` | `static`. See ScanCoverage.scanTier. */
  scanTier: string;
}

const EMPTY_COUNTS: Record<string, number> = {
  critical: 0, high: 0, medium: 0, low: 0, info: 0,
};

export function toEvidence(skillId: string, scan: SentryScanResult): SecurityEvidence {
  const findings: EvidenceFinding[] = (scan.findings || []).map((f) => ({
    ruleId: f.ruleId,
    severity: f.severity,
    originalSeverity: f.originalSeverity,
    demoted: f.demoted,
    confidence: f.confidence,
    category: f.category,
    file: f.file,
    line: f.line,
    description: f.description,
    remediation: f.remediation,
    hardBlock: f.hardBlock,
    context: f.context,
    // Defensive defaults: an older engine, or a future one that renames a
    // field, must degrade the panel rather than throw inside a map.
    owaspLlm: f.owaspLlm || [],
    owaspAgentic: f.owaspAgentic || [],
    owaspAst: f.owaspAst || [],
    references: f.references || [],
    cwe: f.cwe || [],
    fingerprint: f.fingerprint,
    suppressed: f.suppressed,
    ...(f.suppressedReason ? { suppressedReason: f.suppressedReason } : {}),
    ...(f.suppressionRefused ? { suppressionRefused: true } : {}),
    ...(f.derived ? { derived: f.derived } : {}),
    ...(f.example ? { example: true } : {}),
  }));

  const severityCounts = { ...EMPTY_COUNTS };
  for (const f of findings) {
    if (severityCounts[f.severity] !== undefined) severityCounts[f.severity] += 1;
  }

  return {
    skillId,
    scannedAt: scan.scannedAt || new Date().toISOString(),
    schemaVersion: scan.schemaVersion || '',
    outcome: scan.outcome,
    score: typeof scan.score === 'number' ? scan.score : null,
    riskClassification: scan.riskClassification || '',
    recommendation: scan.recommendation || '',
    hardBlocked: scan.hardBlocked,
    confirmedCritical: scan.confirmedCritical ?? false,
    scannerVersion: scan.scannerVersion,
    rulesetVersion: scan.rulesetVersion,
    isolated: scan.isolated,
    scanMode: scan.scanMode,
    rulesDegraded: scan.rulesDegraded === true,
    rulesSource: scan.rulesSource || '',
    ...(scan.warning ? { warning: scan.warning } : {}),
    ...(scan.unavailableReason ? { unavailableReason: scan.unavailableReason } : {}),
    severityCounts,
    findings,
    ...(scan.scoreBreakdown ? { scoreBreakdown: scan.scoreBreakdown } : {}),
    ...(scan.coverage ? { coverage: scan.coverage } : {}),
    ...(scan.frameworkSummary ? { frameworkSummary: scan.frameworkSummary } : {}),
    ...(scan.structuralSummary ? { structuralSummary: scan.structuralSummary } : {}),
    ...(scan.dependencyManifests ? { dependencyManifests: scan.dependencyManifests } : {}),
    ...(scan.baseline ? { baseline: scan.baseline } : {}),
    attackSurface: scan.attackSurface || {
      egressPoints: 0, dynamicExecPoints: 0, persistencePoints: 0, hasBinaries: false,
    },
    requiredMitigations: scan.requiredMitigations || [],
    limitations: scan.limitations || [],
    ...(scan.instructionRisk ? { instructionRisk: scan.instructionRisk } : {}),
    ...(scan.localRedLines ? { localRedLines: scan.localRedLines } : {}),
    ...(scan.blockingRules ? { blockingRules: scan.blockingRules } : {}),
    // A static PASS and a sandboxed PASS are different security claims. Falling
    // back to `static` when unmeasured is the conservative reading: it never
    // overstates the strength of the check.
    scanTier: scan.scanTier || (scan.isolated ? 'sandboxed' : 'static'),
  };
}

/** Run a full-detail scan of one skill directory and return renderer-safe evidence. */
export async function skillSecurityReport(
  skillDir: string,
  skillId: string,
): Promise<SecurityEvidence> {
  const scan = await scanSkillDir(skillDir, 'thirdparty', { detail: true });
  if (!scan.findings && scan.outcome !== 'unknown') {
    // Detail was requested and came back without findings. Not fatal, but it
    // means the engine and this mapper disagree — worth a line in the log so
    // the empty panel has an explanation attached to it.
    log.warn('detail scan returned no findings array', {
      skillId, outcome: scan.outcome, scannerVersion: scan.scannerVersion,
    });
  }
  return toEvidence(skillId, scan);
}

// ── Export formats ──────────────────────────────────────────────────────
//
// SARIF is built here rather than by shelling out to the engine's own exporter
// (`python3 -m engine.scanner_core.report --format sarif`). The engine's version
// exists for CI, where a single process produces the whole document; the app's
// export button already has the evidence in hand, and spawning a second Python
// process to re-scan the same directory would double the work and introduce a
// second code path that can fail.
//
// The two must agree on the field mapping. `test/main/features/security/
// sarif-parity.test.ts` pins the parts that would silently drift: the SARIF
// version, the driver name, the severity→level mapping and the fingerprint key.

const SARIF_VERSION = '2.1.0';
const SARIF_SCHEMA =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';

export const SARIF_LEVEL: Record<string, string> = {
  critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note',
};

/**
 * Numeric severity for GitHub code scanning's `security-severity` property.
 *
 * GitHub buckets these into critical (>9.0), high (7.0–8.9), medium (4.0–6.9)
 * and low (0.1–3.9). Without the property every finding lands in the default
 * bucket and the repository's security tab cannot triage by severity at all.
 * The midpoints leave room for a future confidence adjustment without changing
 * the bucket.
 */
export const SARIF_SECURITY_SEVERITY: Record<string, number> = {
  critical: 9.5, high: 8.0, medium: 5.5, low: 2.0, info: 0.5,
};

export function toSarif(evidence: SecurityEvidence): Record<string, unknown> {
  const seen = new Map<string, Record<string, unknown>>();
  // `info` findings are clues, not alerts: the level is `http_url`-style
  // "this document mentions an external address". Exporting one SARIF result per
  // documented URL floods a code-scanning tab and trains reviewers to dismiss
  // the whole report — the same failure mode as a scanner that flags every
  // skill. They remain in the JSON and Markdown exports, where a reader is
  // looking at the full picture rather than a triage queue.
  const results = evidence.findings.filter((f) => f.severity !== 'info').map((f) => {
    if (!seen.has(f.ruleId)) {
      seen.set(f.ruleId, {
        id: f.ruleId,
        name: f.ruleId,
        shortDescription: { text: f.description.slice(0, 200) },
        fullDescription: { text: f.description },
        helpUri: f.references[0] || '',
        help: { text: f.remediation, markdown: `**修复建议**\n\n${f.remediation}` },
        defaultConfiguration: { level: SARIF_LEVEL[f.severity] || 'warning' },
        properties: {
          tags: [
            'security',
            ...f.cwe,
            ...f.owaspLlm.map((k) => `OWASP-LLM-${k}`),
            ...f.owaspAgentic.map((k) => `OWASP-${k}`),
            ...f.owaspAst.map((k) => `OWASP-${k}`),
            `category:${f.category}`,
          ],
          category: f.category,
          confidence: f.confidence,
          securitySeverity: SARIF_SECURITY_SEVERITY[f.severity] ?? 5.5,
        },
      });
    }
    return {
      ruleId: f.ruleId,
      level: SARIF_LEVEL[f.severity] || 'warning',
      message: { text: f.description },
      locations: [{
        physicalLocation: {
          // Skill-relative, never absolute: an absolute path would carry the
          // user's directory layout into whatever receives this file.
          artifactLocation: { uri: f.file.replace(/\\/g, '/') },
          ...(typeof f.line === 'number' ? { region: { startLine: f.line } } : {}),
        },
      }],
      partialFingerprints: { 'skillSentryFingerprint/v1': f.fingerprint },
      properties: {
        category: f.category,
        confidence: f.confidence,
        severity: f.severity,
        originalSeverity: f.originalSeverity,
        context: f.context,
        demoted: f.demoted,
        hardBlock: f.hardBlock,
        cwe: f.cwe,
        owaspLlm: f.owaspLlm,
        owaspAgentic: f.owaspAgentic,
        owaspAst: f.owaspAst,
        remediation: f.remediation,
        ...(f.derived ? { derived: f.derived } : {}),
      },
    };
  });

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [{
      tool: {
        driver: {
          name: 'skill-sentry',
          version: evidence.scannerVersion,
          informationUri: 'https://github.com/bonc-ai/cogseed',
          rules: [...seen.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))),
        },
      },
      results,
      invocations: [{ executionSuccessful: evidence.outcome !== 'unknown' }],
      properties: {
        rulesetVersion: evidence.rulesetVersion,
        scanTier: evidence.scanTier,
        ...(evidence.score !== null ? { securityScore: evidence.score } : {}),
        ...(evidence.recommendation ? { recommendation: evidence.recommendation } : {}),
        ...(evidence.riskClassification ? { riskClassification: evidence.riskClassification } : {}),
      },
    }],
  };
}

/** RFC 4180 CSV. Escapes quotes and newlines so Excel does not shred the rows. */
export function toCsv(evidence: SecurityEvidence): string {
  const header = ['skillId', 'ruleId', 'severity', 'originalSeverity', 'confidence',
    'category', 'file', 'line', 'cwe', 'owaspLlm', 'owaspAgentic', 'context',
    'suppressed', 'description', 'remediation'];
  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = evidence.findings.map((f) => [
    evidence.skillId, f.ruleId, f.severity, f.originalSeverity, f.confidence,
    f.category, f.file, f.line ?? '', f.cwe.join(' '), f.owaspLlm.join(' '),
    f.owaspAgentic.join(' '), f.context, f.suppressed ? 'yes' : '', f.description, f.remediation,
  ].map(cell).join(','));
  // BOM so Excel on Windows reads the Chinese text as UTF-8.
  return `\uFEFF${[header.join(','), ...rows].join('\n')}\n`;
}

/** A one-page human report, for pasting into a ticket or a chat. */
export function toMarkdown(evidence: SecurityEvidence): string {
  const lines: string[] = [];
  lines.push(`# 安全扫描报告 — ${evidence.skillId}`);
  lines.push('');
  lines.push(`- 结论：**${evidence.recommendation || evidence.outcome}**`);
  lines.push(`- 评分：${evidence.score ?? '—'}/100（${evidence.riskClassification || '—'}）`);
  lines.push(`- 扫描时间：${evidence.scannedAt}`);
  lines.push(`- 引擎：skill-sentry ${evidence.scannerVersion || '—'} · 规则包 ${evidence.rulesetVersion || '—'}`);
  lines.push(`- 扫描档位：${evidence.scanTier === 'sandboxed' ? '沙箱隔离' : '静态（未隔离）'}`);
  if (evidence.rulesDegraded) lines.push('- ⚠️ 规则库未完整加载，本次检查覆盖面较弱');
  if (!evidence.isolated) lines.push('- 非隔离扫描，结果可信度较低');
  lines.push('');
  const counts = evidence.severityCounts;
  lines.push(`## 发现分布`);
  lines.push('');
  lines.push(`严重 ${counts.critical ?? 0} · 高 ${counts.high ?? 0} · 中 ${counts.medium ?? 0} · 低 ${counts.low ?? 0} · 提示 ${counts.info ?? 0}`);
  lines.push('');
  const active = evidence.findings.filter((f) => !f.suppressed);
  if (active.length) {
    lines.push('## 发现明细');
    lines.push('');
    lines.push('| 严重级 | 规则 | 位置 | 类别 | 置信度 | CWE |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const f of active) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`| ${f.severity} | ${f.ruleId} | ${loc} | ${f.category} | ${f.confidence} | ${f.cwe.join(' ')} |`);
    }
    lines.push('');
    const fixed = active.slice(0, 10);
    lines.push('## 修复建议（前 10 条）');
    lines.push('');
    for (const f of fixed) {
      lines.push(`- **${f.ruleId}** — ${f.description}`);
      if (f.remediation) lines.push(`  - ${f.remediation}`);
    }
    lines.push('');
  } else {
    lines.push('本次扫描未发现需要处理的问题。');
    lines.push('');
  }
  if (evidence.baseline?.suppressedFindings) {
    lines.push(`> 另有 ${evidence.baseline.suppressedFindings} 条命中已被风险接受（未计入评分）。`);
    lines.push('');
  }
  if (evidence.limitations.length) {
    lines.push('## 已知局限');
    lines.push('');
    for (const l of evidence.limitations) lines.push(`- ${l}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Findings a SARIF export will contain. See `toSarif`. */
export function sarifResultCount(evidence: SecurityEvidence): number {
  return evidence.findings.filter((f) => f.severity !== 'info').length;
}

export function exportSecurityPayload(
  evidence: SecurityEvidence,
  format: 'json' | 'sarif' | 'csv' | 'markdown',
): string {
  switch (format) {
    case 'sarif': return JSON.stringify(toSarif(evidence), null, 2);
    case 'csv': return toCsv(evidence);
    case 'markdown': return toMarkdown(evidence);
    default: return JSON.stringify(evidence, null, 2);
  }
}
