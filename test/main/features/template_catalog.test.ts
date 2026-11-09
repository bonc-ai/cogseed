import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * S5 Hub 模板目录：映射层、错误归类、未登录不请求、离线缓存（contracts/client-hub-templates.md）。
 * Hub 响应来自 `fixtures/hub-templates/`（按 2026-10-27 冻结契约编写）。
 */

const postJson = vi.fn();
let anonymous = false;
let language = 'zh';
let appVersion = '1.4.0';

vi.mock('../../../src/main/features/marketplace', () => ({
  postJson: (...args: unknown[]) => postJson(...args),
  currentAppVersion: () => appVersion,
  isMarketplaceEndpointUnsupported: (err: unknown) =>
    !!err && typeof err === 'object' && (err as { hubErrorCode?: unknown }).hubErrorCode === 'NOT_SUPPORTED',
}));
vi.mock('../../../src/main/features/users', () => ({ isAnonymousLocalId: () => anonymous }));
vi.mock('../../../src/main/features/config', () => ({ getLanguage: () => language }));

const FIX = path.join(__dirname, 'fixtures', 'hub-templates');
const WS = JSON.parse(fs.readFileSync(path.join(FIX, 'workspace-templates.json'), 'utf8'));
const TASK = JSON.parse(fs.readFileSync(path.join(FIX, 'scheduled-tasks.json'), 'utf8'));
const UID = 'u-template-catalog';

let tmpDir: string;
let prevWs: string | undefined;

async function load() {
  return import('../../../src/main/features/marketplace/template-catalog');
}

