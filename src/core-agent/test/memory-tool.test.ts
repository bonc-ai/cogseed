import { describe, expect, it, vi } from 'vitest';
import { createCrossSessionMemoryTool } from '../src/tools/memory-tool.js';
const context = {} as never;
describe('existing cross-session memory is read-only for every actor', () => {
  it('exposes only inventory reads, retaining caller-scoped stores', () => {
    const tool = createCrossSessionMemoryTool({ list: vi.fn() });
    expect((tool.inputSchema as any).properties.action.enum).toEqual(['list']);
    expect((tool.inputSchema as any).properties.target.enum).toEqual(['agent', 'shared', 'user']);
    expect((tool.inputSchema as any).properties).not.toHaveProperty('content');
    expect((tool.inputSchema as any).properties).not.toHaveProperty('old_text');
    expect(tool.description).toMatch(/read-only/i);
  });
  it.each(['add', 'replace', 'remove', 'unknown'])('rejects retired %s dispatch before any IO', async action => {
    const handler = { list: vi.fn() };
    const tool = createCrossSessionMemoryTool(handler, { includeProjectTier: true });
    for (const target of ['agent', 'shared', 'user', 'space']) {
      expect(await tool.execute({ action, target, content: 'new', old_text: 'old' }, context)).toMatchObject({ isError: true });
    }
    expect(handler.list).not.toHaveBeenCalled();
  });
  it('lists existing space entries only when space scope is offered', async () => {
    const existing = { ok: true, entries: ['existing decision'], usage: { current: 1, limit: 100 } };
    const handler = { list: vi.fn().mockResolvedValue(existing) };
    const scoped = createCrossSessionMemoryTool(handler, { includeProjectTier: true });
    expect(JSON.parse((await scoped.execute({ action: 'list', target: 'space' }, context)).content)).toEqual(existing);
    expect(handler.list).toHaveBeenCalledWith('space');
    handler.list.mockClear();
    expect(await createCrossSessionMemoryTool(handler).execute({ action: 'list', target: 'space' }, context)).toMatchObject({ isError: true });
    expect(handler.list).not.toHaveBeenCalled();
  });
  it('defaults to the caller agent and preserves read failures', async () => {
    const handler = { list: vi.fn().mockResolvedValue({ ok: false, error: 'unavailable', entries: [], usage: { current: 0, limit: 100 } }) };
    expect(await createCrossSessionMemoryTool(handler).execute({ action: 'list' }, context)).toMatchObject({ isError: true });
    expect(handler.list).toHaveBeenCalledWith('agent');
  });
});
