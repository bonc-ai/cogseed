---
name: eduseed-teacher-publish
description: ① 教师用自然语言创建挑战：补全必填项→展示发布摘要→等待人工确认→写入平台+飞书→返回挑战编号；学生身份调用会被运行时拒绝;② 适合"创建一个新挑战""把这份作业发下去""周五截止的个人作品集作业";③ 触发词:发布、发作业、新挑战、建挑战
---

# EduSeed 教师发布｜自然语言建挑战（Plugin 版，MVP US-1）

本 Skill 是 EduSeed 课程客户端（Course Plugin）的教师侧入口。运行时为
`scripts/runtime.js`（与其它技能同一份自包含运行时，角色由 `EDUSEED_ROLE=teacher` 决定）。

## 运行时调用方式

```bash
"$COGSEED_NODE" "$COGSEED_PC_DIR/bin/run-skill.cjs" eduseed-teacher-publish runtime -- <命令> '<JSON载荷>'
```

run_skill 工具等价形式：`{skill_id:"eduseed-teacher-publish", script:"runtime", args:["<命令>","<JSON>"]}`

## 命令面（教师视角）

| 命令 | 作用 | 关键载荷 |
|---|---|---|
| `publish-challenge` | **发布挑战（唯一写入命令）** | `{"title","deadline","deliverables","rubric","brief?","objective?","requiredDeliverables?","rubricDimensions?"}` |
| `list-challenges` / `get-challenge` | 查已有挑战（避免重复） | `{"challengeId":...}` |
| `get-dashboard` | 班级统计（学生进度/提交） | — |
| `submit-review` | 教师终审（accept/return） | `{"evaluatorType":"teacher","submissionId","score","feedback","action","submissionRecordId?"}` |
| `notify` | 飞书通知（class_group/student_dm/teacher_dm） | `{"target":"class_group","text":...}` |
| `agent-send` / `agent-inbox` / `agent-contacts` | P3394 师生互通 | — |
| `health` | 平台连接检查 | — |

## 发布工作流（MVP US-1：自然语言建挑战 + 人工确认）

1. **解析意图** — 从教师自然语言提取：标题 / 截止时间 / 交付物 / 评分标准 / 背景 / 目标
2. **查重** — `list-challenges` / `get-challenge` 确认没有同题挑战（有则提示，不重复发布）
3. **补全必填项** — 缺 deadline / deliverables / rubric 时逐个问教师补齐；
   rubric 可选用 4 套类型模板（build/explore/research/product）帮教师生成初稿
4. **发布摘要人工确认（硬性）** — 展示完整摘要：标题/背景/目标/截止/交付物（含通配符）/Rubric 摘要/
   GitHub pointer/提交方式，然后问"确认发布吗？";**只在教师明确确认后**执行发布。
   失败行为：`never_publish_without_user_confirm`
5. **发布** — `publish-challenge`（平台校验教师身份；学生调用返回 `ROLE_DENIED`），返回受理编号 `task:task-xxx`
6. **轮询取挑战编号** — `get-task` 轮询该 task（约 1-5s 完成）：
   - `result.challengeId` 即真实挑战编号（如 ch-20260825xxxx-xxxx）
   - 回报教师：挑战编号 + 飞书群公告已触发说明；task 失败则回读 `result.error` 转达驳回原因


### 确认卡片（GUI 模式，硬性要求）

**具备 create_artifact 工具时必须使用「确认卡片」，禁止退化为纯文字确认**。仅当卡片创建失败或工具不可用时才允许文字确认，且必须在回复中明确说明原因：

1. 创建 artifact（title=「待确认：发布挑战」），含两个文件：
   - `index.html`：确认卡片宿主模板（附录 A，**原样使用**，不要增删改动）
   - `confirm-config.json`：`{"op":"publish-challenge","payload":{…完整写入载荷…}}`
