// 成员编辑的作用域契约（PRD FR-014；验收报告 MA-02）。
//
// 真机现象：当前运行仍在执行时，从会话名单取消成员（或删掉该成员最后一个草稿
// 标记）会**中止已提交运行**——后端清队列、中止该成员、拒绝其待唤醒请求并阻塞
// 依赖。PRD FR-014 要求「提交冻结当次成员与配置，后续修改不改变已提交运行」：
// 编辑会话成员只影响下一次提交，停止当前工作必须走显式停止入口（FR-020）。
//
// 这条契约靠渲染层不自动调用 groupChat.abort 来保证，因此用源码契约测试钉住：
// 一旦有人重新加入「成员变化 → 停止运行」的联动，这里会立刻变红。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('composer member edit scope (FR-014 / MA-02)', () => {
  const conversation = read('src/renderer/modules/conversation.js');

  it('does not stop the committed run when members are edited', () => {
    // 渲染层不得再以「成员被移除」为理由调用运行停止。
    expect(conversation).not.toContain("reason: 'member_removed'");
    expect(conversation).not.toContain("'groupChat.abort'");
    // 该联动专用的活跃 run 追踪也随之下线（否则会留下只写不读的状态）。
    expect(conversation).not.toContain('_activeMemberRunByCid');
  });

  it('still syncs the composer recipient from member changes', () => {
    // 成员变化仍然驱动底部入口显示（默认 CogSeed / 单成员 / 首位 +N）。
    expect(conversation).toContain("window.addEventListener('composer-members-change'");
    expect(conversation).toContain('_syncRecipientFromMembers(detail.target)');
  });

  it('drops the retired member-stop copy from both renderer locales', () => {
    for (const locale of ['zh', 'en']) {
      const body = read(`src/renderer/locales/${locale}.json`);
      expect(body).not.toContain('chat.run_member_removed');
      expect(body).not.toContain('chat.run_member_remove_failed');
    }
  });

  it('keeps the member-change event wired from the composer members module', () => {
    const members = read('src/renderer/modules/composer-members.js');
    expect(members).toContain("'composer-members-change'");
    expect(members).toContain('removed_agent_ids');
  });
});
