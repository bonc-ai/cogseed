import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCompliantSkillPackage } from '../../../fixtures/make-skill-packages';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-disable-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => workspace), isPackaged: false, getVersion: vi.fn(() => '1.1.2') },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

const iv = await import('../../../../src/main/features/marketplace/installed-version');
const store = await import('../../../../src/main/features/marketplace/version-store');
const paths = await import('../../../../src/main/paths');

const SRC = path.resolve(__dirname, '../../../../src');
const CONTENT_ID = 'a1b2c3d4e5f6';

let uidSeq = 0;
let UID = '';

beforeEach(() => {
  uidSeq += 1;
  UID = `u_disable_${uidSeq}`;
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** 落一版已安装内容；`extra` 用来写入 status / state / 布尔 disabled 等字段。 */
function landInstalled(version: string, extra: Record<string, unknown> = {}): void {
  const dir = paths.userMarketplaceSkillDir(UID, CONTENT_ID);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: x\nversion: ${version}\n---\n`);
  fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
    version, published_at: 1, installed_at: Date.now(), ...extra,
  }));
}

/** 改写本机记录的状态（模拟一次检查把 Hub 侧状态写回本机）。 */
function setStatus(extra: Record<string, unknown>): void {
  const marker = path.join(paths.userMarketplaceSkillDir(UID, CONTENT_ID), '_install.json');
  const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.writeFileSync(marker, JSON.stringify({ ...meta, ...extra }));
}

async function landVersionCopy(version: string): Promise<void> {
  const pkg = makeCompliantSkillPackage(undefined, version);
  const src = path.join(workspace, 'sources', UID, version);
  fs.mkdirSync(src, { recursive: true });
  new AdmZip(pkg.bytes).extractAllTo(src, true);
  await store.writeVersionCopy(
    UID, { contentId: CONTENT_ID, version, sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }, src,
  );
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

describe('内容级停用 / 恢复（PRD US5 客户端半，C8）', () => {
  describe('⭐ T065 只读 status / state 字符串，绝不读布尔 disabled（FR-004）', () => {
    it('status 为 disabled → 判定停用', () => {
      landInstalled('1.0.0', { status: 'disabled' });
      expect(iv.isContentDisabled(UID, CONTENT_ID)).toBe(true);
    });

    it('旧字段 state 为 disabled → 同样判定停用', () => {
      landInstalled('1.0.0', { state: 'disabled' });
      expect(iv.isContentDisabled(UID, CONTENT_ID)).toBe(true);
    });

    it('⚠️ 只下发布尔 disabled:true 而 status 仍是 approved → **不**判定停用', () => {
      // 这正是发现 11 要防的静默失效：若实现改去读布尔字段，本断言会红。
      landInstalled('1.0.0', { status: 'approved', disabled: true });
      expect(iv.isContentDisabled(UID, CONTENT_ID)).toBe(false);
    });

    it('实现里确实没有读布尔 disabled 的代码', () => {
      const raw = readSrc('main/features/marketplace/installed-version.ts');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      // 只能出现 `'disabled'` 这个**字符串取值**，不得出现读 `parsed.disabled` 的成员访问。
      expect(code).not.toMatch(/parsed\.disabled|\.disabled\s*===\s*true|Boolean\(\s*\w+\.disabled/);
    });

    it('其余取值一律视为可用——判错方向应当是不阻断', () => {
      for (const extra of [{ status: 'approved' }, { status: 'published' }, {}, { status: '' }]) {
        landInstalled('1.0.0', extra);
        expect(iv.isContentDisabled(UID, CONTENT_ID)).toBe(false);
      }
    });

    it('未安装 → unknown，不当作停用', () => {
      expect(iv.readContentStatus(UID, CONTENT_ID)).toEqual({ raw: '', availability: 'unknown' });
      expect(iv.isContentDisabled(UID, CONTENT_ID)).toBe(false);
    });
  });

  describe('⭐ 阻断新的使用（FR-043，SC-005 的阻断率）', () => {
    it('停用的内容被挡在 allowlist 之外——两个创建点都过滤', () => {
      const store2 = readSrc('main/features/cogseed_backend/task-store.ts');
      expect(store2).toContain('function withoutDisabledContent(');
      // createCogSeedTask 与 admitPlannedCogSeedTask 两处都必须过滤。
      expect(store2.split('withoutDisabledContent(').length - 1).toBe(3); // 1 定义 + 2 调用
    });

    it('阻断靠 allowlist，不在执行期再读一次状态——避免第二处停用判定', () => {
      const resolver = readSrc('main/features/cogseed_runtime/kernel/tools/skill-tools.ts');
      expect(resolver).not.toContain('isContentDisabled');
      expect(resolver).not.toContain('readContentStatus');
    });
  });

  describe('⭐ 不中止已开始的使用（中止率 0）', () => {
    it('停用之后，已钉固版本仍然解析得到', async () => {
      await landVersionCopy('1.0.0');
      landInstalled('1.0.0');
      const pin = store.hubPinIdentity(UID, CONTENT_ID)!;

      setStatus({ status: 'disabled' });

      expect(iv.isContentDisabled(UID, CONTENT_ID)).toBe(true);
      // 解析路径不读状态 → 进行中的使用不受影响。
      expect(store.resolveHubPinnedTree(UID, CONTENT_ID, pin.version, pin.manifestHash)).not.toBeNull();
    });

    it('停用不删除本机副本', async () => {
      await landVersionCopy('1.0.0');
      landInstalled('1.0.0');
      setStatus({ status: 'disabled' });

      expect(fs.existsSync(paths.userMarketplaceSkillDir(UID, CONTENT_ID))).toBe(true);
      expect(store.resolveVersionCopy(UID, CONTENT_ID, '1.0.0')).not.toBeNull();
    });
  });

  describe('⭐ 恢复后回到用户原有启停选择，而不是一律启用（FR-044）', () => {
    it('status 回到 approved → 重新可用', () => {
      landInstalled('1.0.0', { status: 'disabled' });
      expect(iv.isContentDisabled(UID, CONTENT_ID)).toBe(true);

      setStatus({ status: 'approved' });

      expect(iv.isContentDisabled(UID, CONTENT_ID)).toBe(false);
    });

    it('全程不触碰用户的启停开关——停用判定只读 status，不写任何用户偏好', () => {
      const code = readSrc('main/features/marketplace/installed-version.ts');
      expect(code).not.toMatch(/writeFile|setSkillEnabled|userEnabled|toggle/i);
      const store2 = readSrc('main/features/cogseed_backend/task-store.ts');
      const helper = store2.slice(
        store2.indexOf('function withoutDisabledContent('),
        store2.indexOf('async function resolveSkillVersionPins'),
      );
      expect(helper).not.toMatch(/writeFile|setSkillEnabled|userEnabled|toggle/i);
    });
  });

  describe('⭐ 状态到达判定点的接缝（否则停用会静默不生效）', () => {
    it('检查流程即便内容未变也把 status patch 进本机 _install.json', () => {
      // 判定读的是 `_install.json.status`。若检查只写云端清单而不 patch 本机标记，
      // 内容没变的停用就永远读不到 —— 这条断言把这个耦合钉住。
      const reconcile = readSrc('main/features/marketplace_reconcile.ts');
      const block = reconcile.slice(
        reconcile.indexOf('if (!contentChanged && (defaultInstallChanged || statusChanged'),
      ).slice(0, 600);
      expect(block).toContain('_patchInstallMeta(userMarketplaceSkillDir(uid, s.id)');
      expect(block).toContain("typeof server.status === 'string' ? { status: server.status }");
    });

    it('内容被重新拉取时，install meta 也带上 status', () => {
      const reconcile = readSrc('main/features/marketplace_reconcile.ts');
      const pull = reconcile.slice(
        reconcile.indexOf('async function _pullSkillLocked'),
        reconcile.indexOf('async function _fetchAgentPrivateSkillsBundle'),
      );
      expect(pull).toContain("{ status: current.status || current.state }");
    });
  });

  describe('⭐ Hub 不可达时沿用最近一次检查结果（FR-045）', () => {
    it('判定全程不联网：fetch 换成抛错实现也照样得出结论', () => {
      landInstalled('1.0.0', { status: 'disabled' });
      const fetchMock = vi.fn(() => { throw new Error('network is down'); });
      vi.stubGlobal('fetch', fetchMock);

      expect(iv.isContentDisabled(UID, CONTENT_ID)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('不可达期间既不擅自解除也不擅自施加阻断——状态就是上次写下的那个', () => {
      landInstalled('1.0.0', { status: 'approved' });
      // 没有任何新的检查发生。
      expect(iv.readContentStatus(UID, CONTENT_ID)).toEqual({ raw: 'approved', availability: 'available' });

      landInstalled('1.0.0', { status: 'disabled' });
      expect(iv.readContentStatus(UID, CONTENT_ID)).toEqual({ raw: 'disabled', availability: 'disabled' });
    });

    it('状态读取的实现里没有网络调用', () => {
      const code = readSrc('main/features/marketplace/installed-version.ts')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code).not.toMatch(/fetch\(|postJson|getSkillMetadata|http/);
    });
  });
});
