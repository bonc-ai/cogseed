import { describe, expect, it } from 'vitest';
import { buildP3394MappingReport, validateP3394MappingReport, P3394_REQUIRED_UMF_FIELDS } from '../../../../src/main/features/p3394_bridge/reduced-profiles';

describe('P3394 reduced profiles and mapping reports (guide §12, SDK §13)', () => {
  it('builds a full-preservation report for native P3394 targets', () => {
    const report = buildP3394MappingReport('p3394-native');
    expect(report.session_semantics).toBe('full');
    for (const field of P3394_REQUIRED_UMF_FIELDS) {
      const mapping = report.fields.find((f) => f.field === field);
      expect(mapping?.disposition).toBe('preserved');
    }
    expect(validateP3394MappingReport(report).ok).toBe(true);
  });

  it('maps session/task/parts onto A2A contextId/taskId/message.parts', () => {
    const report = buildP3394MappingReport('a2a');
    expect(report.session_semantics).toBe('binding-mapped');
    const session = report.fields.find((f) => f.field === 'session_id');
    expect(session).toMatchObject({ disposition: 'synthesized', target: 'contextId' });
    const parts = report.fields.find((f) => f.field === 'payload.parts');
    expect(parts).toMatchObject({ disposition: 'synthesized', target: 'message.parts' });
    expect(report.fields.find((f) => f.field === 'kind')?.disposition).toBe('dropped');
    expect(validateP3394MappingReport(report).ok).toBe(true);
  });

  it('declares restricted semantics for MCP and local-bridge for model APIs', () => {
    const mcp = buildP3394MappingReport('mcp');
    expect(mcp.session_semantics).toBe('restricted');
    expect(mcp.fields.find((f) => f.field === 'recipients')?.disposition).toBe('synthesized');
    expect(validateP3394MappingReport(mcp).ok).toBe(true);

    const model = buildP3394MappingReport('openai-model');
    expect(model.session_semantics).toBe('local-bridge');
    expect(model.fields.find((f) => f.field === 'session_id')).toMatchObject({ disposition: 'synthesized', target: 'bridge-held session' });
    expect(validateP3394MappingReport(model).ok).toBe(true);
  });

  it('rejects reports that drop required UMF fields', () => {
    const report = buildP3394MappingReport('proprietary');
    const reportWithDrop = { ...report, fields: report.fields.map((f) => (f.field === 'session_id' ? { ...f, disposition: 'dropped' as const } : f)) };
    const validated = validateP3394MappingReport(reportWithDrop);
    expect(validated.ok).toBe(false);
    if (validated.ok) throw new Error('expected failure');
    expect(validated.error.reason).toBe('required_field_dropped');
    expect(validated.error.field).toBe('session_id');
  });
});
