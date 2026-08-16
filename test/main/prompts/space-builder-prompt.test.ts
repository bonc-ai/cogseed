import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 空间构建师 prompt 回归守卫：防止关键引导在后续修改或合并中丢失
// （本项目已发生过合并把本地 prompt 改动覆盖掉的情况）。
// 注意：用户已决定「还原为借鉴 grill-me 之前那版」——这里守卫的是还原后的基线：
//   一次一个问题、最多三问、模糊就给默认、draft JSON 输出契约 + 注入占位符。
function readSpaceBuilderPrompt(): string {
  return fs.readFileSync(path.join(__dirname, '../../../src/main/prompts/space_builder.md'), 'utf8');
}

describe('space_builder prompt guards', () => {
  it('keeps the runtime injection placeholders', () => {
    const content = readSpaceBuilderPrompt();
    for (const placeholder of ['$skills_block', '$agents_block', '$templates_block', '$scenarios_block']) {
      expect(content).toContain(placeholder);
    }
  });

  it('keeps the pre-grill-me conversation style (一次一个问题、模糊给默认、不追问到底)', () => {
    const content = readSpaceBuilderPrompt();
    expect(content).toContain('one question at a time');
    expect(content).toContain('propose a sensible default space and move on');
    expect(content).toContain('Do not interrogate');
    // 引导问题只有三个需求问题（长期做什么 / 给谁用产出 / 频率），不涉及模板技能选择
    expect(content).toContain('What do you want to keep doing long-term');
    expect(content).toContain('Who is it for');
    expect(content).toContain('Roughly how often');
  });

  it('keeps the draft output contract (space-draft JSON + 资源字段 + 副模板)', () => {
    const content = readSpaceBuilderPrompt();
    expect(content).toContain('space-draft');
    expect(content).toContain('primary_template_id');
    expect(content).toContain('secondary_template_ids');
    expect(content).toContain('main_skill_ref');
    expect(content).toContain('extra_skill_ids');
    expect(content).toContain('extra_agent_ids');
    expect(content).toContain('Only reference resources that actually exist in the injected lists');
  });
});
