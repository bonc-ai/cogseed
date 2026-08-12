/** 把能力包导出成可以交给外部执行端的两份文件（接入方案 L0 档）。
 *
 *  **为什么需要 L0，而且它不是"临时凑合"。** L1（本地 MCP + 目标端 Skill）需要
 *  对方客户端支持自定义 MCP、能装 Bridge Skill、能固定「先读 Context 再提交
 *  Action Plan」的顺序——这些都得在真实客户端上做 Spike 才知道。L0 一个都不依赖：
 *  导出两个文件，用户自己放进对方的项目里。它对任何外部执行端都成立，
 *  也是 L1 谈不拢时唯一还站得住的交付形态。
 *
 *  **两份文件各有各的读者，不能合并成一份：**
 *
 *  - `manifest.json` —— 机器读。带 `contentHash`，对方可以核对自己拿到的是不是
 *    这一份；带资产版本，回执才说得清「当时用的是第几版」。
 *  - `context-pack.md` —— 人读。用户要能在交出去之前自己看一眼「这次带了什么、
 *    什么没带、为什么没带」。最小投影如果只有机器可读，用户就无从复核，
 *    等于把外发内容变成黑箱。
 *
 *  **导出不等于已接入。** 接入方案 4.1 写死了对外主张纪律：文件复制、界面跳转
 *  都不构成跨 Agent 传递证明。这里只产出文件，不写任何 ContextReuseReceipt——
 *  回执要等目标端真的读取并回传相同 hash 才算数。把导出记成"已复用"会让
 *  「复用了几次」这个数字凭空变大，而履历页正是靠它。
 */

import * as path from 'node:path';

import { writeJson } from '../../storage';
import { assertPackIntegrity, isPackExpired, type DeliveryCapabilityPack } from './capability-pack-delivery';

export interface CapabilityPackExportFiles {
  manifestPath: string;
  contextPackPath: string;
}

/** 排除原因的用户可读说法。键与 `PackExclusionReason` 一一对应——
 *  导出的文件是给人看的，`status_not_active` 这种内部枚举不该出现在里面。 */
const EXCLUSION_LABEL: Record<string, string> = {
  status_not_active: '当前未生效',
  revoked: '已撤销',
  scope_mismatch: '作用域不匹配',
  forbidden_here: '命中禁用条件',
  not_for_this_agent: '未授权给这个执行端',
  missing_evidence: '缺少来源证据',
  superseded: '已被更新的条目取代',
  user_excluded: '你手动移除',
};

function renderConditions(label: string, values?: string[]): string {
  if (!values?.length) return '';
  return `\n  - ${label}：${values.join('；')}`;
}

/** 人读版能力包。刻意不写 `assetId` 之外的内部字段名——这份是给用户和对方
 *  执行端的人看的，statementHash 那类校验数据留在 manifest 里。 */
export function renderContextPackMarkdown(pack: DeliveryCapabilityPack): string {
  const lines: string[] = [
    `# 能力包 ${pack.packId}`,
    '',
    `- 用途：${pack.purpose}`,
    `- 交给：${pack.targetAgent}`,
    `- 冻结于：${pack.frozenAt}`,
    `- 有效至：${pack.expiresAt}`,
    `- 内容校验值：\`${pack.contentHash}\``,
    '',
    '> 这份包在冻结那一刻定稿。此后原始资产即使被修改或撤销，这里的内容也不会变——',
    '> 回执要能说清「当时用的是第几版」。',
    '',
    `## 带入的判断（${pack.assets.length} 条）`,
    '',
  ];

  if (!pack.assets.length) {
    lines.push('（这次没有带入任何判断。）', '');
  } else {
    for (const ref of pack.assets) {
      lines.push(
        `### ${ref.title}`,
        '',
        ref.statement,
        '',
        `- 版本：第 ${ref.version} 版`,
        `- 作用域：${ref.scope}`
        + renderConditions('适用', ref.applicableWhen)
        + renderConditions('禁用', ref.forbiddenWhen),
        `- 标识：\`${ref.assetId}\``,
        '',
      );
    }
  }

  lines.push(`## 未带入（${pack.excluded.length} 条）`, '');
  if (!pack.excluded.length) {
    lines.push('（没有被排除的条目。）', '');
  } else {
    // 排除项必须带原因：最小投影如果不解释自己扣了什么，就成了黑箱。
    for (const entry of pack.excluded) {
      const reason = entry.detail || EXCLUSION_LABEL[entry.reason] || entry.reason;
      lines.push(`- \`${entry.assetId}\` —— ${reason}`);
    }
    lines.push('');
  }

  lines.push(
    '## 给接收方',
    '',
    '- 这份包只包含上面列出的内容，没有夹带其它个人数据。',
    `- 带出的字段范围：${pack.fieldScope.join('、')}。`,
    '- 请按「先读完本文件、再提交执行计划」的顺序使用。',
    `- 收到后请回传内容校验值 \`${pack.contentHash}\`，否则无法确认你读到的是这一份。`,
    '',
  );

  return lines.join('\n');
}

/**
 * 导出能力包到指定目录。
 *
 * 导出前强制校验完整性与有效期：一份内容对不上自己哈希、或者已经过期的包
 * 不该被交出去——对方拿到之后没有任何办法发现这件事。
 */
export async function exportCapabilityPack(
  pack: DeliveryCapabilityPack,
  targetDir: string,
  now: string | number = Date.now(),
): Promise<CapabilityPackExportFiles> {
  assertPackIntegrity(pack);
  if (isPackExpired(pack, now)) {
    throw new Error('capability pack has expired and must not be exported');
  }

  const manifestPath = path.join(targetDir, `${pack.packId}.manifest.json`);
  const contextPackPath = path.join(targetDir, `${pack.packId}.context-pack.md`);

  await writeJson(manifestPath, pack);
  // writeJson 建好了目录，这里可以直接写第二份。
  const fs = await import('node:fs/promises');
  await fs.writeFile(contextPackPath, renderContextPackMarkdown(pack), 'utf8');

  return { manifestPath, contextPackPath };
}
