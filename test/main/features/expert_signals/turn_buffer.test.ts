import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Module-level setup mirrors storage.test.ts — WS_ROOT swap + activateUser
// must run before any expert_signals import (storage caches active uid).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-skill-buffer-'));
process.env.COGSEED_WORKSPACE_ROOT = TMP;
fs.writeFileSync(path.join(TMP, 'users.json'),
  JSON.stringify({ current_user_id: '99999991', users: [{ user_id: '99999991', created_at: new Date().toISOString() }] }));
const UID = '99999991';

import { activateUser } from '../../../../src/main/features/users';
activateUser(UID);

import { createSkillTurnBuffer } from '../../../../src/main/features/expert_signals/turn_hooks';
import { querySignals } from '../../../../src/main/features/expert_signals';

/**
 * Signal writes are fire-and-forget (`appendJsonl`), so the only sound way to
 * observe them is to wait for the real condition. A fixed 30 ms sleep read a
 * partial batch under full-suite parallelism (3 expected, 1 observed); this
 * polls until the expected count holds and fails on the deadline instead, so no
 * assertion is weakened.
 */
async function waitForSignals(
  read: () => Promise<Array<{ turn_id?: string }>>,
  expected: number,
  timeoutMs = 5000,
): Promise<Array<{ turn_id?: string }>> {
  const deadline = Date.now() + timeoutMs;
  let sigs = await read();
  while (sigs.length !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    sigs = await read();
  }
  return sigs;
}

describe('expert_signals.turn_hooks › SkillTurnBuffer', () => {
  it('groups advertised by system, dedups duplicates, emits one signal per system', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordAdvertised('summary-writer', 'A.custom');
    buf.recordAdvertised('search-docs', 'A.custom');
    // Duplicate (system, id) → deduped
    buf.recordAdvertised('summary-writer', 'A.custom');
    buf.recordAdvertised('a1b2c3d4e5f6', 'A.platform');
    buf.recordAdvertised('learned-skill', 'B');

    const cid = 'cid-buf-adv';
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_42', msg_ids: ['m_42'],
    });
    const sigs = await waitForSignals(
      () => querySignals({ types: ['skill_advertised'], cid }),
      3,
    );
    expect(sigs.length).toBe(3);
    const bySystem = new Map(sigs.map((s) => [s.delta!.system, s]));
    expect(bySystem.get('A.custom')!.delta!.skill_ids!.sort()).toEqual(['search-docs', 'summary-writer']);
    expect(bySystem.get('A.platform')!.delta!.skill_ids).toEqual(['a1b2c3d4e5f6']);
    expect(bySystem.get('B')!.delta!.skill_ids).toEqual(['learned-skill']);
    for (const s of sigs) {
      expect(s.turn_id).toBe('m_42');
      expect(s.aid).toBe('agent_x');
    }
  });

  it('skill_invoked: deduped per (system, id); same id under different systems is distinct', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordInvoked('summary-writer', 'A.custom', 'read_file');
    buf.recordInvoked('summary-writer', 'A.custom', 'read_file');   // dup
    buf.recordInvoked('summary-writer', 'B', 'read_file');           // distinct: different system
    buf.recordInvoked('other-skill', 'A.custom', 'read_file');

    const cid = 'cid-buf-inv';
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_43', msg_ids: ['m_43'],
    });
    const sigs = await waitForSignals(
      () => querySignals({ types: ['skill_invoked'], cid }),
      3,
    );
    expect(sigs.length).toBe(3);
    for (const s of sigs) {
      expect(s.delta!.trigger).toBe('read_file');
      expect(s.turn_id).toBe('m_43');
    }
  });

  it('drops without turn_id (silent turn protection)', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordAdvertised('summary-writer', 'A.custom');
    const cid = 'cid-buf-drop';
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: '', msg_ids: [],
    });
    // Control emit on the same cid: it proves the writer flushed past the
    // dropped drain above, and that the dropped turn contributed nothing.
    // Without it a bare `length === 0` could pass before any write had a chance.
    const control = createSkillTurnBuffer();
    control.recordAdvertised('control-skill', 'A.custom');
    control.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_control', msg_ids: ['m_control'],
    });

    const sigs = await waitForSignals(() => querySignals({ cid }), 1);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].turn_id).toBe('m_control');
  });

  it('clears buffer after drain (second drain emits nothing for the same data)', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordAdvertised('s1', 'A.custom');
    const cid = 'cid-buf-clear';
    buf.drainAndEmit({ uid: UID, cid, aid: null, turn_id: 'm1', msg_ids: ['m1'] });
    buf.drainAndEmit({ uid: UID, cid, aid: null, turn_id: 'm2', msg_ids: ['m2'] });
    // Same control-emit trick: exactly one signal from the first drain plus the
    // control proves the second drain emitted nothing for the cleared buffer.
    const control = createSkillTurnBuffer();
    control.recordAdvertised('control-skill', 'A.custom');
    control.drainAndEmit({ uid: UID, cid, aid: null, turn_id: 'm_ctrl', msg_ids: ['m_ctrl'] });

    const sigs = await waitForSignals(
      () => querySignals({ types: ['skill_advertised'], cid }),
      2,
    );
    expect(sigs.map((s) => s.turn_id).sort()).toEqual(['m1', 'm_ctrl']);
  });
});
