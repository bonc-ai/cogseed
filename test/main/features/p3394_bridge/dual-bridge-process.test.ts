/**
 * C-06：两个独立进程、各自拥有 Kernel/Agent Home/Session Authority/
 * Runtime Adapter 的完整 Bridge 双向闭环验收。
 *
 * 父进程（本测试）作为 Node A：完整 Kernel + 独立 Agent Home + HTTP
 * listener/dialer；子进程（fixtures/bridge-node-child.ts，经 tsx 启动）
 * 作为 Node B：完整 Kernel + 独立 Agent Home + Executor + §11 自动回发。
 *
 * 流程：A 向 B 发送 task（携带 reply_endpoint/reply_token）→ B 独立
 * 执行并产出 episode → B 自动回发 response 到 A → A 校验闭环证据。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildP3394BridgeManifest,
  P3394BridgeExecutor,
  P3394BridgeKernel,
  P3394HttpChannel,
} from '../../../../src/main/features/p3394';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../src/main/features/p3394_bridge/runtime-adapter';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
let previousRuntimeVariant: string | undefined;
let variantName: string;
const children: ChildProcess[] = [];
const openChannels: P3394HttpChannel[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-dual-bridge-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // p3394StateFile 走 ORKAS_RUNTIME_VARIANT（非 ORKAS_WORKSPACE_ROOT）：
  // 用一次性 variant 隔离 outbox/cursor 等状态文件，避免污染真实 cogseed variant。
  variantName = 'p3394-dual-' + Math.random().toString(36).slice(2, 8);
  previousRuntimeVariant = process.env.ORKAS_RUNTIME_VARIANT;
  process.env.ORKAS_RUNTIME_VARIANT = variantName;
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const channel of openChannels.splice(0)) await channel.close().catch(() => {});
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  if (previousRuntimeVariant === undefined) delete process.env.ORKAS_RUNTIME_VARIANT;
  else process.env.ORKAS_RUNTIME_VARIANT = previousRuntimeVariant;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName), { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error('no port'));
      }
    });
  });
}

function waitFor(probe: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (probe()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('waitFor timeout'));
      }
    }, 25);
  });
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => reject(new Error('child exit timeout')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

function manifestOf(id: string) {
  const result = buildP3394BridgeManifest({
    agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

describe('P3394 dual full-bridge process acceptance (C-06)', () => {
  it('两个独立进程的完整 Bridge 节点完成双向任务闭环（C-06/C-09）', async () => {
    const childPort = await freePort();
    const parentPort = await freePort();
    const childHome = path.join(tmpDir, 'child-agent-home');
    const resultFile = path.join(tmpDir, 'child-result.json');
    const reverseResult = path.join(tmpDir, 'child-reverse-result.json');
    const fixture = path.join(process.cwd(), 'test', 'main', 'features', 'p3394_bridge', 'fixtures', 'bridge-node-child.ts');
    const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

    // Node B：独立进程启动完整桥节点（含真实 Runtime Adapter）。
    const child = spawn(process.execPath, [tsxCli, fixture], {
      env: {
        ...process.env,
        P3394_CHILD_PORT: String(childPort),
        P3394_CHILD_TOKEN: 'child-token',
        P3394_CHILD_AGENT_HOME: childHome,
        P3394_CHILD_RESULT: resultFile,
        P3394_CHILD_USER_ID: 'p3394-child-node-user',
        // 真实 Runtime Adapter 需要会话/任务/事件存储根。
        ORKAS_WORKSPACE_ROOT: tmpDir,
        // R-09：adapter 映射持久化，供进程重启恢复。
        P3394_CHILD_STATE: path.join(childHome, 'p3394-adapter-state.json'),
        // C-09 反向任务：B 完成后主动向 A 发起任务。
        P3394_CHILD_PARENT_ENDPOINT: `http://127.0.0.1:${parentPort}`,
        P3394_CHILD_PARENT_TOKEN: 'parent-token',
        P3394_CHILD_REVERSE_RESULT: reverseResult,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let childErr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { childErr += chunk; });
    let ready = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (chunk.includes('CHILD_READY')) ready = true; });
    await waitFor(() => ready || child.exitCode !== null, 15_000);
    expect(ready, 'child stderr: ' + childErr).toBe(true);

    // Node A：本进程完整桥节点（独立 Agent Home + HTTP listener/dialer）。
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'parent-node', display_name: 'ParentNode' }, manifest: manifestOf('parent-node') });
    bridge.registry.register({
      identity: { agent_id: 'child-node', display_name: 'ChildNode' },
      manifest: manifestOf('child-node'),
      endpoints: [`http://127.0.0.1:${childPort}`],
    });

    // A 侧也执行入站任务并自动回发（反向闭环的接收端）。
    let parentTaskId = '';
    const parentRuntime: P3394RuntimeAdapter = {
      async openSession(input): Promise<P3394RuntimeSessionBinding> {
        return { session_id: input.session_id, native_session_id: 'native-' + input.session_id, agent_id: input.agent_id };
      },
      async deliver(envelope): Promise<{ task_id: string }> {
        parentTaskId = envelope.task_id || 'task-' + envelope.message_id;
        return { task_id: parentTaskId };
      },
      async *stream(): AsyncIterable<P3394RuntimeEvent> {
        yield { sequence: 1, task_id: parentTaskId, kind: 'started', data: {} };
        yield { sequence: 2, task_id: parentTaskId, kind: 'delta', data: { text: 'parent answer' } };
        yield { sequence: 3, task_id: parentTaskId, kind: 'completed', data: {} };
      },
      async resume(): Promise<void> {},
      async cancel(): Promise<void> {},
      async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
        return { session_id: sessionId, native_session_id: 'native-' + sessionId, at: new Date().toISOString() };
      },
      async closeSession(): Promise<void> {},
    };
    const executor = new P3394BridgeExecutor({
      bridge,
      runtime: parentRuntime,
      selfIdentity: { agent_id: 'parent-node', alias: 'ParentNode' },
    });

    const parentChannel = new P3394HttpChannel('parent-http', {
      listen: { host: '127.0.0.1', port: parentPort },
      authToken: 'parent-token',
    });
    parentChannel.setLocalManifest(manifestOf('parent-node'));
    const replies: Array<Record<string, unknown>> = [];
    const receivedTaskIds: string[] = [];
    parentChannel.subscribe((envelope) => {
      if (envelope.kind === 'task') receivedTaskIds.push(envelope.message_id);
      replies.push(envelope as unknown as Record<string, unknown>);
      executor.execute(envelope);
    });
    await parentChannel.listen();
    openChannels.push(parentChannel);

    const dialer = new P3394HttpChannel('parent-dial', {
      dial: { endpoints: [`http://127.0.0.1:${childPort}`], bearerToken: 'child-token', expected_identity: 'child-node' },
    });
    openChannels.push(dialer);
    await dialer.dial('child-node');

    const messageId = 'msg-dual-1';
    const taskId = 'tsk-dual-1';
    await dialer.send({
      spec_version: 'p3394/1.0',
      message_id: messageId,
      session_id: 'ses-dual-1',
      task_id: taskId,
      kind: 'task',
      performative: 'request',
      sender: { agent_id: 'parent-node' },
      recipients: [{ agent_id: 'child-node' }],
      payload: { parts: [{ type: 'text', text: 'dual bridge task' }] },
      extensions: { reply_endpoint: `http://127.0.0.1:${parentPort}`, reply_token: 'parent-token' },
      idempotency_key: 'idem-dual-1',
    } as never);

    // B 自动回发 + 终态证据。
    await waitFor(() => replies.length >= 1);
    await waitFor(() => fs.existsSync(resultFile));
    const reply = replies[0];
    expect(reply.reply_to).toBe(messageId);
    expect((reply.sender as { agent_id?: string }).agent_id).toBe('child-node');
    expect(reply.session_id).toBe('ses-dual-1');

    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { status: string; session_id: string; task_id: string; agent_id: string; actions?: Array<{ kind: string; text?: string }> };
    expect(result).toMatchObject({ status: 'completed', session_id: 'ses-dual-1', task_id: taskId, agent_id: 'child-node' });
    // R-05 长任务跨进程：多轮 delta 事件完整送达，终态 completed 且文本单调收敛。
    const actions = result.actions ?? [];
    const deltaTexts = actions.filter((action) => action.kind === 'delta').map((action) => action.text).filter((text): text is string => !!text);
    expect(deltaTexts).toEqual(['child answer one', 'child answer two', 'child answer three']);
    expect(actions.some((action) => action.kind === 'completed')).toBe(true);

    // Node B 的 Agent Home 独立存在：会话状态落盘在自己的 home。
    const sessionFiles = fs.readdirSync(path.join(childHome, 'sessions'));
    expect(sessionFiles.length).toBeGreaterThanOrEqual(1);

    // C-09 反向闭环：B 主动向 A 发起任务 → A 执行并自动回发 → B 落盘反向结果。
    await waitFor(() => fs.existsSync(reverseResult), 15_000);
    const reverse = JSON.parse(fs.readFileSync(reverseResult, 'utf8')) as { reply_to: string; from: string };
    expect(reverse.reply_to).toMatch(/^msg-reverse-/);
    expect(reverse.from).toBe('parent-node');

    const exitCode = await waitExit(child, 8000);
    expect(exitCode, 'child stderr: ' + childErr).toBe(0);

    // C-07 出站事务闭环：reverse 任务在 outbox 里完整走过 submitted → sent → completed。
    const outboxFile = path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName, 'p3394-outbox.jsonl');
    expect(fs.existsSync(outboxFile)).toBe(true);
    const outboxLines = fs.readFileSync(outboxFile, 'utf8').split('\n').filter((line) => line.trim());
    const reverseMessageId = (JSON.parse(fs.readFileSync(reverseResult, 'utf8')) as { reply_to: string }).reply_to;
    const statuses = outboxLines
      .map((line) => JSON.parse(line) as { message_id?: string; status?: string })
      .filter((record) => record.message_id === reverseMessageId)
      .map((record) => record.status);
    expect(statuses).toContain('submitted');
    expect(statuses).toContain('sent');
    expect(statuses).toContain('completed');
    // 信封快照只随 submitted 存储一次，peer 目标正确。
    const snapshotLines = outboxLines
      .map((line) => JSON.parse(line) as { message_id?: string; kind?: string; peer?: string })
      .filter((record) => record.kind === 'envelope' && record.message_id === reverseMessageId);
    expect(snapshotLines).toHaveLength(1);
    expect(snapshotLines[0].peer).toBe('parent-node');

    // R-09 进程重启恢复：同一 Agent Home + adapter stateFile 重启子进程，
    // 同一 session 继续执行任务（映射恢复 + 会话恢复）。
    const stateFile = path.join(childHome, 'p3394-adapter-state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    const resultFile2 = path.join(tmpDir, 'child-result-2.json');
    const reverseResult2 = path.join(tmpDir, 'child-reverse-result-2.json');
    // S-05 三方同框：模拟上次进程遗留的 outbox submitted 信封（未确认出站），
    // 重启后由 replayOutbox 重放——与游标续读恢复（R-08）同框。
    const outboxLegacyFile = path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName, 'p3394-outbox.jsonl');
    fs.mkdirSync(path.dirname(outboxLegacyFile), { recursive: true });
    const legacyMessageId = 'msg-outbox-legacy-1';
    fs.appendFileSync(outboxLegacyFile, JSON.stringify({ at: new Date().toISOString(), message_id: legacyMessageId, status: 'submitted' }) + '\n');
    fs.appendFileSync(outboxLegacyFile, JSON.stringify({
      at: new Date().toISOString(), message_id: legacyMessageId, kind: 'envelope', peer: 'parent-node',
      envelope: {
        spec_version: 'p3394/1.0', message_id: legacyMessageId, session_id: 'ses-outbox-legacy-1', task_id: 'tsk-outbox-legacy-1',
        kind: 'task', performative: 'request', sender: { agent_id: 'child-node' }, recipients: [{ agent_id: 'parent-node' }],
        payload: { parts: [{ type: 'text', text: 'legacy outbox task after restart' }] },
        extensions: { reply_endpoint: `http://127.0.0.1:${parentPort}`, reply_token: 'parent-token' },
        idempotency_key: 'idem-outbox-legacy-1',
      },
    }) + '\n');    const child2 = spawn(process.execPath, [tsxCli, fixture], {
      env: {
        ...process.env,
        P3394_CHILD_PORT: String(childPort),
        P3394_CHILD_TOKEN: 'child-token',
        P3394_CHILD_AGENT_HOME: childHome,
        P3394_CHILD_RESULT: resultFile2,
        P3394_CHILD_USER_ID: 'p3394-child-node-user',
        P3394_CHILD_STATE: stateFile,
        ORKAS_WORKSPACE_ROOT: tmpDir,
        // R-08 跨进程恢复注入：前 1 次事件外发失败 → recoverable → sweep 恢复。
        P3394_CHILD_FAIL_DELIVERY: '1',
        // S-05 三方同框：重启后重放 outbox 遗留的 submitted 信封。
        P3394_CHILD_REPLAY_OUTBOX: '1',
        P3394_CHILD_PARENT_ENDPOINT: `http://127.0.0.1:${parentPort}`,
        P3394_CHILD_PARENT_TOKEN: 'parent-token',
        P3394_CHILD_REVERSE_RESULT: reverseResult2,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child2);
    let child2Err = '';
    child2.stderr.setEncoding('utf8');
    child2.stderr.on('data', (chunk: string) => { child2Err += chunk; });
    let ready2 = false;
    let outboxReplayLine = '';
    child2.stdout.setEncoding('utf8');
    child2.stdout.on('data', (chunk: string) => {
      if (chunk.includes('CHILD_READY')) ready2 = true;
      if (chunk.includes('CHILD_OUTBOX_REPLAY')) outboxReplayLine += chunk;
    });
    await waitFor(() => ready2 || child2.exitCode !== null, 15_000);
    expect(ready2, 'child2 stderr: ' + child2Err).toBe(true);
    // 重启后 outbox 遗留重放完成：遗留信封送达 parent。
    await waitFor(() => outboxReplayLine.includes('CHILD_OUTBOX_REPLAY'), 15_000);
    const replayOutcome = JSON.parse(outboxReplayLine.replace('CHILD_OUTBOX_REPLAY ', '').trim()) as { replayed: number };
    expect(replayOutcome.replayed).toBe(1);

    // 同 session 的第二任务：重启后的节点恢复会话/任务映射并正常执行。
    await dialer.send({
      spec_version: 'p3394/1.0',
      message_id: 'msg-dual-2',
      session_id: 'ses-dual-1',
      task_id: 'tsk-dual-2',
      kind: 'task',
      performative: 'request',
      sender: { agent_id: 'parent-node' },
      recipients: [{ agent_id: 'child-node' }],
      payload: { parts: [{ type: 'text', text: 'dual bridge task after restart' }] },
      extensions: { reply_endpoint: `http://127.0.0.1:${parentPort}`, reply_token: 'parent-token' },
      idempotency_key: 'idem-dual-2',
    } as never);
    await waitFor(() => fs.existsSync(resultFile2), 15_000);
    const result2 = JSON.parse(fs.readFileSync(resultFile2, 'utf8')) as { status: string; session_id: string; task_id: string; actions?: Array<{ kind: string; text?: string }> };
    expect(result2.status).toBe('completed');
    expect(result2.session_id).toBe('ses-dual-1'); // 会话恢复，而非新建
    // 重启后长任务事件流同样完整。
    const deltaTexts2 = (result2.actions ?? []).filter((action) => action.kind === 'delta').map((action) => action.text).filter((text): text is string => !!text);
    expect(deltaTexts2).toEqual(['child answer one', 'child answer two', 'child answer three']);
    // S-05 三方同框：outbox 遗留重放已送达 parent（与游标续读恢复同框）。
    expect(receivedTaskIds).toContain('msg-outbox-legacy-1');
    await waitFor(() => fs.existsSync(reverseResult2), 15_000);
    const exitCode2 = await waitExit(child2, 8000);
    expect(exitCode2, 'child2 stderr: ' + child2Err).toBe(0);
  }, 60_000);
});
