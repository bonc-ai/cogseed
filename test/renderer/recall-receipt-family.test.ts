// 对话里「本轮带入了什么」的卡只有一张（2026-09-28 拍板项 #8 合并后）。
//   「本次使用的记忆」（.chat-recall-citations）—— modules/recall-projection-card.js
// 引用卡（事后回执）与投影卡（事前面板）合并为一张：头部投影状态摘要、列表
// 资产行（带入+已引用标记；省略灰显）、尾部反馈+投影操作。本文件钉住合并后
// 的契约：壳与头部仍是一份分组规则（历史壳类 .chat-recall-projection-card
// 保留给生产不可达的预载草稿分支）、动作行只用共享按钮、头部图标/标题/右侧
// 状态同构、图标原语缺席时优雅降级。
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(__dirname, '../..');
const styleSource = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8');
const conversationSource = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/conversation.js'), 'utf8');
const cardSource = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/recall-projection-card.js'), 'utf8');

const PROJECTION = '.chat-recall-projection-card';
const CITATIONS = '.chat-recall-citations';

/** 取某个顶层选择器的声明块；缺块直接红（样式被合并事故吃掉过一次）。
 *  家族共享规则写成分组选择器（A 卡, B 卡 { }），块可能以
 *  「selector,」开头，两种形态都要找得到。 */
function cssBlock(selector: string): string {
  const own = styleSource.indexOf(`\n${selector} {`);
  const grouped = styleSource.indexOf(`\n${selector},`);
  const start = own > -1 ? own : grouped;
  expect(start, `${selector} 顶层样式缺失（含分组选择器）`).toBeGreaterThan(-1);
  const end = styleSource.indexOf('\n}', start);
  expect(end, `${selector} 声明块没有闭合`).toBeGreaterThan(start);
  return styleSource.slice(start, end + 2);
}

