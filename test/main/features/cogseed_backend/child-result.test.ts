import { describe, expect, it } from 'vitest';

import { parseChildResult } from '../../../../src/main/features/cogseed_backend/child-result';

const block = (value: unknown) => '```cogseed-result\n' + JSON.stringify(value) + '\n```';

describe('child structured result', () => {
  it('parses the contract, keeps absolute files and strips the host-only block', () => {
    const parsed = parseChildResult([
      'MINUTES READY',
      'Two sections written.',
      block({
        status: 'completed',
        summary: 'Wrote the minutes',
        files: ['/w/minutes.md', 'relative.md', '/w/minutes.md'],
        open_questions: ['Confirm the owner?'],
        next_step: 'Publish after confirmation',
      }),
    ].join('\n\n'));

    expect(parsed.error).toBeUndefined();
    expect(parsed.text).toBe('MINUTES READY\n\nTwo sections written.');
    expect(parsed.structured).toEqual({
      status: 'completed',
      summary: 'Wrote the minutes',
      files: ['/w/minutes.md'],
      openQuestions: ['Confirm the owner?'],
      nextStep: 'Publish after confirmation',
    });
  });

  it('uses the last block and strips malformed earlier blocks', () => {
    const parsed = parseChildResult([
      'first',
      '```cogseed-result\n{not json}\n```',
      'second',
      block({ status: 'partial', summary: 'Half done', files: [], open_questions: [] }),
    ].join('\n'));

    expect(parsed.text).toBe('first\n\nsecond');
    expect(parsed.structured).toMatchObject({ status: 'partial', summary: 'Half done' });
  });

  it('reports invalid JSON without inventing a status', () => {
    const parsed = parseChildResult('done\n```cogseed-result\n{oops}\n```');
    expect(parsed.structured).toBeUndefined();
    expect(parsed.error).toBe('invalid_json');
    expect(parsed.text).toBe('done');
  });

  it('rejects an unknown status', () => {
    const parsed = parseChildResult(`done\n${block({ status: 'ok', summary: 'x' })}`);
    expect(parsed.error).toBe('invalid_shape');
    expect(parsed.structured).toBeUndefined();
  });

  it('leaves an ordinary reply untouched when no block exists', () => {
    const parsed = parseChildResult('just a prose answer');
    expect(parsed).toEqual({ text: 'just a prose answer' });
  });
});
