/**
 * Agent replies cite workspace files as inline code, often shortened by the
 * model itself: `.../<conv dir>/<file>.md`, `~/…`, or a bare `<dir>/<file>`.
 * This turns one such hint into ordered absolute candidates.
 *
 * Pure: never touches disk. Callers must still pass every candidate through
 * the file-action sandbox and stat it — a candidate is not a permission.
 * Order: recorded produced paths whose tail matches (most specific) → each
 * base joined with the hint's relative tail.
 */
import * as path from 'node:path';

export interface PathHintContext {
  homeDir: string;
  /** Directories a relative / `.../`-shortened hint may hang off. */
  bases: string[];
  /** Exact produced paths already recorded on the conversation. */
  recordedPaths: string[];
}

const MAX_HINT_LENGTH = 1024;
const ELLIPSIS_PREFIX_RE = /^(?:\.{3}|…)[\\/]+/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function candidatePathsForHint(raw: unknown, ctx: PathHintContext): string[] {
  if (typeof raw !== 'string') return [];
  const hint = raw.trim();
  if (!hint || hint.length > MAX_HINT_LENGTH) return [];
  if (/[\r\n\0]/.test(hint) || URL_SCHEME_RE.test(hint)) return [];

  if (hint.startsWith('~/') || hint.startsWith('~\\')) {
    return [path.resolve(ctx.homeDir, hint.slice(2))];
  }
  if (path.isAbsolute(hint)) return [path.resolve(hint)];

  const rel = hint.replace(ELLIPSIS_PREFIX_RE, '').replace(/^\.[\\/]+/, '');
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  // A shortened hint names a tail inside a known base; traversal can't be one.
  if (!segments.length || segments.some((s) => s === '..' || s === '.')) return [];
  const tail = segments.join(path.sep);

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const recorded of ctx.recordedPaths) {
    if (typeof recorded !== 'string' || !recorded) continue;
    const abs = path.resolve(recorded);
    if (abs.endsWith(path.sep + tail)) push(abs);
  }
  for (const base of ctx.bases) {
    if (typeof base !== 'string' || !base) continue;
    push(path.join(path.resolve(base), tail));
  }
  return out;
}
