/**
 * Agent 贡献主流程：用真实暂存副本 + 注入的外部能力，验证"什么条件下才发出、发出什么"。
 * 网络、身份、条款、扫描器均为替身；文件系统与打包是真实的。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  confirmAgentPreview, startAgentContribution, submitAgentContribution, type AgentContributionDeps, type StartResult,
} from '../../../../src/main/features/contribution/agent-contribution';
import { acceptTerms, confirmMaintenance, declareOrigin } from '../../../../src/main/features/contribution/declarations';
import { _resetForTest, getSession } from '../../../../src/main/features/contribution/session';
import type { ContributionAdmission } from '../../../../src/main/features/contribution/admission';
import type { ValidationReport } from '../../../../src/main/quality';

const UID = 'u1';
const ACCOUNT = 'acc-1';
const TERMS = { version: '1.0', text: 'terms' } as never;

let root: string;
const write = (rel: string, content: string): void => {
  const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content);
};
const agent = {
  agent_id: 'my-expense', name: '报销助手', description_zh: '核对材料', workflow: '1. 读', category: 'office',
  created_at: 'x', skill_list: ['a3f09c21b7e4', 'invoice-ocr'],
};
const okReport = { ok: true, violations: [], validated_at: 'x', validator_version: 'x' } as ValidationReport;

function makeDeps(over: Partial<AgentContributionDeps> = {}): AgentContributionDeps & { submitted: Array<{ idempotencyKey: string; manifest: Record<string, unknown>; packageBytes: Buffer }> } {
  const submitted: Array<{ idempotencyKey: string; manifest: Record<string, unknown>; packageBytes: Buffer }> = [];
  let keyN = 0;
  return {
    submitted,
    gateIdentity: async () => ({ outcome: 'ready', displayName: 'Lin', accountId: ACCOUNT }),
    resolveSources: () => ({
      agentDir: path.join(root, 'cloud/agents/my-expense'), userSkillsDir: path.join(root, 'cloud/skills'), stagingRoot: path.join(root, 'cache'),
    }),
    cleanupOrphans: vi.fn(),
    fetchTerms: async () => ({ status: 'open', terms: TERMS }) as never,
    createSubmission: async (_u, args) => { submitted.push(args as never); return { submission_id: 'sub_1', status: 'PENDING_REVIEW' }; },
    contributionTarget: () => null,
    skillDisplayName: (_u, id) => (id === 'a3f09c21b7e4' ? '依据材料作答' : null),
    localAgentUuid: () => '00000000-0000-4000-8000-0000000000aa',
    clientVersion: () => '1.2.3',
    newIdempotencyKey: () => `key-${++keyN}`,
    admission: {
      admitSkill: async () => ({ outcome: 'pass' }) as unknown as ContributionAdmission,
      validateAgentSpec: () => okReport,
    },
    ...over,
  };
}

/** 声明三项都已勾选。 */
function declareAll(token: string): void {
  const s = getSession(UID, token)!;
  s.declarations.origin = declareOrigin('original', '', null);
  s.declarations.terms = acceptTerms(TERMS);
  s.declarations.maintenance = confirmMaintenance();
}

