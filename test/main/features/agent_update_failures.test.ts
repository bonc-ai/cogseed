/**
 * 已装 Agent 更新失败的记录：只存原因代码、版本追上后不再提示、读坏了也不影响启动。
 * 路径指向真实临时目录。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
vi.mock('../../../src/main/paths', () => ({
  userMarketplaceDir: (uid: string) => path.join(root, uid, 'marketplace'),
}));

import {
  activeUpdateFailure, classifyUpdateFailure, clearAgentUpdateFailure, readAgentUpdateFailures, recordAgentUpdateFailure,
} from '../../../src/main/features/agent_update_failures';

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-update-failures-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('classifyUpdateFailure：只给原因代码，不带原文', () => {
  it.each([
    ['agent abc requires CogSeed >= 1.4.0 (current 1.3.0)', 'app_too_old'],
    ['agent abc needs the built-in capability builtin:coding, which this client does not provide', 'builtin_unavailable'],
    ['dependency skill 9b27f4a1c0e6 is not approved (disabled)', 'dependency_disabled'],
    ['CONTENT_NOT_FOUND: 5e1c8a02d9b3', 'dependency_missing'],
    ['agent x: DIGEST_MISMATCH: expected aaa, got bbb', 'package_invalid'],
    ['SIZE_MISMATCH: expected 10, got 9', 'package_invalid'],
    ['AGENT_PACKAGE_MISSING_FILE: _meta.json is missing', 'package_invalid'],
    ['HTTP 503', 'network'],
    ['request timed out after 30s', 'network'],
    ['something nobody planned for /Users/secret/path', 'unknown'],
  ])('%s → %s', (message, reason) => {
    expect(classifyUpdateFailure(new Error(message))).toBe(reason);
  });

  it('不是 Error 的值也不抛错', () => {
    expect(classifyUpdateFailure(undefined)).toBe('unknown');
    expect(classifyUpdateFailure('requires CogSeed >= 2')).toBe('app_too_old');
  });
});

describe('记录与读取', () => {
  it('记下后能读到；原因代码而不是报错原文', () => {
    recordAgentUpdateFailure('u1', 'agent1', { targetVersion: '2.0.0', reason: 'dependency_disabled' });
    const map = readAgentUpdateFailures('u1');
    expect(map.agent1).toMatchObject({ target_version: '2.0.0', reason: 'dependency_disabled' });
    expect(typeof map.agent1.at).toBe('number');
    const raw = fs.readFileSync(path.join(root, 'u1', 'marketplace', '_agent_update_failures.json'), 'utf8');
    expect(raw).not.toContain('/Users');
  });

  it('同一个 Agent 再失败一次是覆盖，别的 Agent 的不受影响', () => {
    recordAgentUpdateFailure('u1', 'a', { targetVersion: '2.0.0', reason: 'network' });
    recordAgentUpdateFailure('u1', 'b', { targetVersion: '3.0.0', reason: 'unknown' });
    recordAgentUpdateFailure('u1', 'a', { targetVersion: '2.1.0', reason: 'app_too_old' });
    const map = readAgentUpdateFailures('u1');
    expect(map.a).toMatchObject({ target_version: '2.1.0', reason: 'app_too_old' });
    expect(map.b.target_version).toBe('3.0.0');
  });

  it('清除后读不到；清光了连文件都不留；清不存在的不报错', () => {
    recordAgentUpdateFailure('u1', 'a', { targetVersion: '2.0.0', reason: 'network' });
    clearAgentUpdateFailure('u1', 'a');
    expect(readAgentUpdateFailures('u1')).toEqual({});
    expect(fs.existsSync(path.join(root, 'u1', 'marketplace', '_agent_update_failures.json'))).toBe(false);
    expect(() => clearAgentUpdateFailure('u1', 'nope')).not.toThrow();
  });

  it('账号之间互不可见', () => {
    recordAgentUpdateFailure('u1', 'a', { targetVersion: '2.0.0', reason: 'network' });
    expect(readAgentUpdateFailures('u2')).toEqual({});
  });

  it('文件损坏或形态不对：当作没有，不抛错', () => {
    const file = path.join(root, 'u1', 'marketplace', '_agent_update_failures.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(readAgentUpdateFailures('u1')).toEqual({});
    fs.writeFileSync(file, JSON.stringify(['array']));
    expect(readAgentUpdateFailures('u1')).toEqual({});
    fs.writeFileSync(file, JSON.stringify({ good: { target_version: '2.0.0', at: 1, reason: 'network' }, bad: { target_version: 5 } }));
    expect(Object.keys(readAgentUpdateFailures('u1'))).toEqual(['good']);
  });
});

describe('activeUpdateFailure：现在还算数吗', () => {
  const failures = { a: { target_version: '2.0.0', at: 1, reason: 'network' as const } };

  it('本机版本低于没能更新到的版本 → 算数', () => {
    expect(activeUpdateFailure(failures, 'a', '1.0.0')).toEqual(failures.a);
  });

  it('本机版本已追上或超过 → 不再提示', () => {
    expect(activeUpdateFailure(failures, 'a', '2.0.0')).toBeNull();
    expect(activeUpdateFailure(failures, 'a', '2.1.0')).toBeNull();
  });

  it('没有记录 → null；本机版本未知 → 仍提示（宁可多提示一次）', () => {
    expect(activeUpdateFailure(failures, 'other', '1.0.0')).toBeNull();
    expect(activeUpdateFailure(failures, 'a', undefined)).toEqual(failures.a);
  });
});
