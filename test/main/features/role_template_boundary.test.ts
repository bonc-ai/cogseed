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

describe('role-template boundary › M3 三元组不再跨 renderer / IPC 往返', () => {
  it('skills.js 落点下拉的 option value 就是 fieldRef，不再序列化四元组', () => {
    const skills = stripComments(read('src/renderer/modules/skills.js'));
    expect(skills).toContain("invoke('personalOntology.templates.fieldTargets')");
    expect(skills).toContain('target.fieldRef');
    expect(skills).not.toContain('groupId: template.group_id');
    expect(skills).not.toContain('encodeURIComponent(JSON.stringify({');
    expect(skills).not.toContain('personalTemplates');
  });

  it('skills-bindings.js 只回传 { fieldRef }，不再 JSON.parse 落点', () => {
    const bindings = stripComments(read('src/renderer/modules/skills-bindings.js'));
    expect(bindings).toContain('{ fieldRef }');
    expect(bindings).not.toContain('decodeURIComponent(encoded)');
    expect(bindings).not.toContain('target.groupId');
  });

  it('IPC 层不再逐字段校验 PO 内部结构', () => {
    const ipc = stripComments(read('src/main/ipc/index.ts'));
    expect(ipc).not.toContain('profileTarget.groupId');
    expect(ipc).not.toContain('profileTarget.section');
    expect(ipc).not.toContain('profileTarget.fieldName');
    expect(ipc).toContain('profileTarget.fieldRef');
  });

  it('Recall 侧不再持有 PO 内部地址，也不再自建 T-box 白名单', () => {
    const sync = stripComments(read('src/main/features/recall/personal-profile-sync.ts'));
    expect(sync).not.toContain('buildContentRef');
    expect(sync).not.toContain('appendExistingTemplateFieldValueToRef');
    expect(sync).not.toContain('getRoleTemplate');
    expect(sync).not.toContain('preset_groups');
    expect(sync).toContain('isTboxField');
    expect(sync).toContain('appendRoleTemplateFieldValue');

    const candidateService = stripComments(read('src/main/features/recall/candidate-service.ts'));
    expect(candidateService).toContain('describeRoleTemplateFieldRef');
    expect(candidateService).not.toContain("throw new Error('invalid personal profile target group')");
  });
});

describe('role-template boundary › M7/M8 PO 内部规则收口', () => {
  it('模板文件判据只有一份实现，template_files 只做别名', () => {
    const groups = read('src/main/features/personal_ontology_groups.ts');
    const files = read('src/main/features/personal_ontology_template_files.ts');
    expect(groups).toContain('export const TEMPLATE_FILE_META_RE');
    expect(groups).toContain('export function isTemplateFileText');
    // template_files 不再自带正则字面量，只 import 别名
    expect(files).not.toMatch(/const TEMPLATE_META_RE = \//);
    expect(files).toContain('const TEMPLATE_META_RE = TEMPLATE_FILE_META_RE;');
    expect(files).toContain('export { isTemplateFileText };');
  });

  it('T-box 白名单只有 contract 一份，调用方不再自建', () => {
    for (const file of [
      'src/main/features/personal_ontology_candidates.ts',
      'src/main/features/personal_ontology_groups.ts',
      'src/main/features/personal_ontology_template_files.ts',
      'src/main/features/recall/personal-profile-sync.ts',
    ]) {
      // 只禁「用 preset_groups 重建白名单」；用 T-box 做安装种子（installTemplateFile /
      // migrateLegacyTemplateGroups 里的 preset_groups.map）是 PO 内部正当用法。
      const code = stripComments(read(file));
      expect(code, `${file} must not rebuild the T-box whitelist`)
        .not.toContain('preset_groups.flatMap');
      expect(code, `${file} must not re-derive field declaration from preset_groups`)
        .not.toContain('.preset_groups.some');
    }
    expect(read('src/main/features/personal_ontology_contract.ts')).toContain('export function isTboxField');
    expect(read('src/main/features/personal_ontology_contract.ts')).toContain('export function listTboxFieldNames');
  });

  it('普通 group 生命周期对模板行设防', () => {
    const groups = read('src/main/features/personal_ontology_groups.ts');
    const guards = groups.match(/role_template_group/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(2); // renameGroup + deleteGroup
  });
});
