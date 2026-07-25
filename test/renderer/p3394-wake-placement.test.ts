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
    expect(renderSource).toContain('btn btn-primary btn-sm');
    expect(renderSource).toContain('btn btn-sm');
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
  });

  it('removes composer wake cards after an approval decision instead of leaving stale completed cards', () => {
    const start = conversationSource.indexOf('async function _resolveWakeRequest');
    const end = conversationSource.indexOf('\nfunction _mountMarketplaceInstallRequests', start);
    const resolveSource = conversationSource.slice(start, end);

    expect(resolveSource).toContain('card.remove()');
    expect(resolveSource).toContain('_pruneWakeRequestHost(_wakeRequestHost(cid, { create: false }))');
    expect(resolveSource).not.toContain('_renderWakeRequestCard(card, data.request');
  });
});
