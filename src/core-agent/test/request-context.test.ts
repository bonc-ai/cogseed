import { describe, expect, it } from 'vitest';
import { RequestContextProjection, MAX_RETAINED_EXECUTION_CONTEXT_TOKENS } from '../src/agent/request-context.js';
import type { Message } from '../src/shared/types.js';

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] });
const body = (messages: Message[]) => JSON.stringify(messages);

describe('bounded run-local execution context projection', () => {
  it('retains sent state positions while appending tool pairs and the latest changed state', () => {
    const projection = new RequestContextProjection();
    const base = [user('task')];
    const first = projection.project(base, [user('plan revision 1')], 100_000);
    const toolPair: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'receipt' }] },
    ];
    const next = projection.project([...base, ...toolPair], [user('plan revision 2')], 100_000);
    expect(next.slice(0, first.length)).toEqual(first);
    expect(next.slice(first.length, first.length + toolPair.length)).toEqual(toolPair);
    expect(body(next.at(-1) ? [next.at(-1)!] : [])).toContain('plan revision 2');
    expect(body(next)).toContain('latest snapshot supersedes');
    expect(base).toEqual([user('task')]);
    expect(projection.overheadTokens).toBeGreaterThan(0);
  });

  it('does not duplicate unchanged state on retries or new tool rounds', () => {
    const projection = new RequestContextProjection();
    const state = [user('same plan')];
    const first = projection.project([user('task')], state, 100_000);
    expect(projection.project([user('task')], state, 100_000)).toEqual(first);
    const next = projection.project([user('task'), assistant('tool process')], state, 100_000);
    expect(next).toEqual([...first, assistant('tool process')]);
  });

  it('resets on canonical checkpoint, healing, history removal or same-length edits', () => {
    for (const changed of [[user('checkpoint')], [], [user('TASK')]]) {
      const projection = new RequestContextProjection();
      projection.project([user('task')], [user('old state')], 100_000);
      const next = projection.project(changed, [user('current state')], 100_000);
      expect(body(next)).not.toContain('old state');
      expect(next.slice(0, changed.length)).toEqual(changed);
    }
  });

  it('clears obsolete plan state explicitly when state disappears', () => {
    const projection = new RequestContextProjection();
    const base = [user('task')];
    projection.project(base, [user('old plan')], 100_000);
    const next = projection.project([...base, user('cancel plan')], [], 100_000);
    expect(body([next.at(-1)!])).toContain('No current execution plan or work ledger');
    const same = projection.project([...base, user('cancel plan')], [], 100_000);
    expect(same).toEqual(next);
  });

  it('bounds old snapshots and preserves exact current state on a budget reset', () => {
    const projection = new RequestContextProjection();
    const base = [user('task')];
    let sawReset = false;
    for (let i = 0; i < 40; i++) {
      const state = [user(`revision ${i} ${'x'.repeat(1_200)}`)];
      const next = projection.project(base, state, 100_000);
      expect(projection.overheadTokens).toBeLessThanOrEqual(MAX_RETAINED_EXECUTION_CONTEXT_TOKENS);
      if (next.length === base.length + state.length && body(next) === body([...base, ...state])) sawReset = true;
      expect(body(next)).toContain(`revision ${i} `);
    }
    expect(sawReset).toBe(true);
  });

  it('sheds retained state near the context limit without dropping canonical messages', () => {
    const projection = new RequestContextProjection();
    const base = [user('task')];
    projection.project(base, [user('old state')], 100_000);
    const state = [user('current state')];
    expect(projection.project(base, state, 0)).toEqual([...base, ...state]);
    expect(projection.overheadTokens).toBe(0);
    expect(new RequestContextProjection().project(base, [], 100_000)).toEqual(base);
  });
});
