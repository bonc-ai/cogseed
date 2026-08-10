import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadModule(): { briefingViewModel: (briefing: Record<string, unknown>) => Record<string, unknown> } {
  const moduleBox = { exports: {} as Record<string, unknown> };
  const context = { module: moduleBox, document: {}, window: {} };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/briefing-center.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'briefing-center.js' });
  return moduleBox.exports as { briefingViewModel: (briefing: Record<string, unknown>) => Record<string, unknown> };
}

describe('briefing center renderer', () => {
  it('allows preview before delivery is configured', () => {
    const module = loadModule();
    const model = module.briefingViewModel({ state: 'preview_ready', canDeliver: false, sections: [{ id: 'today', title: '今日安排' }] });
    expect(model.previewVisible).toBe(true);
    expect(model.deliveryEnabled).toBe(false);
    expect(model.sectionCount).toBe(1);
  });

  it('keeps failed delivery retryable', () => {
    const module = loadModule();
    const model = module.briefingViewModel({ state: 'delivery_failed', canDeliver: true, lastDelivery: { retryable: true } });
    expect(model.retryVisible).toBe(true);
  });
});