async function startPassing(deps = makeDeps()): Promise<{ deps: ReturnType<typeof makeDeps>; token: string; start: Extract<StartResult, { token: string }> }> {
  const start = await startAgentContribution(UID, 'my-expense', deps);
  if (!start.token) throw new Error('expected a session');
  return { deps, token: start.token, start };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-contrib-'));
  write('cloud/agents/my-expense/agent.json', JSON.stringify(agent));
  write('cloud/skills/invoice-ocr/SKILL.md', '---\nname: ocr\ndescription: d\n---\nbody\n');
  _resetForTest();
});
afterEach(() => {
  _resetForTest();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('开始', () => {
  it('身份门未通过：不建副本，不建会话', async () => {
    const deps = makeDeps({ gateIdentity: async () => ({ outcome: 'blocked', reason: 'not_signed_in' }) });
    const r = await startAgentContribution(UID, 'my-expense', deps);
    expect(r.token).toBeNull();
    expect(fs.existsSync(path.join(root, 'cache'))).toBe(false);
    expect(deps.cleanupOrphans).not.toHaveBeenCalled();
  });

  it('准入通过：返回预览、本机处理项与随包 Skill 名单；处理项不含在预览里', async () => {
    const { start, deps } = await startPassing();
    expect(deps.cleanupOrphans).toHaveBeenCalledWith(UID);
    expect(start.admission.outcome).toBe('pass');
    expect(start.preview?.files.map((f) => f.path)).toEqual(['agent.json', 'skills/invoice-ocr/SKILL.md']);
    expect(start.handled.map((h) => h.field)).toEqual(['created_at']);
    expect(start.bundledSkills).toEqual(['invoice-ocr']);
    expect(start.hubRefs).toEqual(['a3f09c21b7e4']);
    expect(start.builtinRefs).toEqual([]);
    // 本机装着的 Hub 技能显示名字；没装的不编造，由页面退回显示 ID
    expect(start.hubRefNames).toEqual({ 'a3f09c21b7e4': '依据材料作答' });
    expect(JSON.stringify(start.preview)).not.toContain('created_at');
  });

  it('准入阻断：不给预览（渲染层拿不到"先看到再说"的路径），会话仍在可取消', async () => {
    const deps = makeDeps({ admission: { admitSkill: async () => ({ outcome: 'blocked', reason: 'declaration_absent' }) as unknown as ContributionAdmission, validateAgentSpec: () => okReport } });
    const { start, token } = await startPassing(deps);
    expect(start.admission.outcome).toBe('blocked');
    expect(start.preview).toBeNull();
    expect(getSession(UID, token)).not.toBeNull();
  });
});

describe('预览里的本机信息提示（只提示，不改正文）', () => {
  const withPath = (extra: Record<string, unknown> = {}) => write(
    'cloud/agents/my-expense/agent.json',
    JSON.stringify({ ...agent, workflow: '1. 读 /Users/lin/Documents/发票2024/ 下的材料', ...extra }),
  );

  it('正文里有本机路径：开始时给出提示，指出文件与行；正文原样保留', async () => {
    withPath();
    const { start } = await startPassing();
    expect(start.hints).toHaveLength(1);
    expect(start.hints[0]).toMatchObject({ kind: 'local_path', file: 'agent.json' });
    expect(start.hints[0].excerpt).toBe('/Users/lin/Documents/发票2024/');
    expect(start.hints[0].line).toBeGreaterThan(0);
    // 客户端没有替用户改一个字：预览里的 agent.json 仍含原路径
    const staged = fs.readFileSync(path.join(getSession(UID, start.token)!.staging.dir, 'agent.json'), 'utf8');
    expect(staged).toContain('/Users/lin/Documents/发票2024/');
  });

  it('随包技能里的路径与凭据也提示，文件路径带上 skills/ 前缀', async () => {
    write('cloud/skills/invoice-ocr/scripts/run.py', "KEY = 'sk-abcdefghijklmnopqrstuvwx'\nprint(1)\n");
    const { start } = await startPassing();
    const h = start.hints.find((x) => x.kind === 'credential_like');
    expect(h?.file).toBe('skills/invoice-ocr/scripts/run.py');
    expect(h?.excerpt).not.toContain('abcdefghijklmnopqrstuvwx');
  });

  it('有提示而用户没明确确认：不确认预览，并告知有几处', async () => {
    withPath();
    const { token, start, deps } = await startPassing();
    declareAll(token);
    expect(await confirmAgentPreview(UID, token, start.preview!.digest, deps)).toEqual({ confirmed: false, reason: 'hints_unacknowledged', count: 1 });
    expect(getSession(UID, token)!.confirmedPackage).toBeNull();
    expect(getSession(UID, token)!.idempotencyKey).toBeNull();
  });

  it('用户明确确认已看过：按预览里的原样确认，提交的字节含原路径（不被替换）', async () => {
    withPath();
    const { token, start, deps } = await startPassing();
    declareAll(token);
    expect(await confirmAgentPreview(UID, token, start.preview!.digest, deps, { acknowledgeHints: true })).toEqual({ confirmed: true });
    await submitAgentContribution(UID, token, { version: '1.0.0', targetContentId: null }, deps);
    const zip = new AdmZip(deps.submitted[0].packageBytes);
    expect(zip.readAsText('agent.json')).toContain('/Users/lin/Documents/发票2024/');
  });

  it('没有提示时不要求确认，行为与以前一致', async () => {
    const { token, start, deps } = await startPassing();
    expect(start.hints).toEqual([]);
    declareAll(token);
    expect(await confirmAgentPreview(UID, token, start.preview!.digest, deps)).toEqual({ confirmed: true });
  });

  it('准入被阻断时不扫描、不给提示（也不给预览）', async () => {
    withPath();
    const deps = makeDeps({ admission: { admitSkill: async () => ({ outcome: 'blocked' }) as unknown as ContributionAdmission, validateAgentSpec: () => okReport } });
    const { start } = await startPassing(deps);
    expect(start.preview).toBeNull();
    expect(start.hints).toEqual([]);
  });

  it('其他必填项缺失时先报缺项，不因为提示掩盖它', async () => {
    withPath();
    const { token, start, deps } = await startPassing();
    expect(await confirmAgentPreview(UID, token, start.preview!.digest, deps, { acknowledgeHints: true }))
      .toMatchObject({ confirmed: false, reason: 'declarations_missing' });
  });
});

describe('确认预览', () => {
  it('声明缺项：指出缺哪项，不确认', async () => {
    const { token, start } = await startPassing();
    const r = await confirmAgentPreview(UID, token, start.preview!.digest, makeDeps());
    expect(r).toEqual({ confirmed: false, reason: 'declarations_missing', missing: ['origin', 'terms', 'maintenance'] });
  });

  it('准入未通过：不能确认（抛错，不是状态）', async () => {
    const deps = makeDeps({ admission: { admitSkill: async () => ({ outcome: 'blocked' }) as unknown as ContributionAdmission, validateAgentSpec: () => okReport } });
    const { token } = await startPassing(deps);
    declareAll(token);
    await expect(confirmAgentPreview(UID, token, 'x', deps)).rejects.toThrow('admission not passed');
  });

  it('条款改版：作废已接受的条款并要求重新确认', async () => {
    const { token, start, deps } = await startPassing();
    declareAll(token);
    const newer = makeDeps({ fetchTerms: async () => ({ status: 'open', terms: { version: '2.0', text: 'new' } }) as never });
    const r = await confirmAgentPreview(UID, token, start.preview!.digest, newer);
    expect(r).toMatchObject({ confirmed: false, reason: 'terms_stale' });
    expect(getSession(UID, token)!.declarations.terms).toBeNull();
    void deps;
  });

  it('摘要不一致：回到重新预览，不确认', async () => {
    const { token, deps } = await startPassing();
    declareAll(token);
    const r = await confirmAgentPreview(UID, token, 'stale-digest', deps);
    expect(r).toMatchObject({ confirmed: false, reason: 'digest_mismatch' });
  });

  it('包上限（契约配置）超限：给出真实数值，不确认', async () => {
    const deps = makeDeps({ limits: { maxCompressedBytes: 1 << 20, maxFiles: 200, maxUnpackedBytes: 1 << 20, maxEntryCompressionRatio: 100 } });
    const { token, start } = await startPassing(deps);
    declareAll(token);
    // 副本里追加一个高压缩比文件，预览重新计算
    fs.writeFileSync(path.join(getSession(UID, token)!.staging.dir, 'big.txt'), 'A'.repeat(500_000));
    const { buildPreview } = await import('../../../../src/main/features/contribution/preview');
    const digest = buildPreview(getSession(UID, token)!.staging).digest;
    const r = await confirmAgentPreview(UID, token, digest, deps);
    expect(r).toMatchObject({ confirmed: false, reason: 'package_limits' });
    if (!r.confirmed && r.reason === 'package_limits') {
      expect(r.violations.map((v) => v.kind)).toContain('compression_ratio_too_high');
      expect(r.violations.every((v) => v.actual > 0)).toBe(true);
    }
    void start;
  });

  it('通过：绑定字节与幂等键', async () => {
    const { token, start, deps } = await startPassing();
    declareAll(token);
    expect(await confirmAgentPreview(UID, token, start.preview!.digest, deps)).toEqual({ confirmed: true });
    const s = getSession(UID, token)!;
    expect(s.idempotencyKey).toBe('key-1');
    expect(s.confirmedPackage?.bytes.length).toBeGreaterThan(0);
  });
});

async function confirmed(over: Partial<AgentContributionDeps> = {}) {
  const deps = makeDeps(over);
  const { token, start } = await startPassing(deps);
  declareAll(token);
  await confirmAgentPreview(UID, token, start.preview!.digest, deps);
  return { deps, token };
}

describe('提交', () => {
  it('发出的是确认过的那份字节；manifest 为 agent 形态，无 skill 字段，包内无 _meta.json 与剥离项', async () => {
    const { deps, token } = await confirmed();
    const r = await submitAgentContribution(UID, token, { version: '1.0.0', targetContentId: null }, deps);
    expect(r).toMatchObject({ ok: true, delivery: 'arrived' });
    const sent = deps.submitted[0];
    expect(sent.idempotencyKey).toBe('key-1');
    expect(sent.manifest.content_type).toBe('agent');
    expect(sent.manifest.local_agent_id).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(sent.manifest).not.toHaveProperty('local_skill_id');
    expect(sent.manifest.metadata).toEqual({ name: '报销助手', description: '核对材料', version: '1.0.0' });
    expect(sent.manifest.package_size).toBe(sent.packageBytes.length);
    const names = new AdmZip(sent.packageBytes).getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(['agent.json', 'skills/invoice-ocr/SKILL.md']);
    expect(new AdmZip(sent.packageBytes).readAsText('agent.json')).not.toContain('created_at');
    expect(getSession(UID, token)).toBeNull(); // 成功后会话与副本销毁
  });

  it('没确认预览就提交：抛错，不发请求', async () => {
    const deps = makeDeps();
    const { token } = await startPassing(deps);
    await expect(submitAgentContribution(UID, token, { version: '1.0.0', targetContentId: null }, deps)).rejects.toThrow('preview_not_confirmed');
    expect(deps.submitted).toEqual([]);
  });

  it('确认后副本被改动：snapshot_drift，不发请求', async () => {
    const { deps, token } = await confirmed();
    fs.appendFileSync(path.join(getSession(UID, token)!.staging.dir, 'agent.json'), ' ');
    const r = await submitAgentContribution(UID, token, { version: '1.0.0', targetContentId: null }, deps);
    expect(r).toEqual({ ok: false, reason: 'snapshot_drift' });
    expect(deps.submitted).toEqual([]);
  });

  it('提交前身份失效：不发请求，原因透出', async () => {
    const { deps, token } = await confirmed();
    const gone = { ...deps, gateIdentity: async () => ({ outcome: 'blocked', reason: 'not_signed_in' }) as never };
    const r = await submitAgentContribution(UID, token, { version: '1.0.0', targetContentId: null }, gone);
    expect(r).toEqual({ ok: false, reason: 'not_signed_in' });
    expect(deps.submitted).toEqual([]);
  });

  it('版本号不是 SemVer：拒绝', async () => {
    const { deps, token } = await confirmed();
    expect(await submitAgentContribution(UID, token, { version: 'v1', targetContentId: null }, deps)).toEqual({ ok: false, reason: 'invalid_semver' });
  });

  it('新版本：版本不高于已发布 → version_not_higher；有待审提交须确认替换', async () => {
    const target = { currentVersion: '1.2.0', pendingSubmissionId: null as string | null };
    const { deps, token } = await confirmed({ contributionTarget: () => target });
    expect(await submitAgentContribution(UID, token, { version: '1.2.0', targetContentId: 'abcdef123456' }, deps))
      .toEqual({ ok: false, reason: 'version_not_higher', current_version: '1.2.0' });
    target.pendingSubmissionId = 'sub_9';
    expect(await submitAgentContribution(UID, token, { version: '1.3.0', targetContentId: 'abcdef123456' }, deps))
      .toEqual({ ok: false, reason: 'replacement_confirmation_required' });
    const ok = await submitAgentContribution(UID, token, { version: '1.3.0', targetContentId: 'abcdef123456', replaceConfirmed: true }, deps);
    expect(ok).toMatchObject({ ok: true });
  });

  it('目标内容本机查不到：target_version_unavailable', async () => {
    const { deps, token } = await confirmed({ contributionTarget: () => null });
    expect(await submitAgentContribution(UID, token, { version: '1.0.0', targetContentId: 'abcdef123456' }, deps))
      .toEqual({ ok: false, reason: 'target_version_unavailable' });
  });

  it('网络/接口失败：交给 IPC 转成可渲染错误；会话与确认副本保留，同键同字节可重试', async () => {
    let n = 0;
    const attempts: Array<{ key: string; bytes: Buffer }> = [];
    const { deps, token } = await confirmed({
      createSubmission: async (_u, a) => { attempts.push({ key: a.idempotencyKey, bytes: a.packageBytes }); if (++n === 1) throw new Error('boom'); return { submission_id: 's' }; },
    });
    const first = await submitAgentContribution(UID, token, { version: '1.0.0', targetContentId: null }, deps);
    expect(first).toMatchObject({ ok: false });
    expect('apiError' in first).toBe(true);
    expect(getSession(UID, token)).not.toBeNull();
    const second = await submitAgentContribution(UID, token, { version: '1.0.0', targetContentId: null }, deps);
    expect(second).toMatchObject({ ok: true });
    expect(attempts[1].key).toBe(attempts[0].key);
    expect(attempts[1].bytes.equals(attempts[0].bytes)).toBe(true);
  });

  it('用户取消上传：upload_cancelled，保留幂等键与字节', async () => {
    let session: ReturnType<typeof getSession> = null;
    const { deps, token } = await confirmed({
      createSubmission: async () => { session!.uploadController?.abort(); throw new Error('aborted'); },
    });
    session = getSession(UID, token);
    const r = await submitAgentContribution(UID, token, { version: '1.0.0', targetContentId: null }, deps);
    expect(r).toMatchObject({ ok: false, reason: 'upload_cancelled', retryable: true });
    expect(getSession(UID, token)!.idempotencyKey).toBe('key-1');
  });
});

describe('会话隔离', () => {
  it('不同账号取不到别人的会话', async () => {
    const { token } = await startPassing();
    await expect(confirmAgentPreview('other-user', token, 'x', makeDeps())).rejects.toThrow('session not found');
  });

  it('Skill 会话不能被当作 Agent 会话使用', async () => {
    const { createSession } = await import('../../../../src/main/features/contribution/session');
    const s = createSession(UID, { dir: path.join(root, 'x'), sourceSkillId: 's', token: 'abcdef012345' });
    await expect(confirmAgentPreview(UID, s.token, 'x', makeDeps())).rejects.toThrow('session not found');
  });
});
