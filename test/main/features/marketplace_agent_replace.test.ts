/**
 * 更新已装 Agent：失败必须保留旧版（产品 2026-10-13）。
 * 用真实临时目录——要测的正是"盘上还剩什么"。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_BACKUP_PREFIX, agentIdFromBackupName, beginAgentReplace, recoverInterruptedAgentReplaces,
} from '../../../src/main/features/marketplace_agent_replace';

let agents: string;
const write = (rel: string, content: string): void => {
  const f = path.join(agents, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content);
};
const read = (rel: string): string => fs.readFileSync(path.join(agents, rel), 'utf8');
const names = (): string[] => fs.readdirSync(agents).sort();

beforeEach(() => { agents = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-replace-')); });
afterEach(() => { fs.rmSync(agents, { recursive: true, force: true }); });

const installOld = (): void => {
  write('abc/agent.json', '{"v":"old"}');
  write('abc/skills/ocr/SKILL.md', 'old skill');
  write('abc/_install.json', '{"version":"1.0.0"}');
};

describe('更新已装 Agent', () => {
  it('成功：新版本在原路径，备份被清掉，列表里不留残留', async () => {
    installOld();
    const target = path.join(agents, 'abc');
    const replace = await beginAgentReplace(target, 'abc');
    expect(replace.hadPrevious).toBe(true);
    // 备份期间旧目录不在原路径，写新版本不会混进旧文件
    expect(fs.existsSync(target)).toBe(false);
    write('abc/agent.json', '{"v":"new"}');
    write('abc/_install.json', '{"version":"2.0.0"}');
    await replace.commit();

    expect(read('abc/agent.json')).toBe('{"v":"new"}');
    expect(fs.existsSync(path.join(agents, 'abc/skills/ocr'))).toBe(false); // 旧版的随包 Skill 没混进来
    expect(names()).toEqual(['abc']);
  });

  it('失败：写了一半的新版本被删掉，旧版连同随包 Skill 原样换回', async () => {
    installOld();
    const target = path.join(agents, 'abc');
    const replace = await beginAgentReplace(target, 'abc');
    write('abc/agent.json', '{"v":"half-written"}');
    write('abc/skills/evil/SKILL.md', 'rejected by the scan');
    await replace.rollback();

    expect(read('abc/agent.json')).toBe('{"v":"old"}');
    expect(read('abc/skills/ocr/SKILL.md')).toBe('old skill');
    expect(fs.existsSync(path.join(agents, 'abc/skills/evil'))).toBe(false);
    expect(read('abc/_install.json')).toBe('{"version":"1.0.0"}');
    expect(names()).toEqual(['abc']);
  });

  it('失败时新目录还没建出来也不出错，旧版照样回来', async () => {
    installOld();
    const replace = await beginAgentReplace(path.join(agents, 'abc'), 'abc');
    await replace.rollback();
    expect(read('abc/agent.json')).toBe('{"v":"old"}');
  });

  it('提交与回滚都只生效一次：提交后再回滚不会把已提交的新版换掉', async () => {
    installOld();
    const replace = await beginAgentReplace(path.join(agents, 'abc'), 'abc');
    write('abc/agent.json', '{"v":"new"}');
    await replace.commit();
    await replace.rollback();
    expect(read('abc/agent.json')).toBe('{"v":"new"}');
  });
});

describe('全新安装', () => {
  it('没有旧版：hadPrevious 为 false；失败只清掉残留，不留任何东西', async () => {
    const target = path.join(agents, 'fresh');
    const replace = await beginAgentReplace(target, 'fresh');
    expect(replace.hadPrevious).toBe(false);
    write('fresh/agent.json', 'partial');
    await replace.rollback();
    expect(names()).toEqual([]);
  });

  it('成功提交后目录保留', async () => {
    const replace = await beginAgentReplace(path.join(agents, 'fresh'), 'fresh');
    write('fresh/agent.json', 'ok');
    await replace.commit();
    expect(read('fresh/agent.json')).toBe('ok');
  });
});

describe('备份目录的名字', () => {
  it('点号前缀，Agent 列表看不到；能还原出是谁的备份', async () => {
    installOld();
    await beginAgentReplace(path.join(agents, 'abc'), 'abc');
    const backup = names().find((n) => n.startsWith(AGENT_BACKUP_PREFIX));
    expect(backup).toBeDefined();
    expect(backup!.startsWith('.')).toBe(true);
    expect(agentIdFromBackupName(backup!)).toBe('abc');
  });

  it('认不出的名字返回 null', () => {
    expect(agentIdFromBackupName('abc')).toBeNull();
    expect(agentIdFromBackupName('.prev-abc')).toBeNull();
    expect(agentIdFromBackupName('.prev-abc-zzzz')).toBeNull();
    expect(agentIdFromBackupName('.staging-abc-12345678')).toBeNull();
    expect(agentIdFromBackupName('.prev-my-agent-id-0a1b2c3d')).toBe('my-agent-id');
  });
});

describe('启动时善后被中断的更新', () => {
  const crashMidUpdate = async (writeNew: boolean, complete: boolean): Promise<void> => {
    installOld();
    await beginAgentReplace(path.join(agents, 'abc'), 'abc'); // 然后"进程被杀"：不提交也不回滚
    if (writeNew) {
      write('abc/agent.json', '{"v":"new"}');
      if (complete) write('abc/_install.json', '{"version":"2.0.0"}');
    }
  };

  it('新目录缺失（刚改名就被杀）→ 旧版换回', async () => {
    await crashMidUpdate(false, false);
    expect(recoverInterruptedAgentReplaces(agents)).toEqual(['abc']);
    expect(read('abc/agent.json')).toBe('{"v":"old"}');
    expect(names()).toEqual(['abc']);
  });

  it('新目录写了一半（没有成功标记）→ 删掉半成品，旧版换回', async () => {
    await crashMidUpdate(true, false);
    expect(recoverInterruptedAgentReplaces(agents)).toEqual(['abc']);
    expect(read('abc/agent.json')).toBe('{"v":"old"}');
    expect(read('abc/skills/ocr/SKILL.md')).toBe('old skill');
    expect(names()).toEqual(['abc']);
  });

  it('新目录是完整安装（只是没来得及删备份）→ 保留新版，备份只是残留，删掉', async () => {
    await crashMidUpdate(true, true);
    expect(recoverInterruptedAgentReplaces(agents)).toEqual([]);
    expect(read('abc/agent.json')).toBe('{"v":"new"}');
    expect(names()).toEqual(['abc']);
  });

  it('备份自己就不是一份可用安装 → 不换回，删掉', async () => {
    fs.mkdirSync(path.join(agents, `${AGENT_BACKUP_PREFIX}abc-0a1b2c3d`, 'junk'), { recursive: true });
    expect(recoverInterruptedAgentReplaces(agents)).toEqual([]);
    expect(names()).toEqual([]);
  });

  it('名字认不出是谁的备份 → 不猜，删掉', () => {
    write(`${AGENT_BACKUP_PREFIX}weird/agent.json`, '{}');
    expect(recoverInterruptedAgentReplaces(agents)).toEqual([]);
    expect(names()).toEqual([]);
  });

  it('不碰正常的 Agent 目录与别的点号前缀目录；目录不存在不报错', async () => {
    installOld();
    write('.staging-keep/agent.json', '{}');
    expect(recoverInterruptedAgentReplaces(agents)).toEqual([]);
    expect(names()).toEqual(['.staging-keep', 'abc']);
    expect(recoverInterruptedAgentReplaces(path.join(agents, 'nope'))).toEqual([]);
  });
});
