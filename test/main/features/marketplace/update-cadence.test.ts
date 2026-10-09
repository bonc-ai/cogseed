import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decideMarketplaceContentUpdate,
} from '../../../../src/main/features/marketplace-update-policy';

const SRC = path.resolve(__dirname, '../../../../src');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

describe('Hub 内容检查节奏与更新边界', () => {
  describe('⭐ T060 检查节奏按 FR-034（FROZEN）', () => {
    const index = readSrc('main/index.ts');

    it('启动后 60 秒首次检查', () => {
      expect(index).toContain('const MARKETPLACE_STARTUP_CHECK_DELAY_MS = 60 * 1000;');
      expect(index).toContain('MARKETPLACE_STARTUP_CHECK_DELAY_MS,');
    });

    it('在线期间每 6 小时一次（基线曾是 12 小时，未满足冻结要求）', () => {
      expect(index).toContain('const MARKETPLACE_SERVER_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;');
      expect(index).toContain('MARKETPLACE_SERVER_CHECK_INTERVAL_MS);');
    });

    it('失败 30 分钟后重试**一次**，再失败等下一周期', () => {
      expect(index).toContain('const MARKETPLACE_CHECK_RETRY_DELAY_MS = 30 * 60 * 1000;');
      // 重试自身失败不再安排新的重试。
      expect(index).toMatch(/function scheduleMarketplaceCheckRetry[\s\S]*?if \(reason === 'retry'\) return;/);
      // 同一时间最多一个重试定时器。
      expect(index).toMatch(/if \(marketplaceCheckRetryTimer\) return;/);
    });

    it('检查不打断用户、不弹阻断式窗口', () => {
      const block = index.slice(
        index.indexOf('async function runMarketplaceInstallReconcile'),
        index.indexOf('async function runMarketplaceInstallReconcile') + 3000,
      );
      expect(block).not.toMatch(/showMessageBox|dialog\.|alert\(/);
    });

    it('周期定时器不阻止进程退出', () => {
      expect(index).toMatch(/timer\.unref\?\.\(\)/);
    });
  });

  describe('⭐ T062 Hub 回退发布不覆盖本机（C5）', () => {
    it('服务端 v1 低于本机 v2 → 保留本机', () => {
      expect(decideMarketplaceContentUpdate(
        { version: '2.0.0', published_at: 200, updated_at: 200 },
        { version: '1.0.0', published_at: 999, updated_at: 999 },
        'hub',
      )).toEqual({ action: 'preserve_content', reason: 'older_version' });
    });

    it('即便回退版本的发布时间更晚也不覆盖——单调看的是版本不是时间', () => {
      expect(decideMarketplaceContentUpdate(
        { version: '2.1.0', published_at: 100 },
        { version: '2.0.9', published_at: 10_000 },
        'hub',
      ).action).toBe('preserve_content');
    });
  });

  describe('⭐ T061 更新的作用边界（FR-040 / FR-041）', () => {
    it('更新只作用于来源为 Hub 的官方副本：随包种子行不进入拉取集合', () => {
      const reconcile = readSrc('main/features/marketplace_reconcile.ts');
      expect(reconcile).toContain('function _skillRowHasServerSource(row: SkillInstall): boolean');
      expect(reconcile).toMatch(/row\.seed_source !== 'builtin' && row\.seed_source !== 'resource'/);
      expect(reconcile).toContain('_skillRowHasServerSource(r) && _skillNeedsPull(uid, r)');
    });

    it('自定义 Skill 只被**只读**查询，不进入拉取集合', () => {
      const reconcile = readSrc('main/features/marketplace_reconcile.ts');
      // 拉取集合只来自安装清单的 skills；自定义 Skill 落在 cloud/skills/，不在其中。
      expect(reconcile).toContain('manifest.skills.filter(');

      // `userSkillsDir` 在本文件里只出现在依赖满足的存在性判定中——那是**读**，不是更新。
      const uses = reconcile.split('userSkillsDir(uid)').length - 1;
      expect(uses).toBe(1);
      expect(reconcile).toContain(
        "return fs.existsSync(path.join(userSkillsDir(uid), id, 'SKILL.md'));",
      );
    });

    it('更新不改变用户的启停选择：写回的 status 来自服务端，不触碰本地启停开关', () => {
      const reconcile = readSrc('main/features/marketplace_reconcile.ts');
      const pull = reconcile.slice(
        reconcile.indexOf('async function _pullSkillLocked'),
        reconcile.indexOf('async function _fetchAgentPrivateSkillsBundle'),
      );
      // 该函数不读写用户侧的启用开关（那是 skills 的 enabled/disabled 用户偏好）。
      expect(pull).not.toMatch(/setSkillEnabled|userEnabled|toggleSkill/);
    });
  });
});
