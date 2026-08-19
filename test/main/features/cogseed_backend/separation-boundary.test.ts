import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const backendRoot = path.resolve(process.cwd(), 'src/main/features/cogseed_backend');
const runtimeRoot = path.resolve(process.cwd(), 'src/main/features/cogseed_runtime');
const roots = [backendRoot, runtimeRoot];

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
  it('does not call Core/model execution or create child-process paths outside approved adapters', () => {
    const bannedEverywhere = [
      'features/execution-records',
      '/execution-records',
      '#core-agent',
      'model/client',
      'model/core-agent',
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of tsFiles(root)) {
        const source = fs.readFileSync(file, 'utf8');
        for (const specifier of importSpecifiers(source)) {
          if (bannedEverywhere.some((needle) => specifier.includes(needle))) {
            offenders.push(`${path.relative(process.cwd(), file)} imports ${specifier}`);
          }
          if (file.startsWith(backendRoot)
            && (specifier.includes('node:child_process') || specifier.includes('child_process'))) {
            offenders.push(`${path.relative(process.cwd(), file)} imports ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('allows Local CLI execution only through the dedicated Backend adapter and local_agents/runner choke point', () => {
    const imports: string[] = [];
    for (const file of tsFiles(backendRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (specifier.includes('local_agents')) imports.push(`${path.basename(file)}:${specifier}`);
      }
    }
    expect(imports).toEqual([
      'local-cli-execution-adapter.ts:../local_agents/backends/base',
      'local-cli-execution-adapter.ts:../local_agents/runner',
      'local-cli-execution-adapter.ts:../local_agents/sessions',
    ]);
    const adapter = fs.readFileSync(path.join(backendRoot, 'local-cli-execution-adapter.ts'), 'utf8');
    expect(adapter).toContain("run as runLocalAgent");
    expect(adapter).not.toMatch(/\bspawn\s*\(|execFile\s*\(|fork\s*\(/);
  });

  it('keeps CogSeed task, execution, session, and worker state paths under cogseed', () => {
    const paths = fs.readFileSync(path.resolve(process.cwd(), 'src/main/paths.ts'), 'utf8');
    expect(paths).toContain("path.join(userCloudRoot(uid), 'cogseed')");
    expect(paths).toContain("path.join(userLocalRoot(uid), 'cogseed')");
    expect(paths).toContain('cogseedAgentExecutionRecordsDir');
  });

  it('does not expose a LegacyCogSeedBackend or fallback selector in CogSeed production files', () => {
    const source = roots.flatMap(tsFiles).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/LegacyCogSeedBackend|native\s*\|\s*core\s*\|\s*shadow/);
  });
});
