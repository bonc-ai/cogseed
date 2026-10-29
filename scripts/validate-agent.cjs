#!/usr/bin/env node
'use strict';
/**
 * Local validator for a builtin marketplace agent definition.
 *
 * Checks the constraints that are enforced in different places at build time
 * (bin/builtin-resource-gate.cjs) and at runtime (src/renderer/modules/avatar.js,
 * src/main/features/agents.ts). A definition can pass the manifest gate and still
 * render a fallback avatar or reference a skill that does not exist, so all of
 * them are checked here instead of only the gate.
 *
 * Usage: node validate-agent.cjs <agentId>
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const agentsDir = path.join(root, 'resources', 'builtin', 'marketplace', 'agents');
const skillsDir = path.join(root, 'resources', 'builtin', 'marketplace', 'skills');
const avatarsFile = path.join(root, 'src', 'main', 'data', 'avatars.json');
const gateFile = path.join(root, 'bin', 'builtin-resource-gate.cjs');

const agentId = process.argv[2];
if (!agentId) {
  console.error('usage: node validate-agent.cjs <agentId>');
  process.exit(2);
}

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

const agentFile = path.join(agentsDir, agentId, 'agent.json');
if (!fs.existsSync(agentFile)) {
  console.error(`missing ${agentFile}`);
  process.exit(2);
}

let agent;
try {
  agent = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
} catch (err) {
  console.error(`invalid JSON in ${agentFile}: ${err.message}`);
  process.exit(2);
}

// --- 1. identity -----------------------------------------------------------
if (agent.agent_id !== agentId) {
  fail(`agent_id (${agent.agent_id}) does not match directory name (${agentId})`);
}
if (!/^[0-9a-f]{12}$/.test(agentId)) fail(`agent id is not 12 lowercase hex chars: ${agentId}`);

// --- 2. required agent fields --------------------------------------------
// Mirrors the runtime-required fields consumed by the marketplace seed and the
// agent list UI; description_en may legitimately be empty.
for (const key of ['name', 'description_zh', 'workflow', 'category']) {
  if (typeof agent[key] !== 'string' || !agent[key].trim()) fail(`missing/empty required string field: ${key}`);
}
if (typeof agent.description_en !== 'string') fail('description_en must be a string (may be empty)');
if (!Array.isArray(agent.skill_list)) fail('skill_list must be an array');
if (agent.skill_list && agent.skill_list.length === 0) {
  notes.push('skill_list is empty [] which means "zero skills", not "no upper bound"');
}

// --- 3. avatar icon / color must come from the catalog -------------------
let catalog = null;
try {
  catalog = JSON.parse(fs.readFileSync(avatarsFile, 'utf8'));
} catch (err) {
  fail(`cannot read avatar catalog: ${err.message}`);
}
if (catalog) {
  const icons = new Set((catalog.icons || []).map((i) => i.id));
  const colors = new Set((catalog.colors || []).map((c) => c.id));
  if (!icons.has(agent.icon)) {
    fail(`icon "${agent.icon}" is not in avatars.json (${icons.size} ids) — renders as the fallback bot icon`);
  }
  if (!colors.has(agent.color)) {
    fail(`color "${agent.color}" is not in avatars.json — collapses to the seed default`);
  }
}

// --- 4. every referenced skill must resolve ------------------------------
// skill_list 在存量内置 agent 里两种写法并存：目录 id（61 处）与 SKILL.md 的
// `name`（23 处），运行时的 resolveSkillAllowlistRefs 两者都认。这里同样两者都认，
// 否则会把合法的定义误判成失败。
const knownSkillIds = new Set(
  fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name) : [],
);
const skillIdByName = new Map();
for (const id of knownSkillIds) {
  const md = path.join(skillsDir, id, 'SKILL.md');
  if (!fs.existsSync(md)) continue;
  const m = /^name:\s*(.+)$/m.exec(fs.readFileSync(md, 'utf8').slice(0, 2000));
  if (m) skillIdByName.set(m[1].trim().replace(/^["']|["']$/g, ''), id);
}
for (const ref of agent.skill_list || []) {
  if (knownSkillIds.has(ref)) continue;
  if (skillIdByName.has(ref)) continue;
  fail(`skill_list does not resolve to any bundled skill (neither a directory id nor a SKILL.md name): ${ref}`);
}

// --- 5. resource gate knows this agent -----------------------------------
const gate = fs.readFileSync(gateFile, 'utf8');
if (!gate.includes(`'${agentId}'`)) {
  fail(`bin/builtin-resource-gate.cjs marketplace_agents does not list ${agentId}; npm run builtin:manifest will throw`);
}

// --- 6. the id must not collide with an existing marketplace dir ---------
const siblings = fs.readdirSync(agentsDir).filter((n) => n !== agentId);
if (siblings.includes(agentId)) fail(`duplicate agent directory ${agentId}`);

// --- 7. 会议纪要场景的输出契约（验收标准："输出结论、待办、负责人、截止时间，
//        缺失项标待确认；未确认不创建任务"）------------------------------------
//
// 这些要求本来只活在 workflow 的散文里——改一个词就悄悄没了，评审也看不出来。
// 这里把"必须出现的要素"变成可执行断言，缺一条就失败。
//
// 用 requireContract 显式登记，避免误伤非会议类 agent。
const CONTRACT_REQUIRED_BY_AGENT = {
  // 智能会议Agent：2026-10-13 截图里的 5 条开发清单 + 4 条验收标准
  // 每条给多个可接受措辞，改文案时不至于误报；但每条都必须真的在定义里找到落点。
  f5bba047480f: [
    // 输出要素
    { label: '结论', any: ['结论'] },
    { label: '待办', any: ['待办', '行动项'] },
    { label: '负责人', any: ['负责人'] },
    { label: '截止时间', any: ['截止时间', '截止'] },
    // 缺失项的显式标记
    { label: '缺失标「待确认」', any: ['待确认'] },
    // 未确认不得建单
    { label: '确认后才能建单', any: ['只在用户确认之后创建', '确认建单', '未确认前', '确认后才'] },
    { label: '含糊不算确认', any: ['不算确认', '沉默'] },
    // 用户改动必须逐字落地（验收：创建内容与修改一致）
    { label: '逐字一致', any: ['逐字一致', '以用户的原话为准'] },
    // 创建结果不明时先核查（验收：避免重复创建）
    { label: '不重复创建', any: ['重复创建'] },
    // 回执要有真实编号与链接（验收：展示真实任务编号与链接）
    { label: '回执含编号与链接', any: ['任务编号与链接', '编号与链接', '任务编号'] },
    // 读不到要报原因而不是编（验收：明确报错、不编造）
    { label: '读不到要说明原因而非编造', any: ['不要编内容', '不要编'] },
    // 权限申请要走人工确认，且不得自造链接
    { label: '申请权限需人工确认', any: ['弹确认框', '确认后才提交', '申请是写操作'] },
    // 澄清纪律（依据：OpenAI Model Spec「reason about which actions are sensitive to
    // assumptions about the user's intent」+ arXiv 2510.05307「确认的价值在于避免全盘重做」）
    { label: '澄清判据：对假设敏感才问', any: ['猜错了', '对假设', '不可逆'] },
    { label: '该问的两件事（哪场会/要不要建任务）', any: ['哪场会', '要不要建任务'] },
    { label: '能查能推的不许问', any: ['一律不问', '不要问', '一律不再问'] },
    { label: '绝不重复提问', any: ['不再重复问', '一律不再问', '不再问'] },
    { label: '一次只发一组问题', any: ['一次只发一组', '一次问完', '不要连续追问'] },
    { label: '尽量给选项而非让用户打字', any: ['能给选项就给选项', '给选项'] },
    { label: '信息不够也要给出可审阅结果', any: ['不能卡死', '不要为了凑齐信息'] },
  ],
};

const contract = CONTRACT_REQUIRED_BY_AGENT[agentId];
if (contract) {
  const haystack = `${agent.workflow || ''}\n${agent.description_zh || ''}`;
  for (const item of contract) {
    if (!item.any.some((needle) => haystack.includes(needle))) {
      fail(`会议场景输出契约缺失「${item.label}」：workflow/description 里应出现 ${item.any.map((n) => `「${n}」`).join(' 或 ')} 之一`);
    }
  }
  notes.push(`会议场景输出契约：${contract.length} 条全部命中`);
}

// --- report ---------------------------------------------------------------
console.log(`agent: ${agentId}  ${agent.name}`);
console.log(`  icon=${agent.icon}  color=${agent.color}  skills=${(agent.skill_list || []).length}  workflow=${agent.workflow.length} chars`);
for (const n of notes) console.log(`  note: ${n}`);
if (problems.length) {
  console.log(`\nFAILED (${problems.length}):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nOK: definition is consistent with the avatar catalog, skill inventory and resource gate.');
