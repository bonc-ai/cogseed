import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const conversationSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const indexSource = readFileSync(
  resolve(__dirname, '../../src/renderer/index.html'),
  'utf8',
);
const styleSource = readFileSync(
  resolve(__dirname, '../../src/renderer/style.css'),
  'utf8',
);

describe('9.1 unified framework · compact result blocks (middle)', () => {
  it('defines one compact result-block container helper', () => {
    expect(conversationSource).toContain('function _mountCompactResultBlock');
    expect(conversationSource).toContain('chat-result-block-head');
    expect(conversationSource).toContain('chat-result-block-body');
  });

  it('wraps artifacts inside a compact result block instead of mounting them bare', () => {
    const start = conversationSource.indexOf("if (role === 'assistant' && Array.isArray(message.artifacts)");
    const end = conversationSource.indexOf('\n  if (producedPaths)', start);
    const blockSource = conversationSource.slice(start, end);

    expect(blockSource).toContain("_mountCompactResultBlock(bubble");
    expect(blockSource).toContain("t('chat.result_block.artifact')");
    expect(blockSource).toContain('count: message.artifacts.length');
  });

  it('wraps KSTAR review, expense forms, recall projection and marketplace requests in result blocks', () => {
    expect(conversationSource).toContain("t('chat.result_block.kstar_review')");
    expect(conversationSource).toContain("t('chat.result_block.expense_setup')");
    expect(conversationSource).toContain("t('chat.result_block.expense_submit')");
    expect(conversationSource).toContain("t('chat.result_block.recall_projection')");
    expect(conversationSource).toContain("t('chat.result_block.marketplace')");
    // Pending (needs-human-confirmation) blocks default to open.
    expect(conversationSource).toContain("open: String(message.kstar_review_card.status || 'pending') === 'pending'");
  });

  it('styles the compact result block in the shared stylesheet', () => {
    expect(styleSource).toContain('.chat-result-block-head');
    expect(styleSource).toContain('.chat-result-block-caret');
    expect(styleSource).toContain('.chat-result-block[open] .chat-result-block-caret');
  });
});

describe('9.1 unified framework · bottom zone (continue + risk)', () => {
  it('renders a continue button next to the send button in the composer', () => {
    expect(indexSource).toContain('id="chat-continue-btn"');
    expect(indexSource).toContain('data-i18n="chat.continue"');
    const sendPos = indexSource.indexOf('id="chat-send-btn"');
    const continuePos = indexSource.indexOf('id="chat-continue-btn"');
    expect(continuePos).toBeGreaterThan(-1);
    expect(sendPos).toBeGreaterThan(continuePos);
  });

  it('binds the continue button to send the localized continue prompt', () => {
    expect(conversationSource).toContain("getElementById('chat-continue-btn')");
    expect(conversationSource).toContain("t('chat.continue_prompt')");
    expect(conversationSource).toContain('await sendInCurrentConversation(content)');
    // 主会话控制器 bindInput=false，继续按钮必须单独接线而非挂在通用控制器。
    expect(conversationSource).toContain('function _bindChatContinueButton');
  });

  it('turns the continue button into a retry button when the last exchange failed', () => {
    expect(conversationSource).toContain('function _chatContinueButtonState');
    expect(conversationSource).toContain("dataset.failed === '1'");
    expect(conversationSource).toContain('_retryFailedAssistantMessage(state.failedMsgEl, null)');
    expect(conversationSource).toContain("continueBtn.classList.toggle('is-retry', isRetry)");
    expect(indexSource).toContain('data-role="continue-label"');
  });

  it('shows continue only while the executor is idle', () => {
    const start = conversationSource.indexOf('function _updateConvSendUI');
    const end = conversationSource.indexOf('\n/** Show / hide a banner', start);
    const sendUi = conversationSource.slice(start, end);
    expect(sendUi).toContain('continueBtn.hidden = pending');
    expect(sendUi).toContain('continueBtn.disabled = pending');
  });

  it('labels the composer pending area as the risk zone', () => {
    expect(conversationSource).toContain("t('chat.risk_zone')");
    expect(styleSource).toContain('.chat-wake-pending-title');
  });
});

describe('9.1 unified framework · left zone (tasks & sessions)', () => {
  it('paints a running badge for conversations with in-flight executors', () => {
    expect(conversationSource).toContain("badge.classList.add('is-running')");
    expect(conversationSource).toContain("t('chat.status.running')");
    expect(conversationSource).toContain('const inFlight = (_latestInFlight.get(cid) || []).length;');
    expect(styleSource).toContain('.conv-status-badge.is-running');
  });
});

describe('9.1 unified framework · locale coverage', () => {
  it('defines the new keys in all four renderer languages', () => {
    const keys = [
      'chat.continue',
      'chat.continue_prompt',
      'chat.risk_zone',
      'chat.status.running',
      'chat.result_block.artifact',
      'chat.result_block.marketplace',
      'chat.result_block.kstar_review',
      'chat.result_block.expense_setup',
      'chat.result_block.expense_submit',
      'chat.result_block.recall_projection',
    ];
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const data = JSON.parse(readFileSync(
        resolve(__dirname, `../../src/renderer/locales/${locale}.json`),
        'utf8',
      ));
      for (const key of keys) {
        expect(data[key], `${locale}.json missing ${key}`).toBeTruthy();
      }
    }
  });
});
