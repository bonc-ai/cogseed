import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');
const mainRoot = path.resolve(__dirname, '../../src/main');

describe('unified cognition entry', () => {
  it('复用 develop 的 personal ontology 入口，不创建第二个侧栏概念', () => {
    const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
    const lazy = fs.readFileSync(path.join(rendererRoot, 'modules/lazy-features.js'), 'utf8');
    const conversation = fs.readFileSync(path.join(rendererRoot, 'modules/conversation.js'), 'utf8');

    expect(html).toContain('id="personal-ontology-btn"');
    expect(html).not.toContain('id="cognition-btn"');
    expect(html).toContain('id="cognition-page"');
    expect(lazy).toContain("'personal-ontology'");
    expect(lazy).toContain("'./modules/cognition/pages.js'");
    expect(lazy).toContain("'./modules/cognition/cognition.js'");
    expect(conversation).toContain('bubble-cognition-btn');
    expect(conversation).toContain("loader('personal-ontology')");
    expect(conversation).toContain('openCognitionCapture');
  });

  it('四个成长阶段与人工确认操作有中文文案', () => {
    const zh = JSON.parse(fs.readFileSync(path.join(rendererRoot, 'locales/zh.json'), 'utf8')) as Record<string, string>;
    for (const key of [
      'cognition.stage.seed',
      'cognition.stage.sprout',
      'cognition.stage.growing',
      'cognition.stage.bright',
      'cognition.action.confirm',
      'cognition.action.reconfirm',
      'cognition.action.reuse',
      'cognition.invalidated.title',
      'cognition.detail.loading',
    ]) {
      expect(zh[key]).toBeTruthy();
    }
  });

  it('只通过现有长期记忆进入普通会话上下文', () => {
    const runner = fs.readFileSync(path.join(mainRoot, 'model/core-agent/runner.ts'), 'utf8');
    const cognition = fs.readFileSync(path.join(mainRoot, 'features/cognition/index.ts'), 'utf8');

    expect(runner).not.toContain('formatCognitionForSystemPrompt');
    expect(runner).not.toContain('Confirmed reusable cognition');
    expect(cognition).toContain(
      'ensureCognitionMemoryEntryLocked(userId, asset.id, asset.summary, transaction)',
    );
    expect(cognition).toContain('withCognitionMemoryTransaction(userId');
  });
});
