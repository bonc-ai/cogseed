import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

interface FakeElement {
  className: string;
  hidden: boolean;
  textContent: string;
  style: Record<string, string>;
  children: FakeElement[];
  appendChild(child: FakeElement): FakeElement;
  replaceChildren(...children: FakeElement[]): void;
}

function createElement(): FakeElement {
  return {
    className: '',
    hidden: false,
    textContent: '',
    style: {},
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
  };
}

describe('reimbursement management setup view', () => {
  it('renders the protected Feishu setup card when configuration is not ready', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/modules/expense-workbench.js'), 'utf8');
    const host = createElement();
    const detail = createElement();
    const chat = createElement();
    const mounted: Array<{ agent_id: string }> = [];
    const elements: Record<string, FakeElement> = {
      'agent-management-surface': host,
      'agents-detail-content': detail,
      'agents-chat-col': chat,
    };
    const windowLike: Record<string, unknown> = {
      orkas: { invoke: async () => ({ ok: true, result: { configured: false, ready: false } }) },
      mountExpenseSetupCard: (_target: FakeElement, payload: { agent_id: string }) => mounted.push(payload),
      addEventListener: () => undefined,
    };
    const context = vm.createContext({
      window: windowLike,
      document: {
        getElementById: (id: string) => elements[id] || null,
        createElement: () => createElement(),
      },
      t: (key: string) => key,
    });
    vm.runInContext(source, context);

    const open = windowLike.openExpenseWorkbench as (agentId: string) => Promise<void>;
    await open('c045605cb916');

    expect(host.hidden).toBe(false);
    expect(detail.style.display).toBe('none');
    expect(chat.style.display).toBe('none');
    expect(host.children[0]?.className).toBe('expense-agent-management');
    expect(mounted[mounted.length - 1]).toEqual({ agent_id: 'c045605cb916' });
  });
});
