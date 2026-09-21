/**
 * Spec §7：来源与处理对象只展示语义，不展示定位键。
 *
 * #266 将来源与候选展示迁入 cognition-assets/views.js，并把处理历史改为
 * 当前候选快照中的已处理记录。本文件通过真实视图入口守住迁移后的用户行为。
 */
import { describe, expect, it } from 'vitest';

import { getRecallCandidateCapabilities } from '../../src/main/features/recall/candidate-capabilities';
import { renderCognition } from './helpers/cognition-renderer';

const CAPS = (status: string) => getRecallCandidateCapabilities({ status: status as never });

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cand-source',
    status: 'pending_review',
    capabilities: CAPS('pending_review'),
    judgment: '保留可追溯的来源说明',
    summary: '来源说明',
    suggestedType: 'rule',
    suggestedScope: 'project',
    sourceRefs: [],
    ...overrides,
  };
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function renderCandidateDetail(
  sourceRef: Record<string, unknown>,
  sources: Array<Record<string, unknown>>,
): string {
  return renderCognition(
    { name: 'review', candidateId: 'cand-source' },
    { candidates: [candidate({ sourceRefs: [sourceRef] })], sources },
  );
}

describe('source refs never fall back to a raw locator', () => {
  it('shows the catalog title when the source resolves', () => {
    const html = renderCandidateDetail(
      { kind: 'conversation', id: 'conv-a' },
      [{ kind: 'conversation', items: [{ id: 'conv-a', title: '认知资产链路排查', status: 'ready' }] }],
    );

    expect(visibleText(html)).toContain('认知资产链路排查');
    expect(visibleText(html)).not.toContain('conv-a');
  });

  it('uses semantic fallback text while the source is still processing', () => {
    const html = renderCandidateDetail(
      { kind: 'conversation', id: 'conv-processing' },
      [{ kind: 'conversation', items: [{ id: 'conv-processing', title: '', status: 'processing' }] }],
    );

    // 2026-09-17 修：processing 态如实显示"整理中"（旧文案"来源对话已删除"
    // 对处理中的来源是误导）；不裸 id 的底线不变。
    expect(visibleText(html)).toContain('来源整理中');
    expect(visibleText(html)).not.toContain('conv-processing');
  });

  it('uses an unavailable-source label when the catalog no longer has the source', () => {
    const html = renderCandidateDetail(
      { kind: 'conversation', id: 'conv-gone' },
      [],
    );

    expect(visibleText(html)).toContain('来源记录不可用');
    expect(visibleText(html)).not.toContain('conv-gone');
  });

  it('reports an unavailable source rather than an id when the catalog marks it failed', () => {
    const html = renderCandidateDetail(
      { kind: 'conversation', id: 'conv-failed' },
      [{ kind: 'conversation', items: [{ id: 'conv-failed', title: '', status: 'failed' }] }],
    );

    expect(visibleText(html)).toContain('来源记录不可用');
    expect(visibleText(html)).not.toContain('conv-failed');
  });

  it('prefers the title carried on the ref itself', () => {
    const html = renderCandidateDetail(
      { kind: 'memory', id: 'mem-1', title: '我偏好简短结论' },
      [],
    );

    expect(visibleText(html)).toContain('我偏好简短结论');
    expect(visibleText(html)).not.toContain('来源记录不可用');
    expect(visibleText(html)).not.toContain('mem-1');
  });
});

describe('processed history shows semantic candidate records', () => {
  it('shows the processed candidate title without exposing its locator', () => {
    const html = renderCognition(
      { name: 'review' },
      {
        candidates: [candidate({
          id: 'cand-processed',
          status: 'confirmed',
          capabilities: CAPS('confirmed'),
          judgment: '架构决策要留可追溯记录',
          summary: '架构决策要留可追溯记录',
          updatedAt: '2026-09-15T10:00:00.000Z',
        })],
      },
    );

    expect(html).toContain('fold-processed');
    expect(visibleText(html)).toContain('架构决策要留可追溯记录');
    expect(visibleText(html)).not.toContain('cand-processed');
  });

  it('does not fabricate a processed record for a candidate absent from the snapshot', () => {
    const html = renderCognition({ name: 'review' }, { candidates: [] });

    expect(html).not.toContain('fold-processed');
    expect(visibleText(html)).toContain('当前没有等待确认的候选');
  });
});

describe('candidate titles never degrade into candidate ids', () => {
  it('labels an untitled candidate instead of printing its id as visible text', () => {
    const html = renderCognition(
      { name: 'review', candidateId: 'cand-xyz' },
      { candidates: [candidate({ id: 'cand-xyz', judgment: '', summary: '' })] },
    );

    expect(visibleText(html)).toContain('未命名候选');
    expect(visibleText(html)).not.toContain('cand-xyz');
  });
});
