import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { admitContribution } from '../../src/main/features/contribution/admission';

/**
 * 本机准入**实跑**（真扫描器 + 真声明引擎）。
 *
 * 只在显式指定技能树时运行，例如：
 *   COGSEED_LIVE_SKILL_DIR=<技能树> npx vitest run test/live/admission-live.test.ts
 *
 * 与常规用例的区别：这条不注入任何桩，跑的是贡献流程真正会跑的那三段
 * （`validateSkillDir` → `scanSkillDir(community)` → `gateDeclaration`）。
 * 它回答的是「这个技能树在应用里点『继续』后，本机检查会不会放行」。
 */
const SKILL_DIR = process.env.COGSEED_LIVE_SKILL_DIR;

describe.skipIf(!SKILL_DIR)('本机准入实跑', () => {
  it('技能树 → admission.outcome = pass', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-admit-'));
    fs.cpSync(String(SKILL_DIR), dir, { recursive: true });

    const admission = await admitContribution({ dir, sourceSkillId: 'live-admission' } as never);
    console.log('[准入] outcome =', admission.outcome, '| reason =', admission.reason ?? '(无)');
    console.log('[准入] components =', JSON.stringify(admission.components));
    console.log('[准入] scan =', JSON.stringify(admission.scan));
    for (const v of admission.report.violations.slice(0, 8)) {
      console.log('[准入] violation:', v.level, v.rule, `@${v.field}`);
    }
    if (admission.declaration) console.log('[准入] declaration =', JSON.stringify(admission.declaration));
    if (admission.componentsBlocking) console.log('[准入] componentsBlocking =', JSON.stringify(admission.componentsBlocking));

    expect(admission.outcome).toBe('pass');
  }, 300_000);
});
