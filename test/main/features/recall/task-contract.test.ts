import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-task-contract-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('deterministic RecallTaskContract', () => {
  it('extracts multilingual action, bounded query fields, and T-Box anchors without model calls', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const contractModule = await import('../../../../src/main/features/recall/task-contract');
    const group = await groups.createGroup('user-a', 'OAuth 回调安全');
    await groups.appendFieldValue('user-a', group.group!.group_id, '回调验证', '只允许当前项目使用', '手动');

    const contract = await contractModule.buildRecallTaskContract('user-a', {
      purpose: '验证 OAuth 回调安全',
      taskText: 'Verify the OAuth callback 回调验证 redirect target and token exchange; only for the current project.',
      workspaceId: 'workspace-a',
    });

    expect(contract.actionType).toBe('verify');
    expect(contract.tokens).toEqual(expect.arrayContaining(['verify', 'oauth', 'callback']));
    expect(contract.ontologyAnchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ groupId: group.group!.group_id, field: '回调验证' }),
    ]));
    expect(contract.objects.length).toBeLessThanOrEqual(16);
    expect(contract.constraints.length).toBeLessThanOrEqual(12);
    expect(contract.requiredCapabilities.length).toBeLessThanOrEqual(12);
    expect(contract.tokens.length).toBeLessThanOrEqual(64);
  });

  it('recognizes Chinese action types and filters project-scoped R-Box anchors by workspace', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const contractModule = await import('../../../../src/main/features/recall/task-contract');
    const current = await groups.createGroup('user-a', '当前项目规则');
    const other = await groups.createGroup('user-a', '其他项目规则');
    await groups.appendFieldValue('user-a', current.group!.group_id, '映射', 'OAuth → 当前回调', '手动', 'workspace-a');
    await groups.appendFieldValue('user-a', other.group!.group_id, '关系', 'OAuth → 其他回调', '手动', 'workspace-b');

    const contract = await contractModule.buildRecallTaskContract('user-a', {
      purpose: '分析当前项目的 OAuth 回调映射',
      taskText: '分析 OAuth 回调并确认当前回调',
      workspaceId: 'workspace-a',
    });

    expect(contract.actionType).toBe('analyze');
    expect(contract.ontologyAnchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ groupId: current.group!.group_id, field: '映射' }),
    ]));
    expect(contract.ontologyAnchors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ groupId: other.group!.group_id }),
    ]));
  });

  it('does not mutate ontology while extracting a contract from bounded input', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const contractModule = await import('../../../../src/main/features/recall/task-contract');
    const group = await groups.createGroup('user-a', '工作方式');
    await groups.appendFieldValue('user-a', group.group!.group_id, '节奏', '上午专注', '手动');
    const before = await groups.readGroupContent('user-a', group.group!.group_id);
    const longText = `${'必须验证 OAuth 回调。'.repeat(400)} 生成报告`;

    const contract = await contractModule.extractRecallTaskContract('user-a', {
      purpose: '生成验证报告',
      taskText: longText,
      workspaceId: 'workspace-a',
    });

    const after = await groups.readGroupContent('user-a', group.group!.group_id);
    expect(after.content).toBe(before.content);
    expect(contract.objects.length).toBeLessThanOrEqual(16);
    expect(contract.constraints.length).toBeLessThanOrEqual(12);
    expect(contract.requiredCapabilities.length).toBeLessThanOrEqual(12);
  });
});
