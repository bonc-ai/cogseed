import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

const CONNECTOR_DIR = 'test/main/features/connectors';
const FIXTURE_DIR = `${CONNECTOR_DIR}/fixtures`;

/** Files that render or transcribe live provider output, and therefore are the places a captured
 *  response is most likely to be pasted next. */
const PROVIDER_SURFACE = [
  `${CONNECTOR_DIR}/tencent-stdio-adapter.test.ts`,
  `${CONNECTOR_DIR}/local-cli-auth.test.ts`,
  `${CONNECTOR_DIR}/tencent-local-cli-connector.test.ts`,
  'bin/tencent-meeting-mcp-server.cjs',
];

/**
 * Every Chinese string value allowed in the Tencent fixtures.
 *
 * This is an allowlist rather than a denylist on purpose. A real capture carries real people,
 * meeting subjects, spoken sentences and organization names, and no pattern can enumerate those:
 * "示例会议 A" and "（示例文本，已脱敏）" are both Chinese text, and the published-repo
 * audit scores neither. The only reliable rule is that fixture text is authored, not captured, so a
 * new value has to be added here deliberately.
 */
const ALLOWED_CJK_VALUES = new Set([
  '云录制',
  '发言人乙',
  '发言人甲',
  '复用',
  '文字转写',
  '确认',
  '示例会议 A',
  '示例会议 B',
  '示例会议 C',
  '示例会议 D',
  '认知种子',
  '转码完成，可根据录制文件权限进行下一步',
  '（示例文本，已脱敏）',
]);

/** Fixture timestamps live in a synthetic window, so a captured one is obvious at a glance. */
const SYNTHETIC_YEAR = '2030';

/** The only OpenId-shaped value allowed anywhere on the provider surface. */
const SYNTHETIC_OPEN_ID = 'cli_0123456789abcdef0123456789abcdef';

// A range, not a fixed width. The real value that leaked was `cli_` + 28 hex characters, so a
// `{32}` pattern would have matched the placeholder and nothing else — a guard that cannot fail on
// the incident it exists for. Keep the bounds loose enough to catch a differently shaped account id.
const OPEN_ID_RE = /cli_[0-9a-f]{16,}/gi;
// No `\b` after the day on purpose: these appear as `2030-09-20T17:13:19+08:00`, and `0`→`T` is not
// a word boundary, so a trailing `\b` matches nothing at all.
const ISO_DATE_RE = /(\d{4})-\d{2}-\d{2}/g;
const SHARE_URL_RE = /https:\/\/meeting\.tencent\.com\/\S+/g;
const CJK_RE = /[\u4e00-\u9fff]/;

function fixtureFiles(): string[] {
  return fs
    .readdirSync(path.join(root, FIXTURE_DIR))
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function walkStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walkStrings(item, visit);
  }
}

/** Every string value in every fixture, paired with the file it came from for a readable failure. */
function fixtureStrings(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const file of fixtureFiles()) {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, FIXTURE_DIR, file), 'utf8'));
    walkStrings(parsed, (text) => out.push({ file, text }));
  }
  return out;
}

describe('Connector fixtures are authored, not captured', () => {
  it('finds the fixtures it is meant to guard', () => {
    // A guard that silently matches nothing is worse than no guard: the fixtures were once moved
    // and renamed, and the scan has to fail loudly rather than pass vacuously.
    expect(fixtureFiles().length).toBeGreaterThanOrEqual(4);
    expect(fixtureStrings().length).toBeGreaterThan(50);
  });

  it('contains no Chinese value that was not deliberately authored', () => {
    const unexpected = fixtureStrings()
      .filter(({ text }) => CJK_RE.test(text) && !ALLOWED_CJK_VALUES.has(text))
      .map(({ file, text }) => `${file}: ${JSON.stringify(text.slice(0, 60))}`);
    expect(unexpected).toEqual([]);
  });

  it('keeps every fixture timestamp inside the synthetic year', () => {
    // A captured response carries the real meeting date; #363 moved every fixture into 2030 so that
    // a real one re-entering is visible without reading the whole file.
    const years = new Set<string>();
    for (const { text } of fixtureStrings()) {
      for (const match of text.matchAll(ISO_DATE_RE)) years.add(match[1]);
    }
    expect([...years].sort()).toEqual([SYNTHETIC_YEAR]);
  });

  it('keeps captured second-precision timestamps out of the provider surface', () => {
    // #363 sanitised the fixture JSON but left three real timestamps behind in the adapter test,
    // where they survived to the tip unnoticed. Seconds are the tell: a captured value has them
    // (`13:58:36`) while a hand-written example does not (`14:00`), so this rule stays quiet about
    // the CLI's own `--start 2026-03-12T14:00+08:00` documentation examples and about unrelated
    // connector suites that use round numbers.
    const offenders: string[] = [];
    const CAPTURED_STAMP_RE = /\b(20\d{2})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g;
    for (const relative of PROVIDER_SURFACE) {
      const text = fs.readFileSync(path.join(root, relative), 'utf8');
      for (const match of text.matchAll(CAPTURED_STAMP_RE)) {
        if (match[1] !== SYNTHETIC_YEAR) offenders.push(`${relative}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every recording share URL redacted', () => {
    // A share URL is the one leaked artifact that is directly clickable, so the fixture keeps the
    // host and drops the token.
    for (const { text } of fixtureStrings()) {
      for (const url of text.match(SHARE_URL_RE) ?? []) {
        expect(url).toBe('https://meeting.tencent.com/redacted');
      }
    }
  });

  it('allows no OpenId-shaped value except the placeholder', () => {
    // The auth-status fixtures print the signed-in account's OpenId. It is an account identifier,
    // not a credential, but it is stable and it pairs with a display name, so a real one must never
    // reach a published repository.
    const offenders: string[] = [];
    const scan = (label: string, text: string) => {
      for (const match of text.match(OPEN_ID_RE) ?? []) {
        if (match.toLowerCase() !== SYNTHETIC_OPEN_ID) offenders.push(`${label}: ${match}`);
      }
    };
    for (const { file, text } of fixtureStrings()) scan(`fixtures/${file}`, text);
    for (const relative of PROVIDER_SURFACE) scan(relative, fs.readFileSync(path.join(root, relative), 'utf8'));
    expect(offenders).toEqual([]);
  });
});
