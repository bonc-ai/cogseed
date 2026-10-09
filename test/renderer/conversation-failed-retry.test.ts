import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const markerStart = source.indexOf(marker);
  if (markerStart < 0) throw new Error(`missing ${name}`);
  const start = source.slice(Math.max(0, markerStart - 6), markerStart) === 'async '
    ? markerStart - 6
    : markerStart;
  const paramsStart = source.indexOf('(', markerStart + marker.length);
  if (paramsStart < 0) throw new Error(`missing params for ${name}`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let i = paramsStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') paramsDepth += 1;
    else if (ch === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', i + 1);
        break;
      }
    }
  }
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadFailedClassifier(): (raw: string, message?: Record<string, unknown> | null) => boolean {
  const fnSource = extractFunction('_isFailedAssistantContent');
  return vm.runInNewContext(`(${fnSource})`, {});
}

function loadModelOutputTracker() {
  const source = [
    extractFunction('_normalizeFeedbackFieldText'),
    extractFunction('_trimTelemetryText'),
    extractFunction('_handleModelOutputErrorForUi'),
  ].join('\n');
  return vm.runInNewContext(`
    const currentCid = 'fallback-cid';
    const calls = [];
    function _convTrackError(action, data) { calls.push({ action, data }); }
    function _groupActorLabel(actorId) { return actorId === 'commander' ? 'Commander' : ''; }
    function _maybeShowCogSeedCreditGuidance() {}
    ${source}
    ({ track: _handleModelOutputErrorForUi, calls });
  `, {});
}

function loadRuntimeRetryHarness(options: {
  runtime?: Record<string, unknown> | null;
  runtimeError?: Error;
  locallyPending?: boolean;
} = {}) {
  const functionSource = [
    extractFunction('_conversationRuntimeIsActive'),
    extractFunction('_readConversationRuntime'),
    extractFunction('_retryFailedAssistantMessage'),
  ].join('\n');
  return vm.runInNewContext(`
    const currentCid = 'retry-cid';
    const calls = { alerts: [], observers: [], sends: [], fetches: [] };
    const runtime = ${JSON.stringify(options.runtime === undefined ? {
      processing: false,
      backend_active: false,
      in_flight: [],
      active_turns: [],
    } : options.runtime)};
    const runtimeError = ${options.runtimeError ? `new Error(${JSON.stringify(options.runtimeError.message)})` : 'null'};
    function apiFetch(url) {
      calls.fetches.push(url);
      if (runtimeError) return Promise.reject(runtimeError);
      return Promise.resolve({ json: async () => runtime });
    }
    function isConvPending() { return ${options.locallyPending === true}; }
    function _observeConversationRunFromPlanAction(cid, opts) { calls.observers.push({ cid, opts }); }
    async function uiAlert(message) { calls.alerts.push(message); }
    async function sendInConversation(cid, content, extra) {
      calls.sends.push({ cid, content, extra });
      return { started: true, queued: false, errored: false };
    }
    function t(key) { return key; }
    function escapeHtml(value) { return String(value); }
    ${functionSource}
    ({ retry: _retryFailedAssistantMessage, isActive: _conversationRuntimeIsActive, calls });
  `, { encodeURIComponent });
}

