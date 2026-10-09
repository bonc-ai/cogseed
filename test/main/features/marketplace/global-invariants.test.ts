/**
 * 全局约束（specs/010 §M：FR-071～FR-074）+ FR-013 的崩溃残留不可见。
 *
 * 这些是**隐私 / data boundary 与解耦的结构性前提**，原任务清单零覆盖（analyze 补入 T106a–e）。
 * 判据刻意以**代码结构**为主：这类约束一旦被一次无心的改动打破，行为层面往往看不出来，
 * 只有下一次真实请求才会暴露。因此这里锁的是「这段代码里不会出现那种东西」。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-invariants-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => workspace), isPackaged: false, getVersion: vi.fn(() => '1.1.2') },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

const store = await import('../../../../src/main/features/marketplace/version-store');
const paths = await import('../../../../src/main/paths');

const SRC = path.resolve(__dirname, '../../../../src');
const CONTENT_ID = 'a1b2c3d4e5f6';

/** 与 Hub 直接通信的模块——本文件的扫描面。 */
const HUB_FACING = [
  'main/features/marketplace.ts',
  'main/features/marketplace_biz.ts',
  'main/features/marketplace_reconcile.ts',
  'main/features/marketplace/metadata-adapter.ts',
  'main/features/marketplace/source-fetch.ts',
  'main/features/marketplace/usage-event.ts',
];

let uidSeq = 0;
let UID = '';

