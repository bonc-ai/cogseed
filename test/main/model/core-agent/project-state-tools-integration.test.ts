import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCrossSessionMemoryTool, type MemoryTier } from '../../../../src/core-agent/src/tools/memory-tool';
import { createProjectInstructionsTool } from '../../../../src/core-agent/src/tools/project-instructions-tool';

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel() {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u-project-state-tools';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-state-tools-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setupSpaceStateTools() {
  const [spaces, memory] = await Promise.all([
    import('../../../../src/main/features/spaces'),
    import('../../../../src/main/features/memory'),
  ]);
  const created = await spaces.createSpace(UID, { name: 'Tool integration' });
  if (!created.ok) throw new Error(`create failed: ${created.error}`);
  const sid = created.space.space_id;
  const memoryScope = (tier: MemoryTier) => tier === 'space' ? { space: sid } as const : 'memory' as const;

  const instructionsTool = createProjectInstructionsTool({
    set: (instructions) => spaces.writeSpaceInstructions(UID, sid, instructions),
  });
  const memoryHandler = {
    add: (tier: MemoryTier, content: string) => memory.addEntry(UID, memoryScope(tier), content),
    replace: (tier: MemoryTier, oldText: string, content: string) => memory.replaceEntry(UID, memoryScope(tier), oldText, content),
    remove: (tier: MemoryTier, oldText: string) => memory.removeEntry(UID, memoryScope(tier), oldText),
    list: (tier: MemoryTier) => memory.listEntries(UID, memoryScope(tier)),
  };
  const memoryTool = createCrossSessionMemoryTool(memoryHandler, { includeProjectTier: true });
  return { spaces, memory, sid, instructionsTool, memoryHandler, memoryTool };
}

describe('space state tools → durable feature stores', () => {
  it('round-trips instructions and durable memory through real handlers', async () => {
    const state = await setupSpaceStateTools();
    const ctx = {} as any;

    const instructions = await state.instructionsTool.execute({
      instructions: 'Goal: ship checkout.\nRule: customer copy is English.',
    }, ctx);
    expect(instructions.isError).toBe(false);
    expect(state.spaces.formatSpaceInstructionsForSystemPrompt(UID, state.sid))
      .toContain('customer copy is English');

    const remembered = await state.memoryTool.execute({
      action: 'add',
      target: 'space',
      content: 'The payment provider is Stripe.',
    }, ctx);
    expect(remembered.isError).toBe(false);
    expect(state.memory.formatForSystemPrompt(UID, undefined, state.sid)).toContain('The payment provider is Stripe.');
  });

  it('enforces sub-agent space-memory read-only mode against the same real store', async () => {
    const state = await setupSpaceStateTools();
    state.memory.addEntry(UID, { space: state.sid }, 'Existing durable decision.');
    const tool = createCrossSessionMemoryTool(state.memoryHandler, {
      includeProjectTier: true,
      projectTierReadOnly: true,
    });
    const ctx = {} as any;

    const listed = await tool.execute({ action: 'list', target: 'space' }, ctx);
    expect(listed.isError).toBe(false);
    expect(JSON.parse(listed.content).entries).toEqual(['Existing durable decision.']);

    const rejected = await tool.execute({ action: 'add', target: 'space', content: 'Unauthorized write.' }, ctx);
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain('read-only');
    expect(state.memory.listEntries(UID, { space: state.sid }).entries)
      .toEqual(['Existing durable decision.']);
  });
});
