import { describe, expect, it } from 'vitest';
import {
  createToolFailureGuard,
  guardToolsWithFailureBreaker,
} from '../../../../src/main/model/core-agent/tool-failure-guard';

/**
 * P1-3: a failed cognition read must not be followed by an ontology write.
 * The breaker counts consecutive *same-kind* failures, so a model that answers a
 * failed `cognition_ontology_query` with `create_cognition(ontology)` reset the
 * streak and wrote anyway. The guard now refuses that write outright.
 */
function tool(name: string, result: { content: string; isError: boolean }, ran: string[]) {
  return {
    name,
    async execute(input: unknown) {
      ran.push(name);
      return result;
    },
  } as never;
}

const READ_FAIL = { content: '{"status":"blocked","code":"ontology_not_found"}', isError: true };
const READ_OK = { content: '{"status":"ok"}', isError: false };

describe('core-agent › tool failure guard › ontology write block (P1-3)', () => {
  it('blocks create_cognition(ontology) after a deterministic cognition read failure', async () => {
    const guard = createToolFailureGuard();
    const ran: string[] = [];
    const tools = guardToolsWithFailureBreaker(
      [
        tool('cognition_ontology_query', READ_FAIL, ran),
        tool('create_cognition', { content: '{"status":"ok"}', isError: false }, ran),
      ] as never,
      { guard },
    ) as unknown as Array<{ name: string; execute: (i: unknown, c?: unknown) => Promise<{ isError?: boolean; endTurn?: boolean; content?: string }> }>;

    const read = await tools[0].execute({}, {});
    expect(read.isError).toBe(true);
    expect(ran).toEqual(['cognition_ontology_query']);

    const write = await tools[1].execute({ target: 'ontology' }, {});
    expect(write.isError).toBe(true);
    expect(write.endTurn).toBe(true);
    expect(String(write.content)).toContain('已阻断');
    // The write must NOT have run.
    expect(ran).toEqual(['cognition_ontology_query']);
  });

  it('leaves a non-ontology create_cognition and a recovered read alone', async () => {
    const guard = createToolFailureGuard();
    const ran: string[] = [];
    const tools = guardToolsWithFailureBreaker(
      [
        tool('cognition_ontology_query', READ_FAIL, ran),
        tool('create_cognition', { content: '{"status":"ok"}', isError: false }, ran),
      ] as never,
      { guard },
    ) as unknown as Array<{ execute: (i: unknown, c?: unknown) => Promise<{ isError?: boolean }> }>;
    await tools[0].execute({}, {});
    const otherTarget = await tools[1].execute({ target: 'rule' }, {});
    expect(otherTarget.isError).toBeFalsy();
    expect(ran).toEqual(['cognition_ontology_query', 'create_cognition']);
  });

  it('does not block on a transient read failure', async () => {
    const guard = createToolFailureGuard();
    const ran: string[] = [];
    const tools = guardToolsWithFailureBreaker(
      [
        tool('cognition_ontology_query', { content: 'Request timed out', isError: true }, ran),
        tool('create_cognition', { content: '{"status":"ok"}', isError: false }, ran),
      ] as never,
      { guard },
    ) as unknown as Array<{ execute: (i: unknown, c?: unknown) => Promise<{ isError?: boolean }> }>;
    const read = await tools[0].execute({}, {});
    expect(read.isError).toBe(true);
    const write = await tools[1].execute({ target: 'ontology' }, {});
    expect(write.isError).toBeFalsy();
  });

  it('does not block a write when the read succeeded', async () => {
    const guard = createToolFailureGuard();
    const ran: string[] = [];
    const tools = guardToolsWithFailureBreaker(
      [
        tool('cognition_ontology_query', READ_OK, ran),
        tool('create_cognition', { content: '{"status":"ok"}', isError: false }, ran),
      ] as never,
      { guard },
    ) as unknown as Array<{ execute: (i: unknown, c?: unknown) => Promise<{ isError?: boolean }> }>;
    await tools[0].execute({}, {});
    const write = await tools[1].execute({ target: 'ontology' }, {});
    expect(write.isError).toBeFalsy();
  });
});
