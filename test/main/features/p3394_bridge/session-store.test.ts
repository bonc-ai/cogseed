import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearSessionForTest, listSessions, normalizeGoal, sessionFor, sessionForGoal } from '../../../../src/main/features/p3394_bridge/session-store';

// isolate: the session store writes under ORKAS_RUNTIME_VARIANT; point it at a scratch variant
const SCRATCH_VARIANT = 'p3394-session-test-' + Math.random().toString(36).slice(2, 8);
process.env.ORKAS_RUNTIME_VARIANT = SCRATCH_VARIANT;

describe('p3394 session store', () => {
  beforeEach(() => {
    clearSessionForTest('conv-a', 'hermes');
    clearSessionForTest('conv-b', 'hermes');
    clearSessionForTest('conv-a', 'claude');
  });

  it('returns the same session id for the same (scope, peer) across calls', () => {
    const first = sessionFor('conv-a', 'hermes');
    const second = sessionFor('conv-a', 'hermes');
    expect(first).toBe(second);
    expect(first).toMatch(/^ses-[a-f0-9]{12}$/);
  });

  it('isolates sessions by scope and by peer', () => {
    const a = sessionFor('conv-a', 'hermes');
    const b = sessionFor('conv-b', 'hermes');
    const c = sessionFor('conv-a', 'claude');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('isolates sessions by goal: same goal reuses, different goal opens a new session', () => {
    const g1 = sessionForGoal('conv-a', 'hermes', '审核合同');
    const g1b = sessionForGoal('conv-a', 'hermes', '审核合同');
    const g2 = sessionForGoal('conv-a', 'hermes', '写周报');
    expect(g1).toBe(g1b);
    expect(g2).not.toBe(g1);
    // 无 goal 的默认会话与 goal 会话互不覆盖
    const plain = sessionFor('conv-a', 'hermes');
    expect(new Set([g1, g2, plain]).size).toBe(3);
  });

  it('normalizes goal whitespace so equivalent goals reuse the session', () => {
    const a = sessionForGoal('conv-b', 'hermes', '  审核   合同  ');
    const b = sessionForGoal('conv-b', 'hermes', '审核 合同');
    expect(normalizeGoal('  审核   合同  ')).toBe(normalizeGoal('审核 合同'));
    expect(a).toBe(b);
  });

  it('lists sessions of a scope with peer and goal', () => {
    const g = sessionForGoal('conv-c', 'claude', '翻译文档');
    const plain = sessionFor('conv-c', 'claude');
    const rows = listSessions('conv-c');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.session_id === g)).toMatchObject({ peer: 'claude', goal: '翻译文档' });
    expect(rows.find((row) => row.session_id === plain)).toMatchObject({ peer: 'claude', goal: '' });
  });

  it('persists the binding to disk (restart stability)', () => {
    const before = sessionFor('conv-a', 'hermes');
    const stateFile = path.join(os.homedir(), '.cogseed', 'runtime-variants', SCRATCH_VARIANT, 'p3394-sessions.json');
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(onDisk.schema_version).toBe(1);
    expect(onDisk.sessions['conv-a\u0000hermes']).toBe(before);
  });
});
