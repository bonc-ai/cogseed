import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ipcSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/main/ipc/index.ts'),
  'utf8',
);

describe('OAuth IPC user scope contract', () => {
  it('passes ctx.userId to every OAuth flow operation', () => {
    expect(ipcSource).toMatch(
      /'auth\.startOAuth':\s+async\s*\(\{ provider, label \},\s*ctx\)\s*=>\s*auth\.startOAuth\(ctx\.userId, provider, label\)/,
    );
    expect(ipcSource).toMatch(
      /'auth\.pollOAuthFlow':\s+async\s*\(\{ flowId \},\s*ctx\)\s*=>\s*auth\.pollOAuthFlow\(ctx\.userId, flowId\)/,
    );
    expect(ipcSource).toMatch(
      /'auth\.submitOAuthInput':\s+async\s*\(\{ flowId, value \},\s*ctx\)\s*=>\s*auth\.submitOAuthInput\(ctx\.userId, flowId, value\)/,
    );
    expect(ipcSource).toMatch(
      /'auth\.cancelOAuthFlow':\s+async\s*\(\{ flowId \},\s*ctx\)\s*=>\s*auth\.cancelOAuthFlow\(ctx\.userId, flowId\)/,
    );
  });
});
