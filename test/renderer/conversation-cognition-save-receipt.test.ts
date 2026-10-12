import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const cognitionCore = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function escape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function button({ label, attrs, className }: { label: string; attrs?: Record<string, string>; className?: string }): string {
  const renderedAttrs = Object.entries(attrs || {}).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
  return `<button class="ui-button ${escape(className || '')}"${renderedAttrs}>${escape(label)}</button>`;
}

function renderReceipts(receipts: unknown[]): string {
  const translations: Record<string, string> = {
    'chat.cognition_save.state_active': 'Saved and active',
    'chat.cognition_save.state_pending': 'Awaiting review',
    'chat.cognition_save.state_update_pending': 'Update awaiting review',
    'chat.cognition_save.state_merged': 'Merged into suggestion',
    'chat.cognition_save.state_taught': '已记住 · 待审核',
    'chat.cognition_save.open_asset': 'View and edit',
    'chat.cognition_save.open_candidate': 'Review or edit',
  };
  const context: any = {
    escapeHtml: escape,
    t: (key: string) => translations[key] || key,
    uiButton: button,
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('_renderCognitionSaveReceiptsHtml')}\nthis.render = _renderCognitionSaveReceiptsHtml;`, context);
  return context.render(receipts);
}

function replaceCandidateMarker(marker: string, insideCode = false): any {
  const node: any = {
    nodeValue: marker,
    parentElement: { closest: () => insideCode ? {} : null },
    parentNode: { replaceChild: (fragment: unknown) => { context.replacement = fragment; } },
  };
  let visited = false;
  const context: any = {
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    document: {
      createTreeWalker: (_container: unknown, _what: number, filter: any) => ({
        currentNode: null as unknown,
        nextNode() {
          if (visited) return false;
          visited = true;
          if (filter.acceptNode(node) === 2) return false;
          this.currentNode = node;
          return true;
        },
      }),
      createDocumentFragment: () => ({
        children: [] as unknown[],
        appendChild(child: unknown) { this.children.push(child); },
      }),
      createTextNode: (text: string) => ({ kind: 'text', text }),
      createElement: (name: string) => {
        if (name !== 'template') throw new Error(`unexpected element ${name}`);
        let html = '';
        return {
          set innerHTML(value: string) { html = value; },
          content: { cloneNode: () => ({ kind: 'html', html }) },
        };
      },
    },
    t: (key: string) => key,
    uiButton: button,
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('_replaceCandidateCitationsIn')}\nthis.replaceMarker = _replaceCandidateCitationsIn;`, context);
  context.replaceMarker({}, ['cand-review-1']);
  return context.replacement;
}

type CandidateCitationClickRun = {
  opened: string[];
  loadedFeatures: string[];
  finishFeatureLoad: () => Promise<void>;
};

