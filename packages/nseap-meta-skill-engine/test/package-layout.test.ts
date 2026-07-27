import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('NSEAP Meta Skill Engine package layout', () => {
  it('has tracked source and ontology inputs but no runtime dependency on userWorkSpace', () => {
    expect(existsSync(path.join(root, 'src/index.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'src/modules/evidence-collector.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'ontologies/university_paper_writing/scene_tbox.yaml'))).toBe(true);
    expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toContain('"type": "module"');
  });
});