describe('conversation failed assistant retry actions', () => {
  it('treats every authoritative runtime activity field as active without an age cutoff', () => {
    const { isActive } = loadRuntimeRetryHarness();

    expect(isActive({ processing: true })).toBe(true);
    expect(isActive({ backend_active: true })).toBe(true);
    expect(isActive({ in_flight: ['commander'] })).toBe(true);
    expect(isActive({ active_turns: [{ actor: 'agent-a' }] })).toBe(true);
    expect(isActive({ processing: false, backend_active: false, in_flight: [], active_turns: [] })).toBe(false);
    expect(isActive({ ok: false, processing: true })).toBe(false);
  });

  it('does not retry while the backend is still active and restores the running observer', async () => {
    const harness = loadRuntimeRetryHarness({
      runtime: {
        processing: true,
        processing_since: '2020-01-01T00:00:00.000Z',
        backend_active: false,
        in_flight: [],
        active_turns: [],
      },
    });
    const button = { disabled: false, innerHTML: '<svg></svg>' };

    await harness.retry({ dataset: { msgId: 'failed-message-1' } }, button);

    expect(harness.calls.fetches).toEqual(['/api/conversations/retry-cid/runtime']);
    expect(harness.calls.sends).toEqual([]);
    expect(harness.calls.observers).toEqual([{
      cid: 'retry-cid',
      opts: { attachExisting: true, allowWithController: true },
    }]);
    expect(harness.calls.alerts).toEqual(['chat.retry_task_running']);
    expect(button.disabled).toBe(false);
    expect(button.innerHTML).toBe('<svg></svg>');
  });

  it('sends one idempotent retry when the authoritative runtime is idle', async () => {
    const harness = loadRuntimeRetryHarness();

    await harness.retry({ dataset: { msgId: 'failed-message-1' } }, { disabled: false, innerHTML: 'retry' });

    expect(harness.calls.sends).toHaveLength(1);
    expect(harness.calls.sends[0]).toMatchObject({
      cid: 'retry-cid',
      extra: { retry_message_id: 'failed-message-1' },
    });
    expect(harness.calls.alerts).toEqual([]);
  });

  it('does not queue a retry when status cannot be confirmed and the conversation is locally pending', async () => {
    const harness = loadRuntimeRetryHarness({ runtimeError: new Error('offline'), locallyPending: true });

    await harness.retry({ dataset: { msgId: 'failed-message-1' } }, { disabled: false, innerHTML: 'retry' });

    expect(harness.calls.sends).toEqual([]);
    expect(harness.calls.alerts).toEqual(['chat.retry_task_running']);
  });

  it('keeps retry and edit operations out of the ordinary pending-message queue', () => {
    const sendBody = extractFunction('sendInConversation');

    expect(sendBody).toContain("extra?.retry_message_id || extra?.edit_message_id");
    expect(sendBody).toContain("reason: 'busy'");
  });

  it('classifies localized model-call failure text as retryable failure content', () => {
    const isFailed = loadFailedClassifier();

    expect(isFailed('⚠️ 模型调用失败：503 系统繁忙，请稍后重试')).toBe(true);
    expect(isFailed('Model call failed: 503 service unavailable')).toBe(true);
    expect(isFailed('<span style="color:var(--danger)">⚠️ 模型调用失败：503</span>')).toBe(true);
    expect(isFailed('普通回复，没有失败状态')).toBe(false);
  });

  it('uses the standard bubble action colors for retry', () => {
    expect(styleSource).not.toMatch(/\.bubble-retry-btn\s*\{/);
    expect(source).toContain("retryBtn.className = 'bubble-action-btn bubble-retry-btn';");
  });

  it('routes live placeholder failures through retry actions instead of archive actions', () => {
    const finalizeBody = extractFunction('_finalizeActorPlaceholder');

    expect(finalizeBody).toContain('const failedAssistant = _isFailedAssistantContent(text, gm);');
    expect(finalizeBody).toContain('_streamingSetFinal(ph, text, { archive: archive && !failedAssistant });');
    expect(finalizeBody).toContain('_attachFailedAssistantActions(ph, () => _messageTextForActions(ph, text));');
    expect(finalizeBody).toContain("failure_kind: String(gm.failure_kind || '')");

    const failedActionsBody = extractFunction('_attachFailedAssistantActions');
    expect(failedActionsBody).toContain("msgDiv.dataset.failed = '1';");
    expect(failedActionsBody).toContain('archive: false');
    expect(failedActionsBody).toContain('retry: true');
    expect(failedActionsBody).not.toContain('report: true');
    expect(source).toContain("const mode = includeRetry ? 'failed'");
    expect(source).toContain('class="chat-bubble-more-wrap"');
    expect(source).toContain('_attachBubbleRetryBtn(directActions, msgDiv)');
  });

  it('restores running history from authoritative activity without a 15-minute freshness gate', () => {
    expect(source).toContain('const processingActive = _conversationRuntimeIsActive(convMeta);');
    expect(source).not.toContain("< 15 * 60 * 1000");
  });

  it('does not send model output error telemetry in the open build', () => {
    const { track, calls } = loadModelOutputTracker();
    const msgDiv = {
      dataset: {
        msgId: 'm123',
        turnId: 'turn-1',
        fromActor: 'commander',
      },
    };
    const longError = `Model call failed: ${'x'.repeat(900)}`;

    track('cid-1', msgDiv, longError, { stage: 'stream_event' });
    track('cid-1', msgDiv, longError, { stage: 'stream_event' });
    track('cid-1', msgDiv, 'aborted', { aborted: true });

    expect(calls).toHaveLength(0);
  });

});
