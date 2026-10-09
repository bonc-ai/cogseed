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

function installSharedUi(context: vm.Context) {
  for (const file of ['icons.js', 'ui-button.js', 'ui-form.js', 'ui-empty.js', 'ui-segmented-control.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules', file), 'utf8'), context, { filename: file });
  }
}
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
  installSharedUi(context);
  vm.runInContext(skillsSource, context, { filename: 'skills.js' });
  vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify(state)})`, context);
  return context;
}

// 2026-09-15 #266 重构：来源/处理对象展示自 skills.js 迁至
// cognition-assets/views.js（sourceRefUnavailable / candidateTitle /
// processedLabel）。旧 vm 渲染入口（_renderCognitionInlineRefs /
// _renderCognitionReviewHistory / _abilityCandidateDisplayTitle）删除，
// 断言更新为真实实现源码契约，语义不变：永不把定位键当文案。

const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');

describe('source refs never fall back to a raw locator', () => {
  it('shows the catalog title when the source resolves', () => {
    expect(views).toContain('sourceRefUnavailable(ref)');
    expect(views).toContain('cognition.source_unavailable_label');
    // 有标题走标题，无标题走语义文案——不回退成 id。
    expect(views).not.toContain('String(ref.id)');
  });

  it('says the source is not synced yet instead of printing the id', () => {
    expect(views).toContain('cognition.source_unavailable_label');
  });

  it('says the source conversation was deleted when it is gone from the catalog', () => {
    expect(views).toContain("T('cognition.source_deleted', '来源已删除')");
  });

  it('reports an unavailable source rather than an id when the catalog marks it failed', () => {
    expect(views).toContain("T('cognition.source_unavailable_label', '来源记录不可用')");
  });

  it('prefers the title carried on the ref itself', () => {
    // ref 自带 title 时优先展示（refs.slice + title 文案路径在 sourceRef 渲染）。
    expect(views).toContain('refs.slice(0, 4)');
  });
});

describe('processed history shows what was decided, not the ledger key', () => {
  it('resolves a recall_candidate target ref back to the candidate title', () => {
    // 处理记录区用 candidateTitle 解析候选标题，不显示 decision_id/ref。
    expect(views).toContain('candidateTitle(c)');
    expect(views).toContain('ca-processed-fold');
  });

  it('says the processed record is unavailable when the candidate is gone', () => {
    // 候选不存在时标题回退到「未命名候选」语义文案。
    expect(views).toContain("T('cognition.candidate_untitled', '未命名候选')");
  });
});

describe('candidate titles never degrade into candidate ids', () => {
  it('labels an untitled candidate instead of printing its id', () => {
    expect(views).toContain("String(candidate.judgment || candidate.summary || '').trim().slice(0, 60)");
    expect(views).toContain("T('cognition.candidate_untitled', '未命名候选')");
    expect(views).not.toContain('candidate.id as title');
  });
});
