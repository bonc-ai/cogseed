/**
 * Capability classification on the guardrail status surface.
 *
 * The original bug this file guarded against was a wording bug with a real cost:
 * the page opened on "以下能力处于降级状态：密钥检测、依赖漏洞扫描" on a machine
 * that simply had not installed two *optional* tools — three capabilities were
 * reported as degraded, and reading that as "my install is broken" was the
 * correct reading of what it said.
 *
 * The fix at the time split `needs_tool` out of `degraded` and classified:
 *   secret_detection              — implemented (built-in rules; gitleaks is an
 *                                   enhancement, not the deliverable).
 *   dependency_vulnerability_scan — needs_tool (no native delivery at all).
 *   malware_signature_matching    — partial (hand-maintained indicator table).
 *
 * 2.3.0 closed the other two gaps natively: the ruleset now ships an OSV
 * snapshot and a YARA signature pack, so both are `implemented` for the same
 * reason secret_detection is, and the remaining optional tool (osv-scanner)
 * widens coverage instead of deciding whether the capability exists. These
 * assertions are still relations rather than fixed counts, because a packaged
 * tree may legitimately ship a different snapshot size or rule count.
 */
import { describe, expect, it } from 'vitest';

import { guardrailStatus } from '../../../../src/main/features/security/guardrail-status';

describe('guardrail capability classification', () => {
  const status = guardrailStatus();
  const byId = new Map(status.capabilities.map((c) => [c.id, c]));
  const toolAvailable = (id: string) =>
    status.externalTools.find((t) => t.id === id)?.available === true;

  it('reads the real packaged scanner and its pin', () => {
    // If this fails the rest of the file is measuring nothing. It also catches a
    // stale integrity pin, which makes the scanner refuse to load entirely — not
    // a display problem.
    expect(status.scanner).toBe('present');
    expect(status.scannerIntegrity).toBe('verified');
    expect(status.capabilities.length).toBeGreaterThan(15);
  });

  it('keeps secret_detection implemented whether or not gitleaks is installed', () => {
    // The built-in rule set is the deliverable. A missing enhancement must not
    // downgrade the capability — that is exactly what produced "3 项降级".
    const secret = byId.get('secret_detection');
    expect(secret?.status).toBe('implemented');
    expect(secret?.reason).toBeUndefined();
  });

  it('reports the CVE lookup as implemented from the shipped snapshot', () => {
    const dep = byId.get('dependency_vulnerability_scan');
    expect(dep?.status).toBe('implemented');
    expect(dep?.reason).toBeUndefined();
    // The snapshot is the deliverable; without it the only honest states are
    // `needs_tool` (no database, no osv-scanner) — never a silent "implemented".
    expect(status.signaturePacks.vulnerabilityDb?.entries).toBeGreaterThan(1000);
    expect(status.signaturePacks.vulnerabilityDb?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // osv-scanner remains an optional widening; it must stay visible as such.
    expect(status.externalTools.map((t) => t.id)).toContain('osv-scanner');
    void toolAvailable;
  });

  it('reports the malware matcher as implemented from the YARA pack', () => {
    const malware = byId.get('malware_signature_matching');
    expect(malware?.status).toBe('implemented');
    expect(malware?.reason).toBeUndefined();
    // A pack that fails to load would make `implemented` a lie; the count is the
    // machine-readable evidence that rules are actually present.
    expect(status.signaturePacks.yaraRules).toBeGreaterThan(20);
  });

  it('does not call anything degraded just because an optional tool is missing', () => {
    const degraded = status.capabilities.filter((c) => c.status === 'degraded');
    // `degraded` must mean "the engine runs this with less coverage", and no
    // capability is in that state today. If one appears, it needs a stated
    // coverage loss that is not merely a missing optional tool.
    expect(degraded.map((c) => c.id)).toEqual([]);
    // Both former gaps are now native, so nothing should be waiting on a tool.
    expect(status.capabilities.filter((c) => c.status === 'needs_tool')).toEqual([]);
  });
});
