/** Keep connector transcripts whole by saving them in the task workspace.
 *
 * A meeting connector returns each transcript twice (paragraph objects plus
 * the same text flattened). For a half-hour meeting that passes the host tool
 * result cap, and the head/tail preview silently drops the middle of the
 * meeting — the Agent then corrects and summarizes a partial transcript.
 * Saving the flat text as a file keeps every word and lets the Agent pass a
 * path to the correction tools instead of retyping thousands of characters. */
import * as path from 'node:path';
import { isPathAllowed } from '../../util/path-sandbox';
import { writeTextAtomicSync } from '../../storage';
import type { CogSeedHostToolResult, CogSeedHostToolScope } from './office-adapter';

const PREVIEW_CHARS = 1_200;

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

export function spillConnectorTranscript(result: CogSeedHostToolResult, scope: Pick<CogSeedHostToolScope, 'workingDir' | 'writableRoots'>): CogSeedHostToolResult {
  if (result.isError || !scope.workingDir) return result;
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(result.content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    payload = parsed as Record<string, unknown>;
  } catch { return result; }
  const recordId = typeof payload.record_file_id === 'string' ? safeSegment(payload.record_file_id) : '';
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!recordId || !text.trim() || !Array.isArray(payload.paragraphs)) return result;
  const firstPid = (payload.paragraphs as Array<{ pid?: unknown }>)[0]?.pid;
  const page = firstPid !== undefined && String(firstPid) !== '0' ? `_from-${safeSegment(String(firstPid))}` : '';
  const file = path.join(scope.workingDir, `transcript_${recordId}${page}.txt`);
  if (!isPathAllowed(file, scope.writableRoots)) return result;
  writeTextAtomicSync(file, text);
  const { paragraphs: _paragraphs, text: _text, ...rest } = payload;
  return {
    ...result,
    content: JSON.stringify({
      ...rest,
      transcript_path: file,
      note: `The full transcript (${text.length} chars) is saved at transcript_path. Pass that path to transcript_glossary_scan / transcript_glossary_apply; do not retype it. Read ranges of the file only when you need exact wording.`
        + (payload.more === true ? ' More paragraphs remain: fetch the next page; each page is saved as its own file.' : ''),
      preview: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text,
    }),
  };
}
