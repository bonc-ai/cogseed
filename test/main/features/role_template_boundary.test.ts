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
