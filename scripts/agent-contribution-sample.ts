/**
 * 生成一份可以直接拿去和 Hub 联调的 Agent 提交样例（`manifest.json` + `agent.zip` + 一条 curl 示例）。
 *
 * 为什么有这个脚本：联调时 Hub 要看到**客户端真实会发出的字节**，而不是双方各自手写一份。这里直接调用
 * 客户端的真实代码（副本暂存、预览、打包、请求体组装，全是无 Electron 依赖的叶模块），所以样例与真实提交
 * 同构；客户端改了组装逻辑，样例自动跟着变。
 *
 * 不联网、不需要登录、不改任何本机数据：全部在临时目录里完成。
 *
 * 用法：
 *   npx tsx scripts/agent-contribution-sample.ts --out /path/to/out [--hub-skill 5e1c8a02d9b3] [--version 1.0.0]
 *                                                [--name 联调样例Agent]
 *
 * 样例 Agent 的**名字**默认取环境变量 `COGSEED_AGENT_SAMPLE_NAME`（Hub 侧联调脚本
 * `scripts/joint-integration/agent-run.mts` 就是用它来决定"发新版本还是新建内容"的），
 * 可用 `--name` 覆盖。名字必须与联调脚本看到的一致，否则会出现两边各说各话的死锁：
 * 库里已有一个同名内容时，走"新建"会撞同名守卫（`REVIEW_NAME_CONFLICT`），走"发新版本"
 * 又要求当前账号就是该内容的贡献者——而合成账号服务是内存库，重启后旧内容的贡献者账号
 * 已经不存在（`403 NOT_CONTRIBUTOR`）。每次联调用一个新名字即可绕开这条历史行。
 *
 * 样例 Agent 引用两类依赖（各一个）：Hub Skill（`--hub-skill`，必须是 Hub 上真实存在的 ID，缺省则不带）、
 * 随包私有 Skill（取仓库里的声明检查样例 `sample-local-format`，含 `references/security-manifest.yaml`）。
 *
 * 样例**不带** `builtin:` 引用：Hub 侧的内置能力清单已按裁定 `DEC-HUB-OPEN3-ALIGN-001` 清空，
 * 而空清单下**任何**内置引用都会在导入期被拒（`builtin_ref.unknown`，失败关闭）；客户端的总开关
 * 也默认关闭。两端因此一致——带内置引用的样例必然提交被拒，跑不到「提交 → 接受 → 发布」。
 * 要联调内置能力，须先由产品定成员并**两端一起改**（Hub 加回条目 + 客户端把总开关默认打开），
 * 届时这里再加回 `builtin:` 引用。负例（清单外的内置引用被拒）不受影响：联调脚本会自行注入一条。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildAgentSubmissionManifest } from '../src/main/features/contribution/agent-submission-request';
import { stageAgent } from '../src/main/features/contribution/agent-staging';
import { acceptTerms, confirmMaintenance, declareOrigin } from '../src/main/features/contribution/declarations';
import { buildPackage } from '../src/main/features/contribution/package';
import { buildPreview } from '../src/main/features/contribution/preview';

const REPO = path.resolve(__dirname, '..');
const SAMPLE_SKILL_DIR = path.join(REPO, 'resources', 'guardrail', 'skill-declaration-core', 'fixtures', 'sample-skill');
const SAMPLE_SKILL_NAME = 'sample-local-format';
const SAMPLE_AGENT_ID = 'sample-joint-test-agent';
/** 样例 Agent 名字的缺省值；环境变量与 `--name` 都可覆盖。 */
const SAMPLE_AGENT_NAME_DEFAULT = '联调样例Agent';
/** 与 Hub 侧联调脚本 `agent-run.mts` 共用：它读同名环境变量决定"发新版本 / 新建内容"。 */
const SAMPLE_AGENT_NAME_ENV = 'COGSEED_AGENT_SAMPLE_NAME';

export interface SampleOptions {
  outDir: string;
  /** Hub 上真实存在的 Skill ID（12 位十六进制）；缺省则样例不引用 Hub Skill。 */
  hubSkillId?: string;
  version?: string;
  /** 样例 Agent 的名字；缺省取 `COGSEED_AGENT_SAMPLE_NAME`，再缺省为「联调样例Agent」。 */
  name?: string;
  /**
   * 目标内容 ID（12 位十六进制）：给了就是「给已有内容发新版本」，缺省是「新建内容」。
   *
   * 为什么要这个开关：客户端在「已装 Agent 有新版本」时走的是新版本提交路径
   * （请求体带 `target_content_id`），缺省的 `null` 只覆盖首次贡献。联调要验证
   * 「新版本 / 版本不更高 / 同名内容守卫」这几条，就必须能发出带目标的请求。
   */
  targetContentId?: string;
}

export interface SampleResult {
  manifestPath: string;
  packagePath: string;
  curlPath: string;
  digest: string;
  size: number;
  files: string[];
}

