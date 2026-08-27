import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Role Template 收归的**边界**测试：断言外部模块不再触碰 Personal Ontology
 * 的内部存储、寻址与 markdown 格式。
 *
 * 这些是源码级断言，故意如此——它们锁的不是行为而是依赖方向。行为回归由
 * personal_ontology_contract.test.ts 与各 consumer 测试负责；这里只保证
 * 「即使行为对了，也不许再从后门拿」。任何一条失败都意味着越层依赖回潮。
 */

const REPO = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** 去掉行注释与块注释，避免注释里提到的名字造成误报。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('role-template boundary › M1 Workspace 不再直读 PO 模板文件', () => {
  const spaces = stripComments(read('src/main/features/spaces.ts'));

  it('spaces.ts 不再调用 readTemplateFileText / parseTemplateContent', () => {
    expect(spaces).not.toContain('readTemplateFileText');
    expect(spaces).not.toContain('parseTemplateContent');
  });

  it('spaces.ts 不再 import personal_ontology_template_files', () => {
    expect(spaces).not.toContain('personal_ontology_template_files');
  });

  it('spaces.ts 不再自行遍历分节/字段/来源/项目标记', () => {
    expect(spaces).not.toContain('.sections');
    expect(spaces).not.toContain('sec.fields');
    expect(spaces).not.toContain('@proj:');
  });

  it('角色画像注入改为经 PO contract', () => {
    expect(spaces).toContain('getRoleProfileForRuntime');
    expect(spaces).toContain('personal_ontology_contract');
  });
});

describe('role-template boundary › M6 模板目录只剩 PO 一个出口', () => {
  const ipc = stripComments(read('src/main/ipc/index.ts'));

  it('spaces.templates.list / spaces.scenarios.list 已下线', () => {
    for (const file of [
      'src/main/ipc/index.ts',
      'src/renderer/modules/workspace.js',
      'src/renderer/modules/conversation.js',
      'src/renderer/modules/onboarding.js',
    ]) {
      const source = read(file);
      expect(source, `${file} must not use spaces.templates.list`).not.toContain('spaces.templates.list');
      expect(source, `${file} must not use spaces.scenarios.list`).not.toContain('spaces.scenarios.list');
    }
  });

  it('目录出口走 contract，IPC 层不再直连 T-box 常量', () => {
    expect(ipc).toContain("'personalOntology.templates.catalog'");
    expect(ipc).toContain("'personalOntology.scenarios.list'");
    expect(ipc).not.toContain('role_templates');
  });

  it('Workspace / 会话导入 / 空间构建师都不再 import role_templates', () => {
    for (const file of [
      'src/main/features/spaces.ts',
      'src/main/features/session_import/welcome-message.ts',
      'src/main/features/session_import/recommend-start.ts',
      'src/main/features/group_chat/bus.ts',
    ]) {
      expect(stripComments(read(file)), `${file} must not import role_templates`)
        .not.toContain('role_templates');
    }
  });

  it('Workspace 侧不再自带 PO markdown parser（parseTemplateFileBundle 已删）', () => {
    const spaces = read('src/main/features/spaces.ts');
    expect(spaces).not.toContain('parseTemplateFileBundle');
    expect(spaces).not.toContain('捆绑技能');
  });

  it('preset_groups 不出现在任何渲染层代码里', () => {
    for (const file of [
      'src/renderer/modules/workspace.js',
      'src/renderer/modules/conversation.js',
      'src/renderer/modules/onboarding.js',
      'src/renderer/modules/agents.js',
      'src/renderer/modules/skills.js',
    ]) {
      expect(read(file), `${file} must not know preset_groups`).not.toContain('preset_groups');
    }
  });
});

describe('role-template boundary › M2 渲染层不再拼接 PO 复合 id', () => {
  const agents = read('src/renderer/modules/agents.js');

  it('agents.js 不再出现 `${...}::${...}` 形式的 ref 拼接', () => {
    expect(agents).not.toMatch(/\$\{[^}]*\}::\$\{[^}]*\}/);
  });

  it('agents.js 不再持有 PO 内部 group_id', () => {
    const code = stripComments(agents);
    expect(code).not.toContain('group.group_id');
    expect(code).not.toContain('t.group_id');
    expect(code).not.toContain("invoke('personalOntology.groups.list'");
  });

  it('chat-use.js 保持不变：ref 仍是不透明字符串，不解析分节语法', () => {
    const chatUse = stripComments(read('src/renderer/modules/chat-use.js'));
    expect(chatUse).not.toContain('SECTION_REF_SEP');
    expect(chatUse).not.toContain("split('::')");
    expect(chatUse).toContain("invoke('personalOntology.groups.read'");
  });

  it('SECTION_REF_SEP 只存在于 PO 内部实现，不出现在任何渲染层文件', () => {
    const rendererDir = path.join(REPO, 'src/renderer/modules');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        if (fs.readFileSync(full, 'utf8').includes('SECTION_REF_SEP')) {
          offenders.push(path.relative(REPO, full));
        }
      }
    };
    walk(rendererDir);
    expect(offenders).toEqual([]);
  });
});
