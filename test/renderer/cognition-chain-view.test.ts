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

const STAGES = ['formation', 'settling', 'inheritance', 'use', 'evidence'];

/** 与选择层 WithheldReason 加渲染侧两个（needs_confirmation / truncated）对齐。 */
const WITHHELD_REASONS = [
  'scope_agent_not_allowed',
  'scope_role_not_allowed',
  'scope_project_not_allowed',
  'scope_workspace_not_allowed',
  'sensitivity_above_destination',
  'sensitivity_unclassified',
  'asset_paused',
  'asset_archived',
  'asset_revoked',
  'asset_deleted',
  'asset_purged',
  'use_policy_never',
  'asset_missing',
  'content_changed',
  'version_changed',
  'needs_confirmation',
  'truncated',
];

describe('使用与证明视图的 i18n', () => {
  it('五段名在四种语言里都有', () => {
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      for (const stage of STAGES) {
        expect(data[`cognition.chain_stage_${stage}`], `${locale} 缺 ${stage}`).toBeTruthy();
      }
    }
  });

  it('段名用用户语言，不漏实现名', () => {
    // Capability Pack / ContextReuseReceipt 是实现名，只能出现在开发者视角，
    // 不能出现在用户看得见的段名里。
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      const text = STAGES.map((s) => data[`cognition.chain_stage_${s}`]).join(' ');
      expect(text).not.toMatch(/capability pack|contextreusereceipt|receipt|回执|能力包/i);
    }
  });

  it('段名不带进度语义——不能说成「未完成」「待完成」', () => {
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      const text = STAGES.map((s) => data[`cognition.chain_stage_${s}`]).join(' ');
      expect(text).not.toMatch(/未完成|待完成|缺失|pending|incomplete|unfinished/i);
    }
  });
});

describe('未带入原因的文案', () => {
  it('每种原因都有对应文案，不落到显示机器码', () => {
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      const src = readSrc('modules/skills.js');
      for (const reason of WITHHELD_REASONS) {
        expect(src, `渲染层没有映射 ${reason}`).toContain(`${reason}:`);
      }
      expect(data['cognition.withheld_unknown'], `${locale} 缺兜底文案`).toBeTruthy();
    }
  });

  it('原因文案互不重复——否则用户分不清是被拦了还是挤掉了', () => {
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      const keys = Object.keys(data).filter((k) => k.startsWith('cognition.withheld_'));
      const texts = keys.map((k) => data[k]);
      expect(new Set(texts).size, `${locale} 有原因文案重复`).toBe(keys.length);
    }
  });

  it('「等你确认」与「放不下」是两句不同的话', () => {
    // 一个是权限决定，一个是资源限制，处理动作完全不同。
    for (const locale of LOCALES) {
      const data = loadLocale(locale);
      expect(data['cognition.withheld_needs_confirmation'])
        .not.toBe(data['cognition.withheld_truncated']);
    }
  });
});

describe('使用与证明的接线', () => {
  it('资产动作里有履历入口，彻底清除后仍然保留', () => {
    const src = readSrc('modules/skills.js');
    expect(src).toContain("cognition.asset_action_chain");
    // purged 只剩版本与履历：墓碑没有内容可治理，但它被谁带走过是既成事实。
    expect(src).toMatch(/status === 'purged'\) return \['versions', 'chain'\]/);
  });

  it('bindings 里有加载与关闭两条路径', () => {
    const bindings = readSrc('modules/skills-bindings.js');
    expect(bindings).toContain("recall.cognitionChain.read");
    expect(bindings).toContain("recall.usage.list");
    expect(bindings).toContain('data-recall-asset-chain-close');
  });

  it('使用记录取不到不影响履历打开', () => {
    // 履历本身来自回执，使用记录只是补充——它挂了不该让整个面板打不开。
    const bindings = readSrc('modules/skills-bindings.js');
    expect(bindings).toMatch(/recall\.usage\.list[^\n]*\.catch\(\(\) => null\)/);
  });

  it('not_yet 只是更淡，不用警告色也不加图标', () => {
    // 这是履历不是进度条：没发生就是还没发生，不是欠着一步。
    const css = readSrc('recall-local.css');
    // 选择器可能跨多行，取从第一次出现 is-not-yet 到该规则块结束的整段。
    const start = css.indexOf('.cognition-chain-segment.is-not-yet');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}', start) + 1);
    expect(rule).toContain('muted');
    expect(rule).not.toMatch(/danger|warning|--red|#ef4444|#dc2626/i);
  });
});
