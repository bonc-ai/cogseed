import type { SkillSnapshotFile } from './snapshot-service';
import { snapshotSkillFiles } from './snapshot-service';

export type SkillFileDiffStatus = 'added' | 'modified' | 'deleted';

export interface SkillDiffLine {
  type: 'context' | 'added' | 'deleted';
  text: string;
}
export interface SkillFileDiff {
  path: string;
  status: SkillFileDiffStatus;
  beforeHash?: string;
  afterHash?: string;
  lines?: SkillDiffLine[];
  truncated?: boolean;
}

export interface SkillTreeDiff {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
  files: SkillFileDiff[];
}

const MAX_DIFF_FILE_CHARS = 80_000;
const MAX_DIFF_LINES = 400;
const MAX_LCS_CELLS = 120_000;

function textLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n');
}

function lineDiff(before: string, after: string): { lines?: SkillDiffLine[]; truncated?: boolean } {
  if (before.length + after.length > MAX_DIFF_FILE_CHARS) return { truncated: true };
  const left = textLines(before);
  const right = textLines(after);
  if (left.length * right.length > MAX_LCS_CELLS) return { truncated: true };
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines: SkillDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push({ type: 'context', text: left[i] });
      i += 1;
      j += 1;
    } else if (j < right.length && (i >= left.length || table[i][j + 1] >= table[i + 1][j])) {
      lines.push({ type: 'added', text: right[j] });
      j += 1;
    } else {
      lines.push({ type: 'deleted', text: left[i] });
      i += 1;
    }
    if (lines.length >= MAX_DIFF_LINES) return { lines, truncated: true };
  }
  return { lines };
}

export function diffSkillTrees(
  beforeFiles: ReadonlyArray<SkillSnapshotFile>,
  afterFiles: ReadonlyArray<SkillSnapshotFile>,
): SkillTreeDiff {
  const before = snapshotSkillFiles(beforeFiles).files;
  const after = snapshotSkillFiles(afterFiles).files;
  const left = new Map(before.map((file) => [file.path, file]));
  const right = new Map(after.map((file) => [file.path, file]));
  const paths = Array.from(new Set([...left.keys(), ...right.keys()])).sort();
  const result: SkillTreeDiff = { added: 0, modified: 0, deleted: 0, unchanged: 0, files: [] };
  for (const path of paths) {
    const prior = left.get(path);
    const next = right.get(path);
    if (!prior && next) {
      result.added += 1;
      result.files.push({ path, status: 'added', afterHash: next.contentHash, ...lineDiff('', next.content) });
    } else if (prior && !next) {
      result.deleted += 1;
      result.files.push({ path, status: 'deleted', beforeHash: prior.contentHash, ...lineDiff(prior.content, '') });
    } else if (prior && next && prior.contentHash !== next.contentHash) {
      result.modified += 1;
      result.files.push({
        path,
        status: 'modified',
        beforeHash: prior.contentHash,
        afterHash: next.contentHash,
        ...lineDiff(prior.content, next.content),
      });
    } else {
      result.unchanged += 1;
    }
  }
  return result;
}
