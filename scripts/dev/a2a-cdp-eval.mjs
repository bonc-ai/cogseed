#!/usr/bin/env node
/**
 * 最小 CDP 求值器（dev only，不提交）：在指定端口的渲染层执行一段 JS 并打印结果。
 *
 * 用法：node scripts/dev/a2a-cdp-eval.mjs <port> '<expression>'
 * 表达式可用 await（包在 async IIFE 里）。
 */
const port = process.argv[2] || '9223';
const expression = process.argv[3] || '1';

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error(`no page target on ${port}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
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

const result = await send('Runtime.evaluate', {
  expression: `(async () => { ${expression} })()`,
  awaitPromise: true,
  returnByValue: true,
});
if (result.exceptionDetails) {
  console.error(JSON.stringify(result.exceptionDetails, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result.result.value, null, 2));
}
ws.close();
