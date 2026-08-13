import { describe, expect, it } from 'vitest';

import {
  getRuntimeOpenAIToolCatalog,
  getRuntimeToolCatalog,
} from '../../../../../src/main/features/cogseed_runtime/kernel/tools/catalog';

describe('CogSeed Runtime OpenAI tool schema contract', () => {
  it('exposes the complete approved safe Runtime catalog with strict JSON schemas', () => {
    const catalog = getRuntimeToolCatalog();
    const tools = getRuntimeOpenAIToolCatalog();

    expect(tools.map((tool) => tool.name)).toEqual(catalog.map((tool) => tool.name));
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'stat_file',
        parameters: expect.objectContaining({
          type: 'object',
          required: ['path'],
          additionalProperties: false,
        }),
      }),
      expect.objectContaining({
        name: 'search_files',
        parameters: expect.objectContaining({
          type: 'object',
          additionalProperties: false,
        }),
      }),
      expect.objectContaining({
        name: 'grep_files',
        parameters: expect.objectContaining({
          type: 'object',
          required: ['pattern'],
          additionalProperties: false,
        }),
      }),
      expect.objectContaining({
        name: 'edit_file',
        parameters: expect.objectContaining({
          type: 'object',
          required: ['path', 'old_string'],
          additionalProperties: false,
        }),
      }),
      expect.objectContaining({
        name: 'read_file',
        parameters: expect.objectContaining({
          type: 'object',
          required: ['path'],
          additionalProperties: false,
        }),
      }),
      expect.objectContaining({
        name: 'write_file',
        parameters: expect.objectContaining({
          type: 'object',
          required: ['path', 'content'],
          additionalProperties: false,
        }),
      }),
      expect.objectContaining({
        name: 'bash',
        parameters: expect.objectContaining({
          type: 'object',
          required: ['command'],
          additionalProperties: false,
        }),
      }),
      expect.objectContaining({
        name: 'run_skill',
        parameters: expect.objectContaining({
          type: 'object',
          required: ['skill_id', 'script'],
          additionalProperties: false,
        }),
      }),
    ]));

    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });
});
