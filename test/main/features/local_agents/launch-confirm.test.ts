import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// External-agent launch-confirmation gate (per-conversation first use): each
// conversation (cid) asks once per (agent, cli); an allow covers later turns
// in that conversation; a NEW conversation always re-confirms; timeout /
// abort denies.

const TEST_UID = 'u-launch-confirm';
let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-launch-confirm-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function load() {
  return import('../../../../src/main/features/local_agents/launch_confirm');
}

describe('local_agents/launch_confirm', () => {
  it('pushes a confirm request and resolves with the user verdict', async () => {
    const lc = await load();
    const pushed: any[] = [];
    lc._setBroadcastForTest((_ch, payload) => pushed.push(payload));
    try {
      const p = lc.requestLaunchConfirm({
        uid: TEST_UID, cid: 'c1', agentId: 'a1', agentName: 'Claude', cli: 'claude',
      });
      expect(pushed).toHaveLength(1);
      expect(pushed[0].agent_id).toBe('a1');
      expect(pushed[0].cli).toBe('claude');
      expect(pushed[0].cid).toBe('c1');
      expect(lc.respond(pushed[0].request_id, true, false)).toBe(true);
      await expect(p).resolves.toBe(true);
    } finally {
      lc._setBroadcastForTest(null);
    }
  });

  it('allow covers later turns in the SAME conversation but a NEW conversation re-asks', async () => {
    const lc = await load();
    const pushed: any[] = [];
    lc._setBroadcastForTest((_ch, payload) => pushed.push(payload));
    try {
      const p = lc.requestLaunchConfirm({
        uid: TEST_UID, cid: 'c1', agentId: 'a1', agentName: 'Claude', cli: 'claude',
      });
      lc.respond(pushed[0].request_id, true, false);
      await expect(p).resolves.toBe(true);
      // same conversation: silent
      await expect(lc.requestLaunchConfirm({
        uid: TEST_UID, cid: 'c1', agentId: 'a1', agentName: 'Claude', cli: 'claude',
      })).resolves.toBe(true);
      expect(pushed).toHaveLength(1);
      // NEW conversation: must ask again
      const p2 = lc.requestLaunchConfirm({
        uid: TEST_UID, cid: 'c2', agentId: 'a1', agentName: 'Claude', cli: 'claude',
      });
      expect(pushed).toHaveLength(2);
      lc.respond(pushed[1].request_id, false, false);
      await expect(p2).resolves.toBe(false);
    } finally {
      lc._setBroadcastForTest(null);
    }
  });

  it('persists the per-conversation allow across module reload (restart mid-conversation)', async () => {
    const lc = await load();
    const pushed: any[] = [];
    lc._setBroadcastForTest((_ch, payload) => pushed.push(payload));
    try {
      const p = lc.requestLaunchConfirm({
        uid: TEST_UID, cid: 'c3', agentId: 'a2', agentName: 'Codex', cli: 'codex',
      });
      lc.respond(pushed[0].request_id, true, false);
      await expect(p).resolves.toBe(true);
      // reload module → fresh in-memory state; same cid still grants
      const reloaded = await load();
      expect(reloaded.hasSessionAllow(TEST_UID, 'c3', 'a2', 'codex')).toBe(true);
      await expect(reloaded.requestLaunchConfirm({
        uid: TEST_UID, cid: 'c3', agentId: 'a2', agentName: 'Codex', cli: 'codex',
      })).resolves.toBe(true);
      expect(pushed).toHaveLength(1); // no second push
    } finally {
      lc._setBroadcastForTest(null);
    }
  });

  it('stale / unknown respond ids are ignored, cancelForCid declines pending', async () => {
    const lc = await load();
    lc._setBroadcastForTest(() => {});
    try {
      expect(lc.respond('nope', true, false)).toBe(false);
      const p = lc.requestLaunchConfirm({
        uid: TEST_UID, cid: 'c9', agentId: 'a3', agentName: 'X', cli: 'hermes',
      });
      lc.cancelForCid('c9');
      await expect(p).resolves.toBe(false);
    } finally {
      lc._setBroadcastForTest(null);
    }
  });

  it('deny is not remembered — the next launch in the same conversation still asks', async () => {
    const lc = await load();
    const pushed: any[] = [];
    lc._setBroadcastForTest((_ch, payload) => pushed.push(payload));
    try {
      const p = lc.requestLaunchConfirm({
        uid: TEST_UID, cid: 'c1', agentId: 'a4', agentName: 'X', cli: 'opencode',
      });
      lc.respond(pushed[0].request_id, false, false);
      await expect(p).resolves.toBe(false);
      const p2 = lc.requestLaunchConfirm({
        uid: TEST_UID, cid: 'c1', agentId: 'a4', agentName: 'X', cli: 'opencode',
      });
      expect(pushed).toHaveLength(2); // asked again
      lc.respond(pushed[1].request_id, true, false);
      await expect(p2).resolves.toBe(true);
    } finally {
      lc._setBroadcastForTest(null);
    }
  });
});
