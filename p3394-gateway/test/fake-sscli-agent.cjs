'use strict';
/** p3394-sscli/1.0 协议假 Agent —— 用于网关 SSCLI 模式一致性测试。
 *  stdin 收 JSONL 指令，stdout 输出协议 JSONL；操作记录写入 SSCLI_LOG_FILE。 */
const fs = require('fs');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

const logFile = process.env.SSCLI_LOG_FILE;
function log(line) { if (logFile) fs.appendFileSync(logFile, JSON.stringify(line) + '\n'); }

let seq = 0;
rl.on('line', (raw) => {
  let op;
  try { op = JSON.parse(raw); } catch { return; }
  log(op);
  if (op.op === 'hello') {
    process.stdout.write(JSON.stringify({ ok: true, protocol: 'p3394-sscli/1.0', runtime: 'fake-sscli', request_id: op.request_id }) + '\n');
  } else if (op.op === 'open_session') {
    process.stdout.write(JSON.stringify({ ok: true, request_id: op.request_id, native_session_id: 'fake-thread-1' }) + '\n');
  } else if (op.op === 'deliver') {
    seq += 1;
    const part = op.message && op.message.payload && op.message.payload.parts && op.message.payload.parts[0];
    const text = (part && part.text) || '';
    process.stdout.write(JSON.stringify({ event: 'status', request_id: op.request_id, sequence: seq, state: 'working' }) + '\n');
    process.stdout.write(JSON.stringify({ event: 'delta', request_id: op.request_id, sequence: seq + 1, text: 'SSCLI-REPLY: ' + text }) + '\n');
    process.stdout.write(JSON.stringify({ event: 'completed', request_id: op.request_id, sequence: seq + 2 }) + '\n');
  } else if (op.op === 'cancel' || op.op === 'heartbeat') {
    process.stdout.write(JSON.stringify({ ok: true, request_id: op.request_id }) + '\n');
  }
});
