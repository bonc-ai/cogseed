import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../../src/renderer/modules/evolution/pages.js');

describe('P3394 execution observability renderer', () => {
  it('renders baseline/treatment, receipt scope, counts, and boundary without raw output', () => {
    const html = P.renderExecutionObservability({
      contrast: {
        contrastId: 'contrast-1', boundary: 'test-double', changed: true,
        baseline: { status: 'completed', artifactIds: ['a1'], outputHash: 'hash-secret-baseline' },
        treatment: { status: 'failed', artifactIds: ['a2', 'a3'], outputHash: 'hash-secret-treatment' },
      },
      receipt: {
        reusedRefs: ['memory:decision-1'], omittedRefs: ['memory:private-1'],
        permissionMode: 'workspace-write', boundary: 'test-double', status: 'completed',
      },
    });
    expect(html).toContain('Baseline');
    expect(html).toContain('Treatment');
    expect(html).toContain('completed');
    expect(html).toContain('failed');
    expect(html).toContain('memory:decision-1');
    expect(html).toContain('memory:private-1');
    expect(html).toContain('workspace-write');
    expect(html).toContain('测试替身');
    expect(html).toContain('2');
    expect(html).not.toContain('hash-secret-baseline');
    expect(html).not.toContain('hash-secret-treatment');
  });
  it('renders normalized validator status and counts', () => {
    const html = P.renderValidationRun({ status: 'blocked', validatorVersion: '0.3.0', scannedFiles: 3, violations: [{ rule: 'x' }], boundary: 'real' });
    expect(html).toContain('阻断'); expect(html).toContain('0.3.0'); expect(html).toContain('3'); expect(html).toContain('真实执行');
  });

});
