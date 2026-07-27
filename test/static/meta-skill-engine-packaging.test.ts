import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { metaSkillEnginePackageDir, PC_ROOT } from '../../src/main/paths';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

describe('desktop Meta Skill Engine packaging contract', () => {
  it('ships the repository Engine package as an Electron extraResource', () => {
    const extraResources = packageJson.build?.extraResources;
    expect(Array.isArray(extraResources)).toBe(true);
    expect(extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'packages/nseap-meta-skill-engine',
          to: 'packages/nseap-meta-skill-engine',
          filter: expect.arrayContaining(['dist/**/*', 'ontologies/**/*', 'package.json']),
        }),
      ]),
    );
  });

  it('resolves the development Engine package from the repository packages directory', () => {
    expect(metaSkillEnginePackageDir()).toBe(path.join(PC_ROOT, 'packages', 'nseap-meta-skill-engine'));
  });
});
