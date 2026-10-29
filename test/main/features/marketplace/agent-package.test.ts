import * as crypto from 'node:crypto';

import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../../src/main/features/api_base', () => ({ requireCogSeedApiBase: () => 'https://hub.test' }));
vi.mock('../../../../src/main/features/api_common', () => ({ withCommonHeaders: (h: Record<string, string>) => h }));
vi.mock('../../../../src/main/features/config', () => ({ getLanguage: () => 'zh-CN' }));

const { AgentPackageError, fetchAgentPackage, readAgentPackage } = await import('../../../../src/main/features/marketplace/agent-package');

const AGENT = { agent_id: 'author-local-id', name: 'ExpenseHelper', description_zh: '核对', workflow: '1. 读', category: 'office', skill_list: ['a3f09c21b7e4', 'invoice-ocr'] };
const META = { version: '1.2.0', published_at: '2026-10-13T00:00:00Z' };

type Files = Record<string, string | Buffer>;
function pack(files: Files): Buffer {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(files)) zip.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
  return zip.toBuffer();
}
const good = (over: Files = {}): Files => ({
  'agent.json': JSON.stringify(AGENT), '_meta.json': JSON.stringify(META),
  'README.md': '# readme', 'skills/invoice-ocr/SKILL.md': '---\nname: invoice-ocr\n---\nbody', 'skills/invoice-ocr/scripts/run.sh': 'echo', ...over,
});
const read = (files: Files, over: Record<string, unknown> = {}) =>
  readAgentPackage(pack(files), { expectedVersion: '1.2.0', installedAgentId: 'f0e1d2c3b4a5', ...over });
