import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadModule(): { reviewItemModel: (item: Record<string, unknown>) => Record<string, unknown> } {
  const moduleBox = { exports: {} as Record<string, unknown> };
  const context = { module: moduleBox, document: {}, window: {} };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/personal-context-review.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'personal-context-review.js' });
  return moduleBox.exports as { reviewItemModel: (item: Record<string, unknown>) => Record<string, unknown> };
}

describe('personal context review renderer', () => {
  it('exposes source and evidence for a candidate', () => {
    const module = loadModule();
    const model = module.reviewItemModel({
      candidateId: 'candidate-1',
      summary: '产品评审',
      source: { title: '我的日历', type: 'calendar_event', updatedAt: '2026-08-10T10:00:00Z' },
      evidence: [{ excerpt: '2026-08-11 09:00 产品评审', sourceUrl: 'https://example.test/event-1' }],
      state: 'pending',
    });
    expect(model.summary).toBe('产品评审');
    expect(model.sourceLabel).toContain('我的日历');
    expect(model.evidenceCount).toBe(1);
  });
});
