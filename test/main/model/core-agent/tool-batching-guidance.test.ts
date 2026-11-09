import { describe, expect, it } from 'vitest';
import { prompts } from '../../../../src/main/prompts/loader';

// Prompt contract only: batching requests must not imply concurrent execution
// for writes/barriers or authorize guessing a dependent call's arguments.
describe('shared static tool batching guidance', () => {
  const body = prompts.load('chat_shared_rules', {});
  const guidance = body.match(/^## Tool call batching\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? '';

  it('groups independent ready calls in one assistant response', () => {
    expect(guidance).toMatch(/independent.*ready.*tool calls.*same assistant response/i);
    expect(guidance).toMatch(/arguments.*known.*authorized/i);
  });

  it('waits for prerequisite results before issuing dependent calls', () => {
    expect(guidance).toMatch(/dependent calls.*wait.*prerequisite results/i);
    expect(guidance).toMatch(/do not guess.*arguments/i);
  });

  it('leaves read-only concurrency bounded by the runtime without a fixed cap', () => {
    expect(guidance).toMatch(/runtime.*bounds.*read-only concurrency/i);
    expect(guidance).toMatch(/batching.*does not.*parallel execution/i);
    expect(guidance).not.toMatch(/\d|Promise\.all|`[a-z][a-z0-9_]*`/);
  });

  it('preserves model order for writes and execution barriers', () => {
    expect(guidance).toMatch(/writes.*barriers.*serial.*model order/i);
  });
});
