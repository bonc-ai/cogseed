import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const roots = [
  path.resolve(process.cwd(), 'src/main/features/cogseed_backend'),
  path.resolve(process.cwd(), 'src/main/features/cogseed_runtime'),
];

function tsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...tsFiles(abs));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(abs);
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const pattern = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

describe('CogSeed complete backend separation boundary', () => {
  it('does not import Orkas Agent backend, Core runtime, shared execution-records, or Group Chat', () => {
    const banned = [
      'features/execution-records',
      '/execution-records',
      'group_chat',
      '#core-agent',
      'model/client',
      'model/core-agent',
      'features/agents',
      'features/skills',
      'connectors/manager',
      'connectors/index',
      'connectors/oauth',
      'connectors/registry',
      'connectors/tools-adapter',
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of tsFiles(root)) {
        const source = fs.readFileSync(file, 'utf8');
        for (const specifier of importSpecifiers(source)) {
          if (banned.some((needle) => specifier.includes(needle))) offenders.push(`${path.relative(process.cwd(), file)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps CogSeed task, execution, session, and worker state paths under mate_agent', () => {
    const paths = fs.readFileSync(path.resolve(process.cwd(), 'src/main/paths.ts'), 'utf8');
    expect(paths).toContain("path.join(userCloudRoot(uid), 'mate_agent')");
    expect(paths).toContain("path.join(userLocalRoot(uid), 'mate_agent')");
    expect(paths).toContain('mateAgentExecutionRecordsDir');
  });

  it('does not expose a LegacyOrkasBackend or fallback selector in CogSeed production files', () => {
    const source = roots.flatMap(tsFiles).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/LegacyOrkasBackend|native\s*\|\s*core\s*\|\s*shadow/);
  });
});
