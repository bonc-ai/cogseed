/**
 * 正文一等规范（2026-09-29 子安拍板）：
 *   ① 判定四项（空/超长/会话残留/规则偏好类路径）按类型分级；
 *   ② 晋升正文＝judgment 单一来源（value 不再拼入）；
 *   ③ 候选读回带 statementIssues（警示不拦截）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { recallStatementIssues, recallStatementWarning, ABILITY_ASSET_STATEMENT_HARD_MAX } from '../../../../src/main/features/recall/statement-policy';

describe('statement-policy 判定', () => {
  it('空正文', () => {
    expect(recallStatementIssues({ statement: '  ', type: 'rule' })).toEqual(['empty']);
  });

  it('超长按硬限 200（rule/personal/fact 同限）', () => {
    const long = 'A'.repeat(ABILITY_ASSET_STATEMENT_HARD_MAX + 1);
    expect(recallStatementIssues({ statement: long, type: 'rule' })).toContain('too_long');
    const ok = 'B'.repeat(ABILITY_ASSET_STATEMENT_HARD_MAX);
    expect(recallStatementIssues({ statement: ok, type: 'fact' })).toEqual([]);
  });

  it('会话残留：cid/turn 号与 16 位 hex 会话号', () => {
    expect(recallStatementIssues({ statement: '排查见 cid=abc1234567 的记录。', type: 'fact' })).toContain('session_debris');
    expect(recallStatementIssues({ statement: 'B'.repeat(200), type: 'fact' })).not.toContain('session_debris');
    expect(recallStatementIssues({ statement: '在会话 f48ee2fc19a4b2c3 中确认。', type: 'rule' })).toContain('session_debris');
    // 普通内容不误伤
    expect(recallStatementIssues({ statement: '周报先给结论，再给分层依据。', type: 'rule' })).toEqual([]);
  });

  it('路径分级：rule/personal 拦、fact 豁免', () => {
    const path = '日志在 /Users/an/.cogseed/data/logs/ 下。';
    expect(recallStatementIssues({ statement: path, type: 'rule' })).toContain('local_path');
    expect(recallStatementIssues({ statement: path, type: 'personal' })).toContain('local_path');
    expect(recallStatementIssues({ statement: path, type: 'fact' })).not.toContain('local_path');
    // 源码文件名同样按类型拦
    expect(recallStatementIssues({ statement: '见 candidate-service.ts 的实现。', type: 'rule' })).toContain('local_path');
  });

  it('警示文案拼装：多问题并列、合规返回 undefined', () => {
    expect(recallStatementWarning({ statement: '见 /Users/an/x 的 turn-abc1234567。', type: 'rule' })).toContain('；');
    expect(recallStatementWarning({ statement: '周报先给结论。', type: 'rule' })).toBeUndefined();
  });
});

describe('晋升正文＝judgment 单一来源（value 不拼入）', () => {
  let tmpDir: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-stmt-policy-'));
    previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
    process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  });
  afterEach(() => {
    if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
    else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('有 value 的候选晋升后正文不含 value 段，且读回带 statementIssues 派生', async () => {
    const { saveRecallCandidate, promoteRecallCandidate, readRecallCandidate } = await import('../../../../src/main/features/recall/candidate-service');
    const uid = 'user-stmt';
    const candidate = await saveRecallCandidate(uid, {
      judgment: '汇报先给一句话结论，读者要细节再看分层依据。',
      value: '这样能省读者的时间，也避免结论被长文淹没。',
      summary: '周报汇报骨架规则',
      suggestedType: 'rule', suggestedScope: 'report', suggestedAction: 'create',
      applicableWhen: ['写汇报'], forbiddenWhen: ['闲聊'],
      sourceRefs: [{ kind: 'conversation', id: 'conv-stmt-1' }],
    });
    expect(candidate.statementIssues).toBeUndefined(); // 合规正文无警示
    const promoted = await promoteRecallCandidate(uid, candidate.id, { actor: 'user' });
    expect(promoted.asset.statement).toBe('汇报先给一句话结论，读者要细节再看分层依据。');
    expect(promoted.asset.statement).not.toContain('省读者的时间');
  });

  it('超长正文候选读回带 too_long 警示（不拦截，保存仍成功）', async () => {
    const { saveRecallCandidate } = await import('../../../../src/main/features/recall/candidate-service');
    const uid = 'user-stmt2';
    const candidate = await saveRecallCandidate(uid, {
      judgment: 'X'.repeat(220) + '。',
      summary: '超长正文样本',
      suggestedType: 'fact', suggestedScope: 'general', suggestedAction: 'create',
      sourceRefs: [{ kind: 'conversation', id: 'conv-stmt-2' }],
    });
    expect(candidate.status).toBe('pending_review'); // 警示不拦截
    expect(candidate.statementIssues).toContain('too_long');
  });
});
