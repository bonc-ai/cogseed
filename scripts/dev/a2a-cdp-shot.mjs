#!/usr/bin/env node
/**
 * 最小 CDP 截图器（dev only）：把一个客户端窗口当前画面存成 PNG，便于肉眼判断交互。
 *
 * 用法：node scripts/dev/a2a-cdp-shot.mjs <port> <out.png>
 */
import { writeFileSync } from 'node:fs';

const port = process.argv[2] || '9223';
const out = process.argv[3] || `~/.cogseed/a2a-dev/shot-${port}.png`;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error(`no page target on ${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(JSON.stringify(msg.error)));
  else resolve(msg.result);
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
const { data } = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out.replace(/^~/, process.env.HOME), Buffer.from(data, 'base64'));
console.log(out);
ws.close();
