import http from 'node:http';
import fs from 'node:fs';

const target = await new Promise((res, rej) =>
  http.get('http://127.0.0.1:9222/json/list', r => {
    let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d)[0]));
  }).on('error', rej));

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params={}) => new Promise(res => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await new Promise(res => ws.addEventListener('open', res));

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

const shot = async (path) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(r.result.data, 'base64'));
  return path;
};

const cmd = process.argv[2];
if (cmd === 'eval') console.log(JSON.stringify(await evaluate(process.argv[3]), null, 2));
else if (cmd === 'shot') { await evaluate(process.argv[4] || '1'); if(process.argv[5]) await new Promise(r=>setTimeout(r,+process.argv[5])); console.log(await shot(process.argv[3])); }
ws.close();
