import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Model client stub. Individual tests override `__nextChat` to shape the
// extractor's model output.
let __nextChat: (message: string, systemPrompt?: string) => { ok: boolean; text: string } =
  () => ({ ok: true, text: '' });
// The extractor imports chatWithModel from model/core-agent/client, so that is
// the module we must intercept (not the lower-level model/client).
vi.mock('../../../src/main/model/core-agent/client', () => ({
  async chatWithModel(opts: any) {
    const r = __nextChat(opts.message, opts.systemPrompt);
    return { ok: r.ok, text: r.text, error: r.ok ? '' : 'stub-fail', aborted: false };
  },
}));
// group_chat's send path (reached transitively by chats.ts) still uses the
// lower-level model/client stream — stub it so nothing does a real LLM call.
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel(_opts: any) {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

let tmpDir: string;
let homeDir: string;
let prevWs: string | undefined;
let prevHome: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-simport-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Isolate HOME so os.homedir() (used by the Claude session + skill readers)
  // points at a clean per-test dir — never the real ~/.claude.
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = homeDir;
  __nextChat = () => ({ ok: true, text: '' });
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  process.env.HOME = prevHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('session_import › transcript-normalize', () => {
  it('parses new (string content) and old (block array) Claude formats', async () => {
    const { parseClaudeTranscript } = await import(
      '../../../src/main/features/session_import/transcript-normalize'
    );
    const body = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, cwd: '/proj', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } }),
      JSON.stringify({ type: 'queue-operation', foo: 1 }),
      '{ this is not json',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] } }),
    ].join('\n');

    const norm = parseClaudeTranscript(body, 'sess-1');
    expect(norm.source).toBe('claude');
    expect(norm.sourceId).toBe('sess-1');
    expect(norm.projectPath).toBe('/proj');
    // queue-op, malformed and tool-only lines are dropped.
    expect(norm.turns).toEqual([
      { role: 'user', text: 'hello', ts: '2026-01-01T00:00:00Z' },
      { role: 'assistant', text: 'hi there', ts: '' },
    ]);
  });
});

describe('session_import › extractor', () => {
  it('parses strict JSON from a single pass', async () => {
    __nextChat = () => ({
      ok: true,
      text: JSON.stringify({
        summary: '完成了支付迁移，遗留退款回调未测。',
        personal: [{ text: '偏好 TypeScript' }],
        rules: ['提交前必须过 lint'],
        templates: [],
      }),
    });
    const { extractSession } = await import('../../../src/main/features/session_import/extractor');
    const res = await extractSession(TEST_UID, {
      source: 'claude', sourceId: 's', projectPath: '/p',
      turns: [{ role: 'user', text: '帮我迁移支付', ts: '' }],
    });
    expect(res.ok).toBe(true);
    expect(res.sessionSummary).toContain('支付迁移');
    expect(res.personal[0].text).toBe('偏好 TypeScript');
    expect(res.rules[0].text).toBe('提交前必须过 lint');
    expect(res.templates).toEqual([]);
  });

  it('strips code fences around the JSON', async () => {
    __nextChat = () => ({
      ok: true,
      text: '好的，结果如下：\n```json\n{"summary":"S","personal":[],"rules":[],"templates":[]}\n```',
    });
    const { extractSession } = await import('../../../src/main/features/session_import/extractor');
    const res = await extractSession(TEST_UID, {
      source: 'claude', sourceId: 's', projectPath: '',
      turns: [{ role: 'user', text: 'hi', ts: '' }],
    });
    expect(res.ok).toBe(true);
    expect(res.sessionSummary).toBe('S');
  });

  it('degrades honestly when the model output is unparseable', async () => {
    __nextChat = () => ({ ok: true, text: 'sorry no json here' });
    const { extractSession } = await import('../../../src/main/features/session_import/extractor');
    const res = await extractSession(TEST_UID, {
      source: 'claude', sourceId: 's', projectPath: '',
      turns: [{ role: 'user', text: '第一句用户消息', ts: '' }],
    });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    // Fallback seed = first user turn, so the session stays importable.
    expect(res.sessionSummary).toContain('第一句用户消息');
    expect(res.personal).toEqual([]);
  });

  it('degrades when the model call fails', async () => {
    __nextChat = () => ({ ok: false, text: '' });
    const { extractSession } = await import('../../../src/main/features/session_import/extractor');
    const res = await extractSession(TEST_UID, {
      source: 'claude', sourceId: 's', projectPath: '',
      turns: [{ role: 'user', text: 'x', ts: '' }],
    });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.reason).toBe('model_unavailable');
  });
});

