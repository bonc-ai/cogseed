import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { captureIpcContract } = require('../../scripts/capture-ipc-contract.cjs') as {
  captureIpcContract(options: { rootDir: string; sourceDir?: string; baselineCommit?: string }): {
    totals: {
      calls: number;
      staticCalls: number;
      dynamicCalls: number;
      uniqueStaticChannels: number;
      invokeChannels: number;
      streamChannels: number;
    };
    callsites: Array<{
      file: string;
      line: number;
      column: number;
      kind: string;
      channel: string | null;
      argumentCount: number;
      payloadNodeKind: string | null;
    }>;
  };
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('renderer IPC contract capture', () => {
  it('captures literal, dynamic, stream, and optional-chain calls with source locations', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cogseed-ipc-capture-'));
    tempRoots.push(rootDir);
    const sourceDir = join(rootDir, 'src/renderer/modules');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, 'fixture.js'),
      [
        "window.cogseed.invoke('literal.channel', { id: 1 });",
        "window.cogseed.stream('stream.channel', {}, onEvent);",
        'window.cogseed.invoke(channelName, payload);',
        "window.cogseed?.invoke?.('optional.channel', {});",
      ].join('\n'),
    );

    const snapshot = captureIpcContract({ rootDir, baselineCommit: 'test-baseline' });

    expect(snapshot.totals).toEqual({
      calls: 4,
      staticCalls: 3,
      dynamicCalls: 1,
      uniqueStaticChannels: 3,
      invokeChannels: 2,
      streamChannels: 1,
    });
    expect(snapshot.callsites).toEqual([
      expect.objectContaining({
        file: 'src/renderer/modules/fixture.js',
        line: 1,
        column: 1,
        kind: 'invoke',
        channel: 'literal.channel',
        argumentCount: 2,
        payloadNodeKind: 'ObjectLiteralExpression',
      }),
      expect.objectContaining({
        file: 'src/renderer/modules/fixture.js',
        line: 2,
        column: 1,
        kind: 'stream',
        channel: 'stream.channel',
        argumentCount: 3,
        payloadNodeKind: 'ObjectLiteralExpression',
      }),
      expect.objectContaining({
        file: 'src/renderer/modules/fixture.js',
        line: 3,
        column: 1,
        kind: 'invoke',
        channel: null,
        argumentCount: 2,
        payloadNodeKind: 'Identifier',
      }),
      expect.objectContaining({
        file: 'src/renderer/modules/fixture.js',
        line: 4,
        column: 1,
        kind: 'invoke',
        channel: 'optional.channel',
        argumentCount: 2,
        payloadNodeKind: 'ObjectLiteralExpression',
      }),
    ]);
  });
});
