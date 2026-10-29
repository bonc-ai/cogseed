import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isBundledAgentId, isBundledSkillId } from '../../../src/main/features/builtin_bundled';

const ROOT = path.join(__dirname, '../../../resources/builtin/marketplace');
const ids = (kind: string) => fs.readdirSync(path.join(ROOT, kind), { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name);

describe('随包内容身份：按安装包里有没有这个 ID 判定', () => {
  it('安装包里的智能体与技能都认作随包', () => {
    const agents = ids('agents');
    const skills = ids('skills');
    expect(agents.length).toBeGreaterThan(0);
    expect(skills.length).toBeGreaterThan(0);
    for (const id of agents) expect(isBundledAgentId(id)).toBe(true);
    for (const id of skills) expect(isBundledSkillId(id)).toBe(true);
  });

  it('报销智能体是随包的；智能体 ID 不会被当成技能，反之亦然', () => {
    expect(isBundledAgentId('c045605cb916')).toBe(true);
    expect(isBundledSkillId('c045605cb916')).toBe(false);
  });

  it('不在安装包里的 ID（如已移出随包的「AI产品构建评测」）不算随包', () => {
    expect(isBundledSkillId('36867a076129')).toBe(false);
    expect(isBundledAgentId('000000000000')).toBe(false);
    expect(isBundledSkillId('not-an-id')).toBe(false);
  });
});
