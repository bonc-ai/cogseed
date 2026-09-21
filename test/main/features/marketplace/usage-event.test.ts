import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCompliantSkillPackage } from '../../../fixtures/make-skill-packages';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-usage-event-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => workspace), isPackaged: false, getVersion: vi.fn(() => '1.1.2') },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

const usage = await import('../../../../src/main/features/marketplace/usage-event');
const store = await import('../../../../src/main/features/marketplace/version-store');
const paths = await import('../../../../src/main/paths');

const SRC = path.resolve(__dirname, '../../../../src');
const CONTENT_ID = 'a1b2c3d4e5f6';

let uidSeq = 0;
let UID = '';
let sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  uidSeq += 1;
  UID = `u_usage_${uidSeq}`;
  sent = [];
  // 替身发送器：SC-011 的可执行判据——采集侧测试全部跑在替身上，一行未改。
  usage.setUsageEventSender((event) => { sent.push({ ...event }); });
  usage.setConsentReader(() => 'granted');
});

afterEach(() => {
  usage.setUsageEventSender(null);
  usage.setConsentReader(null);
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** Hub 官方副本的事实 = 该版本在不可变版本存储里有副本。 */
async function landVersionCopy(version: string): Promise<void> {
  const pkg = makeCompliantSkillPackage(undefined, version);
  const src = path.join(workspace, 'sources', UID, version);
  fs.mkdirSync(src, { recursive: true });
  new AdmZip(pkg.bytes).extractAllTo(src, true);
  await store.writeVersionCopy(
    UID, { contentId: CONTENT_ID, version, sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, src,
  );
}

function landCurrentInstall(version: string): void {
  const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: x\nversion: ${version}\n---\n`);
  fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
    version, published_at: 1, installed_at: Date.now(),
  }));
}

describe('hub_content_used 采集（O2 / O3 / O4，FR-061–FR-066）', () => {
  describe('⭐ T089 / O2：成功与失败各 1 条，字段集合与白名单完全相等（SC-008）', () => {
    it('一次成功使用产生 1 条事件，字段恰好 5 项（成功无 reason）', async () => {
      await landVersionCopy('1.0.0');

      const event = usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      });

      expect(sent).toHaveLength(1);
      expect(Object.keys(sent[0]).sort())
        .toEqual(['content_id', 'event_id', 'occurred_at', 'result', 'version']);
      expect(event).toMatchObject({ content_id: CONTENT_ID, version: '1.0.0', result: 'success' });
    });

    it('一次失败使用产生 1 条事件，字段恰好 6 项（含 reason）', async () => {
      await landVersionCopy('1.0.0');

      usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0',
        result: 'failure', reason: 'content_unavailable',
      });

      expect(sent).toHaveLength(1);
      expect(Object.keys(sent[0]).sort())
        .toEqual(['content_id', 'event_id', 'occurred_at', 'reason', 'result', 'version']);
      expect(sent[0].reason).toBe('content_unavailable');
    });

    it('⚠️ 多一项即违规：事件键集合必须是白名单的子集', async () => {
      await landVersionCopy('1.0.0');
      usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      });

      const whitelist = new Set<string>(usage.HUB_CONTENT_USED_FIELDS);
      for (const key of Object.keys(sent[0])) expect(whitelist.has(key)).toBe(true);
      expect(usage.HUB_CONTENT_USED_FIELDS).toHaveLength(6);
    });

    it('event_id 每次不同，occurred_at 是 ISO 时间', async () => {
      await landVersionCopy('1.0.0');
      const a = usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      })!;
      const b = usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      })!;

      expect(a.event_id).not.toBe(b.event_id);
      expect(Number.isNaN(Date.parse(a.occurred_at))).toBe(false);
    });
  });

  describe('⭐ T090 / O3：匿名 / 拒绝 / 撤回三种状态下事件数 0', () => {
    it('匿名（未登录）→ 0 条', async () => {
      await landVersionCopy('1.0.0');
      // 落一份匿名 uid 下的副本，确保跳过原因是登录态而不是来源。
      const anonUid = 'anonymous';
      const pkg = makeCompliantSkillPackage(undefined, '1.0.0');
      const src = path.join(workspace, 'sources', 'anon');
      fs.mkdirSync(src, { recursive: true });
      new AdmZip(pkg.bytes).extractAllTo(src, true);
      await store.writeVersionCopy(
        anonUid, { contentId: CONTENT_ID, version: '1.0.0', sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, src,
      );

      const event = usage.recordHubContentUsage({
        userId: anonUid, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      });

      expect(event).toBeNull();
      expect(sent).toHaveLength(0);
    });

    it('明确拒绝 → 0 条', async () => {
      await landVersionCopy('1.0.0');
      usage.setConsentReader(() => 'denied');

      expect(usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      })).toBeNull();
      expect(sent).toHaveLength(0);
    });

    it('撤回后 → 0 条（同一会话内先 granted 后 denied）', async () => {
      await landVersionCopy('1.0.0');
      usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      });
      expect(sent).toHaveLength(1);

      usage.setConsentReader(() => 'denied');
      usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      });

      expect(sent).toHaveLength(1);   // 没有新增
    });

    it('⚠️ Consent scope 尚不可用（默认状态）→ 0 条：没有有效同意就不采集', async () => {
      await landVersionCopy('1.0.0');
      usage.setConsentReader(null);   // 回到默认实现

      expect(usage.readProductAnalyticsConsent(UID)).toBe('unavailable');
      expect(usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      })).toBeNull();
    });

    it('不缓存补报：跳过的事件不进任何队列，也不落盘（FR-066）', () => {
      const code = readSrc('main/features/marketplace/usage-event.ts')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      // 按**机制**断言，不按字面量：日志文案里出现 "pending" 不代表存在待发队列。
      expect(code).not.toMatch(/from 'node:fs'|writeFileSync|fs\.promises/);
      expect(code).not.toMatch(/setTimeout|setInterval/);
      // 没有模块级数组或 Map 在累积事件。
      expect(code).not.toMatch(/^(const|let)\s+\w+(:\s*[^=]+)?=\s*(\[\]|new Map\(|new Set\()/m);
    });

    it('采集不影响使用：内部异常被吞掉并返回 null，不抛错', async () => {
      await landVersionCopy('1.0.0');
      usage.setConsentReader(() => { throw new Error('consent store unavailable'); });

      expect(() => usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      })).not.toThrow();
      expect(sent).toHaveLength(0);
    });
  });

  describe('⭐ T091 / O4：只对 Hub 官方副本采集', () => {
    it('自定义 Skill（无版本副本）→ 0 条', () => {
      expect(usage.recordHubContentUsage({
        userId: UID, contentId: 'custom-skill', pinnedVersion: '1.0.0', result: 'success',
      })).toBeNull();
      expect(sent).toHaveLength(0);
    });

    it('派生副本转为 custom 之后 → 0 条（它不在 Hub 版本存储里）', () => {
      expect(usage.isHubOfficialUse(UID, 'forked-copy', '1.0.0')).toBe(false);
    });

    it('未被 Hub 接管的随包种子 → 0 条（没有版本副本）', () => {
      landCurrentInstall('1.0.0');   // 有安装内容，但没有 Hub 版本副本
      expect(usage.isHubOfficialUse(UID, CONTENT_ID, '1.0.0')).toBe(false);
      expect(usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      })).toBeNull();
    });

    it('被 Hub 接管过的内容 → 采集', async () => {
      await landVersionCopy('1.0.0');
      expect(usage.isHubOfficialUse(UID, CONTENT_ID, '1.0.0')).toBe(true);
    });

    it('来源判定与 pin 解析同源：都以「该版本有副本」为事实', () => {
      const code = readSrc('main/features/marketplace/usage-event.ts');
      expect(code).toContain("import { resolveVersionCopy } from './version-store'");
    });
  });

  describe('⭐ T092 / FR-064：version 来自本次使用的 pin，不是 current install', () => {
    it('pin 了 v1 而 current 已是 v2 → 事件 version 为 v1', async () => {
      await landVersionCopy('1.0.0');
      await landVersionCopy('2.0.0');
      landCurrentInstall('2.0.0');   // current 已前进

      const event = usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '1.0.0', result: 'success',
      })!;

      expect(event.version).toBe('1.0.0');
      expect(store.hubPinIdentity(UID, CONTENT_ID)?.version).toBe('2.0.0');   // current 确实是 v2
    });

    it('缺少 pin 版本时不产生事件，而不是退而去读 current', () => {
      landCurrentInstall('2.0.0');
      expect(usage.recordHubContentUsage({
        userId: UID, contentId: CONTENT_ID, pinnedVersion: '', result: 'success',
      })).toBeNull();
    });

    it('实现里不读 current install 的版本', () => {
      const code = readSrc('main/features/marketplace/usage-event.ts')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code).not.toContain('installedVersionOf');
      expect(code).not.toContain('readInstalledVersion');
    });
  });

  describe('⭐ T093 Q3 可翻转性与扩散检测（SC-011）', () => {
    it('替身替换 sendUsageEvent → 采集侧测试不改即通过', () => {
      // 本文件的每一个用例都跑在替身发送器上；能全部通过即是该判据。
      expect(typeof usage.setUsageEventSender).toBe('function');
    });

    it('网络调用符号在本模块内一次都不出现——发送侧尚未实现（Q3 未收口）', () => {
      const code = readSrc('main/features/marketplace/usage-event.ts')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const symbol of ['fetch(', 'postJson', 'fetchWithRetry', 'requireCogSeedApiBase', 'http']) {
        expect(code).not.toContain(symbol);
      }
    });

    it('sendUsageEvent 是唯一的发送出口，采集入口只经它', () => {
      const code = readSrc('main/features/marketplace/usage-event.ts');
      expect(code.split('sendUsageEvent(').length - 1).toBeGreaterThanOrEqual(2); // 定义 + 调用
      // 采集入口不直接碰 sender 变量以外的传输手段。
      expect(code).toContain('sendUsageEvent(event);');
    });

    it('请求体 / 响应信封 / 错误码一个字都没写死', () => {
      const code = readSrc('main/features/marketplace/usage-event.ts');
      expect(code).not.toMatch(/JSON\.stringify\(\s*\{\s*data/);
      expect(code).not.toContain('/marketplace/events');
      expect(code).not.toMatch(/code:\s*0/);
    });
  });

  describe('⭐ 触发时机挂在真实使用尝试上，不是 UI 行为', () => {
    it('采集入口只在运行时执行 Skill 的路径被调用', () => {
      const walk = (dir: string, out: string[] = []): string[] => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, out);
          else if (e.name.endsWith('.ts')) out.push(full);
        }
        return out;
      };
      const callers = walk(SRC)
        .filter((f) => !f.endsWith('usage-event.ts'))
        .filter((f) => fs.readFileSync(f, 'utf8').includes('recordHubContentUsage'))
        .map((f) => path.relative(SRC, f).split(path.sep).join('/'));

      expect(callers).toEqual(['main/features/cogseed_runtime/kernel/tools/skill-tools.ts']);
    });

    it('安装 / 目录页 / 详情路径都不产生事件', () => {
      for (const rel of [
        'main/features/marketplace.ts',
        'main/features/marketplace_reconcile.ts',
        'main/features/builtin_marketplace.ts',
      ]) {
        expect(readSrc(rel)).not.toContain('recordHubContentUsage');
      }
    });

    it('埋点落在脚本真正跑过之后（成功 / 失败由退出码与超时决定）', () => {
      const runtime = readSrc('main/features/cogseed_runtime/kernel/tools/skill-tools.ts');
      const exec = runtime.slice(runtime.indexOf('const execute = async ()'));
      expect(exec).toContain('const result = await runProcess([');
      expect(exec).toMatch(/const usageResult = !result\.timedOut && result\.code === 0 \? 'success' : 'failure';/);
      // 采集在 runProcess 之后、返回结果之前。
      expect(exec.indexOf('runProcess([')).toBeLessThan(exec.indexOf('recordHubContentUsage'));
    });
  });
});
