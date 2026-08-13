import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

interface MockNode {
  textContent: string;
  dataset: Record<string, string>;
  children: MockNode[];
  className: string;
  append(...nodes: MockNode[]): void;
  appendChild(node: MockNode): void;
  setAttribute(name: string, value: string): void;
}

function loadModule(): { viewModel: (dashboard: Record<string, unknown>) => Record<string, unknown> } {
  const moduleBox = { exports: {} as Record<string, unknown> };
  const context = {
    module: moduleBox,
    document: { createElement: () => ({}) },
    window: {},
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/personal-context-center.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'personal-context-center.js' });
  return moduleBox.exports as { viewModel: (dashboard: Record<string, unknown>) => Record<string, unknown> };
}

void ({} as MockNode);

describe('personal context center renderer', () => {
  it('shows real connection as the primary path', () => {
    const module = loadModule();
    const model = module.viewModel({
      mode: 'real',
      authorization: { kind: 'ready_to_authorize' },
      resources: { discovered: 0, selected: 0, ready: 0, failed: 0 },
      review: { pending: 0, confirmed: 0, rejected: 0 },
      briefing: { state: 'not_configured' },
    });
    expect(model.primaryAction).toBe('authorize.begin');
    expect(model.badge).toBe('真实连接');
  });

  it('marks demo mode without changing the real authorization wording', () => {
    const module = loadModule();
    const model = module.viewModel({
      mode: 'demo',
      authorization: { kind: 'connected' },
      resources: { discovered: 4, selected: 2, ready: 2, failed: 0 },
      review: { pending: 2, confirmed: 0, rejected: 0 },
      briefing: { state: 'preview_ready' },
    });
    expect(model.badge).toBe('演示模式');
    expect(model.primaryAction).toBe('sync.start');
  });
});
