#!/usr/bin/env node
/**
 * A2A 交互走查（dev only）：用真机 UI 把「提问 → 接待确认 → 批准 → 回答」跑一遍，
 * 每步记录耗时与界面状态，并把截图存到 ~/.cogseed/a2a-dev/shots/。
 *
 * 用法：node scripts/dev/a2a-cdp-flow.mjs [question]
 * 前置：Hub 4202 + 两个客户端（9223=B 接收方 / 9224=A 发起方）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOME = os.homedir();
const OUT = path.join(HOME, '.cogseed', 'a2a-dev', 'shots');
mkdirSync(OUT, { recursive: true });

const B = '9223';
const A = '9224';

async function evalOn(port, code) {
  const out = execFileSync('node', [
    path.join(process.cwd(), 'scripts/dev/a2a-cdp-eval.mjs'), port, code,
  ], { encoding: 'utf8' });
  try { return JSON.parse(out); } catch { return out; }
}

function shot(port, name) {
  try {
    execFileSync('node', [path.join(process.cwd(), 'scripts/dev/a2a-cdp-shot.mjs'), port, path.join(OUT, name)], { encoding: 'utf8' });
  } catch (err) { console.log(`  (screenshot failed: ${err.message})`); }
}

const question = process.argv[2] || `今天几号？顺便说下你们的接待范围。`;
const t0 = Date.now();
const step = (label, extra) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${label}${extra ? ` :: ${JSON.stringify(extra)}` : ''}`);

const state = await evalOn(B, `return { state: window.a2aRelayInbox._state(), strip: !!document.getElementById('a2a-relay-strip') };`);
step('B 初始收件箱', state);

// 心跳 60s 一轮：新账号刚起来时对方可能还显示离线，而离线按 PRD 不可选。
// 走查因此先等到 online，再开始点选。
let online = false;
for (let i = 0; i < 40; i += 1) {
  const list = await evalOn(A, `const c = await window.cogseed.invoke('contacts.list', {}); return (c.contacts || []).map(x => ({ name: x.name, online: x.online }));`);
  if (Array.isArray(list) && list.some((row) => row.online)) { online = true; step('联系人在线', list); break; }
  await new Promise((r) => setTimeout(r, 1500));
}
if (!online) step('联系人始终离线（跳过）', null);

step('A 打开新任务并选联系人');
// 合成事件打不开真实的 @ 选择器（它监听输入框的按键/文本游标），这里走与选择器
// 相同的插入口 insertMention：点选链路本身由 composer-members 的单测覆盖。
const picked = await evalOn(A, `
  const c = await window.cogseed.invoke('contacts.list', {});
  const contact = (c.contacts || [])[0];
  if (!contact) return { error: 'no contact' };
  window.setView('new-chat');
  await new Promise(r => setTimeout(r, 900));
  const draft = document.getElementById('new-chat-input');
  if (draft) { draft.value = ''; draft.dispatchEvent(new Event('input', { bubbles: true })); }
  await new Promise(r => setTimeout(r, 200));
  window.composerMembers.insertMention('new-chat', { kind: 'contact', user_id: contact.userId, name: contact.name });
  await new Promise(r => setTimeout(r, 500));
  const input = document.getElementById('new-chat-input');
  return { contact: contact.userId, value: input ? input.value : null };
`);
step('A 点名联系人', picked);

const sent = await evalOn(A, `
  const input = document.getElementById('new-chat-input');
  input.value = input.value + ${JSON.stringify(question)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('new-chat-send-btn').click();
  for (let i = 0; i < 20; i += 1) {
    await new Promise(r => setTimeout(r, 400));
    const active = (document.querySelector('.panel.active') || {}).id;
    if (active === 'panel-conversation') return { view: active, waitedMs: (i + 1) * 400 };
  }
  return { view: (document.querySelector('.panel.active') || {}).id, waitedMs: 8000 };
`);
step('A 发送后落点', sent);
shot(A, 'flow-a-sent.png');

for (let i = 0; i < 20; i += 1) {
  const s = await evalOn(B, `return window.a2aRelayInbox._state();`);
  if (Array.isArray(s) && s.some((r) => r.relayState === 'waiting' || r.relayState === 'answering')) {
    step('B 收到问题', s);
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
shot(B, 'flow-b-inbox.png');

const hasConfirm = await evalOn(B, `return { hasConfirm: !!document.querySelector('[data-relay-confirm]'), hasOpen: !!document.querySelector('[data-relay-open]'), rows: Array.from(document.querySelectorAll('[data-relay-message]')).map(r => r.getAttribute('data-relay-state')), agentOptions: Array.from(document.querySelectorAll('[data-a2a-reception-input]')).length };`);
step('B 收件箱动作', hasConfirm);

const confirmed = await evalOn(B, `
  const btn = document.querySelector('[data-relay-confirm]');
  if (!btn) return { skipped: 'no confirm button' };
  btn.click();
  await new Promise(r => setTimeout(r, 900));
  const dialog = Array.from(document.querySelectorAll('.ui-modal')).find(d => (d.querySelector('.ui-modal__title') || {}).textContent === '确认接待');
  if (!dialog) return { error: 'no dialog' };
  const ws = dialog.querySelector('[data-a2a-reception-input=workspace]');
  const agents = dialog.querySelector('[data-a2a-reception-input=assistant]');
  const agentOptions = agents ? agents.options.length : 0;
  if (ws && !ws.value) { ws.value = ${JSON.stringify(path.join(HOME, '.cogseed/a2a-dev/workspace'))}; ws.dispatchEvent(new Event('input', { bubbles: true })); }
  dialog.querySelector('[data-ui-form-submit]').click();
  await new Promise(r => setTimeout(r, 1200));
  return { agentOptions, workspacePrefilled: !!(ws && ws.value), activeView: (document.querySelector('.panel.active') || {}).id, state: window.a2aRelayInbox._state() };
`);
step('B 确认接待', confirmed);
shot(B, 'flow-b-confirmed.png');

for (let i = 0; i < 40; i += 1) {
  const s = await evalOn(B, `return window.a2aRelayInbox._state();`);
  if (Array.isArray(s) && s.length && s.every((r) => r.relayState === 'answered' || r.relayState === 'failed')) {
    step('B 回答完成', s);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
shot(B, 'flow-b-answered.png');
shot(A, 'flow-a-answered.png');

const answer = await evalOn(A, `
  const el = document.getElementById('a2a-relay-strip');
  const history = document.getElementById('chat-history');
  return { strip: el && !el.hidden ? el.innerText.slice(0, 240) : null, history: history ? history.innerText.slice(0, 400) : null };
`);
step('A 看到回答', answer);
