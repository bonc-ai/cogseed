/**
 * S4 停用被引用的技能（specs/009 FR-027、UI-07）：停用前反查在用的智能体并确认；取消不改任何东西。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf8');

function load(agents: any[], confirmResult: boolean): any {
  const calls: Array<{ channel: string; payload: any }> = [];
  const asked: Array<{ action: string; name: string; names: string[] }> = [];
  const window: any = {
    addEventListener() {}, removeEventListener() {},
    cogseed: {
      invoke: async (channel: string, payload: any) => {
        calls.push({ channel, payload });
        if (channel === 'agents.list') return { agents };
        return { ok: true };
      },
    },
  };
  window.window = window;
  const context: any = {
    window, console, setTimeout, clearTimeout, calls, asked,
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    createLogger: () => ({ warn() {}, error() {}, info() {} }),
    t: (key: string) => key,
    escapeHtml: (v: string) => String(v),
    uiAlert: async () => {},
    catalogConfirmDependents: async (action: string, name: string, names: string[]) => { asked.push({ action, name, names }); return confirmResult; },
    loadSkills: async () => {},
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'skills.js' });
  return context;
}

const agents = [
  { agent_id: 'a1', name: '报销助手', enabled: true, skill_list: ['invoice'] },
  { agent_id: 'a2', name: '已停用的', enabled: false, skill_list: ['invoice'] },
  { agent_id: 'a3', name: '无关的', enabled: true, skill_list: ['other'] },
];

describe('停用被引用的技能', () => {
  it('反查只算启用中、确实引用了它的智能体', async () => {
    const ctx = load(agents, true);
    expect(await vm.runInContext('_skillDependentAgentNames', ctx)('invoice')).toEqual(['报销助手']);
  });

  it('智能体里写的是技能名（旧写法）也算在用', async () => {
    const ctx = load([{ agent_id: 'old', name: '老报销助手', enabled: true, skill_list: ['发票抽取'] }], true);
    vm.runInContext('_skillsCache = [{ id: "invoice", name: "发票抽取" }]', ctx);
    expect(await vm.runInContext('_skillDependentAgentNames', ctx)('invoice')).toEqual(['老报销助手']);
  });

  it('取消：不调用 skills.setEnabled', async () => {
    const ctx = load(agents, false);
    expect(await vm.runInContext('_flipSkillEnabled', ctx)('invoice', false)).toBe(false);
    expect(ctx.asked[0]).toMatchObject({ action: 'disable', names: ['报销助手'] });
    expect(ctx.calls.some((c: any) => c.channel === 'skills.setEnabled')).toBe(false);
  });

  it('确认：停用，并刷新智能体（依赖状态随之变化）', async () => {
    const ctx = load(agents, true);
    let agentsReloaded = 0;
    ctx.loadAgents = async () => { agentsReloaded++; };
    expect(await vm.runInContext('_flipSkillEnabled', ctx)('invoice', false)).toBe(true);
    expect(ctx.calls).toContainEqual({ channel: 'skills.setEnabled', payload: { id: 'invoice', enabled: false } });
    expect(agentsReloaded).toBe(1);
  });

  it('没人在用：直接停用，不提示', async () => {
    const ctx = load(agents, false);
    expect(await vm.runInContext('_flipSkillEnabled', ctx)('lonely', false)).toBe(true);
    expect(ctx.asked).toHaveLength(0);
  });

  it('启用不提示', async () => {
    const ctx = load(agents, false);
    expect(await vm.runInContext('_flipSkillEnabled', ctx)('invoice', true)).toBe(true);
    expect(ctx.asked).toHaveLength(0);
  });
});