/** 按路径回放夹具：`/list` → list_response，`/detail` / `/content` → frozen snapshots。 */
function serve(fixture: typeof WS) {
  postJson.mockImplementation(async (p: string, body: { content_id?: string; version?: string; page?: number; size?: number }) => {
    if (p.endsWith('/list')) {
      const rows = fixture.list_response.list;
      const size = Number(body.size) || 20;
      const page = Number(body.page) || 1;
      return { code: 0, ...fixture.list_response, total: rows.length, list: rows.slice((page - 1) * size, page * size) };
    }
    const table = p.endsWith('/content') ? fixture.contents : fixture.details;
    const row = table[body.content_id ?? ''];
    if (!row) throw Object.assign(new Error('not found'), { marketplaceCode: 1, hubErrorCode: 'CONTENT_NOT_FOUND' });
    return { code: 0, ...row };
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-template-catalog-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  postJson.mockReset();
  anonymous = false;
  language = 'zh';
  appVersion = '1.4.0';
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('template catalog › list', () => {
  it('keeps disabled rows but marks them not creatable, and gates on min_app_version', async () => {
    serve(WS);
    const { listTemplates } = await load();
    const res = await listTemplates(UID, 'workspace');
    expect(res.ok).toBe(true);
    // Hub 目录保留停用行（`status: "disabled"`），客户端不隐藏、只标不可创建。
    expect(res.items.map((i) => [i.template_id, i.creatable, i.blocked_reason ?? null])).toEqual([
      ['ws-tpl-a', true, null],
      ['ws-tpl-disabled', false, 'disabled'],
      ['ws-tpl-too-new', false, 'client_too_old'],
      ['ws-tpl-unknown', true, null],
    ]);
    expect(res.items[0].name).toBe('竞品研究空间');
  });

  it('uses the catalog display string and falls back to zh-only rows', async () => {
    serve(WS);
    language = 'en';
    const { listTemplates } = await load();
    const res = await listTemplates(UID, 'workspace');
    expect(res.items[0].name).toBe('竞品研究空间');
    expect(res.items.find((i) => i.template_id === 'ws-tpl-too-new')?.name).toBe('需要新版客户端的空间模板');
  });

  it('does not call Hub when signed out', async () => {
    anonymous = true;
    const { listTemplates } = await load();
    expect(await listTemplates(UID, 'task')).toEqual({ ok: true, items: [], signed_out: true });
    expect(postJson).not.toHaveBeenCalled();
  });

  it('sends no local identifiers in the request body', async () => {
    serve(TASK);
    const { listTemplates, getTemplateDetail } = await load();
    await listTemplates(UID, 'task');
    await getTemplateDetail(UID, 'task', 'task-tpl-b');
    for (const [, body] of postJson.mock.calls) {
      const flat = JSON.stringify(body);
      expect(flat).not.toContain(UID);
      expect(flat).not.toContain(tmpDir);
      for (const key of Object.keys(body as object)) expect(['page', 'size', 'content_id', 'version']).toContain(key);
    }
  });

  it('hides the entry when Hub does not support templates', async () => {
    postJson.mockRejectedValue(Object.assign(new Error('nope'), { marketplaceCode: 1, hubErrorCode: 'NOT_SUPPORTED' }));
    const { listTemplates } = await load();
    expect(await listTemplates(UID, 'workspace')).toEqual({ ok: true, items: [], hidden: true });
  });

  it('falls back to the last good list when offline', async () => {
    serve(WS);
    const { listTemplates } = await load();
    await listTemplates(UID, 'workspace');
    postJson.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
    const res = await listTemplates(UID, 'workspace');
    expect(res).toMatchObject({ ok: false, error: 'offline', from_cache: true });
    expect(res.items.map((i) => i.template_id)).toEqual(['ws-tpl-a', 'ws-tpl-disabled', 'ws-tpl-too-new', 'ws-tpl-unknown']);
    // 停用是服务端事实，不会被版本重算冲掉。
    expect(res.items.find((i) => i.template_id === 'ws-tpl-disabled')).toMatchObject({
      creatable: false, blocked_reason: 'disabled',
    });
    expect(fs.existsSync(path.join(tmpDir, UID, 'local', 'marketplace', 'template-catalog-cache.json'))).toBe(true);
  });

  it('recomputes the version gate on cached items after a client upgrade', async () => {
    serve(WS);
    const { listTemplates } = await load();
    await listTemplates(UID, 'workspace');
    postJson.mockRejectedValue(new Error('fetch failed'));
    appVersion = '99.0.0';
    const res = await listTemplates(UID, 'workspace');
    expect(res.items.find((i) => i.template_id === 'ws-tpl-too-new')).toMatchObject({ creatable: true });
  });

  it('offline with no cache returns an empty list and the error', async () => {
    postJson.mockRejectedValue(new Error('fetch failed'));
    const { listTemplates } = await load();
    expect(await listTemplates(UID, 'task')).toEqual({ ok: false, items: [], error: 'offline' });
  });
});

describe('template catalog › error classification', () => {
  it.each([
    [Object.assign(new Error('x'), { hubErrorCode: 'NOT_SUPPORTED' }), 'not_supported'],
    [Object.assign(new Error('x'), { hubErrorCode: 'CONTENT_NOT_FOUND' }), 'not_found'],
    [Object.assign(new Error('x'), { hubErrorCode: 'content_disabled' }), 'disabled'],
    [Object.assign(new Error('x'), { hubErrorCode: 'FORBIDDEN' }), 'forbidden'],
    [new Error('bad response (403): denied'), 'forbidden'],
    [new Error('bad response (404): gone'), 'not_found'],
    [new Error('bad response (502): upstream'), 'server_error'],
    [Object.assign(new Error('x'), { marketplaceCode: 7 }), 'server_error'],
    [new Error('fetch failed: ENOTFOUND'), 'offline'],
  ] as const)('%s → %s', async (err, expected) => {
    const { classifyCatalogError } = await load();
    expect(classifyCatalogError(err)).toBe(expected);
  });
});

describe('template catalog › detail mapping', () => {
  it('maps a workspace template', async () => {
    serve(WS);
    const { computeTemplateContentSha256, getTemplateDetail } = await load();
    // Fixed value was generated by the Hub implementation from this frozen response fixture.
    expect(computeTemplateContentSha256(WS.contents['ws-tpl-a'])).toBe(
      '587d21f59f9991ab2c033e6bb4fca70f79823672c60040fabf9c0dea19d9a490',
    );
    const res = await getTemplateDetail(UID, 'workspace', 'ws-tpl-a');
    expect(res).toMatchObject({ ok: true, creatable: true });
    if (!res.ok) throw new Error('unreachable');
    expect(res.template).toMatchObject({
      template_id: 'ws-tpl-a',
      // 模板名只用于来源记录；预填名称单独放 suggested_name（占位已转【…】）。
      name: '竞品研究空间',
      suggested_name: '竞品研究：【竞品名称】',
      project_dir: 'optional',
      connector_types: ['tencent-meeting'],
      role_templates: [{ source: 'builtin', kind: 'role_template', id: 'student', hub_availability: 'available' }],
      extra_skills: [{ source: 'hub', kind: 'skill', id: 'aaaaaaaaaaa1', compat: { min_version: '1.0.0' } }],
      extra_agents: [],
    });
    expect((res.template as { instructions: string }).instructions).toContain('【竞品名称】');
    expect(res.template.fill_ins.map((f) => f.id)).toEqual(['competitor', 'market']);
    expect(postJson).toHaveBeenCalledWith('/marketplace/workspace-templates/content', {
      content_id: 'ws-tpl-a', version: '1.0.0',
    });
  });

  it('keeps unknown kinds and availabilities so the resolver can mark them unknown', async () => {
    serve(WS);
    const { getTemplateDetail } = await load();
    const res = await getTemplateDetail(UID, 'workspace', 'ws-tpl-unknown');
    if (!res.ok) throw new Error('unreachable');
    expect((res.template as { extra_skills: unknown[] }).extra_skills).toEqual([
      { source: 'hub', kind: 'workflow', id: 'bbbbbbbbbbb1', hub_availability: 'available' },
      { source: 'hub', kind: 'skill', id: 'bbbbbbbbbbb2', hub_availability: 'unknown' },
      { source: 'hub', kind: 'skill', id: 'bbbbbbbbbbb3', hub_availability: 'unknown' },
    ]);
  });

  it('maps a task template run by the main agent without exposing connector prerequisites', async () => {
    serve(TASK);
    const { getTemplateDetail } = await load();
    const res = await getTemplateDetail(UID, 'task', 'task-tpl-b');
    if (!res.ok) throw new Error('unreachable');
    expect(res.template).toMatchObject({
      content: '汇总今天已结束的会议，按【团队名称】关心的议题整理要点和待办。',
      schedule: { type: 'daily', hour: 18, minute: 0 },
      execution_agent: null,
      skills: [],
    });
    expect(res.template).not.toHaveProperty('connector_types');
  });

  it('converts {{id}} placeholders to 【label】, including undeclared ids', async () => {
    const { fillTemplateText, mapTaskTemplate } = await load();
    const fillIns = [{ id: 'team', label_zh: '团队名称' }];
    // 未声明的 id 退回 id：仍然看得见，创建门也会拦住它。
    expect(fillTemplateText('按{{team}}整理，{{unknown}} 也要看得见', fillIns))
      .toBe('按【团队名称】整理，【unknown】 也要看得见');
    const mapped = mapTaskTemplate({
      content_id: 't', version: '1', name: 'n', status: 'published',
      config: { task_content_zh: '汇总 {{team}}', schedule: { type: 'daily', hour: 9, minute: 0 } },
      fill_ins: fillIns,
    }, 'zh');
    expect(mapped?.content).toBe('汇总 【团队名称】');
  });

  it('a one-time template carries no time; an explicit execution agent is kept', async () => {
    serve(TASK);
    const { getTemplateDetail } = await load();
    const res = await getTemplateDetail(UID, 'task', 'task-tpl-c');
    if (!res.ok) throw new Error('unreachable');
    expect(res.template).toMatchObject({
      schedule: { type: 'one_time' },
      execution_agent: { source: 'hub', kind: 'agent', id: 'ccccccccccc1' },
    });
  });

  it('verifies frozen content digests and rejects missing or tampered snapshots', async () => {
    const { computeTemplateContentSha256, getTemplateDetail } = await load();
    for (const fixture of [WS, TASK]) {
      for (const row of Object.values(fixture.contents) as Array<Record<string, unknown>>) {
        expect(computeTemplateContentSha256(row)).toBe(row.config_sha256);
      }
    }

    const resolved = JSON.parse(JSON.stringify(WS.contents['ws-tpl-a']));
    resolved.references[0].resolved_version = '1.0.0';
    resolved.references[0].reason = '本机已安装';
    resolved.references[0].availability = 'incompatible';
    expect(computeTemplateContentSha256(resolved)).toBe(resolved.config_sha256);

    const tampered = JSON.parse(JSON.stringify(WS));
    tampered.contents['ws-tpl-a'].config.goal_zh = '被篡改的目标';
    serve(tampered);
    expect(await getTemplateDetail(UID, 'workspace', 'ws-tpl-a'))
      .toEqual({ ok: false, error: 'invalid_template' });

    const missing = JSON.parse(JSON.stringify(WS));
    delete missing.contents['ws-tpl-a'].config_sha256;
    serve(missing);
    expect(await getTemplateDetail(UID, 'workspace', 'ws-tpl-a'))
      .toEqual({ ok: false, error: 'invalid_template' });
  });

  it('rejects weekday 7 and other broken schedules instead of correcting them', async () => {
    const { mapTaskTemplate } = await load();
    const raw = (schedule: unknown) => ({ content_id: 't', version: '1', status: 'published', name: 'n', config: { task_content_zh: 'c', schedule } });
    // Hub 只发 0–6（0 = 周日），7 会被发布校验拒绝；客户端不再替它纠正成周日。
    expect(mapTaskTemplate(raw({ type: 'weekly', weekday: 7, hour: 9, minute: 0 }), 'zh')).toBeNull();
    expect(mapTaskTemplate(raw({ type: 'weekly', weekday: 9, hour: 9, minute: 0 }), 'zh')).toBeNull();
    expect(mapTaskTemplate(raw({ type: 'hourly' }), 'zh')).toBeNull();
  });

  it('blocks creation when task content exceeds 8000 characters', async () => {
    const { computeTemplateContentSha256, getTemplateDetail } = await load();
    const content = {
      code: 0, content_id: 'long', version: '1', status: 'published', name: 'n',
      template_kind: 'scheduled_task',
      config: { task_content_zh: 'x'.repeat(8001), schedule: { type: 'daily', hour: 9, minute: 0 } },
    };
    const configSha256 = computeTemplateContentSha256(content);
    postJson.mockImplementation(async (p: string) => ({
      ...content,
      ...(p.endsWith('/content') ? { config_sha256: configSha256 } : { template_kind: undefined }),
    }));
    expect(await getTemplateDetail(UID, 'task', 'long')).toMatchObject({ ok: true, creatable: false, blocked_reason: 'content_too_long' });
  });

  it('a disabled template still opens but cannot be created; a draft is not a template', async () => {
    const { getTemplateDetail } = await load();
    postJson.mockResolvedValue({
      code: 0, content_id: 'd', version: '1', status: 'disabled', disabled: true,
      name: '已下架模板', config: { suggested_name: '已下架模板', goal_zh: 'g', instructions_zh: 'i' },
      references: [{ source: 'builtin', kind: 'role_template', id: 'student', usage: 'primary_role', availability: 'available' }],
    });
    // Hub 用 200 + disabled 表示下架，不是 404：已建实例还要靠它说明「来源已停用」。
    expect(await getTemplateDetail(UID, 'workspace', 'd')).toMatchObject({
      ok: true, creatable: false, blocked_reason: 'disabled',
    });
    postJson.mockResolvedValue({ code: 0, content_id: 'd', version: '1', status: 'draft' });
    expect(await getTemplateDetail(UID, 'workspace', 'd')).toEqual({ ok: false, error: 'invalid_template' });
  });

  it('signed out cannot open details', async () => {
    anonymous = true;
    const { getTemplateDetail } = await load();
    expect(await getTemplateDetail(UID, 'workspace', 'ws-tpl-a')).toEqual({ ok: false, error: 'signed_out' });
    expect(postJson).not.toHaveBeenCalled();
  });

  it('marks detail as not creatable when the client is older than the template requires', async () => {
    const { getTemplateDetail } = await load();
    // 同一份夹具，把最低版本抬到本机之上：详情要给出 creatable:false + 原因。
    const strict = JSON.parse(JSON.stringify(WS));
    strict.details['ws-tpl-a'].min_app_version = '9.0.0';
    serve(strict);
    appVersion = '1.4.0';
    const res = await getTemplateDetail(UID, 'workspace', 'ws-tpl-a');
    expect(res).toMatchObject({ ok: true, creatable: false, blocked_reason: 'client_too_old' });
  });

  it('reading and refreshing the catalog never rewrites the builtin manifest', async () => {
    const { listTemplates, getTemplateDetail } = await load();
    // 模板更新 / 停用只影响 Hub 内容，内置清单是发布物，不能被目录读写碰到。
    const manifest = path.join(__dirname, '../../../src/main/features/marketplace/builtin-template-refs.json');
    const candidates = [
      manifest,
      path.join(__dirname, '../../../specs/010-hub-workspace-task-templates/contracts/builtin-template-refs.json'),
    ].filter((p) => fs.existsSync(p));
    const before = candidates.map((p) => fs.readFileSync(p, 'utf8'));
    serve(WS);
    await listTemplates(UID, 'workspace');
    await getTemplateDetail(UID, 'workspace', 'ws-tpl-a').catch(() => null);
    const after = candidates.map((p) => fs.readFileSync(p, 'utf8'));
    expect(after).toEqual(before);
  });

  it('pages through the catalog instead of trusting the default page size', async () => {
    // Hub 默认 size=20、上限 100，total 是全量：不翻页会静默丢第 21 条以后。
    const rows = Array.from({ length: 150 }, (_, i) => ({
      content_id: 'tpl' + String(i).padStart(9, '0'),
      version: '1', status: 'published', name: { zh: '模板' + i },
    }));
    postJson.mockImplementation(async (p: string, body: { size?: number; page?: number }) => {
      if (!p.endsWith('/list')) throw new Error('unexpected path ' + p);
      const size = Number(body.size) || 20;
      const page = Number(body.page) || 1;
      return { code: 0, total: rows.length, list: rows.slice((page - 1) * size, page * size) };
    });
    const { listTemplates } = await load();
    const res = await listTemplates(UID, 'workspace');
    expect(res.items).toHaveLength(150);
    const calls = postJson.mock.calls.filter(([p]) => String(p).endsWith('/list'));
    expect(calls.map(([, body]) => body.page)).toEqual([1, 2]);
    for (const [, body] of calls) expect(body.size).toBe(100);
  });

  it('keeps Hub codes and client-local categories apart', async () => {
    const { classifyCatalogError } = await load();
    // Hub 线上码
    expect(classifyCatalogError(Object.assign(new Error('x'), { hubErrorCode: 'NOT_FOUND' }))).toBe('not_found');
    expect(classifyCatalogError(Object.assign(new Error('x'), { hubErrorCode: 'NOT_SUPPORTED' }))).toBe('not_supported');
    expect(classifyCatalogError(Object.assign(new Error('x'), { hubErrorCode: 'UNAVAILABLE' }))).toBe('server_error');
    // 请求体不合规是客户端自己的问题，归到服务端错误而不是模板非法
    expect(classifyCatalogError(Object.assign(new Error('x'), { hubErrorCode: 'UNEXPECTED_FIELD' }))).toBe('server_error');
    // 客户端本地合成：Hub 不返回 401/403，网络失败没有响应体
    expect(classifyCatalogError(new Error('fetch failed: ECONNREFUSED'))).toBe('offline');
    expect(classifyCatalogError(Object.assign(new Error('403'), { status: 403 }))).toBe('forbidden');
  });
});
