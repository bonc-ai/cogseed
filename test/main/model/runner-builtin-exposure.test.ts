import { describe, expect, it } from 'vitest';

import { systemSkillsExposureFromSessionId } from '../../../src/main/model/core-agent/runner';
import { openBuiltinNamesOf } from '../../../src/main/features/agent_builtin_capabilities';

/**
 * `builtin:<name>` 的语义：系统技能是编排/创作协议，普通 Agent 工作会话默认**看不到**；
 * 只有 Agent 的 skill_list 里声明了、且客户端开放的那几个才对它可见。
 * 运行时这一判断由"会话类型是否整体暴露系统技能"与"Agent 声明了哪些开放的内置能力"两部分组成。
 */
describe('系统技能对不同会话的暴露', () => {
  it.each([
    ['gconv-abc', true],    // 群聊指挥官
    ['agent-abc', true],    // Agent 编辑会话
    ['skill-abc', true],    // Skill 编辑会话
    ['gmember-abc', false], // 普通 Agent 工作会话：不暴露
    ['conv-abc', false],
    ['', false],
  ])('%s → %s', (sessionId, expected) => {
    expect(systemSkillsExposureFromSessionId(sessionId)).toBe(expected);
  });
});

describe('Agent 声明的内置能力（工作会话里据此只放行这几个）', () => {
  it('只取开放清单内的名字；清单外（含强权限的）与非 builtin 写法都不放行', () => {
    expect(openBuiltinNamesOf(['builtin:coding', 'builtin:kb-mindmap', 'a3f09c21b7e4', 'my-skill']).sort())
      .toEqual(['coding', 'kb-mindmap']);
    expect(openBuiltinNamesOf(['builtin:agent-creator', 'builtin:package-installer', 'builtin:nope'])).toEqual([]);
    expect(openBuiltinNamesOf(undefined)).toEqual([]);
  });
});
