# Quickstart: 9.17 Bug 清单修复验证

## 自动验证

```bash
npm run test:js -- test/main/features/auth.test.ts \
  test/renderer/chat-input-form.test.ts \
  test/renderer/kb-workbench.test.ts \
  test/renderer/conversation-polling.test.ts \
  test/renderer/conversation-failed-retry.test.ts \
  test/main/features/group_chat/failed-turn-retry.test.ts
npm run typecheck && npm run lint && npm run tokens:check && git diff --check
```

## 手工验证

1. **Bug 1**：配置一个模型 → 制造一次可轮转失败使 profile 进入冷却 → 直接发起新任务；应正常执行，而不是提示「模型暂不可用 / 红圈」。
2. **Bug 2**：触发一个含必填单选问题的表单 → 不选任何选项，点「跳过」；应提交成功，用户消息中显示跳过说明。
3. **Bug 3**：知识库右区问答框输入 3~5 行文本；输入框应随之增高，超过约 120px 后出现纵向滚动；发送后高度复位。
4. **Bug 4**：任务运行中打断再恢复，页面应显示后台真实状态；对运行中任务点重试应提示仍在处理，而不是显示可重试。

## 真实环境

```bash
scripts/restart-cogseed.sh
```
确认启动日志与 `/tmp/cogseed-cogseed-run.log` 无新增报错。
