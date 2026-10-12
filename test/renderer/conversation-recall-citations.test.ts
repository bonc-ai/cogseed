import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const cardModuleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/recall-projection-card.js'), 'utf8');
const uiButtonSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/ui-button.js'), 'utf8');

function renderCitations(citations: unknown[]): string {
  // 合并卡（拍板项 #8）：引用行的渲染实现已随两卡合并迁入
  // recall-projection-card.js（conversation.js 只留同步入口委托）。
  const escape = (value: unknown) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const context: any = {
    t: (key: string) => key,
    escapeHtml: escape,
    window: {
      uiButton: ({ label, attrs, className }: { label: string; attrs?: Record<string, string>; className?: string }) => {
        const renderedAttrs = Object.entries(attrs || {}).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
        return `<button type="button" class="ui-button ${escape(className || '')}"${renderedAttrs}>${escape(label)}</button>`;
      },
    },
    document: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(cardModuleSource, context, { filename: 'recall-projection-card.js' });
  return context.window.recallMemoryCardHtml(citations);
}

type AssetCitationClickRun = {
  opened: string[];
  loadedFeatures: string[];
  finishFeatureLoad: () => Promise<void>;
};

function activateAssetCitation(assetId: string, options: { lazyOpener?: boolean } = {}): AssetCitationClickRun {
  const start = source.indexOf("// [asset:<id>] 引用卡点击");
  const end = source.indexOf('\n});', start);
  if (start < 0 || end < 0) throw new Error('Recall citation click handler not found');
  const opened: string[] = [];
  const loadedFeatures: string[] = [];
  let releaseFeatureLoad: () => void = () => {};
  const featureLoad = new Promise<void>((resolve) => { releaseFeatureLoad = resolve; });
  const mockWindow: any = {
    loadRendererFeature: (name: string) => {
      loadedFeatures.push(name);
      return featureLoad.then(() => {
        // recall feature 加载完成的副作用：cognition-assets/core.js 定义 asset opener。
        mockWindow.openCognitionAssetById = (id: string) => { opened.push(id); };
      });
    },
  };
  if (!options.lazyOpener) mockWindow.openCognitionAssetById = (id: string) => { opened.push(id); };
  let clickHandler: ((event: any) => void) | null = null;
  const context: any = {
    document: {
      addEventListener(type: string, handler: (event: any) => void) {
        if (type === 'click') clickHandler = handler;
      },
    },
    window: mockWindow,
  };
  vm.runInNewContext(source.slice(start, end + '\n});'.length), context);
  if (!clickHandler) throw new Error('Recall citation click handler was not registered');
  clickHandler({
    target: {
      closest: (selector: string) => selector === '[data-asset-citation]'
        ? { dataset: { assetCitation: assetId } }
        : null,
    },
  });
  return {
    opened,
    loadedFeatures,
    // 放行懒加载后等 handler 的 .then(open) 微任务跑完（setTimeout 轮次前微任务队列已清空）。
    finishFeatureLoad: async () => {
      releaseFeatureLoad();
      await featureLoad;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('conversation Recall citations', () => {
  it('keeps recall_citations in the persisted message record and renders the feedback footer', () => {
    // 本地产品决定（保留版）：recall_citations 在消息透传 + 渲染「本次使用的
    // 记忆」（2026-09-28 拍板项 #8 起与投影卡合并为一张卡，标题统一）
    // footer（有帮助/需改进反馈走 recall.usage.feedback）。远端曾按「后端可见
    // 即可」移除 footer，合并时保留本地版（用户实际在使用该反馈 UI）。
    expect(source).toContain('recall_citations');
    expect(source).toContain('_renderRecallCitationsHtml');
    expect(source).toContain('_hydrateRecallCitations');
    expect(source).toContain('chat-recall-citations');
    expect(source).toContain('data-recall-feedback');
    expect(source).toContain('recall.usage.feedback');
    // 渲染实现收在 recall-projection-card.js，conversation.js 只留委托入口。
    expect(source).toContain('window.recallMemoryCardHtml(citations)');
  });

  it('lets users open a cited asset from the answer memory card', () => {
    const html = renderCitations([{ asset_id: 'asset-1', title: '项目复盘规则', type: 'rule', scope: 'project' }]);

    expect(html).toContain('data-asset-citation="asset-1"');
    expect(html).toContain('chat-recall-citation-open');
    expect(html).toContain('>项目复盘规则</button>');
    // 合并卡：被实际引用的行带「已引用」标记（带入未引用行没有）。
    expect(html).toContain('已引用');
    expect(source).toContain("closest('[data-asset-citation]')");
    expect(source).toContain('window.openCognitionAssetById(assetId)');
  });

  it('routes activation of the shared citation button to the existing asset detail opener', () => {
    const run = activateAssetCitation('asset-1');
    expect(run.opened).toEqual(['asset-1']);
    // opener 已定义（用户进过认知资产页）：直接打开，不再触发懒加载。
    expect(run.loadedFeatures).toEqual([]);
  });

  it('lazy-loads the recall feature when the asset opener is missing, then opens the exact asset', async () => {
    const run = activateAssetCitation('asset-lazy-9', { lazyOpener: true });

    // 点击时 opener 未定义：fallback 必须加载 recall feature（cognition-assets/core.js
    // 定义 opener；旧的 skills feature 不包含它，加载完仍然打不开详情）。
    expect(run.loadedFeatures).toEqual(['recall']);
    expect(run.opened).toEqual([]);

    await run.finishFeatureLoad();
    expect(run.opened).toEqual(['asset-lazy-9']);
    expect(run.loadedFeatures).toEqual(['recall']);
  });

  it('omits citations whose title is blank instead of rendering an empty action', () => {
    expect(renderCitations([{ asset_id: 'asset-1', title: '  ' }])).toBe('');
  });
});
describe('conversation asset approval card (specs/008 US-406)', () => {
  // 卡片本体（渲染/编辑/三态）已抽到 `modules/chat-asset-approval.js`，由
  // `test/renderer/chat-asset-approval-card.test.ts` 真实调用测试。这里只钉
  // conversation.js 这一侧：载荷透传、两个挂载点、已挂守卫，以及那个模块真的被加载。
  const cardSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/chat-asset-approval.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');

  it('mounts the card in both history and live paths, with a dedupe guard', () => {
    // 卡片挂载点与透传：历史重载与实时渲染两条路都要挂（只挂一条会让刷新后卡片消失）。
    expect(source).toContain('asset_change_approval_card');
    expect(source).toContain('_mountAssetApprovalCard');
    // 已挂则不再挂（消息重渲染时不重复插入）。
    expect(source).toContain("if (gm.asset_change_approval_card && !el.querySelector('.chat-asset-approval')) return false;");
    // 挂载点委托给独立模块；模块缺席要吵（以前这里静默不挂，卡片直接消失）。
    expect(source).toContain('ChatAssetApproval.mount(host, payload)');
    expect(source).toContain('chat-asset-approval module missing');
    // 模块必须真的被 index.html 加载，且在 conversation.js 之前。
    expect(indexHtml).toContain('./modules/chat-asset-approval.js');
    expect(indexHtml.indexOf('./modules/chat-asset-approval.js')).toBeLessThan(indexHtml.indexOf('./modules/conversation.js'));
  });

  it('wires the three decisions and re-checks the version on confirm', () => {
    // 三态按钮名与已定口径一致（确认更新 / 稍后处理 / 拒绝）。
    for (const action of ['confirm', 'defer', 'reject']) {
      expect(cardSource).toContain(`'data-asset-approval-action': '${action}'`);
    }
    expect(cardSource).toContain("recall.assets.approval.decide");
    // 历史重载要查一次状态，否则已处置的卡片会又变回"待处理"。
    expect(cardSource).toContain("recall.assets.approval.read");
    // 版本重检不一致：卡片保持待处理 + 如实说明，不静默套用。
    expect(cardSource).toContain('versionConflict');
    expect(cardSource).toContain("state: 'pending'");
    // 拟生效内容可编辑，编辑后的值随确认一起回传。
    expect(cardSource).toContain("'data-asset-approval-field'");
    // 字段值来自**提议记录**（消息载荷里只有摘要）：不查内容"可编辑"就是空话
    // ——2026-09-25 真机抓到卡片上「正文」下面是空的。
    expect(cardSource).toContain('proposal.beforeValues');
    expect(cardSource).toContain('proposal.payload');
    // 当前值与拟生效值都显示出来，用户才判断得了要不要批。
    expect(cardSource).toContain('recall.asset_approval.current_label');
  });

  it('uses the shared component seams instead of page-local controls', () => {
    // 卡片不许自绘按钮/文本域（shared-ui-adoption-guard 的同一要求）。
    expect(cardSource).toContain('uiButton({');
    expect(cardSource).toContain('uiTextarea({');
    expect(cardSource).toContain('uiTag({');
    expect(cardSource).not.toContain('<button data-asset-approval');
  });
});