const codeOf = (fn: () => unknown): string => { try { fn(); return 'no-throw'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

describe('readAgentPackage', () => {
  it('读出 agent.json（agent_id 改写成安装后的 id）、版本、发布时间与私有技能', () => {
    const pkg = read(good());
    expect(pkg.agentJson).toMatchObject({ agent_id: 'f0e1d2c3b4a5', name: 'ExpenseHelper', skill_list: ['a3f09c21b7e4', 'invoice-ocr'] });
    expect(pkg.version).toBe('1.2.0');
    expect(pkg.publishedAt).toBe(Date.parse('2026-10-13T00:00:00Z'));
    expect(pkg.hasReadme).toBe(true);
    const names = pkg.privateSkills!.getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(['invoice-ocr/SKILL.md', 'invoice-ocr/scripts/run.sh']);
  });

  it('没有 skills/ 时私有技能为 null，README 可缺', () => {
    const pkg = read({ 'agent.json': JSON.stringify({ ...AGENT, skill_list: ['a3f09c21b7e4'] }), '_meta.json': JSON.stringify(META) });
    expect(pkg.privateSkills).toBeNull();
    expect(pkg.hasReadme).toBe(false);
  });

  it('不修改作者原文里的其他字段，只改 agent_id', () => {
    const pkg = read(good());
    const { agent_id: _a, ...rest } = pkg.agentJson;
    const { agent_id: _b, ...orig } = AGENT;
    expect(rest).toEqual(orig);
  });

  it('请求的版本与 _meta.json 不一致 → 拒绝', () => {
    expect(codeOf(() => read(good(), { expectedVersion: '9.9.9' }))).toBe('AGENT_PACKAGE_VERSION_MISMATCH');
  });

  it('缺 agent.json 或 _meta.json → 拒绝', () => {
    const { 'agent.json': _x, ...noAgent } = good();
    expect(codeOf(() => read(noAgent))).toBe('AGENT_PACKAGE_MISSING_FILE');
    const { '_meta.json': _y, ...noMeta } = good();
    expect(codeOf(() => read(noMeta))).toBe('AGENT_PACKAGE_MISSING_FILE');
  });

  it('JSON 不合法或不是对象、_meta 无版本 → 拒绝', () => {
    expect(codeOf(() => read(good({ 'agent.json': '{oops' })))).toBe('AGENT_PACKAGE_INVALID_JSON');
    expect(codeOf(() => read(good({ 'agent.json': '[]' })))).toBe('AGENT_PACKAGE_INVALID_JSON');
    expect(codeOf(() => read(good({ '_meta.json': '{}' })))).toBe('AGENT_PACKAGE_INVALID_JSON');
  });

  it('私有技能目录名是 12 位十六进制 / 没有 SKILL.md → 拒绝', () => {
    expect(codeOf(() => read(good({ 'skills/a3f09c21b7e4/SKILL.md': 'x' })))).toBe('AGENT_PACKAGE_PRIVATE_SKILL');
    expect(codeOf(() => read(good({ 'skills/no-skill-md/readme.txt': 'x' })))).toBe('AGENT_PACKAGE_PRIVATE_SKILL');
  });

  it('skill_list 里名字形式的条目在包里没有对应目录 → 拒绝', () => {
    const { 'skills/invoice-ocr/SKILL.md': _s, 'skills/invoice-ocr/scripts/run.sh': _r, ...none } = good();
    expect(codeOf(() => read(none))).toBe('AGENT_PACKAGE_PRIVATE_SKILL');
  });

  it('路径穿越的条目 → 拒绝', () => {
    const zip = new AdmZip();
    zip.addFile('agent.json', Buffer.from(JSON.stringify(AGENT)));
    zip.addFile('_meta.json', Buffer.from(JSON.stringify(META)));
    zip.addFile('skills/invoice-ocr/SKILL.md', Buffer.from('x'));
    zip.addFile('skills/invoice-ocr/evil.txt', Buffer.from('x'));
    // addFile 会规整路径，直接篡改条目名才能造出真正的恶意包
    zip.getEntry('skills/invoice-ocr/evil.txt')!.entryName = 'skills/invoice-ocr/../../../evil.txt';
    expect(codeOf(() => readAgentPackage(zip.toBuffer(), { installedAgentId: 'f0e1d2c3b4a5' }))).toBe('AGENT_PACKAGE_UNSAFE');
  });

  it('符号链接条目 → 拒绝', () => {
    const zip = new AdmZip();
    zip.addFile('agent.json', Buffer.from(JSON.stringify({ ...AGENT, skill_list: [] })));
    zip.addFile('_meta.json', Buffer.from(JSON.stringify(META)));
    zip.addFile('link', Buffer.from('/etc/passwd'));
    zip.getEntry('link')!.header.attr = ((0o120777 << 16) >>> 0);
    expect(codeOf(() => readAgentPackage(zip.toBuffer(), { installedAgentId: 'f0e1d2c3b4a5' }))).toBe('AGENT_PACKAGE_UNSAFE');
  });

  it('不是 ZIP / 截断的字节 → 抛错而不是静默成功', () => {
    expect(() => readAgentPackage(Buffer.from('not a zip at all'), { installedAgentId: 'x' })).toThrow();
  });
});

describe('fetchAgentPackage（B-02）', () => {
  afterEach(() => vi.unstubAllGlobals());
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

  it('打 /marketplace/agents/bundle，请求体含 content_id 与 version，校验 sha256 后读出', async () => {
    const bytes = pack(good());
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const pkg = await fetchAgentPackage({ contentId: 'f0e1d2c3b4a5', version: '1.2.0', artifact: { sha256: sha(bytes), size_bytes: bytes.length } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hub.test/marketplace/agents/bundle');
    expect(JSON.parse(String(init.body))).toEqual({ content_id: 'f0e1d2c3b4a5', version: '1.2.0' });
    expect(pkg.agentJson.agent_id).toBe('f0e1d2c3b4a5');
  });

  it('摘要对不上 → 不返回内容', async () => {
    const bytes = pack(good());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })));
    await expect(fetchAgentPackage({ contentId: 'f0e1d2c3b4a5', version: '1.2.0', artifact: { sha256: 'deadbeef', size_bytes: bytes.length } })).rejects.toThrow();
  });

  it('响应不是字节流（JSON 错误信封）→ 拒绝，不当字节落盘', async () => {
    const body = Buffer.from('{"code":1}');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await expect(fetchAgentPackage({ contentId: 'f0e1d2c3b4a5', version: '1.2.0', artifact: { sha256: sha(body), size_bytes: body.length } })).rejects.toThrow();
  });
});
