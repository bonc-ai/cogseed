import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const conversationSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const styleSource = readFileSync(
  resolve(__dirname, '../../src/renderer/style.css'),
  'utf8',
);

describe('P3394 wake approval placement', () => {
  it('mounts wake approval cards in the current composer pending area', () => {
    const start = conversationSource.indexOf('function _wakeRequestHost');
    const end = conversationSource.indexOf('\nfunction _renderWakeRequestCard', start);
    const hostSource = conversationSource.slice(start, end);

    expect(hostSource).toContain("#panel-conversation .chat-input-wrapper");
    expect(hostSource).toContain("wrap.querySelector('.chat-wake-pending-host')");
    expect(hostSource).toContain('host.dataset.cid = cid');
    expect(hostSource).toContain('host.dataset.cid !== cid');
    expect(hostSource).toContain("wrap.querySelector('.chat-input-area')");
    expect(hostSource).toContain('wrap.insertBefore(host, anchor || wrap.firstChild)');
    expect(styleSource).toContain('.chat-wake-pending-host');
    expect(styleSource).toContain('pointer-events: auto');
  });

  it('does not attach new wake approvals to historical user chat bubbles', () => {
    expect(conversationSource).not.toContain("role === 'user' && Array.isArray(message.wake_requests)");
    expect(conversationSource).not.toContain("latest?.querySelector('.chat-bubble')");
  });

  it('uses a compact approval strip with clickable buttons', () => {
    const start = conversationSource.indexOf('function _renderWakeRequestCard');
    const end = conversationSource.indexOf('\nfunction _pruneWakeRequestHost', start);
    const renderSource = conversationSource.slice(start, end);

    const cssStart = styleSource.indexOf('.chat-wake-pending-host');
    const cssEnd = styleSource.indexOf('.chat-kstar-review', cssStart);
    const wakeCss = styleSource.slice(cssStart, cssEnd);

    expect(renderSource).toContain('chat-wake-request-main');
    expect(renderSource).toContain("role: 'primary', size: 'sm'");
    expect(renderSource).toContain("data-wake-decision': 'reject'");
    expect(renderSource).toContain('event.stopPropagation()');
    expect(wakeCss).toContain('min-height: 36px');
    expect(wakeCss).toContain('white-space: nowrap');
    expect(wakeCss).not.toContain('flex-direction: column');
  });





  it('shows a short preview by default and keeps the full wake objective behind details', () => {
    const start = conversationSource.indexOf('function _wakeRequestPreview');
    const end = conversationSource.indexOf('\nfunction _mountWakeRequestCards', start);
    const wakeSource = conversationSource.slice(start, end);
    const cssStart = styleSource.indexOf('.chat-wake-pending-host');
    const cssEnd = styleSource.indexOf('.chat-kstar-review', cssStart);
    const wakeCss = styleSource.slice(cssStart, cssEnd);

    expect(wakeSource).toContain('function _wakeRequestPreview');
    expect(wakeSource).toContain('p3394.wake.details.show');
    expect(wakeSource).toContain('p3394.wake.details.hide');
    expect(wakeSource).toContain('chat-wake-request-details');
    expect(wakeCss).toContain('max-height: min(220px, 32vh)');
    expect(wakeCss).toContain('overflow: auto');
  });

  it('deduplicates pending wake cards by agent and objective as a stale-state fallback', () => {
    const start = conversationSource.indexOf('function _mountWakeRequestCards');
    const end = conversationSource.indexOf('\nasync function _resolveWakeRequest', start);
    const mountSource = conversationSource.slice(start, end);

    expect(conversationSource).toContain('function _wakeRequestSemanticKey');
    expect(mountSource).toContain('const requestsByKey = new Map()');
    expect(mountSource).toContain('requestsByKey.has(key)');
    expect(mountSource).toContain('data-wake-request-key');
    expect(mountSource).not.toContain('document.querySelector(selector)');
  });

  it('settles the composer wake card with its outcome instead of removing it silently', () => {
    const start = conversationSource.indexOf('async function _resolveWakeRequest');
    const end = conversationSource.indexOf('\n// ── 外接智能体', start);
    const resolveSource = conversationSource.slice(start, end);

    // 需求口径（2026-10-14 需求方）：批准后卡片退场（授权已生效，回执交给工人气泡上
    // 的运行指示）；拒绝保留定格回执（没有别的信号能说明这次拒绝）。
    expect(resolveSource).toContain("if (decision === 'approve')");
    expect(resolveSource).toContain('card.remove()');
    expect(resolveSource).toContain('_pruneWakeRequestHost(_wakeRequestHost(cid, { create: false }))');
    expect(resolveSource).toContain('_renderWakeRequestCard(card, settled, cid)');
    expect(resolveSource).toContain("status: decision === 'approve' ? 'approved' : 'rejected'");
  });

  it('reports the real reason and retires a card whose request no longer exists', () => {
    const probeStart = conversationSource.indexOf('async function _wakeRequestStillPending');
    const probeEnd = conversationSource.indexOf('\nasync function _resolveWakeRequest', probeStart);
    const probeSource = conversationSource.slice(probeStart, probeEnd);
    const start = conversationSource.indexOf('async function _resolveWakeRequest');
    const end = conversationSource.indexOf('\n// ── 外接智能体', start);
    const resolveSource = conversationSource.slice(start, end);

    // 真机 2026-10-21：卡片来自消息快照，后台已经没有这条请求；通用「处理失败」
    // 既没有说明原因，也让卡片继续挂着反复失败。
    expect(probeStart).toBeGreaterThan(-1);
    expect(probeSource).toContain('/wake-requests');
    expect(probeSource).toContain("String(candidate?.status || 'pending') === 'pending'");
    // 读不到就保留卡片：宁可让用户再点一次，也不能藏掉一条可能仍有效的审批。
    expect(probeSource).toContain('return true;');

    expect(resolveSource).toContain('_wakeRequestStillPending(cid, request.id)');
    expect(resolveSource).toContain('p3394.wake.failed_reason');
    expect(resolveSource).toContain('p3394.wake.stale');
    expect(resolveSource).toContain('_hydratePendingWakeRequests(cid)');
    expect(resolveSource).not.toContain("uiAlert(t('p3394.wake.failed'))");
  });

  it('ships every wake decision message in all renderer locales', () => {
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const messages = JSON.parse(readFileSync(
        resolve(__dirname, `../../src/renderer/locales/${locale}.json`),
        'utf8',
      )) as Record<string, string>;
      for (const key of ['p3394.wake.failed_reason', 'p3394.wake.stale', 'p3394.wake.stale_reason']) {
        expect(messages[key], `${locale}: ${key}`).toBeTruthy();
      }
      // The reason-bearing variants must interpolate, or the alert loses the cause
      // again.
      expect(messages['p3394.wake.failed_reason']).toContain('{reason}');
      expect(messages['p3394.wake.stale_reason']).toContain('{reason}');
    }
  });
});
