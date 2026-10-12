import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');

describe('contribution privacy boundary', () => {
  it('never logs package bytes, access tokens, terms bodies, file bodies or raw finding snippets', () => {
    const files = [
      'src/main/features/contribution/hub-client.ts',
      'src/main/features/contribution/staging.ts',
      'src/main/features/contribution/terms.ts',
      'src/main/ipc/contribution.ts',
    ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    const logCalls = [...files.matchAll(/log\.(?:info|warn|error)\([^;]+/g)].map((match) => match[0]).join('\n');
    expect(logCalls).not.toMatch(/access_token|Authorization|packageBytes|body_markdown|\.snippet|content:/);
    expect(files).not.toMatch(/console\.(?:log|warn|error)/);
  });

  it('sends only sanitized violation summaries into local_check', () => {
    const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/contribution.ts'), 'utf8');
    expect(ipc).toContain('.map(toUploadableIssue)');
    expect(ipc).not.toMatch(/local_check:\s*\{[^}]*snippet/s);
  });
});
