import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../../src/main');
const mateFiles = [
  path.join(ROOT, 'features/cogseed_backend/office-adapter.ts'),
  path.join(ROOT, 'features/cogseed_backend/browser-manager.ts'),
  path.join(ROOT, 'features/cogseed_backend/coordinator.ts'),
  path.join(ROOT, 'features/cogseed_backend/host-tool-router.ts'),
];

describe('Mate host capability boundaries', () => {
  it('does not import Orkas Core Office, local tools, or Group Chat business modules', () => {
    const source = mateFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/model\/core-agent\/(?:office-tools|local-tools|tool-catalog)/);
    expect(source).not.toMatch(/features\/group_chat/);
    expect(source).not.toMatch(/playwright|puppeteer/i);
  });

  it('keeps Runtime worker spawn in the approved choke point', () => {
    const runtimeDir = path.join(ROOT, 'features/cogseed_runtime');
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(runtimeDir)) {
      if (!entry.endsWith('.ts') || entry === 'worker-process.ts') continue;
      if (/\bspawn\s*\(/.test(fs.readFileSync(path.join(runtimeDir, entry), 'utf8'))) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});
