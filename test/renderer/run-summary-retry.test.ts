import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
).replace(/\r\n/g, '\n');
const stateSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/modules/state.js'),
  'utf8',
).replace(/\r\n/g, '\n');

function functionSource(name: string, nextName: string): string {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${nextName}(`));
}

function conversationsUpdatedHandlerSource(): string {
  const marker = "window.cogseed.onPushEvent('conversations:updated', (payload) => {";
  const start = stateSource.indexOf(marker);
  const end = stateSource.indexOf('\n  });\n\n  // Sidebar nav', start);
  if (start < 0 || end < 0) throw new Error('conversations:updated handler not found');
  return `(payload) => {${stateSource.slice(start + marker.length, end)}\n}`;
}

function conversationsUpdatedHarness(input: {
  cid: string;
  lastStreamAt: number;
  liveMessageIds?: string[];
}) {
  const loadConversationHistory = vi.fn();
  const bumpConvToTop = vi.fn();
  const liveIds = new Set(input.liveMessageIds || []);
  const handler = vm.runInNewContext(conversationsUpdatedHandlerSource(), {
    window: { __cogseedLiveBusTracker: { has: (id: string) => liveIds.has(id) } },
    conversations: [],
    currentCid: input.cid,
    _lastGroupWorkEventAt: new Map([[input.cid, input.lastStreamAt]]),
    loadConversationHistory,
    _bumpConvToTop: bumpConvToTop,
  }) as (payload: Record<string, unknown>) => void;
  return { handler, loadConversationHistory, bumpConvToTop };
}

describe('conversation run summary integration (FR-018/019)', () => {
  it('汇总块用共享按钮，且只在有可重跑成员时生成操作', () => {
    const render = functionSource('_renderRunSummaryHtml', '_hydrateRunSummary');
    expect(render).toContain('memberWorkState.retryableAgentIds');
    expect(render).toContain("uiButton({");
    expect(render).toContain("'data-run-summary-retry'");
    expect(render).not.toMatch(/<button\b/);
  });

  it('动态失败码没有翻译时回退到通用原因，不把 i18n key 显示给用户', () => {
    const reason = functionSource('_runSummaryReasonLabel', '_renderRunSummaryHtml');
    const render = functionSource('_renderRunSummaryHtml', '_hydrateRunSummary');
    expect(reason).toContain("t('chat.run_summary.reason.unknown')");
    expect(reason).toContain('translated === key');
    expect(render).toContain('_runSummaryReasonLabel(entry.reason)');
  });

  it('点击重跑按钮调用唯一 groupChat.retryRun IPC，请求体带 run_id / agent_ids / request_id', () => {
    const hydrate = functionSource('_hydrateRunSummary', '_renderMessageAttachmentsHtml');
    expect(hydrate).toContain("window.cogseed.invoke('groupChat.retryRun'");
    expect(hydrate).toContain('run_id: runId');
    expect(hydrate).toContain('agent_ids: retryIds');
    expect(hydrate).toContain('request_id:');
  });

  it('revision push 绕过 live-id 与三秒 stream 抑制并强制刷新当前会话', () => {
    const cid = 'cid-summary-revision';
    const messageId = 'run-summary-run-revision';
    const harness = conversationsUpdatedHarness({
      cid,
      lastStreamAt: Date.now(),
      liveMessageIds: [messageId],
    });

    harness.handler({ cid, msgId: messageId, revisionOf: messageId });

    expect(harness.loadConversationHistory).toHaveBeenCalledTimes(1);
    expect(harness.loadConversationHistory).toHaveBeenCalledWith(cid, { preserveScroll: true });
  });

  it('普通 message push 保留 live-id 去重与三秒 stream 抑制', () => {
    const cid = 'cid-ordinary-push';
    const duplicateId = 'message-already-rendered';
    const duplicateHarness = conversationsUpdatedHarness({
      cid,
      lastStreamAt: 0,
      liveMessageIds: [duplicateId],
    });
    duplicateHarness.handler({ cid, msgId: duplicateId });
    expect(duplicateHarness.loadConversationHistory).not.toHaveBeenCalled();

    const recentStreamHarness = conversationsUpdatedHarness({
      cid,
      lastStreamAt: Date.now(),
    });
    recentStreamHarness.handler({ cid, msgId: 'new-message' });
    expect(recentStreamHarness.loadConversationHistory).not.toHaveBeenCalled();
  });

  it('revisionOf 只接受非空字符串后才启用强制刷新分支', () => {
    const handler = conversationsUpdatedHandlerSource();
    expect(handler).toContain("typeof revisionOf === 'string'");
    expect(handler).toContain('revisionOf.length > 0');
  });
});