describe('session_import › asset-router (cognitions → Recall candidate pool)', () => {
  it('routes the three buckets to matching suggestedType candidates', async () => {
    const { routeCognitions } = await import('../../../src/main/features/session_import/asset-router');
    const recall = await import('../../../src/main/features/recall/candidate-service');

    // A conversation id must be a safeId; use one materialize would produce.
    const cid = 'imp-claude-abc123';
    const counts = await routeCognitions(TEST_UID, 'claude', 'sess-1', cid, {
      personal: [{ text: '偏好 TypeScript' }],
      rules: [{ text: '提交前必须过 lint', note: '用户强调过两次' }],
      templates: [{ text: 'PR 描述用三段式' }],
    });
    expect(counts).toEqual({ personal: 1, rule: 1, template: 1 });

    const candidates = await recall.listRecallCandidates(TEST_UID);
    const byType = (t: string) => candidates.filter((c: any) => c.suggestedType === t);
    expect(byType('personal')[0].judgment).toBe('偏好 TypeScript');
    expect(byType('rule')[0].judgment).toBe('提交前必须过 lint');
    expect(byType('rule')[0].summary).toBe('用户强调过两次');
    expect(byType('template')[0].judgment).toBe('PR 描述用三段式');
    // Evidence points at the materialized conversation.
    expect(byType('personal')[0].sourceRefs[0].id).toBe(cid);
    expect(byType('personal')[0].sourceRefs[0].kind).toBe('conversation');
  });

  it('is idempotent — same cognition from same session dedupes via captureKey', async () => {
    const { routeCognitions } = await import('../../../src/main/features/session_import/asset-router');
    const recall = await import('../../../src/main/features/recall/candidate-service');
    const cid = 'imp-claude-dedup1';

    await routeCognitions(TEST_UID, 'claude', 'sess-dup', cid, {
      personal: [{ text: '偏好深色主题' }], rules: [], templates: [],
    });
    await routeCognitions(TEST_UID, 'claude', 'sess-dup', cid, {
      personal: [{ text: '偏好深色主题' }], rules: [], templates: [],
    });

    const personal = (await recall.listRecallCandidates(TEST_UID))
      .filter((c: any) => c.suggestedType === 'personal' && c.judgment === '偏好深色主题');
    expect(personal.length).toBe(1);
  });
});

describe('session_import › skill-import (Claude skills → skill library)', () => {
  function stageClaudeSkill(dirName: string, md: string, helpers: Record<string, string> = {}) {
    const dir = path.join(os.homedir(), '.claude', 'skills', dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
    for (const [rel, content] of Object.entries(helpers)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return dir;
  }

  it('lists Claude skills (metadata only) and returns [] when none', async () => {
    const mod = await import('../../../src/main/features/session_import/skill-import');
    // Fresh home in this test has no ~/.claude/skills yet.
    expect(await mod.listClaudeSkills()).toEqual([]);

    stageClaudeSkill('git-flow', '---\nname: git-flow\ndescription: git 工作流\n---\n# body\n步骤...');
    const list = await mod.listClaudeSkills();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('git-flow');
    expect(list[0].description).toBe('git 工作流');
  });

  it('imports a skill with its body and helper files', async () => {
    const mod = await import('../../../src/main/features/session_import/skill-import');
    const skills = await import('../../../src/main/features/skills');

    stageClaudeSkill(
      'pdf-report',
      '---\nname: pdf-report\ndescription: 生成 PDF 报告\n---\n# 用法\n运行脚本生成报告。',
      { 'scripts/gen.py': 'print("hi")', 'ref/notes.md': '# notes' },
    );

    const res = await mod.importClaudeSkill('pdf-report');
    expect(res.ok).toBe(true);
    expect(res.skillId).toBeTruthy();

    // Skill is now in our library.
    const custom = await skills.getCustomSkill('pdf-report');
    expect(custom).toBeTruthy();

    // Body was written (SKILL.md contains the imported body text).
    const body = await skills.readSkillFile('custom', res.skillId!, 'SKILL.md');
    expect(body.ok && body.content).toContain('运行脚本生成报告');

    // Helper files were copied.
    const gen = await skills.readSkillFile('custom', res.skillId!, 'scripts/gen.py');
    expect(gen.ok && gen.content).toContain('print("hi")');
  });

  it('is idempotent — re-importing a same-named skill reports already_exists', async () => {
    const mod = await import('../../../src/main/features/session_import/skill-import');
    stageClaudeSkill('dup-skill', '---\nname: dup-skill\ndescription: d\n---\nbody');

    const first = await mod.importClaudeSkill('dup-skill');
    expect(first.ok).toBe(true);
    const second = await mod.importClaudeSkill('dup-skill');
    expect(second.ok).toBe(true);
    expect(second.reason).toBe('already_exists');
  });

  it('rejects a dirName that escapes the skills root', async () => {
    const mod = await import('../../../src/main/features/session_import/skill-import');
    const res = await mod.importClaudeSkill('../../etc/passwd');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('out_of_bounds');
  });

  it('batch import reports ok/fail counts', async () => {
    const mod = await import('../../../src/main/features/session_import/skill-import');
    stageClaudeSkill('batch-a', '---\nname: batch-a\ndescription: a\n---\nA');
    stageClaudeSkill('batch-b', '---\nname: batch-b\ndescription: b\n---\nB');

    const res = await mod.importClaudeSkills(['batch-a', 'batch-b', 'does-not-exist']);
    expect(res.okCount).toBe(2);
    expect(res.failCount).toBe(1);
  });
});

describe('session_import › full pipeline (importClaudeSession)', () => {
  it('reads → extracts → materializes → routes, end to end', async () => {
    // Stage the fake Claude transcript file the reader will read.
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects', 'enc-proj');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const filePath = path.join(projectsRoot, 'pipe-1.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我修 CI' }, cwd: '/proj', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已修复缓存 key' }] } }),
    ].join('\n'));

    __nextChat = () => ({
      ok: true,
      text: JSON.stringify({
        summary: 'CI 缓存 key 已修复，剩下并发任务待验证。',
        personal: [], rules: [{ text: 'CI 必须绿灯才能合' }], templates: [],
      }),
    });

    const { importClaudeSession } = await import('../../../src/main/features/session_import/asset-router');
    const chats = await import('../../../src/main/features/chats');
    const recall = await import('../../../src/main/features/recall/candidate-service');

    const res = await importClaudeSession({ userId: TEST_UID, filePath });
    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(false);
    expect(res.cognitions.rule).toBe(1);

    // Conversation exists and is seeded.
    const msgs = await chats.getMessages(TEST_UID, res.conversationId!);
    expect(msgs[0].text).toContain('CI 缓存 key');

    // Cognition landed in the candidate pool as a rule.
    const rules = (await recall.listRecallCandidates(TEST_UID))
      .filter((c: any) => c.suggestedType === 'rule');
    expect(rules.some((c: any) => c.judgment === 'CI 必须绿灯才能合')).toBe(true);

    // Cleanup staged file.
    fs.rmSync(filePath, { force: true });
  });

  it('degraded extraction still materializes but routes no cognitions', async () => {
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects', 'enc-proj2');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const filePath = path.join(projectsRoot, 'pipe-deg.jsonl');
    fs.writeFileSync(filePath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: '随便问问' }, timestamp: '2026-01-01T00:00:00Z' }));

    __nextChat = () => ({ ok: true, text: 'not json at all' });

    const { importClaudeSession } = await import('../../../src/main/features/session_import/asset-router');
    const chats = await import('../../../src/main/features/chats');

    const res = await importClaudeSession({ userId: TEST_UID, filePath });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.cognitions).toEqual({ personal: 0, rule: 0, template: 0 });

    // Still importable: conversation exists with the honest degraded banner.
    const msgs = await chats.getMessages(TEST_UID, res.conversationId!);
    expect(msgs[0].text).toContain('未能自动提炼');

    fs.rmSync(filePath, { force: true });
  });
});

