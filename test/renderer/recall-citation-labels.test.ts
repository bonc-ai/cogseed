// 「本次使用的记忆」卡引用行标签的词表门禁（2026-09-29）。
//
// 病灶：卡上「类型 · 范围」的白话词表只认类型 personal/rule/template/skill_method
// 与范围 global/project/agent/personal——而资产的权威取值是类型五枚
// （candidate-service.ts::AbilityAssetType，IPC recall.candidates.save 同集校验）
// 与范围契约五枚（prompts/recall_candidate_contract.md：general | report | code |
// review | product）。没进词表的取值会原样上屏（用户截图里「模板 · general」）。
//
// 本文件遍历两份权威枚举 + 历史范围值，钉三件事：
//   1) 已引用行（citations）每个取值都命中词表（渲染时真的请求了词条 key）；
//   2) 带入行（projection.assetSummaries，未被引用的行）与已引用行同一套白话；
//   3) 上述 key 四语齐全（zh/en/ja/pt——缺一门只会退回代码兜底，中文界面看不出来）。
// 枚举从源文件解析而不是硬编码：将来加第六个取值而忘了词表，这里先红。
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(__dirname, '../..');
const cardSource = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/recall-projection-card.js'), 'utf8');

const LOCALES = ['zh', 'en', 'ja', 'pt'].map((name) => ({
  name,
  table: JSON.parse(fs.readFileSync(path.join(ROOT, `src/renderer/locales/${name}.json`), 'utf8')) as Record<string, string>,
}));

function parseAssetTypes(): string[] {
  const source = fs.readFileSync(path.join(ROOT, 'src/main/features/recall/candidate-service.ts'), 'utf8');
  const match = source.match(/export type AbilityAssetType = ([^;]+);/);
  expect(match, 'AbilityAssetType 枚举行没找到（candidate-service.ts 改了定义形态？）').toBeTruthy();
  return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function parseContractScopes(): string[] {
  const source = fs.readFileSync(path.join(ROOT, 'src/main/prompts/recall_candidate_contract.md'), 'utf8');
  const match = source.match(/"suggestedScope":\s*"([^"]+)"/);
  expect(match, 'suggestedScope 契约行没找到（recall_candidate_contract.md 改了形状？）').toBeTruthy();
  return match![1].split('|').map((value) => value.trim()).filter(Boolean);
}

/** 历史数据容错的范围值（卡上原有映射，不许丢）：transcript 纠错流程仍写
 *  suggestedScope='personal'（ipc/transcript.ts），global/project/agent 是更早期
 *  口径，存量资产里可能出现。 */
const LEGACY_SCOPES = ['global', 'project', 'agent', 'personal'];

function loadCard() {
  const requested: string[] = [];
  const card: Record<string, unknown> = {
    kind: 'recall_projection_card',
    projectionId: 'proj-labels',
    status: 'confirmed',
    authorization: 'model_selected',
    purpose: 'model_selected',
    totalAssetCount: 0,
    assetSummaries: [] as Array<Record<string, unknown>>,
  };
  const host: any = { className: '', innerHTML: '', dataset: {}, addEventListener() {} };
  const context: any = {
    window: {
      cogseed: {
        invoke: async (channel: string) => {
          if (channel === 'recall.projections.card') return { ok: true, card };
          if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
          if (channel === 'recall.injections.omissions') return { ok: true, omissions: [] };
          return { ok: true };
        },
      },
      uiButton: ({ label, attrs }: { label: string; attrs?: Record<string, string> }) => {
        const extra = Object.entries(attrs || {}).map(([k, v]) => ` ${k}="${String(v)}"`).join('');
        return `<button type="button" class="btn ui-button"${extra}><span class="ui-button__label">${String(label)}</span></button>`;
      },
    },
    document: {},
    escapeHtml: (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    // 记录 + 假译：返回值 ≠ key，让标签函数走出「取到译文」分支；命中词表与否
    // 由 requested 里有没有对应 key 断言，不依赖输出文本。
    t: (key: string) => { requested.push(key); return `«${key}»`; },
    uiAlert: () => {},
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(cardSource, context, { filename: 'recall-projection-card.js' });
  return { context, host, card, hits: () => requested };
}

describe('引用行标签词表（类型·范围）', () => {
  const types = parseAssetTypes();
  const contractScopes = parseContractScopes();

  it('枚举解析到了真实取值（防解析失效后变空断言）', () => {
    expect(types.length).toBeGreaterThanOrEqual(5);
    expect(types).toContain('fact');
    expect(contractScopes.length).toBeGreaterThanOrEqual(5);
    expect(contractScopes).toContain('general');
    expect(contractScopes).toContain('review');
  });

  it('已引用行：每个类型/范围取值都命中词表', () => {
    const { context, hits } = loadCard();
    // _validCitations 每卡最多 12 条，分两批渲染。
    context.window.recallMemoryCardHtml(types.map((type, i) => ({
      asset_id: `aa-t${i}`, title: `类型 ${type}`, type, scope: 'general',
    })));
    context.window.recallMemoryCardHtml([...contractScopes, ...LEGACY_SCOPES].map((scope, i) => ({
      asset_id: `aa-s${i}`, title: `范围 ${scope}`, type: 'rule', scope,
    })));
    const seen = hits();
    for (const type of types) expect(seen).toContain(`chat.recall.type_${type}`);
    for (const scope of contractScopes) expect(seen).toContain(`cognition.capture.scope_${scope}`);
    for (const scope of LEGACY_SCOPES) expect(seen).toContain(`chat.recall.scope_${scope}`);
  });

  it('带入行（未被引用的资产行）与已引用行同一套白话', async () => {
    const lab = loadCard();
    lab.card.assetSummaries = [
      ...types.map((type, i) => ({ assetId: `aa-t${i}`, title: `类型 ${type}`, type, status: 'active', scope: 'general', version: '1' })),
      ...contractScopes.map((scope, i) => ({ assetId: `aa-s${i}`, title: `范围 ${scope}`, type: 'fact', status: 'active', scope, version: '1' })),
    ];
    lab.card.totalAssetCount = (lab.card.assetSummaries as unknown[]).length;
    await lab.context.window.mountRecallProjectionCard(lab.host, { projectionId: 'proj-labels' }, { cid: 'c1', onlyModelSelected: true });
    const seen = lab.hits();
    for (const type of types) expect(seen).toContain(`chat.recall.type_${type}`);
    for (const scope of contractScopes) expect(seen).toContain(`cognition.capture.scope_${scope}`);
  });

  it('上述词表 key 四语齐全', () => {
    const keys = [
      ...types.map((type) => `chat.recall.type_${type}`),
      ...contractScopes.map((scope) => `cognition.capture.scope_${scope}`),
      ...LEGACY_SCOPES.map((scope) => `chat.recall.scope_${scope}`),
    ];
    const gaps = keys.flatMap((key) => LOCALES
      .filter((locale) => !(key in locale.table))
      .map((locale) => `${locale.name}:${key}`));
    expect(gaps).toEqual([]);
  });
});
