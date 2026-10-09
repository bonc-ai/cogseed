/**
 * File context classification for red-flag scanning.
 *
 * A pattern's danger depends on where it sits, not just whether it matches.
 * `ut.exec(t)` inside a minified GSAP bundle is a regex call in third-party
 * code; the same text in `scripts/run.py` is dynamic execution in code we are
 * about to run. Treating those identically is what produces the false
 * positives that make a gate untrustworthy — and an untrusted gate gets
 * clicked through.
 *
 * This module was ported from the standalone scanner after calibration on real
 * content. Two findings drove its shape:
 *
 *   1. `scripts/vendor/gsap.min.js` in the shipped `stage-compose` skill
 *      matched `no_eval_with_external_input` on `ut.exec(t)`, i.e. the current
 *      ruleset hard-blocks one of our own builtin skills.
 *   2. In the standalone scanner, a defensive SSRF guard was scored 0/100 and
 *      marked "do not install" because it *named* the metadata IP it existed to
 *      block. Mentioning a threat is not committing one.
 *
 * Demotion is not suppression: findings are still reported, with the original
 * level and the reason recorded, so an auditor can see what was downgraded and
 * why. Silently dropping a finding would trade a visible false positive for an
 * invisible false negative, which is the worse of the two.
 */
import * as path from 'node:path';

import { Level } from '../types';

export type FileContext = 'source' | 'test' | 'vendor' | 'generated';

/** Directory names that mark third-party code. */
const VENDOR_DIRS: ReadonlySet<string> = new Set([
  'vendor', 'vendored', 'node_modules', 'third_party', 'thirdparty',
  'external', 'dist', 'build', 'site-packages',
]);

/** Directory names that mark test code. */
const TEST_DIRS: ReadonlySet<string> = new Set([
  'test', 'tests', '__tests__', 'spec', 'fixtures', 'testdata',
]);

const TEST_FILE_RE = /(?:^|[._-])(?:test|spec)[._-]|^test_|_test\.|\.spec\.|\.test\./i;
const MINIFIED_NAME_RE = /\.min\.(?:js|css|mjs|cjs)$|[.-]bundle\.js$|\.pack\.js$/i;

/**
 * A single line this long implies machine-generated output.
 *
 * Only applied to code files. Prose legitimately runs long — a 682-character
 * Markdown paragraph in `stage-generate/SKILL.md` was misread as a minified
 * bundle by an earlier version of this heuristic, which would have made
 * "write a long paragraph" a way to demote findings.
 */
const LONG_LINE_THRESHOLD = 400;

const CODE_EXTS: ReadonlySet<string> = new Set([
  '.py', '.sh', '.bash', '.zsh', '.ts', '.mjs', '.cjs', '.js',
  '.rb', '.ps1', '.cmd', '.bat', '.go', '.rs', '.java', '.php',
]);

function _isCodeFile(relpath: string): boolean {
  return CODE_EXTS.has(path.extname(relpath).toLowerCase());
}

/** True when the file looks machine-generated (minified or bundled). */
export function isGenerated(relpath: string, content?: string): boolean {
  if (MINIFIED_NAME_RE.test(relpath)) return true;
  if (content === undefined || !_isCodeFile(relpath)) return false;
  // Check only the head: enough to classify, bounded cost on large files.
  const head = content.split('\n', 50);
  return head.some((line) => line.length > LONG_LINE_THRESHOLD);
}

/**
 * Classify a file by path (and content, when available).
 *
 * Precedence is vendor > generated > test > source. Vendor wins over test
 * because `vendor/**\/test_x.js` is primarily *not our code*; that judgement
 * matters more than its role within the dependency.
 */
export function fileContext(relpath: string, content?: string): FileContext {
  const norm = relpath.replace(/\\/g, '/').toLowerCase();
  const segments = norm.split('/');
  const dirs = segments.slice(0, -1);
  const name = segments[segments.length - 1] || '';

  if (dirs.some((d) => VENDOR_DIRS.has(d))) return 'vendor';
  if (isGenerated(norm, content)) return 'generated';
  if (dirs.some((d) => TEST_DIRS.has(d)) || TEST_FILE_RE.test(name)) return 'test';
  return 'source';
}

const ORDER: readonly Level[] = ['LOW', 'MEDIUM', 'EXTREME'];

/** Lower a level by `steps`, floored at LOW. */
function _demote(level: Level, steps: number): Level {
  const idx = ORDER.indexOf(level);
  if (idx < 0 || steps <= 0) return level;
  return ORDER[Math.max(0, idx - steps)];
}

/**
 * How far each context lowers a finding.
 *
 * Vendor and generated code drop to advisory: we did not author it, and a
 * match there is far more likely to be an artifact of minification or a
 * library's own regex handling than an intent to do harm. Test code drops one
 * step — attack strings there are usually assertions, but a test directory is
 * still a real place to hide a payload, so it does not go all the way down.
 */
