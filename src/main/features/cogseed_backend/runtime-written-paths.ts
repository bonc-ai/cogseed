/**
 * Paths a native Runtime session actually wrote, derived from host-owned tool
 * records.
 *
 * `write_file`/`edit_file` are not the only writers: the meeting workflow's
 * transcript and corrected transcript are written by the **host** tools
 * `transcript_glossary_scan` (`rawOutputPath`) and `transcript_glossary_apply`
 * (`corrected_path` / `raw_path` in the receipt). A declaration check that only
 * understood `write_file` would reject two of the four meeting artifacts, and
 * the terminal safety net would never see them either.
 */

import * as path from 'node:path';

import type { NativeRuntimeSessionRecord } from '../cogseed_runtime/kernel/session-store';

const DIRECT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'office_create',
  'office_edit',
]);

/** Absolute, de-duplicated paths proven by a successful tool record. */
export function collectRuntimeWrittenPaths(
  records: readonly NativeRuntimeSessionRecord[],
  baseDir?: string,
): Set<string> {
  const written = new Set<string>();
  const base = baseDir || process.cwd();
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || !value.trim()) return;
    written.add(path.resolve(base, value.trim()));
  };

  for (const record of records) {
    if (record.type !== 'turn' || !record.tool) continue;
    const { name, input, result } = record.tool;
    if (DIRECT_WRITE_TOOLS.has(name)) {
      if (!result.isError) add(input.path);
      continue;
    }
    if (name === 'transcript_glossary_scan') {
      // The scan writes the original transcript to rawOutputPath. outputPath is
      // only remembered for the later apply, so it is not a write yet.
      if (!result.isError) add(input.rawOutputPath);
      continue;
    }
    if (name === 'transcript_glossary_apply') {
      if (result.isError) continue;
      add(input.outputPath);
      add(input.rawOutputPath);
      const content = typeof result.content === 'string' ? result.content : '';
      const corrected = /corrected_path:\s*(\S+)/.exec(content)?.[1];
      const raw = /raw_path:\s*(\S+)/.exec(content)?.[1];
      if (corrected) add(corrected);
      if (raw) add(raw);
    }
  }
  return written;
}
