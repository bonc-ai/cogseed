/**
 * M4 命名防漂移（specs/009）：「记忆分组」族旧命名已统一为「本体分组」，
 * 用机械断言钉住，防止后续改动把旧说法写回来。
 *
 * 背景：Backlog v2.6 第 55 行授权的命名治理。统一前同一事物有两套说法
 * （导航「记忆分组」 vs 详情「本体分组」），四语各有一套旧词形。治理口径：
 * 只改界面词条与代码注释；`personal_ontology_groups.ts` 生成 `groups.md` 的
 * `# 记忆分组` 文件头**刻意保留**（数据文件内容，见 specs/009 待总控确认第 9 条），
 * 因此源码扫描只覆盖渲染层 modules，不扫生成内容。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const LOCALES = ['zh', 'en', 'ja', 'pt'] as const;

/** 旧命名的四语词形——任何语言文件的任何词条值里再出现即为回退。 */
const STALE_TERMS = ['记忆分组', 'Memory Groups', 'メモリグループ', 'Grupos de memória'];

/**
 * v2（2026-09-29 个人本体重构）：三页导航键（事实与条目 / 规则 / 分组与模板）
 * 四语齐全；页面标题与导航行在实现上共用同一键（构造即同词形）。
 */
const NAV_KEYS = [
  'personalOntology.nav_abox',
  'personalOntology.nav_rbox',
  'personalOntology.nav_groups',
  'personalOntology.nav_groups_sub',
] as const;
/** 三盒时代旧词形——任何语言文件再出现即为回退。 */
const RETIRED_KEYS = [
  'personalOntology.nav_tbox',
  'personalOntology.nav_tbox_sub',
  'personalOntology.box_tbox_def',
  'personalOntology.box_abox_def',
  'personalOntology.box_rbox_def',
] as const;

function loadLocale(name: typeof LOCALES[number]): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${name}.json`), 'utf8')) as Record<string, unknown>;
}

function listRendererModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor') out.push(...listRendererModules(full));
      continue;
    }
    if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('M4 命名一致性（本体分组）', () => {
  it('四语词条值中不再出现「记忆分组」族的任何旧说法', () => {
    const offenders: string[] = [];
    for (const name of LOCALES) {
      const table = loadLocale(name);
      for (const [key, value] of Object.entries(table)) {
        if (typeof value === 'string' && STALE_TERMS.some((term) => value.includes(term))) {
          offenders.push(`${name}:${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('三页导航键四语齐全；三盒旧词形键不得回流', () => {
    for (const name of LOCALES) {
      const table = loadLocale(name);
      for (const key of NAV_KEYS) {
        expect(typeof table[key], `${name}:${key} 应存在`).toBe('string');
      }
      for (const key of RETIRED_KEYS) {
        expect(table[key], `${name}:${key} 是三盒旧词形，不应存在`).toBeUndefined();
      }
    }
  });

  it('渲染层 modules 源码（含注释）不再出现「记忆分组」', () => {
    const offenders: string[] = [];
    for (const file of listRendererModules(path.join(root, 'src/renderer/modules'))) {
      if (fs.readFileSync(file, 'utf8').includes('记忆分组')) offenders.push(path.relative(root, file));
    }
    expect(offenders).toEqual([]);
  });
});