beforeEach(() => {
  uidSeq += 1;
  UID = `u_inv_${uidSeq}`;
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** 剥离注释：判据是**代码**里有没有，文档里解释「为什么不能有」不算有。 */
function codeOf(rel: string): string {
  return readSrc(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('全局约束（FR-071～FR-074、FR-013）', () => {
  describe('⭐ T106a 请求只带自身版本号与平台标识（FR-072）', () => {
    it('客户端公共请求头恰好是版本 + 平台族，没有第六项', () => {
      const api = codeOf('main/features/api_common.ts');
      const block = api.slice(api.indexOf('CLIENT_HEADER_NAMES = {'), api.indexOf('} as const;'));
      const names = [...block.matchAll(/^\s*(\w+):\s*'([^']+)'/gm)].map((m) => m[2]);
      expect(names.sort()).toEqual([
        'CogSeed-App-Version', 'CogSeed-Arch', 'CogSeed-Channel',
        'CogSeed-OS-Version', 'CogSeed-Platform',
      ]);
      // 五项都是**客户端自身**的属性：版本、平台、系统版本、架构、发布通道。
      // 其中没有任何一项标识这台机器或这个人——这正是 FR-072 的分界线。
      expect(names.join('|')).not.toMatch(/device|machine|serial|uuid|mac|user|account/i);
    });

    it('⚠️ 与 Hub 通信的模块里不出现账号 / 设备 / 本机内容清单', () => {
      for (const rel of HUB_FACING) {
        const code = codeOf(rel);
        // 账号与凭据：目录、版本状态、取字节三条路径都是匿名的（FR-073）。
        expect(code, `${rel} 不得带凭据`).not.toMatch(/Authorization|Bearer|Cookie|access_token/i);
        // 设备标识。
        expect(code, `${rel} 不得带设备标识`).not.toMatch(/deviceId|device_id|machineId|machine_id|installationId/i);
      }
    });

    it('⚠️ 取字节的请求体恰好是 {content_id, version}，不夹带本机状态', () => {
      const code = codeOf('main/features/marketplace/source-fetch.ts');
      expect(code).toContain('JSON.stringify({ content_id: req.contentId, version: req.version })');
      // 不把本机已装清单、已装版本或用户目录塞进请求。
      expect(code).not.toMatch(/readInstalls|installs\.json|installedVersionOf|userMarketplaceSkillDir/);
    });

    it('⚠️ 本机安装清单不作为任何 Hub 请求的输入', () => {
      for (const rel of HUB_FACING) {
        const code = codeOf(rel);
        // `readInstalls` 允许在本地对账里用，但不得出现在请求体构造中：
        // 判据是同一行/相邻上下文里既有清单又有请求体序列化。
        const bodyLines = code.split('\n').filter((l) => l.includes('JSON.stringify'));
        for (const line of bodyLines) {
          expect(line, `${rel} 的请求体不得含清单`).not.toMatch(/installs|manifest|skills:\s*\[/i);
        }
      }
    });
  });

  describe('⭐ T106b 除 hub_content_used 外没有 Client → Hub 写路径（FR-071）', () => {
    it('与 Hub 通信的模块里没有 PUT / PATCH / DELETE', () => {
      for (const rel of HUB_FACING) {
        const code = codeOf(rel);
        expect(code, `${rel}`).not.toMatch(/method:\s*'(PUT|PATCH|DELETE)'/);
      }
    });

    it('⚠️ 所有 Hub 端点都落在「目录 / 详情 / 取字节」的只读集合里', () => {
      const endpoints = new Set<string>();
      for (const rel of HUB_FACING) {
        for (const m of codeOf(rel).matchAll(/'(\/marketplace\/[a-z0-9/_-]+)'/g)) endpoints.add(m[1]);
      }
      // 每一条都必须是取目录、取详情、取默认集合或取字节。出现第五类即为回写路径。
      // `/marketplace/defaults` 取的是「推荐默认安装集合」，请求体为空对象——它**问**服务端
      // 该装什么，不**告诉**服务端本机装了什么。
      const allowed = new RegExp([
        '^/marketplace/(skills|agents|projects|categories)/(list|detail)$',
        '^/marketplace/(skills|agents)/(bundle|source)$',
        '^/marketplace/defaults$',
      ].join('|'));
      for (const ep of endpoints) {
        expect(ep, `未预期的 Hub 端点：${ep}`).toMatch(allowed);
      }
      expect(endpoints.size).toBeGreaterThan(0);
    });

    it('⚠️ 取默认集合只问不报：请求体是空对象', () => {
      const code = codeOf('main/features/marketplace.ts');
      expect(code).toMatch(/>\('\/marketplace\/defaults',\s*\{\}\)/);
    });

    it('⚠️ 上行只有一个出口，且 Q3 收口前不构造请求体', () => {
      const code = codeOf('main/features/marketplace/usage-event.ts');
      // 唯一与网络接触的函数（FR-065）。
      expect(code).toContain('export function sendUsageEvent');
      expect(code).not.toMatch(/fetch\(|postJson|fetchWithRetry|requireCogSeedApiBase/);
      // 端点与信封形状都不得写死。
      expect(code).not.toMatch(/\/marketplace\/events|code:\s*0/);
    });

    it('⚠️ 回写只能来自使用事件：其它模块不引用上行出口', () => {
      const senders = walkTs(path.join(SRC, 'main'))
        .filter((f) => !f.endsWith('usage-event.ts'))
        .filter((f) => /sendUsageEvent\s*\(/.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(SRC, f));
      expect(senders).toEqual([]);
    });
  });

  describe('⭐ T106c 目录 / 版本状态 / 取字节匿名可访问（FR-073）', () => {
    it('三条读路径都不要求登录态', () => {
      for (const rel of ['main/features/marketplace/metadata-adapter.ts', 'main/features/marketplace/source-fetch.ts']) {
        const code = codeOf(rel);
        expect(code, rel).not.toMatch(/isAnonymousLocalId|requireLogin|getActiveUserId\(\)/);
      }
    });

    it('⚠️ 只有使用事件要求登录：匿名本机 id 一律不采集', () => {
      const code = codeOf('main/features/marketplace/usage-event.ts');
      expect(code).toContain('isAnonymousLocalId');
      expect(code).toContain("skip('anonymous')");
    });

    it('匿名与登录看到的是同一份目录：取行不按用户分流', () => {
      const code = codeOf('main/features/marketplace/metadata-adapter.ts');
      // 请求里没有用户维度，就不可能按用户给出不同目录。
      // 注意 `create_uid` 是**目录条目的字段**（官方恒 '0'），不是本机用户——按词边界区分，
      // 否则这条断言会把内容作者标识误判成用户维度。
      expect(code).not.toMatch(/\buid\b|\buserId\b|\buser_id\b|getActiveUserId/);
    });
  });

  describe('⭐ T106d 崩溃残留不可被内容加载器看见（FR-013）', () => {
    it('版本存储枚举跳过点号前缀的残留', async () => {
      const contentDir = paths.userMarketplaceContentVersionsDir(UID, CONTENT_ID);
      fs.mkdirSync(path.join(contentDir, '.staging-deadbeef'), { recursive: true });
      fs.mkdirSync(path.join(contentDir, '.trash-a1b2c3d4e5f6-0123456789ab'), { recursive: true });

      expect(store.listVersionCopies(UID, CONTENT_ID)).toEqual([]);
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '.staging-deadbeef')).toBeNull();
    });

    it('⚠️ 残留不会被当成一个可用版本，哪怕它里面有完整内容', () => {
      const staging = path.join(paths.userMarketplaceContentVersionsDir(UID, CONTENT_ID), '.staging-full');
      fs.mkdirSync(path.join(staging, 'tree'), { recursive: true });
      fs.writeFileSync(path.join(staging, 'tree', 'SKILL.md'), '---\nname: x\n---\n');
      fs.writeFileSync(path.join(staging, 'meta.json'), JSON.stringify({
        content_id: CONTENT_ID, version: '.staging-full', sha256: 'a'.repeat(64),
        size_bytes: 1, installed_at: Date.now(), source: 'hub',
      }));

      expect(store.listVersionCopies(UID, CONTENT_ID)).toEqual([]);
      expect(store.verifyVersionCopy(UID, CONTENT_ID, '.staging-full')).toBe(false);
    });

    it('技能列表的目录遍历同样跳过点号前缀', () => {
      const code = codeOf('main/features/skills.ts');
      // 两棵 Skill 树的枚举共用同一条过滤：`e.isDirectory() && !e.name.startsWith('.')`。
      expect(code).toMatch(/isDirectory\(\)\s*&&\s*!e\.name\.startsWith\('\.'\)/);
    });

    it('⚠️ 临时区命名前缀与清理时机由客户端自定，但不可见性是硬要求', () => {
      const code = codeOf('main/features/marketplace.ts');
      // 两个前缀都以点号开头——改名可以，丢掉点号不行。
      expect(code).toMatch(/return `\.staging-\$\{hex\}`/);
      expect(code).toMatch(/return `\.trash-\$\{contentId\}-\$\{hex\}`/);
    });
  });

  describe('⭐ T106e 内容加载器与注册表逐项不变（FR-074）', () => {
    it('注册表不认识 Hub 版本存储：本轮没有把 Hub 语义塞进加载路径', () => {
      const code = codeOf('main/model/core-agent/skill-registry.ts');
      expect(code).not.toMatch(/marketplace\/version-store|resolveVersionCopy|isHubManagedContent|forked_from/);
    });

    it('⚠️ Hub 版本存储也不反向依赖注册表', () => {
      for (const rel of ['main/features/marketplace/version-store.ts', 'main/features/marketplace/version-gc.ts']) {
        expect(codeOf(rel), rel).not.toMatch(/skill-registry|core-agent/);
      }
    });

    it('创作流的版本存储契约未被触碰', () => {
      const code = codeOf('main/features/marketplace/version-store.ts');
      // 两套版本存储是并列的两棵树，互不引用（data-model 磁盘布局）。
      expect(code).not.toMatch(/skills\/versions|runtime-snapshots/);
      expect(code).toContain('userMarketplaceVersionsDir');
    });
  });
});
