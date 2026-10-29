import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-engagement-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => workspace), isPackaged: false, getVersion: vi.fn(() => '1.3.0') },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../../src/main/features/api_base', () => ({
  requireCogSeedApiBase: () => 'http://127.0.0.1:59999',
}));

const engagement = await import('../../../../src/main/features/marketplace/engagement-event');
const hubState = await import('../../../../src/main/features/hub_account/state');
const paths = await import('../../../../src/main/paths');

const CONTENT_ID = 'a1b2c3d4e5f6';
const AGENT_ID = 'b2c3d4e5f6a7';

let uidSeq = 0;
let UID = '';
let sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  uidSeq += 1;
  UID = `u_engagement_${uidSeq}`;
  sent = [];
  engagement.setEngagementEventSender((event) => {
    sent.push({ ...event });
    return true;
  });
});

afterEach(() => {
  engagement.setEngagementEventSender(null);
  vi.unstubAllGlobals();
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function writeMarker(dir: string, data: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '_install.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

function landSkill(version = '1.0.0'): string {
  return writeMarker(paths.userMarketplaceSkillDir(UID, CONTENT_ID), {
    version,
    published_at: 1,
    installed_at: Date.now(),
  });
}

function landAgent(agentId = AGENT_ID, version = '1.0.0'): string {
  return writeMarker(paths.userMarketplaceAgentDir(UID, agentId), {
    version,
    published_at: 1,
    installed_at: Date.now(),
  });
}

describe('engagement-event：契约形态与隐私边界', () => {
  it('event_id 是 26 位 Crockford base32 ULID，且每次不同', () => {
    const a = engagement.newEngagementEventId();
    const b = engagement.newEngagementEventId();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a).not.toBe(b);
  });

  it('未登录用本地身份，登录后用 account_id；只发 64 位摘要', () => {
    const local = engagement.engagementActorFor(UID);
    expect(local.actor_kind).toBe('local');
    expect(local.actor_key).toMatch(/^[0-9a-f]{64}$/);
    expect(local.actor_key).not.toContain(UID);

    hubState.writeHubAccountState(UID, { bound: true, account_id: 'cogseed_acc_synthetic' });
    const account = engagement.engagementActorFor(UID);
    expect(account.actor_kind).toBe('account');
    expect(account.actor_key).toMatch(/^[0-9a-f]{64}$/);
    expect(account.actor_key).not.toContain('cogseed_acc_synthetic');
    expect(account.actor_key).not.toBe(local.actor_key);
  });

  it('事件键集合恰好是契约八项', async () => {
    landSkill();
    await engagement.recordSkillActivated(UID, CONTENT_ID, '1.0.0');
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]).sort()).toEqual([...engagement.ENGAGEMENT_EVENT_FIELDS].sort());
    expect(engagement.ENGAGEMENT_EVENT_FIELDS).toHaveLength(8);
  });
});

describe('Skill 安装 / 重新启用', () => {
  it('首次安装成功只发一次；写去重标记后再次调用不重复', async () => {
    const marker = landSkill('1.0.0');
    await engagement.recordSkillActivated(UID, CONTENT_ID, '1.0.0');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      content_id: CONTENT_ID,
      content_type: 'skill',
      event_kind: 'activate',
      version: '1.0.0',
    });
    const after = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
    expect(typeof after.engagement_activate_sent_at).toBe('string');

    await engagement.recordSkillActivated(UID, CONTENT_ID, '1.0.0');
    expect(sent).toHaveLength(1);
  });

  it('传入版本与安装标记不一致时不发（避免把更新当首次安装）', async () => {
    landSkill('1.0.0');
    await engagement.recordSkillActivated(UID, CONTENT_ID, '1.0.1');
    expect(sent).toHaveLength(0);
  });

  it('重新启用每次 false → true 都发一次，但未安装时不发', async () => {
    await engagement.recordSkillEnabled(UID, CONTENT_ID);
    expect(sent).toHaveLength(0);

    landSkill('1.0.0');
    await engagement.recordSkillEnabled(UID, CONTENT_ID);
    await engagement.recordSkillEnabled(UID, CONTENT_ID);
    expect(sent).toHaveLength(2);
    expect(sent.every((event) => event.event_kind === 'activate')).toBe(true);
  });

  it('发送失败时不写去重标记，且不抛错', async () => {
    const marker = landSkill();
    engagement.setEngagementEventSender(() => false);
    await expect(engagement.recordSkillActivated(UID, CONTENT_ID, '1.0.0')).resolves.toBe(false);
    const after = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
    expect(after.engagement_activate_sent_at).toBeUndefined();
  });
});

describe('Agent 会话启动', () => {
  it('只对已安装的 Hub Agent 发一次，同一会话不重复', async () => {
    landAgent(AGENT_ID, '1.0.0');
    const cid = 'c_engagement_1';

    await engagement.recordAgentSessionStarts({
      agentIds: [AGENT_ID, 'ffffffffffff', 'commander'],
      cid,
      userId: UID,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      content_id: AGENT_ID,
      content_type: 'agent',
      event_kind: 'session_start',
      version: '1.0.0',
    });

    await engagement.recordAgentSessionStarts({
      agentIds: [AGENT_ID],
      cid,
      userId: UID,
    });
    expect(sent).toHaveLength(1);
  });

  it('不同会话各自计一次', async () => {
    landAgent(AGENT_ID, '1.0.0');
    await engagement.recordAgentSessionStarts({ agentIds: [AGENT_ID], cid: 'c_engagement_2', userId: UID });
    await engagement.recordAgentSessionStarts({ agentIds: [AGENT_ID], cid: 'c_engagement_3', userId: UID });
    expect(sent).toHaveLength(2);
  });

  it('未安装的 Agent（自定义 / 内置）不发', async () => {
    await engagement.recordAgentSessionStarts({ agentIds: ['custom_agent'], cid: 'c_engagement_4', userId: UID });
    expect(sent).toHaveLength(0);
  });
});

describe('传输层', () => {
  it('POST 到 Hub 端点，不重试；成功响应才返回 true', async () => {
    landSkill();
    engagement.setEngagementEventSender(null);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accepted: true, code: 0 }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    await expect(engagement.recordSkillActivated(UID, CONTENT_ID, '1.0.0')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:59999/marketplace/hub-content/engagement');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('user_id');
    expect(body).not.toHaveProperty('device_id');
    expect(body.actor_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('429 / 5xx 不重试', async () => {
    landSkill();
    engagement.setEngagementEventSender(null);
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ code: 429, error: { code: 'RATE_LIMITED' } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    await expect(engagement.recordSkillActivated(UID, CONTENT_ID, '1.0.0')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