export async function buildAgentContributionSample(opts: SampleOptions): Promise<SampleResult> {
  const version = opts.version ?? '1.0.0';
  const name = (opts.name ?? process.env[SAMPLE_AGENT_NAME_ENV] ?? '').trim() || SAMPLE_AGENT_NAME_DEFAULT;
  if (opts.hubSkillId !== undefined && !/^[a-f0-9]{12}$/.test(opts.hubSkillId)) {
    throw new Error('--hub-skill must be a 12-character lowercase hex Hub content id');
  }
  if (opts.targetContentId !== undefined && !/^[a-f0-9]{12}$/.test(opts.targetContentId)) {
    throw new Error('--target-content must be a 12-character lowercase hex Hub content id');
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-contribution-sample-'));
  try {
    const agentDir = path.join(work, 'cloud', 'agents', SAMPLE_AGENT_ID);
    const userSkillsDir = path.join(work, 'cloud', 'skills');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.cpSync(SAMPLE_SKILL_DIR, path.join(userSkillsDir, SAMPLE_SKILL_NAME), { recursive: true });
    // 本机原 Agent：带着生命周期与本机字段，提交时会被剥掉
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({
      agent_id: SAMPLE_AGENT_ID,
      name,
      description_zh: '联调用的最小样例：整理文本并按需写代码。',
      description_en: 'Smallest sample for joint testing: tidy text and write code when asked.',
      workflow: '1. 读取用户给的文本 2. 用随包技能整理格式 3. 需要时调用内置的 coding 能力',
      category: 'office',
      skill_list: [...(opts.hubSkillId ? [opts.hubSkillId] : []), SAMPLE_SKILL_NAME],
      created_at: '2026-10-13T00:00:00Z',
      updated_at: '2026-10-13T00:00:00Z',
      enabled_connectors: ['local-connector'],
      default_model: { provider: 'sample', model: 'sample' },
    }, null, 2));

    const staging = await stageAgent(SAMPLE_AGENT_ID, { agentDir, userSkillsDir, stagingRoot: path.join(work, 'cache') });
    if (staging.blockers.length || staging.issues.length) {
      throw new Error(`sample is not distributable: ${JSON.stringify({ blockers: staging.blockers, issues: staging.issues })}`);
    }
    const preview = buildPreview(staging);
    const pkg = buildPackage(staging, preview);
    const agentJson = JSON.parse(fs.readFileSync(path.join(staging.dir, 'agent.json'), 'utf8')) as Record<string, unknown>;

    const manifest = buildAgentSubmissionManifest({
      agent: agentJson,
      declarations: {
        origin: declareOrigin('original', '', null),
        terms: acceptTerms({ version: '1.0' } as never),
        maintenance: confirmMaintenance(),
      } as unknown as Record<string, unknown>,
      fileList: pkg.fileList,
      localAgentId: '00000000-0000-4000-8000-00000000a001',
      localCheck: { checker: { side: 'client', version: '0.0.0-sample' }, blocking: [], warnings: [] },
      packageDigest: pkg.digest,
      packageSize: pkg.size,
      targetContentId: opts.targetContentId ?? null,
      version,
    });

    fs.mkdirSync(opts.outDir, { recursive: true });
    const manifestPath = path.join(opts.outDir, 'manifest.json');
    const packagePath = path.join(opts.outDir, 'agent.zip');
    const curlPath = path.join(opts.outDir, 'curl-example.sh');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(packagePath, pkg.bytes);
    fs.writeFileSync(curlPath, [
      '#!/bin/sh',
      '# 联调样例：把 HUB、TOKEN 换成测试环境的地址与登录令牌。请求头与真实客户端一致，',
      '# Idempotency-Key 同一次提交的重试必须相同。manifest 与 package 两个 part 的顺序固定。',
      'HUB="${HUB:?set HUB, e.g. https://hub.example}"',
      'TOKEN="${TOKEN:?set TOKEN}"',
      'curl -sS -X POST "$HUB/marketplace/contributions/submissions" \\',
      '  -H "Authorization: Bearer $TOKEN" \\',
      '  -H "Idempotency-Key: $(uuidgen)" \\',
      '  -H "X-CogSeed-Client-Version: 1.3.0" \\',
      '  -H "X-CogSeed-Platform: macos" \\',
      '  -H "X-CogSeed-Request-ID: sample-$(date +%s)" \\',
      '  -H "CogSeed-Channel: open" \\',
      '  -F "manifest=@manifest.json;type=application/json" \\',
      '  -F "package=@agent.zip;type=application/zip"',
      '',
    ].join('\n'), { mode: 0o755 });

    return { manifestPath, packagePath, curlPath, digest: pkg.digest, size: pkg.size, files: pkg.fileList.map((f) => f.path) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (require.main === module) {
  const out = argValue(process.argv, '--out');
  if (!out) {
    process.stderr.write(
      'usage: npx tsx scripts/agent-contribution-sample.ts --out <dir> [--hub-skill <12-hex>] ' +
        '[--target-content <12-hex>] [--version 1.0.0] [--name <样例 Agent 名>]\n',
    );
    process.exit(2);
  }
  buildAgentContributionSample({
    outDir: path.resolve(out),
    hubSkillId: argValue(process.argv, '--hub-skill'),
    targetContentId: argValue(process.argv, '--target-content'),
    version: argValue(process.argv, '--version'),
    name: argValue(process.argv, '--name'),
  }).then((r) => {
    process.stdout.write(`${JSON.stringify({ ...r, note: 'sample only; nothing was sent' }, null, 2)}\n`);
  }, (err) => {
    process.stderr.write(`${String(err?.message ?? err)}\n`);
    process.exit(1);
  });
}
