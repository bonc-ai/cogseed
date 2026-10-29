import { describe, expect, it, vi } from 'vitest';
import { validateToolArguments, type Tool } from '@earendil-works/pi-ai';

const sdk = vi.hoisted(() => ({ complete: vi.fn(), stream: vi.fn() }));
vi.mock('@earendil-works/pi-ai', async importOriginal => ({
  ...await importOriginal<typeof import('@earendil-works/pi-ai')>(),
  complete: sdk.complete,
  stream: sdk.stream,
}));

import { createPiProvider } from '../../../../src/core-agent/src/providers/pi-provider';

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    templateValues: { type: 'object', additionalProperties: { type: 'string' } },
    items: { type: 'array', items: { type: 'object', properties: { version: { type: 'integer', minimum: 1 } }, required: ['version'], additionalProperties: false } },
    kind: { type: 'string', enum: ['template', 'rule'] },
  }, required: ['templateValues', 'kind'],
};
const params = { model: 'test-model', messages: [], tools: [{ name: 'fill', description: 'fill a template', inputSchema: schema }] };
const provider = createPiProvider({ provider: 'test', customModel: {
  id: 'test-model', name: 'test', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
} });

describe('pi provider tool schema', () => {
  it('preserves nested JSON Schema in complete and isolates the caller schema', async () => {
    sdk.complete.mockResolvedValue({ content: [], stopReason: 'stop', model: 'test-model', usage: {} });
    await provider.complete(params);
    const tool = sdk.complete.mock.calls.at(-1)![1].tools[0] as Tool;
    expect(tool.parameters).toEqual(schema);
    expect(tool.parameters).not.toBe(schema);
    const valid = { templateValues: { 活动: '虚构活动', 负责人: '测试人' }, kind: 'template', items: [{ version: 1 }] };
    expect(validateToolArguments(tool, { type: 'toolCall', id: '1', name: 'fill', arguments: valid })).toEqual(valid);
    for (const invalid of [
      { ...valid, templateValues: '活动=虚构活动' },
      { ...valid, kind: 'personal' },
      { ...valid, items: [{ version: 0 }] },
      { ...valid, unknown: true },
    ]) expect(() => validateToolArguments(tool, { type: 'toolCall', id: '1', name: 'fill', arguments: invalid })).toThrow();
  });

  it('preserves the same schema in the real streaming adapter', async () => {
    sdk.stream.mockReturnValue((async function* () {})());
    for await (const _event of provider.stream(params)) { /* drain */ }
    expect(sdk.stream.mock.calls.at(-1)![1].tools[0].parameters).toEqual(schema);
  });
});