/** 注释里会写到"被删掉的旧色值"，所以查硬编码前先把注释剥掉。 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function loadCardModule(withIconPrimitive: boolean) {
  const host: any = { className: '', innerHTML: '', dataset: {}, addEventListener() {} };
  const context: any = {
    window: {
      cogseed: {
        invoke: async (channel: string) => channel === 'recall.projections.card'
          ? {
              ok: true,
              card: {
                projectionId: 'proj-a',
                status: 'confirmed',
                authorization: 'user_confirmed',
                purpose: 'user_pinned',
                totalAssetCount: 1,
                assetSummaries: [{ assetId: 'asset-a', title: '被引用的资产', version: '2' }],
              },
            }
          : { ok: true, assets: [] },
      },
      uiButton: ({ label, attrs }: { label: string; attrs?: Record<string, string> }) => {
        const extra = Object.entries(attrs || {}).map(([key, value]) => ` ${key}="${String(value)}"`).join('');
        return `<button type="button" class="btn ui-button"${extra}><span class="ui-button__label">${String(label)}</span></button>`;
      },
    },
    document: {},
    escapeHtml: (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    t: (_key: string, varsOrFallback?: unknown) => (typeof varsOrFallback === 'string' ? varsOrFallback : _key),
    uiAlert: vi.fn(),
    console,
  };
  if (withIconPrimitive) {
    context.window.uiIconHtml = (name: string, className: string) => `<svg class="${className} is-${name}" aria-hidden="true"></svg>`;
  }
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(cardSource, context, { filename: 'recall-projection-card.js' });
  return { context, host };
}

describe('对话内「本次使用的记忆」卡（引用卡＋投影卡合并后）', () => {
  it('壳仍是一份分组共享块，禁止单卡壳覆写', () => {
    const sharedShell = [
      'margin: 6px 0;',
      'padding: 9px 11px;',
      'border: 1px solid var(--border);',
      'border-radius: var(--radius-field);',
      'background: var(--surface);',
      'color: var(--text);',
      'font-size: var(--font-size-caption);',
      'line-height: 1.45;',
      'box-shadow: none;',
    ];
    const block = stripComments(cssBlock(PROJECTION));
    for (const rule of sharedShell) expect(block, `共享壳缺「${rule}」`).toContain(rule);
    // 分组块必须同时点名两个壳类：合并卡的壳是 .chat-recall-citations，历史
    // 壳类 .chat-recall-projection-card 保留给生产不可达的预载草稿分支。
    expect(block).toContain(`\n${CITATIONS} {`);
    expect(styleSource).not.toMatch(/^\.chat-recall-projection-card\.is-model-selected \{/m);
    // 合并卡的壳只能来自共享分组块：全文件只允许出现一次
    const shellBlocks = stripComments(styleSource).split(`\n${CITATIONS} {`).length - 1;
    expect(shellBlocks, '合并卡壳只能来自共享分组块').toBe(1);
  });

  it('合并卡不再自带硬编码品牌绿，页内药丸变体已删除', () => {
    const block = stripComments(cssBlock(CITATIONS));
    expect(block).not.toContain('rgba(14, 159, 110');
    expect(block).not.toContain('#0b7a4f');
    expect(block).not.toContain('border-radius: 99px');
    expect(block).not.toMatch(/font-size:\s*\d+px/);
    expect(styleSource).not.toMatch(/^\.chat-recall-feedback-btn \{$/m);
    expect(styleSource).toMatch(/^\.chat-recall-citations\.is-feedback-sent \.chat-recall-feedback-btn \{/m);
  });

  it('头部仍是同一份分组规则：head/icon/title/strong/small/status 同块', () => {
    // 合并卡的头部图标与实现都住在 recall-projection-card.js
    expect(cardSource).toContain("_headIconHtml('brain-circuit', 'chat-recall-citations-icon')");
    expect(cardSource).toContain('window.uiIconHtml');
    for (const [projectionSel, citationsSel] of [
      ['.chat-recall-projection-head', '.chat-recall-citations-head'],
      ['.chat-recall-projection-icon', '.chat-recall-citations-icon'],
      ['.chat-recall-projection-title', '.chat-recall-citations-title'],
    ] as const) {
      const block = cssBlock(projectionSel);
      expect(block, `${projectionSel} 与 ${citationsSel} 必须同块`).toContain(`\n${citationsSel} {`);
    }
    // 标题排版同一份：caption + semibold + 1.35；投影摘要行（small）也进分组
    const strong = cssBlock('.chat-recall-projection-title strong');
    expect(strong).toContain('.chat-recall-citations-title strong {');
    expect(strong).toContain('font-size: var(--font-size-caption);');
    expect(strong).toContain('font-weight: var(--font-weight-semibold);');
    expect(strong).toContain('line-height: 1.35;');
    const small = cssBlock('.chat-recall-projection-title small');
    expect(small).toContain('.chat-recall-citations-title small {');
    // 头部图标一律 14px + --primary
    const icon = cssBlock('.chat-recall-projection-icon');
    expect(icon).toContain('.chat-recall-citations-icon {');
    expect(icon).toContain('color: var(--primary);');
    expect(cssBlock('.chat-recall-projection-icon .ui-icon')).toContain('width: 14px; height: 14px;');
    // 右侧状态与徽标同一份让位规则
    const badge = cssBlock('.chat-recall-projection-badge');
    expect(badge).toContain('flex: 0 0 auto;');
    expect(badge).toContain('margin-top: 1px;');
    const status = cssBlock('.chat-recall-feedback-status');
    expect(status).toContain('flex: 0 0 auto;');
    expect(status).toContain('margin-top: 1px;');
    expect(status).toContain('color: var(--muted);');
    expect(status).toContain('font-size: var(--font-size-1);');
    const head = stripComments(cssBlock('.chat-recall-projection-head'));
    expect(head).toContain('display: flex;');
    expect(head).toContain('align-items: flex-start;');
    expect(head).toContain('gap: 8px;');
    expect(head).toContain('margin-bottom: 8px;');
  });

  it('头部 DOM 同构：图标位在标题块之前（实现随合并收进卡模块）', () => {
    expect(cardSource).toContain('chat-recall-citations-icon');
    expect(cardSource).toContain('chat-recall-citations-title');
    expect(cardSource.indexOf('chat-recall-citations-icon'))
      .toBeLessThan(cardSource.indexOf('chat-recall-citations-title'));
    // conversation.js 只留同步入口委托，不再自带渲染实现
    expect(conversationSource).toContain('window.recallMemoryCardHtml(citations)');
    expect(conversationSource).not.toContain('chat-recall-citations-icon');
    expect(styleSource).not.toContain('.chat-recall-citations-head > span:first-child');
  });

  it('合并卡头部真的渲染图标；图标原语缺席时优雅降级', async () => {
    const withIcons = loadCardModule(true);
    await withIcons.context.window.mountRecallProjectionCard(withIcons.host, { projectionId: 'proj-a' }, { cid: 'cid-a', onlyModelSelected: true });
    expect(withIcons.host.innerHTML).toContain('class="chat-recall-citations-icon"');
    expect(withIcons.host.innerHTML).toContain('is-brain-circuit');
    expect(withIcons.host.innerHTML).toContain('data-asset-citation="asset-a"');
    expect(withIcons.host.innerHTML).toContain('class="ui-button__label">被引用的资产</span>');
    // 头部顺序：图标在标题之前
    expect(withIcons.host.innerHTML.indexOf('chat-recall-citations-icon'))
      .toBeLessThan(withIcons.host.innerHTML.indexOf('chat-recall-citations-title'));

    const withoutIcons = loadCardModule(false);
    await withoutIcons.context.window.mountRecallProjectionCard(withoutIcons.host, { projectionId: 'proj-a' }, { cid: 'cid-a', onlyModelSelected: true });
    expect(withoutIcons.host.innerHTML).not.toContain('chat-recall-citations-icon');
    // 降级不能顺手把卡也弄丢：标题、行与撤销口照旧
    expect(withoutIcons.host.innerHTML).toContain('本次使用的记忆');
    expect(withoutIcons.host.innerHTML).toContain('data-asset-citation="asset-a"');
    expect(withoutIcons.host.innerHTML).toContain('data-recall-projection-revoke');
  });

  it('折叠 affordance（2026-09-29 二轮）：头部即热区，箭头只是指示图标，样式钉在记忆卡段', () => {
    // 热区 = 头部元素（role=button + aria-expanded 在头部上）；箭头是纯图标。
    expect(cardSource).toContain('chat-recall-citations-head" role="button" tabindex="0" aria-expanded=');
    expect(cardSource).toContain('chat-recall-toggle');
    expect(cardSource).toContain("'chevron-down'");
    expect(cardSource).not.toContain('data-recall-toggle');
    expect(cardSource).not.toContain('window.uiIconButton');
    expect(cardSource).toContain('function recallCardToggleCollapsed');
    // 点击/键盘认领都在 hydrate 委托（唯一全路径必绑），翻转实现只在卡模块。
    expect(conversationSource).toContain("closest?.('.chat-recall-citations-head')");
    expect(conversationSource).toContain('window.recallCardToggleCollapsed(host)');
    expect(conversationSource.indexOf("closest?.('.chat-recall-citations-head')"))
      .toBeLessThan(conversationSource.indexOf('[data-recall-feedback]'));
    // 折叠只藏内容行（列表＋省略块），尾部反馈/提示句/撤销保持可见。
    const collapsed = cssBlock('.chat-recall-citations.is-collapsed .chat-recall-citation-list');
    expect(collapsed).toContain('.chat-recall-citations.is-collapsed .chat-recall-projection-omitted {');
    expect(collapsed).toContain('display: none;');
    expect(cssBlock('.chat-recall-feedback-actions')).toContain('align-items: center;');
    // 提示句挪到撤销左侧（auto margin 独占中段）；计数上移内联在标题右侧。
    expect(cssBlock('.chat-recall-citations-note')).toContain('margin-left: auto;');
    expect(cssBlock('.chat-recall-citations-count')).toContain('margin-left: 6px;');
    expect(cardSource).toContain('chat-recall-citations-count');
    expect(cardSource).toContain('chat-recall-citations-note');
  });
});
