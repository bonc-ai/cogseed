/** 已退役的私有技能合并函数、调用点和恒真守卫不得恢复；未注册的
 * skills.listPrivate 通道保持不可调用，仍有效的技能读取与过滤契约保留。 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.join(__dirname, '../..');

/** 源文件可能被并发编辑。连续两次读取一致才采纳，不一致时退避 10ms
 * 后重读；达到上限使用最后一次内容，仍由下方契约断言判断结果。 */
function readStabFile(absPath: string, attempts = 6): string {
  let prev = fs.readFileSync(absPath, 'utf8');
  for (let i = 1; i < attempts; i++) {
    const next = fs.readFileSync(absPath, 'utf8');
    if (next === prev) return next;
    prev = next;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return prev;
}

function read(p: string): string {
  return readStabFile(path.join(repoRoot, p));
}

/** 主进程全部通道注册键（分文件字典键 + index.ts 键 + ipcMain.handle 直注）。 */
function mainRegisteredChannels(): Set<string> {
  const keys = new Set<string>();
  const ipcDir = path.join(repoRoot, 'src/main/ipc');
  for (const file of fs.readdirSync(ipcDir).filter((f) => f.endsWith('.ts'))) {
    const text = readStabFile(path.join(ipcDir, file));
    for (const m of text.matchAll(/^\s+'([a-zA-Z0-9_.]+)':/gm)) keys.add(m[1]);
  }
  // ipcMain.handle 直注（preload 直通形态，如 cogseed.relaunch）
  const mainIndex = read('src/main/index.ts');
  for (const m of mainIndex.matchAll(/ipcMain\.handle\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  return keys;
}

describe('skills.listPrivate：渲染调用零注册 + 恒真守卫死代码', () => {
  // 私有技能合并函数、invoke、恒真守卫及配套服务导出均已退役，不能部分恢复。
  it('主靶：死函数/死调用/恒真守卫零残留，通道保持零注册', () => {
    const skills = read('src/renderer/modules/skills.js');
    // ① 渲染层不再有该调用（死函数已删；注释里的历史说明不算残留，锚定
    // 函数定义与调用语法）
    expect(skills).not.toContain("invoke('skills.listPrivate')");
    expect(skills).not.toContain('async function _mergeAgentPrivateSkills');
    expect(skills).not.toContain('await _mergeAgentPrivateSkills');
    // ② 恒真守卫指纹在代码行不复存在（剥离 // 注释行再匹配——历史说明
    // 注释允许引用该指纹）
    const codeLines = skills.split('\n').filter((line) => !line.trim().startsWith('//'));
    expect(codeLines.join('\n')).not.toMatch(/\|\| !false \|\|/);
    // ③ 主进程全部注册源仍无该键（通道从未注册，保持零注册）
    const registered = mainRegisteredChannels();
    expect(registered.has('skills.listPrivate')).toBe(false);
    // 主进程配套服务函数不再导出。
    const skillsService = read('src/main/features/skills.ts');
    expect(skillsService).not.toContain('export async function listAgentPrivateSkills');
    // 渲染防御分支保留：listSkills 排除 ownerAgent，分组分支防未来泄漏
    expect(skills).toContain("if (s.ownerAgent) { groups.private.push(s); continue; }");
  });

  it('对照组：真实注册的 skills.list / skills.read 在注册集合内（扫描口径有效非漏扫）', () => {
    const registered = mainRegisteredChannels();
    expect(registered.has('skills.list')).toBe(true);
    expect(registered.has('skills.read')).toBe(true);
    expect(registered.has('projects.list')).toBe(false); // 另一个已退役通道同样不在注册集合中。
  });
});