const DEMOTE_STEPS: Readonly<Record<FileContext, number>> = {
  source: 0,
  test: 1,
  vendor: 2,
  generated: 2,
};

export interface ContextAdjustment {
  level: Level;
  /** Original level, when demotion changed it. */
  originalLevel?: Level;
  /**
   * Why this level applies. `comment` is not a file classification but a
   * position one — it is set when a match sits in explanatory text, so a
   * demotion always carries its reason.
   */
  context: FileContext | 'comment';
  demoted: boolean;
}

// ── Comment and docstring classification ─────────────────────────────────
// The remaining false-positive class after file-level context: dangerous
// literals inside explanatory text. A defensive SSRF guard names the metadata
// IP it exists to block, and its docstring explains the attack in detail. That
// is documentation, not a request.
//
// This is a deliberately shallow scan rather than a parser. When the structure
// is ambiguous, it does NOT mark a line as a comment — a missed demotion costs
// a visible false positive, while wrongly treating real code as a comment would
// silently downgrade an actual payload.

const LINE_COMMENT_PREFIX: Readonly<Record<string, readonly string[]>> = {
  python: ['#'],
  javascript: ['//'],
  shell: ['#'],
  ruby: ['#'],
  powershell: ['#'],
};

export type SourceLang = 'python' | 'javascript' | 'shell' | 'ruby' | 'powershell' | 'unknown';

const EXT_LANG: Readonly<Record<string, SourceLang>> = {
  '.py': 'python', '.pyi': 'python',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'javascript', '.tsx': 'javascript', '.jsx': 'javascript',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.rb': 'ruby',
  '.ps1': 'powershell',
};

export function languageOf(relpath: string): SourceLang {
  return EXT_LANG[path.extname(relpath).toLowerCase()] ?? 'unknown';
}

/** True when the line is a single-line comment in its file's language. */
export function isCommentLine(line: string, relpath: string): boolean {
  const stripped = line.trimStart();
  if (!stripped) return false;
  const prefixes = LINE_COMMENT_PREFIX[languageOf(relpath)] ?? ['#'];
  return prefixes.some((p) => stripped.startsWith(p));
}

/** Line numbers (1-based) inside a Python docstring. */
function _pyDocstringLines(text: string): Set<number> {
  const out = new Set<number>();
  const delims = ['"""', "'''"];
  let open: string | null = null;
  text.split('\n').forEach((line, i) => {
    const no = i + 1;
    if (open === null) {
      const stripped = line.trimStart();
      for (const d of delims) {
        if (!stripped.startsWith(d)) continue;
        out.add(no);
        // A docstring that opens and closes on one line leaves state unchanged.
        if (_countOccurrences(stripped, d) < 2) open = d;
        break;
      }
    } else {
      out.add(no);
      if (line.includes(open)) open = null;
    }
  });
  return out;
}

/** Line numbers (1-based) inside a `/* … *\/` block. */
function _cBlockCommentLines(text: string): Set<number> {
  const out = new Set<number>();
  let inside = false;
  text.split('\n').forEach((line, i) => {
    const no = i + 1;
    if (inside) {
      out.add(no);
      if (line.includes('*/')) inside = false;
      return;
    }
    if (line.includes('/*') && !line.includes('*/')) {
      inside = true;
      out.add(no);
    }
  });
  return out;
}

function _countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

/** Line numbers inside a block comment or docstring, by language. */
export function blockCommentLines(relpath: string, text: string): Set<number> {
  const lang = languageOf(relpath);
  if (lang === 'python') return _pyDocstringLines(text);
  if (lang === 'javascript') return _cBlockCommentLines(text);
  return new Set();
}

/**
 * True when the match at `index` sits in explanatory text rather than code.
 *
 * Used by rules whose patterns describe things a defensive implementation must
 * legitimately name (internal address ranges, attack URLs). Rules where the
 * literal is the payload itself should not consult this.
 */
export function isExplanatoryPosition(
  content: string,
  index: number,
  relpath: string,
): boolean {
  const lineStart = content.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  let lineEnd = content.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = content.length;
  const line = content.slice(lineStart, lineEnd);
  if (isCommentLine(line, relpath)) return true;
  const lineNo = _lineNumberOf(content, index);
  return blockCommentLines(relpath, content).has(lineNo);
}

function _lineNumberOf(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === '\n') n += 1;
  }
  return n;
}

/**
 * Apply context to a rule's level.
 *
 * `neverDemote` marks rules whose meaning does not soften with location — a
 * hardcoded production credential is a leaked credential even in a test file,
 * because the secret is real regardless of which file quotes it.
 */
export function adjustForContext(
  level: Level,
  context: FileContext,
  opts: { neverDemote?: boolean } = {},
): ContextAdjustment {
  if (opts.neverDemote || context === 'source') {
    return { level, context, demoted: false };
  }
  const next = _demote(level, DEMOTE_STEPS[context]);
  if (next === level) return { level, context, demoted: false };
  return { level: next, originalLevel: level, context, demoted: true };
}
