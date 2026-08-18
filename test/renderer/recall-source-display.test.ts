/**
 * Spec §7：来源与处理对象只展示语义，不展示定位键。
 *
 * conversationId / target_ref / candidateId 解析不出来时必须说"来源怎么了"，
 * 而不是回退成一串 id——那既看不懂，又会把"来源真的没了"这件事藏起来。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const skillsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf8');
const zh: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8'),
);

function loadRenderer(state: Record<string, unknown> = {}) {
  const context: any = {
    console,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    t: (key: string) => zh[key] || key,
    window: { addEventListener() {} },
    setTimeout: () => 1,
    clearTimeout: () => {},
    escapeHtml: (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    normalizeDisplayText: (value: unknown) => String(value || '').trim(),
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(skillsSource, context, { filename: 'skills.js' });
  vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify(state)})`, context);
  return context;
}

describe('source refs never fall back to a raw locator', () => {
  it('shows the catalog title when the source resolves', () => {
    const context = loadRenderer({
      sources: [{ kind: 'conversation', items: [{ id: 'conv-a', title: '认知资产链路排查', status: 'ready' }] }],
    });
    const html = context._renderCognitionInlineRefs([{ kind: 'conversation', id: 'conv-a' }]);
    expect(html).toContain('认知资产链路排查');
    // 定位键只留在 tooltip 里，不进主文案。
    expect(html).toContain('title="conv-a"');
    expect(html.replace(/title="[^"]*"/g, '')).not.toContain('conv-a');
  });

  it('says the source is not synced yet instead of printing the id', () => {
    const context = loadRenderer({
      sources: [{ kind: 'conversation', items: [{ id: 'conv-b', title: '', status: 'processing' }] }],
    });
    const html = context._renderCognitionInlineRefs([{ kind: 'conversation', id: 'conv-b' }]);
    expect(html).toContain('来源暂未同步');
    expect(html.replace(/title="[^"]*"/g, '')).not.toContain('conv-b');
  });

  it('says the source conversation was deleted when it is gone from the catalog', () => {
    const context = loadRenderer({ sources: [] });
    const html = context._renderCognitionInlineRefs([{ kind: 'conversation', id: 'conv-gone' }]);
    expect(html).toContain('来源对话已删除');
    expect(html.replace(/title="[^"]*"/g, '')).not.toContain('conv-gone');
  });

  it('reports an unavailable source rather than an id when the catalog marks it failed', () => {
    const context = loadRenderer({
      sources: [{ kind: 'conversation', items: [{ id: 'conv-c', title: '', status: 'failed' }] }],
    });
    const html = context._renderCognitionInlineRefs([{ kind: 'conversation', id: 'conv-c' }]);
    expect(html).toContain('来源记录不可用');
  });

  it('prefers the title carried on the ref itself', () => {
    const context = loadRenderer({ sources: [] });
    const html = context._renderCognitionInlineRefs([{ kind: 'memory', id: 'mem-1', title: '我偏好简短结论' }]);
    expect(html).toContain('我偏好简短结论');
    expect(html).not.toContain('来源对话已删除');
  });
});

describe('processed history shows what was decided, not the ledger key', () => {
  function renderHistory(state: Record<string, unknown>) {
    const context = loadRenderer(state);
    return context._renderCognitionReviewHistory();
  }

  it('resolves a recall_candidate target ref back to the candidate title', () => {
    const html = renderHistory({
      recallCandidates: [{ id: 'cand-1', summary: '架构决策要留可追溯记录', judgment: '架构决策要留可追溯记录', status: 'confirmed' }],
      reviewHistory: {
        loading: false, total: 1,
        items: [{
          decision_id: 'rd_abc12345', target_ref: 'recall_candidate:cand-1',
          decision_type: 'accept', outcome: 'asset_created', timestamp: '2026-08-17T10:00:00.000Z',
        }],
      },
    });
    expect(html).toContain('架构决策要留可追溯记录');
    // `recall_candidate:cand-1` 只作为 tooltip 保留给排查。
    expect(html.replace(/title="[^"]*"/g, '')).not.toContain('recall_candidate:');
    expect(html.replace(/title="[^"]*"/g, '')).not.toContain('rd_abc12345');
  });

  it('says the processed record is unavailable when the candidate is gone', () => {
    const html = renderHistory({
      recallCandidates: [], assets: [],
      reviewHistory: {
        loading: false, total: 1,
        items: [{
          decision_id: 'rd_abc12345', target_ref: 'recall_candidate:cand-missing',
          decision_type: 'reject', outcome: 'none', timestamp: '2026-08-17T10:00:00.000Z',
        }],
      },
    });
    expect(html).toContain('处理对象记录已不可用');
    expect(html.replace(/title="[^"]*"/g, '')).not.toContain('cand-missing');
  });
});

describe('candidate titles never degrade into candidate ids', () => {
  it('labels an untitled candidate instead of printing its id', () => {
    const context = loadRenderer({});
    // 内容为空时走的是通用标题；关键是无论哪条分支都不会把候选 id 当标题。
    const title = context._abilityCandidateDisplayTitle({ id: 'cand-xyz', summary: '', judgment: '' });
    expect(title).toBeTruthy();
    expect(title).not.toContain('cand-xyz');
  });
});
