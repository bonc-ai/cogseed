import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function exists(rel: string): boolean {
  return fs.existsSync(path.join(process.cwd(), rel));
}

function readIfExists(rel: string): string {
  const file = path.join(process.cwd(), rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function walkFiles(rootRel: string, predicate: (rel: string) => boolean): string[] {
  const root = path.join(process.cwd(), rootRel);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(process.cwd(), full);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && predicate(rel)) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

describe('P3394 single-backend boundary', () => {
  it('removes the standalone Meta Skill Engine package and P3394 engine adapter line', () => {
    const removedPaths = [
      'packages/nseap-meta-skill-engine',
      'src/main/features/p3394/kstar-adapter.ts',
      'src/main/features/p3394/kstar-factory.ts',
      'scripts/smoke-p3394-real-execution.mjs',
      'test/scripts/smoke-p3394-real-execution.test.ts',
      'test/main/features/p3394/kstar-adapter.test.ts',
      'test/main/features/p3394/kstar-factory.test.ts',
      'test/main/features/p3394/kstar-real-boundary.test.ts',
    ];

    expect(removedPaths.filter(exists)).toEqual([]);
  });

  it('does not expose KSTAR Engine startup flags or adapter imports from app boot', () => {
    const files = ['bootstrap.cjs', 'src/main/index.ts', 'package.json'];
    const offenders = files.flatMap((rel) => {
      const content = readIfExists(rel);
      return content.match(/ORKAS_KSTAR_ENGINE|--orkas-kstar-engine|getKstarAdapter|kstar-factory|kstar-adapter/g)
        ? [rel]
        : [];
    });

    expect(offenders).toEqual([]);
  });

  it('keeps Group Chat wake dispatch from acting as the default non-CogSeed execution backend', () => {
    const controller = readIfExists('src/main/features/p3394/wake-controller.ts');
    expect(controller).toContain("request.execution_domain !== 'mate'");
    expect(controller).not.toContain("../group_chat/p3394-wake-dispatcher");
  });

  it('keeps source tests free of direct P3394 adapter/factory dependencies', () => {
    const offenders = walkFiles('test', (rel) => rel.endsWith('.ts')).filter((rel) => {
      const content = readIfExists(rel);
      return /kstar-adapter|kstar-factory|getKstarAdapter|KstarAdapter/.test(content)
        && !rel.endsWith('single-backend-boundary.test.ts');
    });
    expect(offenders).toEqual([]);
  });
});