function activateCandidateCitation(candidateId: string, options: { lazyOpener?: boolean } = {}): CandidateCitationClickRun {
  const marker = '// [candidate:<id>] review action';
  const start = source.indexOf(marker);
  const end = source.indexOf('\n});', start);
  if (start < 0 || end < 0) throw new Error('Candidate citation click handler not found');
  const opened: string[] = [];
  const loadedFeatures: string[] = [];
  let releaseFeatureLoad: () => void = () => {};
  const featureLoad = new Promise<void>((resolve) => { releaseFeatureLoad = resolve; });
  const mockWindow: any = {
    loadRendererFeature: (name: string) => {
      loadedFeatures.push(name);
      return featureLoad.then(() => {
        // recall feature 加载完成的副作用：cognition-assets/core.js 定义 candidate opener。
        mockWindow.openCognitionCandidateById = (id: string) => { opened.push(id); };
      });
    },
  };
  if (!options.lazyOpener) mockWindow.openCognitionCandidateById = (id: string) => { opened.push(id); };
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
  if (!clickHandler) throw new Error('Candidate citation click handler was not registered');
  clickHandler({
    target: {
      closest: (selector: string) => selector === '[data-candidate-citation]'
        ? { dataset: { candidateCitation: candidateId } }
        : null,
    },
  });
  return {
    opened,
    loadedFeatures,
    finishFeatureLoad: async () => {
      releaseFeatureLoad();
      await featureLoad;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('conversation cognition save receipts', () => {
  it('shows exact saved text, truthful outcome copy, and the matching asset or candidate action', () => {
    const html = renderReceipts([
      { target: 'asset', id: 'asset-a', summary: '<remember>附来源', outcome: 'created' },
      { target: 'candidate', id: 'cand-a', summary: 'paraphrased preference', outcome: 'pending-review' },
      { target: 'candidate', id: 'cand-b', summary: 'replacement preference', outcome: 'fused-update-pending' },
      { target: 'candidate', id: 'cand-c', summary: 'duplicate suggestion', outcome: 'merged' },
      // 教学回执并入保存回执（2026-09-28 四病整改 7.0 修7）：taught 态渲染
      // 「已记住 · 待审核」，动作走候选入口。
      { target: 'candidate', id: 'cand-taught', summary: '以后所有结论都附来源。', outcome: 'taught-pending-review' },
    ]);

    expect(html).toContain('&lt;remember&gt;附来源');
    expect(html).toContain('Saved and active');
    expect(html).toContain('Awaiting review');
    expect(html).toContain('Update awaiting review');
    expect(html).toContain('Merged into suggestion');
    expect(html).toContain('已记住 · 待审核');
    expect(html).toContain('data-asset-citation="asset-a"');
    expect(html).toContain('data-candidate-citation="cand-a"');
    expect(html).toContain('data-candidate-citation="cand-b"');
    expect(html).toContain('data-candidate-citation="cand-c"');
    expect(html).toContain('data-candidate-citation="cand-taught"');
  });

  it('mounts the same receipt in the live evidence block and keeps its count', () => {
    const evidenceBlock = { kind: 'evidence-block' };
    const finalNode = { kind: 'final' };
    let mountedBefore: unknown;
    let inserted: unknown;
    let options: any;
    const bubble = {
      querySelector(selector: string) {
        if (selector === '.chat-cognition-save-receipts') return null;
        if (selector === '[data-role="final"]') return finalNode;
        return null;
      },
      insertBefore(node: unknown, before: unknown) {
        inserted = node;
        mountedBefore = before;
      },
    };
    (finalNode as any).parentElement = bubble;
    const template = {
      content: { firstElementChild: evidenceBlock },
      set innerHTML(value: string) { expect(value).toBe('<details></details>'); },
    };
    const context: any = {
      document: { createElement: (name: string) => { expect(name).toBe('template'); return template; } },
      window: { hydrateUiIcons: () => {} },
      t: (key: string) => key,
      _renderMessageReferencesHtml: () => '',
      _renderCognitionSaveReceiptsHtml: (receipts: unknown[]) => `<receipt-count>${receipts.length}</receipt-count>`,
      _compactResultBlockHtml: (next: unknown) => { options = next; return '<details></details>'; },
    };
    vm.createContext(context);
    vm.runInContext(`${extractFunction('_mountFinalEvidenceBlock')}\nthis.mount = _mountFinalEvidenceBlock;`, context);

    context.mount({ querySelector: () => bubble }, {
      references: [],
      cognition_save_receipts: [{ target: 'candidate', id: 'cand-live', summary: 's', outcome: 'pending-review' }],
    });

    expect(options.count).toBe(1);
    expect(options.bodyHtml).toContain('<receipt-count>1</receipt-count>');
    expect(inserted).toBe(evidenceBlock);
    expect(mountedBefore).toBe(finalNode);
  });

  it('turns candidate markers into buttons outside code blocks and opens the exact review item', () => {
    const fragment = replaceCandidateMarker('proposal \u0000CANDIDATEREF0\u0000');
    expect(fragment.children[1].html).toContain('data-candidate-citation="cand-review-1"');
    expect(fragment.children[1].html).toContain('Review suggestion');
    expect(replaceCandidateMarker('\u0000CANDIDATEREF0\u0000', true)).toBeUndefined();
    const run = activateCandidateCitation('cand-review-1');
    expect(run.opened).toEqual(['cand-review-1']);
    // opener 已定义：直接打开，不再触发懒加载。
    expect(run.loadedFeatures).toEqual([]);
  });

  it('lazy-loads the recall feature when the candidate opener is missing, then opens the exact review item', async () => {
    const run = activateCandidateCitation('cand-lazy-7', { lazyOpener: true });

    // 点击时 opener 未定义：fallback 必须加载 recall feature（cognition-assets/core.js
    // 定义 opener；旧的 skills feature 不包含它，跳转会静默失败）。
    expect(run.loadedFeatures).toEqual(['recall']);
    expect(run.opened).toEqual([]);

    await run.finishFeatureLoad();
    expect(run.opened).toEqual(['cand-lazy-7']);
    expect(run.loadedFeatures).toEqual(['recall']);
  });

  it('routes the candidate opener into the exact review detail', () => {
    const marker = 'window.openCognitionCandidateById = function openCognitionCandidateById(';
    const start = cognitionCore.indexOf(marker);
    if (start < 0) throw new Error('Candidate opener not found');
    const braceStart = cognitionCore.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let index = braceStart; index < cognitionCore.length; index += 1) {
      if (cognitionCore[index] === '{') depth += 1;
      else if (cognitionCore[index] === '}') {
        depth -= 1;
        if (depth === 0) { end = index + 1; break; }
      }
    }
    if (end < 0) throw new Error('Candidate opener is unterminated');
    const routes: unknown[] = [];
    let shown = 0;
    let reloads = 0;
    const context: any = {
      window: {},
      router: { go: (route: unknown) => { routes.push(route); } },
      showRecallPanel: () => { shown += 1; },
      // opener 在 core.js 里闭包引用 NS（= window.CogAssets）；2026-09-28 起
      // 路由后补 void NS.reload()（B11/D1，见 cognition-jump-reload.test.ts），
      // 抽取执行的 harness 按既有模式把自由变量供进 VM 上下文。
      NS: { reload: () => { reloads += 1; } },
    };
    vm.runInNewContext(`${cognitionCore.slice(start, end)};`, context);

    expect(context.window.openCognitionCandidateById('cand-review-1')).toBe(true);
    expect(shown).toBe(1);
    expect(routes).toEqual([{ name: 'review', candidateId: 'cand-review-1' }]);
    // 跳转后必须重取一次：对话侧刚保存的候选不在陈旧 store 里（B11 假空态）。
    expect(reloads).toBe(1);
  });

  it('protects candidate markers for rendering and mounts receipts on both persisted and live paths', () => {
    expect(source).toContain(".replace(/\\[candidate:([A-Za-z0-9_-]{1,64})\\]/g");
    expect(source).toContain('_replaceCandidateCitationsIn(tmp, candidateRefIds)');
    expect(source).toContain('cognition_save_receipts: gm.cognition_save_receipts');
    expect(source).toContain('_renderCognitionSaveReceiptsHtml(message.cognition_save_receipts)');
    expect(source).toContain('_mountFinalEvidenceBlock(ph, gm)');
    expect(source).toContain("closest('[data-candidate-citation]')");
  });
});
