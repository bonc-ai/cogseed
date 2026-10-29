import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spillConnectorTranscript } from '../../../../src/main/features/cogseed_backend/connector-transcript-spill';

let workspace: string;
beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-spill-')); });
afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

const transcript = (text: string, extra: Record<string, unknown> = {}) => ({ content: JSON.stringify({
  record_file_id: '2110928670374297601', paragraphCount: 2,
  paragraphs: [{ pid: '0', speaker_name: 'A', text: 'x' }, { pid: '1', speaker_name: 'B', text: 'y' }],
  text, truncated: false, charCount: text.length, more: false, ...extra,
}) });

describe('spillConnectorTranscript', () => {
  it('saves the whole flat transcript and returns a short pointer instead of the doubled payload', () => {
    const text = '[00:51] 樊中扬: 开始\n'.repeat(2_000);
    const result = spillConnectorTranscript(transcript(text), { workingDir: workspace, writableRoots: [workspace] });
    const file = path.join(workspace, 'transcript_2110928670374297601.txt');
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    const body = JSON.parse(result.content);
    expect(body).toMatchObject({ record_file_id: '2110928670374297601', transcript_path: file, charCount: text.length });
    expect(body.paragraphs).toBeUndefined();
    expect(body.text).toBeUndefined();
    expect(result.content.length).toBeLessThan(3_000);
  });

  it('names later pages by their first paragraph id', () => {
    const result = spillConnectorTranscript({ content: JSON.stringify({ record_file_id: 'r1', paragraphs: [{ pid: '100' }], text: 'later', more: true }) },
      { workingDir: workspace, writableRoots: [workspace] });
    expect(JSON.parse(result.content).transcript_path).toBe(path.join(workspace, 'transcript_r1_from-100.txt'));
  });

  it('leaves other results, errors and unwritable workspaces untouched', () => {
    const other = { content: JSON.stringify({ meetings: [] }) };
    expect(spillConnectorTranscript(other, { workingDir: workspace, writableRoots: [workspace] })).toBe(other);
    const error = { ...transcript('t'), isError: true };
    expect(spillConnectorTranscript(error, { workingDir: workspace, writableRoots: [workspace] })).toBe(error);
    const outside = transcript('t');
    expect(spillConnectorTranscript(outside, { workingDir: workspace, writableRoots: [os.homedir() + '/nowhere'] })).toBe(outside);
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
});
