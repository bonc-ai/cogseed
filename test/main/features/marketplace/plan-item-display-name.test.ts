import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const ID = '0d95910c7f2f';

async function load() {
  return (await import('../../../../src/main/features/marketplace')).planItemDisplayName;
}

function lookups(local: Record<string, string> = {}, catalog: Record<string, string> = {}) {
  const calls: string[] = [];
  return {
    calls,
    local: async (id: string) => { calls.push(`local:${id}`); return local[id] || ''; },
    catalog: async (id: string) => { calls.push(`catalog:${id}`); return catalog[id] || ''; },
  };
}

describe('安装预览：依赖项的显示名', () => {
  it('复用的技能显示本机名字，而不是 12 位编号，并且不必再问目录', async () => {
    const name = await load();
    const l = lookups({ [ID]: 'meeting-actions' });
    expect(await name({ id: ID, kind: 'hub', action: 'reuse' }, l)).toBe('meeting-actions');
    expect(l.calls).toEqual([`local:${ID}`]);
  });

  it('要下载安装的技能本机没有，只问目录', async () => {
    const name = await load();
    const l = lookups({}, { [ID]: 'meeting-actions' });
    expect(await name({ id: ID, kind: 'hub', action: 'install' }, l)).toBe('meeting-actions');
    expect(l.calls).toEqual([`catalog:${ID}`]);
  });

  it('本机读不到名字时才回退问目录，最后才是编号', async () => {
    const name = await load();
    expect(await name({ id: ID, kind: 'hub', action: 'reuse' }, lookups({}, { [ID]: 'from-catalog' }))).toBe('from-catalog');
    expect(await name({ id: ID, kind: 'hub', action: 'reuse' }, lookups())).toBe(ID);
    expect(await name({ id: ID, kind: 'hub', action: 'install' }, lookups())).toBe(ID);
  });

  it('builtin: 去掉前缀；随包技能的 id 本身就是名字', async () => {
    const name = await load();
    expect(await name({ id: 'builtin:coding', kind: 'builtin', action: 'builtin' }, lookups())).toBe('coding');
    expect(await name({ id: 'my-private-skill', kind: 'bundled', action: 'bundled' }, lookups())).toBe('my-private-skill');
  });
});

describe('本次新增的主进程提示文案：四种语言齐全、占位符一致', () => {
  const KEYS = [
    'chat.agent_skills_dropped', 'process.agent.skills_dropped',
    'chat.agent_edit_not_found', 'chat.agent_edit_marketplace_blocked', 'chat.agent_edit_external_blocked',
    'chat.agent_update_failed', 'chat.agent_create_failed_missing_fields',
    'chat.agent_create_error', 'chat.agent_edit_error',
  ];
  const load4 = () => Object.fromEntries(['zh', 'en', 'ja', 'pt'].map((l) => [
    l, JSON.parse(fs.readFileSync(path.join(__dirname, `../../../../src/main/locales/${l}.json`), 'utf8')),
  ])) as Record<string, Record<string, string>>;
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

  it.each(KEYS)('%s', (key) => {
    const t = load4();
    for (const l of ['zh', 'en', 'ja', 'pt']) expect(typeof t[l][key], `${l} 缺少 ${key}`).toBe('string');
    for (const l of ['zh', 'ja', 'pt']) expect(placeholders(t[l][key]), `${l} 占位符与 en 不一致`).toBe(placeholders(t.en[key]));
  });
});
