import { describe, expect, it } from 'vitest';
import { createToolFailureGuard, guardToolsWithFailureBreaker } from '../../../../src/main/model/core-agent/tool-failure-guard';

const failure = (path: string, content = 'E_NOT_READ: read before editing') =>
  ({ tool: 'edit_file', input: { path }, content, isError: true });
const success = (tool: string, path: string) => ({ tool, input: { path }, content: 'ok', isError: false });

describe('failure breaker recovery boundaries', () => {
  it('does not combine independent tools with the same error class', () => {
    const guard = createToolFailureGuard();
    for (const tool of ['edit_file', 'bash', 'manage_execution_plan']) {
      expect(guard.observe({ tool, content: 'invalid arguments', isError: true }).action).toBe('continue');
    }
    expect(guard.snapshot()).toMatchObject({ sameKindStreak: 1, countedFailures: 3 });
  });

  it('successful corrected operations retire their old failure budget in long tasks', () => {
    const guard = createToolFailureGuard();
    for (let i = 0; i < 12; i++) {
      expect(guard.observe(failure('alpha.ts')).action).toBe('continue');
      guard.observe(success('read_file', 'alpha.ts'));
      guard.observe(success('edit_file', 'alpha.ts'));
    }
    expect(guard.snapshot()).toMatchObject({ countedFailures: 0, sameKindStreak: 0 });
  });

  it('passes wrapper targets through so independent edit errors do not trip at three', async () => {
    const guard = createToolFailureGuard();
    const [wrapped] = guardToolsWithFailureBreaker([{
      name: 'edit_file',
      async execute(_input: never, _ctx: never) { return { content: 'E_NOT_READ: no write occurred', isError: true }; },
    }], { guard });
    for (const path of ['alpha.ts', 'beta.ts', 'gamma.ts']) {
      expect(await wrapped.execute({ path } as never, {} as never)).not.toHaveProperty('endTurn');
    }
    expect(guard.snapshot()).toMatchObject({ countedFailures: 3, sameKindStreak: 1 });
  });

  it.each(['E_NOT_READ', 'E_STALE', 'E_BAD_INPUT'])('bounds %s correction attempts despite successful reads', (code) => {
    const guard = createToolFailureGuard();
    for (let i = 0; i < 2; i++) {
      expect(guard.observe(failure('alpha.ts', `${code}: rejected ${i}`)).action).toBe('continue');
      guard.observe(success('read_file', 'alpha.ts'));
    }
    expect(guard.observe(failure('alpha.ts', `${code}: still rejected`))).toMatchObject({ action: 'endTurn' });
  });

  it('keeps errors for different targets and codes independent within the bounded window', () => {
    const guard = createToolFailureGuard();
    guard.observe(failure('a.ts', 'E_NOT_READ: read first'));
    guard.observe(failure('b.ts', 'E_NOT_READ: read first'));
    expect(guard.observe(failure('a.ts', 'E_STALE: changed')).action).toBe('continue');
    expect(guard.snapshot().sameKindStreak).toBe(1);
  });

  it('still stops six failures with no success even when all groups differ', () => {
    const guard = createToolFailureGuard();
    for (let i = 0; i < 5; i++) expect(guard.observe(failure(`${i}.ts`)).action).toBe('continue');
    expect(guard.observe(failure('six.ts'))).toMatchObject({ action: 'endTurn', countedFailures: 6 });
  });

  it('expires old groups after twelve intervening observations of progress', () => {
    const guard = createToolFailureGuard();
    guard.observe(failure('a.ts'));
    guard.observe(failure('a.ts'));
    for (let i = 0; i < 12; i++) guard.observe(success('read_file', 'b.ts'));
    expect(guard.observe(failure('a.ts')).action).toBe('continue');
    expect(guard.snapshot()).toMatchObject({ sameKindStreak: 1, countedFailures: 1 });
  });

  it('uses the leading error code rather than codes quoted in a recovery hint', () => {
    const guard = createToolFailureGuard();
    guard.observe(failure('a.ts', 'E_NOT_READ: missing baseline'));
    guard.observe(failure('a.ts', 'E_STALE: changed; avoid E_NOT_READ'));
    expect(guard.observe(failure('a.ts', 'E_BAD_INPUT: invalid hash; may otherwise return E_NOT_READ')).action).toBe('continue');
  });

  it('canonicalizes lexical paths and ignores changing correction content', () => {
    const guard = createToolFailureGuard();
    const attempt = (path: string, old_string: string) => guard.observe({
      ...failure(path, 'E_BAD_INPUT: replacement rejected'), input: { path, old_string }, workingDir: '/workspace',
    });
    attempt('./a.ts', 'one');
    attempt('folder/../a.ts', 'two');
    expect(attempt('/workspace/a.ts', 'three').action).toBe('endTurn');
  });

  it('does not let ignored edit fields split the same file failure group', () => {
    const guard = createToolFailureGuard();
    for (let i = 0; i < 2; i++) {
      expect(guard.observe({ ...failure('a.ts'), input: { path: 'a.ts', id: i, target: i } }).action).toBe('continue');
      guard.observe(success('read_file', 'a.ts'));
    }
    expect(guard.observe({ ...failure('a.ts'), input: { path: 'a.ts', id: 3, target: 3 } }).action).toBe('endTurn');
  });

  it('separates connector actions and common nested resource identities', () => {
    const guard = createToolFailureGuard();
    const attempt = (connector_id: string, tool_name: string, id: string) => guard.observe({
      tool: 'call_connector_tool', input: { connector_id, tool_name, args: { id } },
      content: 'invalid args', isError: true,
    });
    expect(attempt('notes', 'update', 'one').action).toBe('continue');
    expect(attempt('notes', 'update', 'two').action).toBe('continue');
    expect(attempt('notes', 'create', 'one').action).toBe('continue');
    expect(attempt('other', 'update', 'one').action).toBe('continue');
  });

  it('network interruptions do not consume or erase an existing failure group', () => {
    const guard = createToolFailureGuard();
    guard.observe(failure('a.ts'));
    guard.observe(failure('a.ts'));
    guard.observe({ tool: 'web_fetch', content: 'fetch failed', isError: true });
    expect(guard.observe(failure('a.ts'))).toMatchObject({ action: 'endTurn', countedFailures: 3 });
  });
});
