import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const preload = readFileSync(resolve(__dirname, '../../src/main/preload.js'), 'utf8');

describe('Creator/P3394 renderer IPC wiring', () => {
  it('keeps a single generic invoke/stream bridge and does not expose raw network APIs', () => {
    expect(preload).toContain('function invoke(channel, payload)');
    expect(preload).toContain('function stream(channel, payload, onEvent)');
    expect(preload).toContain('invoke,');
    expect(preload).toContain('stream,');
    expect(preload).not.toContain('connectP3394');
    expect(preload).not.toContain('createP3394Session');
    expect(preload).not.toContain('p3394Token');
    expect(preload).not.toContain('endpoint:');
  });
});
