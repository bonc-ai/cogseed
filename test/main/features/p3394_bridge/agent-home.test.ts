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
