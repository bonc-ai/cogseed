/** Make library files named in an Agent's task text readable by that Agent.
 *
 * A Runtime Agent may only read its working directory and files attached to
 * the request. The Commander hands work over in prose and often cites library
 * paths such as `from-tasks/<task>/<file>`, which resolve against no root the
 * Agent has, so the Agent searches an empty workspace and fails. The host
 * copies each cited file that really exists in the user's library into the
 * working directory and appends the absolute paths to the task. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { userContextsDir } from '../../paths';
import { isPathAllowed } from '../../util/path-sandbox';

const MAX_STAGED_FILES = 5;
const MAX_STAGED_BYTES = 5 * 1024 * 1024;
// A relative path with at least one directory and an extension, optionally
// wrapped in backticks or CJK/ASCII quotes.
const CANDIDATE_RE = /(?:^|[\s`'"「『（(：:])((?:[^\s`'"「」『』（）()/\\:：]+\/)+[^\s`'"「」『』（）()/\\]+\.[A-Za-z0-9]{1,8})(?=$|[\s`'"」』）),，。；;])/gu;

export interface StagedLibraryFile { reference: string; path: string }

export function stageLibraryReferences(userId: string, task: string, workingDir: string | undefined): {
  task: string; staged: StagedLibraryFile[];
} {
  if (!workingDir || !path.isAbsolute(workingDir)) return { task, staged: [] };
  fs.mkdirSync(workingDir, { recursive: true });
  const library = userContextsDir(userId);
  const staged: StagedLibraryFile[] = [];
  const seen = new Set<string>();
  for (const match of task.matchAll(CANDIDATE_RE)) {
    const reference = match[1];
    if (seen.has(reference) || staged.length >= MAX_STAGED_FILES) continue;
    seen.add(reference);
    if (reference.split('/').includes('..')) continue;
    const source = path.join(library, reference);
    if (!isPathAllowed(source, [library])) continue;
    let stat: fs.Stats;
    try { stat = fs.statSync(source); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_STAGED_BYTES) continue;
    const target = path.join(workingDir, path.basename(reference));
    if (!isPathAllowed(target, [workingDir])) continue;
    if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    staged.push({ reference, path: target });
  }
  if (!staged.length) return { task, staged };
  return {
    task: `${task}\n\nLibrary files cited above are already copied into your workspace. Use these absolute paths:\n${
      staged.map((file) => `- ${file.reference} → ${file.path}`).join('\n')}`,
    staged,
  };
}
