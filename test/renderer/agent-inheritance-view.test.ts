import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSrc(rel: string): string {
  return readFileSync(resolve(__dirname, `../../src/renderer/${rel}`), 'utf8');
}

function loadLocale(name: string) {
  return JSON.parse(readSrc(`locales/${name}.json`));
}

const LOCALES = ['en', 'zh', 'ja', 'pt'];

const KEYS = [
  'agents.label_inheritance',
  'agents.inheritance_desc',
  'agents.inheritance_none_recorded',
  'agents.inheritance_empty',
  'agents.inheritance_excluded_label',
  'agents.inheritance_excluded_user',
  'agents.inheritance_excluded_paused',
  'agents.inheritance_excluded_archived',
  'agents.inheritance_excluded_revoked',
  'agents.inheritance_excluded_deleted',
  'agents.inheritance_excluded_purged',
];

describe('出生继承视图的 i18n', () => {
  it('四种语言都定义了全部文案', () => {
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      for (const key of KEYS) {
        expect(data[key], `${locale} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it('六种未继承原因各有各的文案，不共用一句笼统说法', () => {
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      const reasons = KEYS.filter((k) => k.startsWith('agents.inheritance_excluded_') && k !== 'agents.inheritance_excluded_label');
      const texts = reasons.map((k) => data[k]);
      expect(new Set(texts).size, `${locale} 有原因文案重复`).toBe(reasons.length);
    }
  });

  it('「没有继承记录」与「继承为空」是两句不同的话', () => {
    // 这是这个视图存在的意义：一个是「当时还没有这套机制」，一个是「确实没东西可继承」。
    // 两者说成同一句，用户会以为自己教过的东西丢了。
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      expect(data['agents.inheritance_none_recorded']).not.toBe(data['agents.inheritance_empty']);
    }
  });

  it('用户勾掉的措辞与系统按状态排除的措辞不能一样', () => {
    // user_excluded 是人的决定，其余是资产状态决定的——用户要能分清是不是自己做的。
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      for (const key of ['paused', 'archived', 'revoked', 'deleted', 'purged']) {
        expect(data['agents.inheritance_excluded_user'])
          .not.toBe(data[`agents.inheritance_excluded_${key}`]);
      }
    }
  });
});

describe('出生继承视图的接线', () => {
  it('详情页有继承区块，默认隐藏', () => {
    const html = readSrc('index.html');
    expect(html).toContain('id="agents-detail-inheritance-section"');
    expect(html).toContain('id="agents-detail-inheritance"');
    expect(html).toContain('data-i18n="agents.label_inheritance"');
  });

  it('ipc-shim 有 agents.inheritance 的路由', () => {
    const shim = readSrc('modules/ipc-shim.js');
    expect(shim).toContain("'agents.inheritance'");
    expect(shim).toMatch(/\/inheritance\$\//);
  });

  it('渲染函数把 null 与空数组分开处理', () => {
    const src = readSrc('modules/agents.js');
    // null 走 none_recorded，空数组走 empty——两个分支必须都在。
    expect(src).toContain('agents.inheritance_none_recorded');
    expect(src).toContain('agents.inheritance_empty');
    expect(src).toContain('_renderAgentDetailInheritance');
  });

  it('六种排除原因在渲染层都有对应分支', () => {
    const src = readSrc('modules/agents.js');
    // 后端的 reason 取值 → 文案 key（user_excluded 的 key 刻意短一截）
    const branches: Record<string, string> = {
      user_excluded: 'agents.inheritance_excluded_user',
      paused: 'agents.inheritance_excluded_paused',
      archived: 'agents.inheritance_excluded_archived',
      revoked: 'agents.inheritance_excluded_revoked',
      deleted: 'agents.inheritance_excluded_deleted',
      purged: 'agents.inheritance_excluded_purged',
    };
    for (const [reason, key] of Object.entries(branches)) {
      expect(src, `渲染层缺 ${reason} 分支`).toContain(key);
      expect(src, `渲染层没有匹配 ${reason} 这个取值`).toContain(`'${reason}'`);
    }
  });
});