describe('session_import › materialize', () => {
  it('creates a continuable conversation seeded with the summary', async () => {
    const { materializeSession } = await import('../../../src/main/features/session_import/materialize');
    const chats = await import('../../../src/main/features/chats');

    const result = await materializeSession({
      userId: TEST_UID,
      source: 'claude',
      sourceId: 'sess-abc',
      extraction: {
        ok: true,
        sessionSummary: '上次进展：完成支付迁移，退款回调待测。',
        personal: [], rules: [], templates: [],
      },
    });

    expect(result.created).toBe(true);
    expect(result.seeded).toBe(true);

    // Conversation shows up in the sidebar list.
    const list = await chats.listConversations(TEST_UID);
    const found = list.find((c: any) => c.conversation_id === result.conversationId);
    expect(found).toBeTruthy();
    expect(found.title).toContain('⤴');

    // Seed message is in the jsonl with both human text and model_text.
    const msgs = await chats.getMessages(TEST_UID, result.conversationId);
    expect(msgs.length).toBe(1);
    expect(msgs[0].from).toBe('commander');
    expect(msgs[0].text).toContain('已提炼');
    expect(msgs[0].text).toContain('支付迁移');
    expect(msgs[0].model_text).toContain('继续协助');
  });

  it('is idempotent — re-importing the same session does not duplicate or re-seed', async () => {
    const { materializeSession } = await import('../../../src/main/features/session_import/materialize');
    const chats = await import('../../../src/main/features/chats');

    const first = await materializeSession({
      userId: TEST_UID, source: 'claude', sourceId: 'dup-1',
      extraction: { ok: true, sessionSummary: 'S1', personal: [], rules: [], templates: [] },
    });
    const second = await materializeSession({
      userId: TEST_UID, source: 'claude', sourceId: 'dup-1',
      extraction: { ok: true, sessionSummary: 'S2-different', personal: [], rules: [], templates: [] },
    });

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.created).toBe(false);
    expect(second.seeded).toBe(false);

    const msgs = await chats.getMessages(TEST_UID, first.conversationId);
    // Still exactly one seed — the second import did not append.
    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toContain('S1');
  });

  it('marks a degraded extraction with the honest banner', async () => {
    const { materializeSession } = await import('../../../src/main/features/session_import/materialize');
    const chats = await import('../../../src/main/features/chats');

    const res = await materializeSession({
      userId: TEST_UID, source: 'claude', sourceId: 'deg-1',
      extraction: {
        ok: false, degraded: true, reason: 'unparseable_json',
        sessionSummary: '原始开头文本', personal: [], rules: [], templates: [],
      },
    });
    const msgs = await chats.getMessages(TEST_UID, res.conversationId);
    expect(msgs[0].text).toContain('未能自动提炼');
  });
});
