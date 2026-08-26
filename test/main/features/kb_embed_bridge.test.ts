import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';

import { createEmbedBridge } from '../../../src/main/features/kb_embed_bridge';

const children: Array<ReturnType<typeof spawn>> = [];

function fakeWorker(script: string, { ready = true, exitAfterMs = 0, noRespond = false } = {}): ReturnType<typeof spawn> {
  const full = `
    process.stdin.setEncoding('utf8');
    ${ready ? 'process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");' : ''}
    let buf = '';
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (req.type === 'embed'${noRespond ? ' && false' : ''}) {
          process.stdout.write(JSON.stringify({ type: 'vectors', id: req.id, vectors: req.texts.map((t) => [t.length]) }) + '\\n');
        }
      }
    });
    ${exitAfterMs ? `setTimeout(() => process.exit(1), ${exitAfterMs});` : ''}
  `;
  const child = spawn(process.execPath, ['-e', full], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch { /* already gone */ }
  }
});

describe('kb_embed_bridge › 子进程桥接协议', () => {
  it('握手就绪后 round-trip 保持顺序与数量', async () => {
    const bridge = createEmbedBridge({ spawnWorker: () => fakeWorker('') });
    await expect(bridge.ready).resolves.toBeUndefined();
    const vectors = await bridge.embedTexts(['hello', 'hi']);
    expect(vectors).toEqual([[5], [2]]);
    bridge.close();
  });

  it('spawn 抛错 → ready 拒绝，调用方据此回退', async () => {
    const bridge = createEmbedBridge({
      spawnWorker: () => { throw new Error('spawn denied'); },
    });
    await expect(bridge.ready).rejects.toThrow('spawn denied');
    bridge.close();
  });

  it('未就绪/已失败状态下请求立即失败（不挂死）', async () => {
    // 握手超时（20s）由 READY_TIMEOUT_MS 兜底，单测不等待真实超时——
    // 这里验证 worker 静默时的失败路径：主动 close 等价 worker 死亡，
    // 之后请求必须立即拒绝而不是挂起。
    const bridge = createEmbedBridge({ spawnWorker: () => fakeWorker('', { ready: false }) });
    bridge.close();
    await expect(bridge.embedTexts(['x'])).rejects.toThrow();
  });

  it('worker 中途退出 → 挂起的请求全部拒绝', async () => {
    const bridge = createEmbedBridge({ spawnWorker: () => fakeWorker('', { exitAfterMs: 60, noRespond: true }) });
    await bridge.ready;
    await expect(bridge.embedTexts(['a', 'b'])).rejects.toThrow(/exited/);
    bridge.close();
  });

  it('fatal 消息 → 挂起请求拒绝', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ type: "fatal", error: "model load failed" }) + "\\n");'], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    const bridge = createEmbedBridge({ spawnWorker: () => child });
    await expect(bridge.ready).rejects.toThrow('model load failed');
    bridge.close();
  });
});
