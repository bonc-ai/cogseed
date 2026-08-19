import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import * as paths from '../../../../src/main/paths';
import {
  isEphemeralSessionId,
  memoryScopeForSession,
  resolveSessionPath,
  sessionKindOf,
  toolResultsDirForSession,
} from '../../../../src/main/model/core-agent/session-store';

describe('CogSeed Runtime session routing', () => {
  it('routes mruntime sessions into the local cogseed_runtime root', () => {
    const uid = 'runtime-routing-user';
    const sid = 'mruntime-alpha_123';

    expect(paths.cogseedRuntimeRoot(uid)).toBe(path.join(paths.userLocalRoot(uid), 'cogseed_runtime'));
    expect(paths.cogseedRuntimeSessionsDir(uid)).toBe(path.join(paths.userLocalRoot(uid), 'cogseed_runtime', 'sessions'));
    expect(paths.cogseedRuntimeSessionFile(uid, sid)).toBe(path.join(paths.userLocalRoot(uid), 'cogseed_runtime', 'sessions', `${sid}.jsonl`));
    expect(resolveSessionPath(uid, sid)).toBe(paths.cogseedRuntimeSessionFile(uid, sid));
    expect(toolResultsDirForSession(uid, sid)).toBe(path.join(paths.userLocalRoot(uid), 'cogseed_runtime', 'sessions', `${sid}.tool-results`));
  });

  it('treats mruntime as local-only and memory-isolated', () => {
    expect(sessionKindOf('mruntime-run1')).toBe('mruntime');
    expect(isEphemeralSessionId('mruntime-run1')).toBe(true);
    expect(memoryScopeForSession('mruntime-run1', 'agent-a')).toBeNull();
  });

  it('continues rejecting unrecognized session kinds', () => {
    expect(() => resolveSessionPath('runtime-routing-user', 'runtime-run1')).toThrow(/known kind/);
  });
});
