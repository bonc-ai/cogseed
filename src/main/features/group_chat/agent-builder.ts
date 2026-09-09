/**
 * Agent 创建师 — host 白名单内的内置智能体可通过 `<agent>` 容器直接
 * 新建 AI 团队智能体（仅新建，不支持编辑）。
 *
 * 背景：`bus.ts` 的 `<agent>` 容器应用目前只开放给 commander。本模块给
 * 指定内置智能体（如「Agent 创建师」）一个受控的创建入口，复用
 * `agents.ts` 的容器解析与 `createAgentFromBlocks` 服务端校验。
 *
 * 安全边界：
 * - 白名单是 host 常量，模型不可写；
 * - 只放开新建（无 `<agent_id>`）；带 `<agent_id>` 的容器直接拒绝；
 * - 创建仍走 `createAgentFromBlocks` 的既有校验（name/workflow 必填、
 *   charset、category、inputs、skill_list）。
 */

import {
  extractAgentFieldBlocks,
  createAgentFromBlocks,
  type ExtractedFields,
} from "../agents";

/** 允许通过 `<agent>` 容器直接创建智能体的内置智能体 id（host 白名单）。 */
export const AGENT_BUILDER_IDS: ReadonlySet<string> = new Set([
  // Agent 创建师（内置 marketplace agent）
  "287ce6012204",
]);

export interface ApplyAgentBuilderContainersInput {
  uid: string;
  cid?: string;
  turnProjectId?: string;
  turnSpaceId?: string;
  agentId: string;
  workingText: string;
}

export interface ApplyAgentBuilderContainersResult {
  /** 剥离 `<agent>` 容器后的展示文本。 */
  cleanText: string;
  /** 成功创建的新智能体。 */
  created: Array<{ agent_id: string; name: string }>;
  /** 用户可见的拒绝原因（中文）。 */
  rejected: string[];
}

export interface ApplyAgentBuilderContainersDeps {
  extractBlocks?: typeof extractAgentFieldBlocks;
  createFromBlocks?: typeof createAgentFromBlocks;
  addSpaceResource?: (
    uid: string,
    sid: string,
    kind: string,
    id: string,
  ) => Promise<unknown>;
}

function inheritanceContext(input: ApplyAgentBuilderContainersInput) {
  return {
    userId: input.uid,
    ...(input.cid ? { conversationId: input.cid } : {}),
    ...(input.turnProjectId ? { projectId: input.turnProjectId } : {}),
  };
}

export interface ApplyAgentBuilderFieldsInput {
  uid: string;
  cid?: string;
  turnProjectId?: string;
  turnSpaceId?: string;
  agentId: string;
}

export interface ApplyAgentBuilderFieldsResult {
  created: Array<{ agent_id: string; name: string }>;
  rejected: string[];
}

/** Apply one direct-mode builder block. Governed mode is deliberately routed
 * by the host orchestration state machine instead of this immediate mutation
 * helper. */
export async function applyAgentBuilderFields(
  input: ApplyAgentBuilderFieldsInput,
  fields: ExtractedFields,
  deps: ApplyAgentBuilderContainersDeps = {},
): Promise<ApplyAgentBuilderFieldsResult> {
  if (fields.agent_id) {
    return {
      created: [],
      rejected: ["Agent 创建师只支持新建智能体，不支持编辑已有智能体。"],
    };
  }
  if (fields.tools?.length || fields.skill_list?.length) {
    return {
      created: [],
      rejected: [
        "包含工具或 Skill 权限的智能体必须走治理创建，请将 mode 设为 governed。",
      ],
    };
  }
  try {
    const createFromBlocks = deps.createFromBlocks ?? createAgentFromBlocks;
    const agent = await createFromBlocks(
      input.uid,
      fields,
      inheritanceContext({ ...input, workingText: "" }),
    );
    if (!agent)
      return {
        created: [],
        rejected: ["Agent 创建失败：缺少必填字段（name / workflow）。"],
      };
    if (input.turnSpaceId && deps.addSpaceResource) {
      try {
        await deps.addSpaceResource(
          input.uid,
          input.turnSpaceId,
          "agent",
          agent.agent_id,
        );
      } catch (err) {
        return {
          created: [{ agent_id: agent.agent_id, name: agent.name }],
          rejected: [
            `新智能体已创建，但加入当前空间失败：${(err as Error).message}`,
          ],
        };
      }
    }
    return {
      created: [{ agent_id: agent.agent_id, name: agent.name }],
      rejected: [],
    };
  } catch (err) {
    return {
      created: [],
      rejected: [`Agent 创建失败：${(err as Error).message}`],
    };
  }
}

export async function applyAgentBuilderContainers(
  input: ApplyAgentBuilderContainersInput,
  deps: ApplyAgentBuilderContainersDeps = {},
): Promise<ApplyAgentBuilderContainersResult> {
  if (!AGENT_BUILDER_IDS.has(input.agentId)) {
    return { cleanText: input.workingText, created: [], rejected: [] };
  }
  const extractBlocks = deps.extractBlocks ?? extractAgentFieldBlocks;
  const parsed = extractBlocks(input.workingText);
  if (!parsed.blocks.length) {
    return { cleanText: input.workingText, created: [], rejected: [] };
  }

  const cleanText = parsed.cleanText;
  const created: ApplyAgentBuilderContainersResult["created"] = [];
  const rejected: string[] = [];

  for (const fields of parsed.blocks) {
    if (!Object.keys(fields).length || fields.mode === "governed") continue;
    const result = await applyAgentBuilderFields(
      input,
      fields as ExtractedFields,
      deps,
    );
    created.push(...result.created);
    rejected.push(...result.rejected);
  }

  return { cleanText, created, rejected };
}