2. 对话中会渲染出插件确认面板（载荷摘要 + 确认/取消按钮）；
3. 等待用户操作：
   - 收到 `{"action":"plugin-confirm","op":"publish-challenge","payload":…}` → 用该 payload 执行第 5 步 `publish-challenge`；
   - 收到 `{"action":"plugin-cancel",…}` 或用户文字取消 → 停止写入，按用户意见修改；
4. 用户未点击时**不得**执行写入。

### 附录 A：确认卡片宿主（index.html 模板）

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>确认卡片</title>
</head>
<body style="margin:0;background:transparent">
<script src="__cogseed/bridge.js"></script>
<script>
(function () {
  'use strict';
  var frame = document.createElement('iframe');
  frame.style.cssText = 'width:100%;border:0;display:block;min-height:340px';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  document.body.appendChild(frame);

  function sendToChat(payload) {
    if (window.cogseedArtifact && typeof window.cogseedArtifact.send === 'function') {
      window.cogseedArtifact.send(payload);
      return;
    }
    try { parent.postMessage({ __cogseedArtifact: true, type: 'submit', payload: payload }, '*'); } catch (e) {}
  }

  fetch('./confirm-config.json')
    .then(function (r) { if (!r.ok) throw new Error('no config'); return r.json(); })
    .then(function (c) {
      var q = new URLSearchParams();
      q.set('op', String((c && c.op) || ''));
      q.set('payload', JSON.stringify((c && c.payload) || {}));
      frame.src = 'cogseed-plugin://eduseed-course-client/ui/confirm.html?' + q.toString();
    })
    .catch(function () { frame.remove(); });

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.__cogseedPlugin !== true) return;
    try { if (ev.source !== frame.contentWindow) return; } catch (e) { return; }
    if (d.type === 'resize') {
      var h = Number(d.height);
      if (isFinite(h) && h > 0) frame.style.height = Math.min(Math.max(h, 120), 900) + 'px';
      return;
    }
    if (d.type === 'confirm') {
      sendToChat({ action: 'plugin-confirm', op: String(d.op || ''), payload: d.payload });
      return;
    }
    if (d.type === 'cancel') {
      sendToChat({ action: 'plugin-cancel', op: String(d.op || '') });
      return;
    }
  });
})();
</script>
</body>
</html>```

## 缺失字段处理（不直接发布）

- 缺 deadline → 提示补充
- 缺 rubric → 提示补充（或选类型模板）
- 缺 required_deliverables → 提示补充（支持 * 通配符）
- 缺 GitHub pointer → 提示补充

## 付费授权（激活门，硬性）

- 除 help/license-check/plugin-version/health 外，**每个命令执行前运行时自动向平台做授权校验**（教师席位 teacher-seat）；
- 返回 `LICENSE_REQUIRED` / `SEAT_NOT_LICENSED` 时：**立即停止**，如实告诉教师"该教师席位未授权，请联系平台管理员开通"，不得绕过；
- `license-check` 命令可主动查询授权状态。

## 版本检查（skill 自动更新，硬性）

- 每次开始课程任务前，先执行 `plugin-version`：
  - `update_required: true` → **立即停止**，告知必须升级（随 CogSeed 发版自动升级（内置版），或联系学校管理员）；
  - `update_available: true` → 提示可升级，不阻塞当前任务；
  - 已是最新 → 继续。

## 身份红线

- 本 Skill 只在教师 Agent（EDUSEED_ROLE=teacher + 教师 api_key）下工作；
- 学生身份调用 `publish-challenge` 会被运行时拒绝（ROLE_DENIED）——不要尝试绕过；
- AI 只生成发布草稿，最终发布决定权在教师（人工确认步骤）。

## 停止规则

metadata 缺失且教师未补充；教师未确认发布摘要；用户取消。

## 失败行为

never_publish_incomplete_metadata；never_fabricate_deadline_or_rubric；
never_publish_without_user_confirm；return_completed_and_uncompleted_parts
