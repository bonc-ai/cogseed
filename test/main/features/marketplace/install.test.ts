import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `paths.ts` 的 WS_ROOT 是模块级常量：工作区在导入前建好且只建一次，用例按 uid 隔离。
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-install-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => workspace), isPackaged: false, getVersion: vi.fn(() => '1.1.2') },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

const iv = await import('../../../../src/main/features/marketplace/installed-version');
const policy = await import('../../../../src/main/features/marketplace-update-policy');
const paths = await import('../../../../src/main/paths');

const SRC = path.join(__dirname, '../../../../src/main');
const CONTENT_ID = 'a1b2c3d4e5f6';

let uidSeq = 0;
let UID = '';

beforeEach(() => {
  uidSeq += 1;
  UID = `u_install_${uidSeq}`;
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** 落一版已安装内容。success marker 最后写，与真实安装链路同序。 */
function landInstalled(version: string, times: { published_at?: number; updated_at?: number } = {}): void {
  const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: x\nversion: ${version}\n---\n`);
  fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
    version,
    published_at: times.published_at ?? 100,
    ...(times.updated_at !== undefined ? { updated_at: times.updated_at } : {}),
    installed_at: Date.now(),
  }));
}

/** 复刻安装路径的判定：本机实际版本 vs 来源版本，走既有 §7.5 策略。 */
function installDecision(
  incoming: { version: string; published_at: number; updated_at?: number },
): ReturnType<typeof policy.decideMarketplaceContentUpdate> {
  const local = iv.readInstalledVersion(UID, CONTENT_ID);
  return policy.decideMarketplaceContentUpdate(
    {
      version: local.version ?? '',
      published_at: local.publishedAt ?? 0,
      ...(typeof local.updatedAt === 'number' ? { updated_at: local.updatedAt } : {}),
    },
    incoming,
    // 与安装路径一致：Hub 来源不咨询新鲜度（Q4 内部默认值）。
    'hub',
  );
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

describe('marketplace/install', () => {
  describe('⭐ T029 同 ID 内容按 §7.5 单调规则处理，不产生第二份（FR-022, C12）', () => {
    it('来源版本更高 → 替换内容', () => {
      landInstalled('1.0.0');
      expect(installDecision({ version: '2.0.0', published_at: 200 }))
        .toEqual({ action: 'replace_content', reason: 'newer_version' });
    });

    it('来源版本更低 → 保留本机（服务端回退发布不覆盖本机）', () => {
      landInstalled('2.0.0');
      expect(installDecision({ version: '1.0.0', published_at: 200 }))
        .toEqual({ action: 'preserve_content', reason: 'older_version' });
    });

    it('版本相同 → 保留本机，不产生第二份', () => {
      landInstalled('1.0.0', { published_at: 100, updated_at: 150 });
      expect(installDecision({ version: '1.0.0', published_at: 100, updated_at: 150 }).action)
        .toBe('preserve_content');
    });

    it('⚠️ 语义等价但拼写不同（v1.0.4 对 1.0.4）走到同一个决策点，不被当成不同版本', () => {
      landInstalled('v1.0.4', { published_at: 100, updated_at: 100 });

      // Hub 来源不咨询新鲜度（Q4 内部默认值），故无论 updated_at 是否更新都保留。
      // 关键是两种输入落到**同一处置**——若字符串不等就直接判「版本不同」，这里会分叉。
      expect(installDecision({ version: '1.0.4', published_at: 100, updated_at: 200 }))
        .toEqual({ action: 'preserve_content', reason: 'freshness_not_consulted' });
      expect(installDecision({ version: '1.0.4', published_at: 100, updated_at: 100 }))
        .toEqual({ action: 'preserve_content', reason: 'freshness_not_consulted' });
    });

    it('版本不可解析时保守保留本机', () => {
      landInstalled('not-a-version', { published_at: 100, updated_at: 100 });
      expect(installDecision({ version: 'also-bad', published_at: 100, updated_at: 100 }).action)
        .toBe('preserve_content');
    });

    it('本机版本取自落盘事实而非目标版本：无 success marker 时判不出，不据此保留', () => {
      const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\n---\n');

      expect(iv.readInstalledVersion(UID, CONTENT_ID).version).toBeNull();
    });

    it('安装路径确实接了这条规则，且本机版本走单一判定入口', () => {
      const code = readSrc('features/marketplace.ts');
      expect(code).toContain('decideMarketplaceContentUpdate(');
      expect(code).toContain('readInstalledVersion(uid, skillId)');
      // force（「重新安装官方版」）不受单调规则约束。
      expect(code).toContain("opts.force !== true");
    });

    it('不产生第二份由既有 promote 的 trash-swap 保证（锁定既有实现）', () => {
      const code = readSrc('features/marketplace.ts');
      expect(code).toContain('if (fs.existsSync(target)) await fsp.rename(target, trash);');
      expect(code).toContain('await fsp.rename(staging, target);');
    });
  });

  describe('T030 Q2 的单一兜底插入点', () => {
    it('插入点存在且标注 Q2 未收口、兜底只加这一处', () => {
      const code = readSrc('features/marketplace.ts');
      expect(code).toContain('Q2（发布侧同 ID 冲突拦截）的**单一兜底插入点**');
      expect(code).toContain('FR-049');
      // 当前按「发布侧已拦截」的内部默认值实现，不做额外阻断。
      expect(code).toContain('当前为实现假设，不是 Hub 的答复');
    });
  });

  describe('T027 锁定既有行为（不改实现，只补断言）', () => {
    it('质量门仅 EXTREME 阻断安装，MEDIUM / LOW 只持久化报告（FR-016）', () => {
      const code = readSrc('features/marketplace.ts');
      // 断言真实代码而非注释：阻断集合只筛 EXTREME，其余等级不进入阻断判定。
      expect(code).toContain("report.violations.filter((v) => v.level === 'EXTREME')");
      // 且 EXTREME 没有 override 通道。
      expect(code).toMatch(/NO override for EXTREME/);
    });

    it('安装期不强制 Skill Runner 兼容（FR-018）', () => {
      const code = readSrc('features/marketplace.ts');
      expect(code).toContain('enforceSkillRunner: false');
      expect(code).toMatch(/Runner compatibility\s*\n\s*\/\/ is enforced while authoring\/publishing, not retroactively on install/);
    });

    it('安全档位由 create_uid === \'0\' 决定（FR-017）', () => {
      const code = readSrc('features/marketplace.ts');
      expect(code).toMatch(/create_uid === '0'/);
    });
  });

  describe('T028 失败保护', () => {
    it('取字节任一校验不过即不落盘（由 source-fetch 保证，此处锁接线）', () => {
      const install = readSrc('features/marketplace.ts');
      // 安装链路的字节只来自唯一取字节入口；它在摘要/大小/内容类型不符时不返回字节。
      expect(install).toContain('await fetchImmutableSource({');
      const fetchSrc = readSrc('features/marketplace/source-fetch.ts');
      expect(fetchSrc).toContain('throw digestMismatch(');
      expect(fetchSrc).toContain('throw sizeMismatch(');
      expect(fetchSrc).toContain('throw unexpectedContentType(');
    });

    it('临时文件在成功与失败两条路径上都被清理', () => {
      const install = readSrc('features/marketplace.ts');
      // `finally` 里清理 staging zip，不依赖成功路径。
      expect(install).toMatch(/finally \{\s*\n\s*await fsp\.rm\(staging, \{ force: true \}\)/);
    });

    it('拒绝时不留 staging 残留、不动最终位置（既有 W2 隔离，已有集成覆盖）', () => {
      const install = readSrc('features/marketplace.ts');
      expect(install).toMatch(/Quarantine \(W2\)/);
    });
  });
});
