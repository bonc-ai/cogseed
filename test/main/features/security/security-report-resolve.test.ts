/**
 * Resolution contract for the 安全与信任 详情 drawer and risk acceptance.
 *
 * Regression this locks: `skillDirCandidates` used to read `skillBaseDir`
 * through `require('../skills')`, but that helper is module-private — the
 * property was always `undefined`, the optional call skipped BOTH the custom
 * and marketplace roots, and every non-builtin skill's 详情 answered
 * `skill_not_found` ("找不到该技能的文件目录") while packaged builtin skills
 * kept working. That asymmetry is why it survived review: the obvious skill to
 * test with (`skill-creator`) resolves through the builtin tree.
 *
 * Asserted at the directory layer, not through the scanner: the scanner has its
 * own tests, and spawning it here would test Python, not resolution.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  acceptFinding, listAcceptances, resolveSkillForScan,
} from '../../../../src/main/features/security/security-report';
import { userMarketplaceSkillsDir, userRoot, userSkillsDir } from '../../../../src/main/paths';

const UID = 'uSecurityReportResolve';

function writeSkill(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: demo\ndescription: demo skill\n---\n\nbody\n',
    'utf8',
  );
}

function customDir(id: string): string {
  return path.join(userSkillsDir(UID), id);
}

function marketplaceDir(id: string): string {
  return path.join(userMarketplaceSkillsDir(UID), id);
}

afterEach(() => {
  fs.rmSync(userRoot(UID), { recursive: true, force: true });
});

describe('安全与信任 › 技能目录解析', () => {
  it('resolves a custom skill (cloud/skills)', async () => {
    writeSkill(customDir('local-format-demo'));

    const resolved = await resolveSkillForScan(UID, 'local-format-demo');

    expect(resolved).toEqual({
      skillId: 'local-format-demo', dir: customDir('local-format-demo'), source: 'custom',
    });
  });

  it('resolves a marketplace-installed skill (local/marketplace/skills)', async () => {
    writeSkill(marketplaceDir('e117a4a3afef'));

    const resolved = await resolveSkillForScan(UID, 'e117a4a3afef');

    expect(resolved).toEqual({
      skillId: 'e117a4a3afef', dir: marketplaceDir('e117a4a3afef'), source: 'marketplace',
    });
  });

  it('prefers the marketplace copy on an id collision, matching the catalog', async () => {
    // `listSkillsForUser` / `getSkillForEditForUser` read marketplace first, so
    // a baseline must pin the same tree the runtime would load.
    writeSkill(marketplaceDir('shared-id'));
    writeSkill(customDir('shared-id'));

    const resolved = await resolveSkillForScan(UID, 'shared-id');

    expect(resolved?.dir).toBe(marketplaceDir('shared-id'));
    expect(resolved?.source).toBe('marketplace');
  });

  it('does not treat a directory without SKILL.md as a skill', async () => {
    fs.mkdirSync(customDir('empty-leftover'), { recursive: true });

    expect(await resolveSkillForScan(UID, 'empty-leftover')).toBeNull();
  });

  it('refuses ids that are not a scannable shape', async () => {
    writeSkill(customDir('nested'));

    expect(await resolveSkillForScan(UID, '../nested')).toBeNull();
    expect(await resolveSkillForScan(UID, '')).toBeNull();
  });

  it('writes and lists a risk acceptance on a custom skill', () => {
    // The old resolver failed here too (`skill_not_found` from `_withSkillDir`),
    // so the drawer's 接受风险 button could never succeed outside builtin skills.
    writeSkill(customDir('accept-demo'));

    const accepted = acceptFinding(UID, {
      skillId: 'accept-demo',
      fingerprint: 'a1b2c3d4',
      ruleId: 'curl_pipe_shell',
      file: 'SKILL.md',
      reason: 'demo acceptance',
      days: 7,
      severity: 'medium',
    });

    expect(accepted).toEqual({ ok: true });
    expect(fs.existsSync(path.join(customDir('accept-demo'), '.skill-sentry-baseline.json'))).toBe(true);
    expect(listAcceptances(UID, 'accept-demo')).toEqual([
      expect.objectContaining({ fingerprint: 'a1b2c3d4', ruleId: 'curl_pipe_shell', expired: false }),
    ]);
  });
});
