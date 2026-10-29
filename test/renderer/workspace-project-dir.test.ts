import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 契约测试：新建空间「本地项目目录」= 绑定（原地工作），不是导入（复制）。
//
// 行为契约（源码级回归保护，风格同 workspace-role-picks.test.ts）：
//   1. 弹窗里那个选择器现在表示"绑定这个目录当空间工作区"，提交时随
//      `spaces.create` 传 projectDir —— 不再走 `workspace.importFolder` 复制一份；
//   2. 导入进度（弹窗进度行 + workspace-import:progress 订阅 + _importing 状态）
//      整体退场，避免留下"看着在导入、其实什么都没发生"的死代码；
//   3. 绑定目录被后端拒绝时给用户可读原因，并停在弹窗上让用户重选；
//   4. 产物删除确认必须带完整路径 —— 绑定本地项目后，列表里的产物可能就是
//      用户磁盘上的真文件，路径是用户判断"这是谁的、删了会怎样"的唯一依据。

const wsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/workspace.js'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8')) as Record<string, string>;
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/en.json'), 'utf8')) as Record<string, string>;

describe('新建空间：本地项目目录 = 绑定，不是导入', () => {
  it('弹窗渲染"本地项目目录"选择器，并给出来源说明而不是"空间创建后为空"', () => {
    const start = wsSource.indexOf('function _renderCreateModal()');
    expect(start).toBeGreaterThan(-1);
    const body = wsSource.slice(start, wsSource.indexOf('function _renderCreateAgentModal', start));
    expect(body).toContain("_t('ws.project_dir_label'");
    expect(body).toContain('data-ws="pick-project-dir"');
    expect(body).toContain('data-ws="clear-project-dir"');
    // 选择器复用原有样式类（按钮/整行可点区域不变），只换语义与文案
    expect(body).toContain('ws-import-picker');
    // 老的"未选择——空间创建后为空"文案已随语义一起退场
    expect(body).not.toContain('ws.import_folder_none');
  });

  it('选中的目录记进 _createProjectDir，清除动作把它置空', () => {
    expect(wsSource).toContain('let _createProjectDir = null;');
    const pick = wsSource.indexOf('[data-ws="pick-project-dir"]');
    expect(pick).toBeGreaterThan(-1);
    const pickBody = wsSource.slice(pick, pick + 1200);
    expect(pickBody).toContain("_invoke('common.pickDirectory'");
    // External folders require an explicit trust confirmation before the
    // directory is recorded (ADR-001/004).
    expect(pickBody).toContain("_t('ws.project_dir_trust_title'");
    expect(pickBody).toContain('await _wsConfirm(');
    expect(pickBody).toContain('_createProjectDir = res.path;');
    const clear = wsSource.indexOf('[data-ws="clear-project-dir"]');
    expect(clear).toBeGreaterThan(-1);
    expect(wsSource.slice(clear, clear + 400)).toContain('_createProjectDir = null;');
  });

  it('提交时把 projectDir 交给 spaces.create，且不再复制任何文件', () => {
    const start = wsSource.indexOf('async function _createSpace()');
    const end = wsSource.indexOf('function _dirBasename', start);
    expect(start).toBeGreaterThan(-1);
    const body = wsSource.slice(start, end);
    expect(body).toContain('{ projectDir: _createProjectDir }');
    // 复制式导入整体退场：不留任何调用点
    expect(body).not.toContain('workspace.importFolder');
    expect(body).not.toContain('_importing');
    // 创建成功后清空选择，避免下次打开弹窗沿用上次的目录
    expect(body).toContain('_createProjectDir = null;');
  });

  it('绑定目录被拒绝 → 停在弹窗并给可读原因（不创建半成品空间）', () => {
    // 后端错误码 → 渲染层文案 key（一一对应，缺一条用户就会看到原始错误码）
    const errorKeys: Record<string, string> = {
      project_dir_not_found: 'ws.project_dir_err_not_found',
      project_dir_not_directory: 'ws.project_dir_err_not_dir',
      project_dir_unsafe: 'ws.project_dir_err_unsafe',
      invalid_project_dir: 'ws.project_dir_err_invalid',
    };
    for (const [code, key] of Object.entries(errorKeys)) {
      expect(zh[key], key).toBeTruthy();
      expect(en[key], key).toBeTruthy();
    }
    const start = wsSource.indexOf('function _projectDirErrorMessage(code)');
    expect(start).toBeGreaterThan(-1);
    const body = wsSource.slice(start, start + 1400);
    for (const [code, key] of Object.entries(errorKeys)) {
      expect(body).toContain(`case '${code}':`);
      expect(body).toContain(key);
    }
    // 调用点：拿到可读文案就 return（停在弹窗），否则才走通用失败文案
    const create = wsSource.slice(wsSource.indexOf('async function _createSpace()'));
    expect(create).toContain('const projectDirError = _projectDirErrorMessage(res.error);');
    expect(create).toContain('if (projectDirError) { _stub(projectDirError); return; }');
  });

  it('导入进度是死代码：没有订阅、没有进度行、没有 _importing 状态', () => {
    expect(wsSource).not.toContain('workspace-import:progress');
    expect(wsSource).not.toContain('_importing');
    expect(wsSource).not.toContain('ws.importing_progress');
    expect(wsSource).not.toContain('_importProgressBound');
    // 老 key 也从两份语言表里退场（新 key 见下一条）
    expect(zh['ws.importing_progress']).toBeUndefined();
    expect(en['ws.importing_progress']).toBeUndefined();
    expect(zh['ws.import_folder_label']).toBeUndefined();
  });
});

describe('产物删除：确认文案带完整路径', () => {
  it('zh/en 两份文案都带 {name} 与 {path} 两个占位符', () => {
    for (const table of [zh, en]) {
      const msg = table['ws.art_delete_confirm'];
      expect(msg).toContain('{name}');
      expect(msg).toContain('{path}');
      // 语义要点：说清是"移到废纸篓"以及何时找不回来，而不是笼统"无法撤销"
      expect(msg).not.toContain('无法撤销');
    }
    expect(en['ws.art_delete_confirm']).not.toMatch(/\p{Script=Han}/u);
  });

  it('渲染层把 a.path 作为 {path} 传进去', () => {
    const start = wsSource.indexOf('async function _deleteArtifact(a)');
    expect(start).toBeGreaterThan(-1);
    const body = wsSource.slice(start, start + 900);
    expect(body).toContain("_t('ws.art_delete_confirm'");
    expect(body).toContain('path: a.path');
  });
});
