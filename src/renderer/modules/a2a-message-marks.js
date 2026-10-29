/**
 * A2A marks used inside a conversation (FR-25/26/27).
 *
 * Three small pieces, kept pure so the message renderer can call them without
 * owning A2A knowledge:
 *
 * - `visBadge()` — the「对方可见」mark on a cross-side message (FR-27). Local
 *   messages never get it, so its presence is what tells a user their words will be
 *   read by the peer;
 * - `sourceLabel()` — who the bubble is from (对方助理 / 对方本人 / 回复对方);
 * - `confirmingHint()` — the「助理正在确认」line while the receiver's assistant waits
 *   for its own human (D-23).
 */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;

  function tr(key, fallback, vars) {
    try {
      if (typeof root.t === 'function') {
        const value = root.t(key, vars);
        if (value && value !== key) return String(value);
      }
    } catch (_) { /* i18n 未加载 */ }
    return String(fallback).replace(/\{(\w+)\}/g, (_, name) => (vars && vars[name] != null ? String(vars[name]) : `{${name}}`));
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function icon(name) {
    return typeof root.uiIconHtml === 'function' ? root.uiIconHtml(name) : '';
  }

  /** 「对方可见」：只出现在跨方消息上（FR-27）。 */
  function visBadge() {
    return `<span class="a2a-vis">${icon('eye')}${esc(tr('a2a.visible_to_peer', '对方可见'))}</span>`;
  }

  const SOURCE_KINDS = ['remote', 'peer', 'reply'];

  /**
   * 来源标识：remote＝对方助理的回复，peer＝对方本人的提问，reply＝本方助理回复对方。
   * 未知 kind 返回空串，避免把本方消息误标成跨方。
   */
  function sourceLabel(kind, who) {
    if (!SOURCE_KINDS.includes(kind)) return '';
    const name = esc(String(who || '').trim());
    if (!name) return '';
    if (kind === 'remote') {
      return `<div class="a2a-source">${icon('user')}${esc(tr('a2a.source_assistant', '{name} 的助理', { name }))}${visBadge()}</div>`;
    }
    if (kind === 'peer') {
      return `<div class="a2a-source">${icon('user')}${name}${visBadge()}</div>`;
    }
    return `<div class="a2a-source is-reply">${icon('arrow-right')}${esc(tr('a2a.source_reply', '回复 {name}', { name }))}${visBadge()}</div>`;
  }

  /** 确认中提示：5 分钟内「正在确认」，超时后「需要本人确认，稍后回复」（D-23）。 */
  function confirmingHint(nudged) {
    const text = nudged
      ? tr('chat.a2a.confirming_nudged', '需要本人确认，稍后回复')
      : tr('chat.a2a.confirming', '助理正在确认');
    return `<div class="a2a-confirming" role="status">${icon('clock')}<span>${esc(text)}</span></div>`;
  }

  /**
   * 具体接收者（T1.3）：只有消息自带发送时快照才显示。
   * 旧消息没有快照就什么都不显示，只保留通用的「对方可见」——不凭会话角色
   * 反推「这条发给了谁」。
   */
  function recipientLabel(who) {
    const name = esc(String(who || '').trim());
    if (!name) return '';
    return `<span class="a2a-vis a2a-vis-to">${icon('arrow-right')}${esc(tr('a2a.sent_to_assistant', '发给 {name} 的助理', { name }))}</span>`;
  }

  const api = { visBadge, sourceLabel, confirmingHint, recipientLabel };
  if (typeof window !== 'undefined') window.a2aMessageMarks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
