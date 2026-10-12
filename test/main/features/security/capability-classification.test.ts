/**
 * Capability classification on the guardrail status surface.
 *
 * The bug this file guards against is a wording bug with a real cost: the status
 * page opened on "以下能力处于降级状态：密钥检测、依赖漏洞扫描" on a machine that
 * simply had not installed two *optional* tools. Three capabilities were reported
 * as degraded, and reading that as "my install is broken" was the correct reading
 * of what it said.
 *
 * Only one of the three was a genuine gap:
 *   secret_detection            — 70 built-in patterns + entropy detection run on
 *                                 every scan. gitleaks widens coverage; it does not
 *                                 decide whether the capability exists.
 *   dependency_vulnerability_scan — nothing native. Without osv-scanner there is no
 *                                 vulnerability database to query at all.
 *   malware_signature_matching  — a native indicator table, honestly a subset.
 *
 * So `needs_tool` was split out of `degraded`. These assertions are relations, not
 * fixed values, because whether gitleaks/osv-scanner are installed differs per
 * machine and must not change the classification.
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

  it('reports the CVE lookup as needs_tool, never as degraded', () => {
    const dep = byId.get('dependency_vulnerability_scan');
    // Nothing native exists here, so "we run it with less coverage" would be false.
    expect(dep?.status).toBe(toolAvailable('osv-scanner') ? 'implemented' : 'needs_tool');
    expect(dep?.status).not.toBe('degraded');
    if (!toolAvailable('osv-scanner')) expect(dep?.reason).toBe('no_osv_scanner');
  });

  it('does not call anything degraded just because an optional tool is missing', () => {
    const degraded = status.capabilities.filter((c) => c.status === 'degraded');
    // `degraded` must mean "the engine runs this with less coverage", and no
    // capability is in that state today. If one appears, it needs a stated
    // coverage loss that is not merely a missing optional tool.
    expect(degraded.map((c) => c.id)).toEqual([]);
    expect(status.capabilities.filter((c) => c.status === 'needs_tool').length).toBeLessThanOrEqual(1);
  });

  it('keeps malware signature matching honest as a subset', () => {
    // A native indicator table exists, so this is not `absent`; its coverage is a
    // hand-maintained subset, so it is not `implemented` either.
    expect(byId.get('malware_signature_matching')?.status).toBe('partial');
  });
});
