import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveP3394AgentHome } from '../../../../src/main/features/p3394';

describe('P3394 Agent Home boundary', () => {
  it('creates isolated user and agent logical home paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-home-'));
    const result = resolveP3394AgentHome({ userLocalRoot: root, uid: 'user-a', agent_id: 'agent-a', create: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.home.root).toContain(path.join('user-a', 'local', 'p3394', 'agents', 'agent-a'));
    expect(fs.existsSync(result.home.root)).toBe(true);
    expect(result.home.sessionFile('session-1')).toBe(path.join(result.home.root, 'sessions', 'session-1', 'session.json'));
    expect(result.home.kstarFile('session-1', 'episode')).toBe(path.join(result.home.root, 'sessions', 'session-1', 'kstar', 'episode.json'));
  });

  it('rejects unsafe roots, user ids, agent ids, and session ids', () => {
    expect(resolveP3394AgentHome({ userLocalRoot: 'relative', uid: 'user-a', agent_id: 'agent-a' })).toMatchObject({ ok: false, error: { reason: 'invalid_root' } });
    expect(resolveP3394AgentHome({ userLocalRoot: os.tmpdir(), uid: '../x', agent_id: 'agent-a' })).toMatchObject({ ok: false, error: { reason: 'invalid_uid' } });
    expect(resolveP3394AgentHome({ userLocalRoot: os.tmpdir(), uid: 'user-a', agent_id: ' agent-a ' })).toMatchObject({ ok: false, error: { reason: 'invalid_agent_id' } });
    const home = resolveP3394AgentHome({ userLocalRoot: os.tmpdir(), uid: 'user-a', agent_id: 'agent-a' });
    expect(home.ok).toBe(true);
    if (!home.ok) throw new Error('expected home');
    expect(() => home.home.sessionDir('../bad')).toThrow(/invalid_session_id/);
  });
});

describe('P3394 Agent Home data-root & variant isolation (S-01)', () => {
  it('所有派生路径都落在 Agent home 根目录之内', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-home-root-'));
    const result = resolveP3394AgentHome({ userLocalRoot: root, uid: 'user-a', agent_id: 'agent-a' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const home = result.home;
    const paths = [
      home.root, home.manifestFile, home.identityFile, home.peersRegistryFile,
      home.policyDir, home.consentDir, home.auditDir, home.journalDir,
      home.sessionFile('s-1'), home.workspaceDir('s-1'), home.artifactsDir('s-1'),
      home.checkpointsDir('s-1'), home.traceFile('s-1'), home.kstarFile('s-1', 'episode'),
    ];
    for (const p of paths) {
      const rel = path.relative(home.root, p);
      const inside = rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
      expect(inside, `escape: ${p}`).toBe(true);
    }
  });

  it('同一 uid 下不同 agent 相互隔离：根目录不同、不共享', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-home-isolate-'));
    const a = resolveP3394AgentHome({ userLocalRoot: root, uid: 'user-a', agent_id: 'agent-a' });
    const b = resolveP3394AgentHome({ userLocalRoot: root, uid: 'user-a', agent_id: 'agent-b' });
    if (!a.ok || !b.ok) throw new Error('expected homes');
    expect(a.home.root).not.toBe(b.home.root);
    expect(a.home.sessionDir('s-1').startsWith(a.home.root)).toBe(true);
    expect(b.home.sessionDir('s-1').startsWith(b.home.root)).toBe(true);
  });

  it('逃逸型 session id 一律拒绝（含路径穿越/反斜杠/编码点）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-home-escape-'));
    const home = resolveP3394AgentHome({ userLocalRoot: root, uid: 'user-a', agent_id: 'agent-a' });
    if (!home.ok) throw new Error('expected home');
    const bad = [
      '../evil', 'a/../b', 'a/../../..', '..', '.', 'a\\b', 'a\\..\\b',
      'a/..%2fb', '..%2f..%2fetc', 'a\tb', 'x/y', '/etc/passwd',
    ];
    for (const id of bad) {
      expect(() => home.home.sessionDir(id), `should reject: ${id}`).toThrow();
    }
    // 合法 session id 仍可解析且留在根内。
    expect(home.home.sessionDir('a-b_c.d:e-2026')).toBe(path.join(home.home.root, 'sessions', 'a-b_c.d:e-2026'));
  });

  it('凭据与状态文件跨 agent 不可达，且 create 不预生成凭据文件（S-01 凭据门禁）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-home-cred-'));
    const a = resolveP3394AgentHome({ userLocalRoot: root, uid: 'user-a', agent_id: 'agent-a' });
    const b = resolveP3394AgentHome({ userLocalRoot: root, uid: 'user-a', agent_id: 'agent-b' });
    if (!a.ok || !b.ok) throw new Error('expected homes');
    // agent-a 的凭据/状态路径不得落入 agent-b 的根内（同 uid 不同 agent 互不可达）。
    const aFiles = [a.home.identityFile, a.home.peersRegistryFile, a.home.manifestFile, a.home.sessionFile('s-1')];
    for (const file of aFiles) {
      const rel = path.relative(b.home.root, file);
      const inB = rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
      expect(inB, `agent-a 凭据/状态落入 agent-b 根: ${file}`).toBe(false);
    }
    // 同 agent 的凭据文件确实在自己的根内（identity/peers 为凭据载体）。
    expect(a.home.identityFile.startsWith(a.home.root)).toBe(true);
    expect(a.home.peersRegistryFile.startsWith(a.home.root)).toBe(true);
    // create 只建目录骨架，不预生成 identity/凭据文件——凭据只由授权流程显式写入。
    resolveP3394AgentHome({ userLocalRoot: root, uid: 'user-a', agent_id: 'agent-a', create: true });
    expect(fs.existsSync(a.home.identityFile)).toBe(false);
    expect(fs.existsSync(a.home.peersRegistryFile)).toBe(false);
    // 反向：agent-b 的凭据同样不落入 agent-a 根。
    expect(path.relative(a.home.root, b.home.identityFile).startsWith('..')).toBe(true);
  });
});
