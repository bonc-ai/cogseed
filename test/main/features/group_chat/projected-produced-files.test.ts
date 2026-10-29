import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectedProducedFiles } from '../../../../src/main/features/group_chat/bus';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projected-produced-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const call = (name: string, args: Record<string, unknown>) => ({ type: 'event', event: { stream: 'tool', data: { phase: 'start', name, arguments: args } } });

describe('projectedProducedFiles', () => {
  it('lists files a Runtime turn wrote, including host-written transcripts, and skips reads and missing files', () => {
    const minutes = path.join(dir, 'm_会议纪要_v002.md');
    const corrected = path.join(dir, 'm_转写-纠错.md');
    const raw = path.join(dir, 'm_转写.md');
    for (const file of [minutes, corrected, raw]) fs.writeFileSync(file, 'x');
    const produced = projectedProducedFiles([
      { type: 'progress', text: 'working' },
      call('read_file', { path: raw }),
      call('transcript_glossary_scan', { path: raw, rawOutputPath: raw }),
      call('transcript_glossary_apply', { path: raw, outputPath: corrected, rawOutputPath: raw }),
      call('write_file', { path: minutes, content: '#' }),
      call('write_file', { path: path.join(dir, 'never-written.md'), content: '#' }),
      call('write_file', { path: 'relative.md', content: '#' }),
      { type: 'event', event: { stream: 'tool', data: { phase: 'end', name: 'write_file', arguments: { path: minutes } } } },
    ] as any);
    expect(new Set(produced)).toEqual(new Set([raw, corrected, minutes]));
  });

  it('returns nothing for a turn without file writes', () => {
    expect(projectedProducedFiles(undefined)).toEqual([]);
    expect(projectedProducedFiles([call('read_file', { path: path.join(dir, 'x.md') })] as any)).toEqual([]);
  });

  it('uses the last publish_outputs declaration and honors an explicit empty set', () => {
    const first = path.join(dir, 'first_会议纪要_v001.md');
    const second = path.join(dir, 'second_会议纪要_v002.md');
    fs.writeFileSync(first, 'x');
    fs.writeFileSync(second, 'y');

    const replaced = projectedProducedFiles([
      call('write_file', { path: first }),
      call('publish_outputs', { paths: [first] }),
      call('publish_outputs', { paths: [second] }),
    ] as any);
    expect(replaced).toEqual([second]);

    // An explicit empty declaration means "no file deliverable"; it must not
    // fall back to inferring files from write_file arguments.
    const empty = projectedProducedFiles([
      call('write_file', { path: first }),
      call('publish_outputs', { paths: [] }),
    ] as any);
    expect(empty).toEqual([]);
  });

});
