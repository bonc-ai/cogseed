import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as paths from '../../../../../src/main/paths';
import { DEFAULT_RUNTIME_TOOL_POLICY, COGSEED_RUNTIME_TOOL_POLICY } from '../../../../../src/main/features/cogseed_runtime/kernel/config';
import { createRuntimeToolRunner } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/runner';

const UID = 'runtime-cap-user';
const SESSION = 'mruntime-cap';
let root = '';

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(paths.userRoot(UID), { recursive: true, force: true });
});

describe('CogSeed Runtime result cap boundary', () => {
  it('caps connector umbrella results before returning them to the model', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-runtime-cap-'));
    const runner = createRuntimeToolRunner({
      userId: UID,
      runtimeSessionId: SESSION,
      allowedRoots: [root],
      toolPolicy: COGSEED_RUNTIME_TOOL_POLICY,
      maxInlineToolResultTokens: 10,
      connectorManager: {
        listAllTools: async () => Array.from({ length: 30 }, (_, index) => ({
          connectorId: 'connector-a',
          name: `tool-${index}`,
          exposedName: `tool-${index}`,
          description: 'large connector description '.repeat(20),
          input_schema: { type: 'object' },
        })),
      } as any,
    });

    const result = await runner.run('list_connector_tools', {});

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<persisted-output');
    expect(result.persistedOutput?.path.startsWith(paths.cogseedRuntimeSessionToolResultsDir(UID, SESSION))).toBe(true);
    expect(fs.existsSync(result.persistedOutput!.path)).toBe(true);
  });

  it('caps CogSeed KB results before returning them to the model', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-runtime-cap-'));
    const runner = createRuntimeToolRunner({
      userId: UID,
      runtimeSessionId: SESSION,
      allowedRoots: [root],
      toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
      maxInlineToolResultTokens: 10,
      kbManager: {
        search: async () => ({ hits: Array.from({ length: 30 }, () => ({ text: 'large kb hit '.repeat(20) })) }),
      } as any,
    });

    const result = await runner.run('search_mate_kb', { query: 'needle' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<persisted-output');
    expect(result.persistedOutput?.path.startsWith(paths.cogseedRuntimeSessionToolResultsDir(UID, SESSION))).toBe(true);
  });
});
