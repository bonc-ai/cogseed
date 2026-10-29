/** 审批字段白名单、渲染标签和四语词条保持一致。
 * tags 使用本地化标签；已下线的 sensitivity 和不可达 title 字段不恢复。
 * 异常输入的裸键兜底只作防御行为，不扩大生产写入白名单。 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rendererRoot = path.join(__dirname, '../../src/renderer');
const repoRoot = path.join(__dirname, '../..');
const locale: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(rendererRoot, 'locales/zh.json'), 'utf8'),
);

const root = globalThis as any;
root.t = (key: string, vars?: Record<string, unknown>): string => {
  const raw = typeof locale[key] === 'string' ? locale[key] : key;
  return Object.entries(vars || {}).reduce(
    (acc, [name, value]) => acc.split(`{${name}}`).join(String(value)),
    raw,
  );
};
root.uiIconHtml = () => '';
root.createLogger = () => ({ warn: () => {} });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const loadRendererModule = (name: string): any => require(path.join(rendererRoot, 'modules', name));
loadRendererModule('ui-button.js');
loadRendererModule('ui-status.js');
loadRendererModule('ui-form.js');
const card = loadRendererModule('chat-asset-approval.js') as {
  cardHtml: (payload: any, view: any) => string;
};

const PROPOSAL_ID = 'ap-r8probe0000000000abcdef';

function payloadWithFields(fields: string[]) {
  return {
    kind: 'asset_change_approval',
    proposalId: PROPOSAL_ID,
    assetId: 'aa-r8-probe',
    assetTitle: '探针资产',
    baselineVersion: '2',
    diff: { before: 'statement=…', after: 'statement=…', fields },
    reason: '探针：字段标签渲染',
    actions: ['confirm', 'defer', 'reject'],
  };
}

describe('审批字段的白名单、标签和词条一致性', () => {
  beforeEach(() => { delete root.__probeLoaded; });

  it('对照组：tags 字段渲染本地化「标签」而非裸键名', () => {
    const html = card.cardHtml(payloadWithFields(['tags']), {});
    expect(html).toContain('标签');
    expect(locale['cognition.asset_edit_field_tags']).toBe('标签'); // 中文标签取自现有词条。
  });

  it('sensitivity 随敏感级下线三方收口：FIELD_LABELS 无行、四语无死键、不复活', () => {
    // sensitivity 不在生产写入白名单；异常 diff 输入仍由 String(key) 兜底，
    // 不为它恢复已下线的标签行。
    const html = card.cardHtml(payloadWithFields(['sensitivity']), {});
    expect(html).toContain('sensitivity'); // 裸键名兜底（防御行为不变）
    expect(html).not.toContain('敏感'); // renderer zh 表无任何 sensitivity 语义词条命中
    // 渲染层源码不得再补 sensitivity 标签行（补行=复活已下线的敏感级接口）。
    const rendererSrc = fs.readFileSync(
      path.join(rendererRoot, 'modules/chat-asset-approval.js'), 'utf8',
    );
    expect(rendererSrc).not.toMatch(/sensitivity:\s*\[/);
  });

  it('契约矩阵断言：白名单无 sensitivity/title；main 四语死键已删；renderer 表无键', () => {
    // ① 工具层白名单（asset-steward-tools.ts SUBSTANTIAL_FIELDS，源码级断言防 import 主进程模块）
    const tools = fs.readFileSync(
      path.join(repoRoot, 'src/main/model/core-agent/asset-steward-tools.ts'), 'utf8',
    );
    const m = tools.match(/SUBSTANTIAL_FIELDS = (\[[^\]]*\])/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain("'tags'");
    expect(m![1]).not.toContain('sensitivity'); // 白名单挡住 → 渲染缺口当前不可达
    expect(m![1]).not.toContain("'title'");
    // ② main 四语死键已随下线收口删除（原断言反转；防回流兜底在
    //    cognition-i18n-deadkeys-batch.test.ts 的 MAIN_DEAD_KEYS）
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      const main = JSON.parse(fs.readFileSync(path.join(repoRoot, `src/main/locales/${lang}.json`), 'utf8'));
      expect(main['recall.asset_approval.field_sensitivity']).toBeUndefined(); // 死键已删
    }
    // ③ renderer 表无此键（三方从未对齐，收口后也不得出现）
    expect(locale['recall.asset_approval.field_sensitivity']).toBeUndefined();
  });
});
