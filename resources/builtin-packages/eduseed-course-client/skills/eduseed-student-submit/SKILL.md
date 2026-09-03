---
name: eduseed-student-submit
description: ① 帮学生查挑战、预检交付物、提交项目并跟踪评分闭环（查→检→确认→交→跟踪），提交前必须向学生展示摘要并等待人工确认;② 适合"看看 C03 要交什么""检查我项目缺什么""提交 C03""我上次评分多少";③ 触发词:挑战、提交、交作业、交付物、评分、评审
---

# EduSeed 学生提交｜挑战提交闭环（Plugin 版）

本 Skill 是 EduSeed 课程客户端（Course Plugin）的学生侧入口。运行时为技能脚本
`scripts/runtime.js`（自包含单文件，直接调平台 HTTP Agent API，**不再走 MCP 连接器**）。

## 首次使用（激活向导，onboarding）

1. 先跑 `license-check` 确认席位状态：
   - 返回 licensed:true → 正常使用；
   - 返回 SEAT_NOT_LICENSED / COURSE_NOT_LICENSED → 告诉学生"该席位未授权，
     请联系学校管理员开通"，并给出三个必配项（EDUSEED_SERVER_URL / EDUSEED_API_KEY / EDUSEED_STUDENT_ID）
     与平台 /companion 页的指引——**不执行任何课程命令**；
2. 缺配置（CONFIG 类报错）→ 提示学生从平台 /companion 页生成 API Key 并下载配置，
   把 env 三件套配好再试；
3. 激活后建议先跑 `list-challenges` 冒烟，确认能看到挑战列表再开始正式使用。

## 运行时调用方式

首选（CogSeed 内，bash 工具）：

```bash
"$COGSEED_NODE" "$COGSEED_PC_DIR/bin/run-skill.cjs" eduseed-student-submit runtime -- <命令> '<JSON载荷>'
```

新版 run_skill 工具等价形式：`{skill_id:"eduseed-student-submit", script:"runtime", args:["<命令>","<JSON载荷>"]}`

本地开发：`node scripts/runtime.js <命令> '<JSON载荷>'`

每次调用 stdout 输出一个 JSON 结果（`{ok, ...}`）。**不得**把多次结果拼进一个 shell 命令的管道再喂给用户，必须逐步读取、逐条解释。

## 命令面（学生视角，来自 runtime help）

| 命令 | 作用 | 关键载荷 |
|---|---|---|
| `list-challenges` | 已发布挑战列表 | — |
| `get-challenge` | 挑战详情（交付物/rubric/截止） | `{"challengeId":"C03"}` |
| `check-deliverables` | 本地交付物检查（离线，非权威） | `{"workdir":"/abs/path","requiredDeliverables":"README.md, src/**"}` |
| `prepare-submission` | 预检报告 + 行动项 + 提交草稿（离线） | 同上 + `githubRepoUrl`,`projectTitle` |
| `submit-project` | 提交（预检→Envelope→task_id） | 见下 |
| `submit-and-track` | 提交并跟踪完整闭环（output contract） | 见下 |
| `get-task` | 任务状态轮询 | `{"taskId":"task-xxx"}` |
| `list-my-submissions` | 我的提交记录 | — |
| `get-evaluation` | 评审详情（AI 初评/教师终审/同伴） | `{"submissionId":"sub-xxx"}` |
| `get-dashboard` | 进度仪表盘 | — |
| `get-delta-r` | ΔR 偏差分析（calibration/learning） | `{"submissionId":...}` 或 `{"challengeId":...}` |
| `list-episodes` / `get-episode` / `get-replay-suggestions` | KSTAR 学习记忆 | `{"episodeId":...}` 等 |
| `agent-send` / `agent-inbox` / `agent-contacts` | P3394 师生互通 | `{"toAgentId":...,"text":...}` |
| `health` | 平台连接检查 | — |

## 九步工作流（继承课程提交技能模板，不可跳过）

### Phase A — 只读校验（步骤 1-4，无后端写入）

1. **validate_submission_inputs** — 必填项存在性/URL 形状；AAR ≠ 自评链接。失败：`INPUT_MISSING` / `INPUT_MALFORMED`
2. **resolve_student_record** — `health` 确认连接；身份由平台从 x-api-key 解析（不可伪造）。失败：`AUTH_FAILED`
3. **resolve_challenge_record** — `get-challenge` 查挑战；确认 deadline/status 开放。失败：`CHALLENGE_NOT_FOUND` / `CHALLENGE_CLOSED`
4. **validate_artifact_links** — `check-deliverables` + `prepare-submission` 本地通配符检查 + GitHub 指针；完整报告每个检查项。失败（软）：`REPO_PATTERN_MISMATCH` / `README_MISSING`

### 步骤 4.5 — 提交摘要人工确认（MVP User Story，硬性）

在调用 `submit-project` / `submit-and-track` 之前，必须：
1. 向学生展示**提交摘要**：挑战 ID、项目标题、GitHub 仓库、AAR/自评字数、交付物检查结果、缺件清单；
2. 明确提问："确认提交吗？（回复'确认'后才会写平台）"；
3. **只在学生明确确认后**执行写入。学生未确认/要求修改 → 停止并列出待改项。
失败行为：`never_submit_without_user_confirm`


### 确认卡片（GUI 模式，硬性要求）

**具备 create_artifact 工具时必须使用「确认卡片」，禁止退化为纯文字确认**。仅当卡片创建失败或工具不可用时才允许文字确认，且必须在回复中明确说明原因：

1. 创建 artifact（title=「待确认：提交项目」），含两个文件：
   - `index.html`：确认卡片宿主模板（附录 A，**原样使用**，不要增删改动）
   - `confirm-config.json`：`{"op":"submit-project","payload":{…完整写入载荷…}}`
2. 对话中会渲染出插件确认面板（载荷摘要 + 确认/取消按钮）；
3. 等待用户操作：
   - 收到 `{"action":"plugin-confirm","op":"submit-project","payload":…}` → 用该 payload 执行第 5 步 `submit-project`；
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

### Phase B — 写入阶段（步骤 5-9）

5. **create_or_update_submission_record** — `submit-project`（载荷：challengeId/githubRepoUrl/projectTitle/aarText(≥10字)/selfEvaluationText(≥10字)/isPublic/reviewMode；可选 workdir+requiredDeliverables 触发预检）。返回 task_id
6. **generate_submission_summary** — `get-task` 轮询；组装教授向 `summary_markdown`
7. **trigger_self_evaluation** — 平台自动触发 AI 初评；`get-evaluation` 查分项/优缺点/建议
8. **update_portfolio_index** — 平台自动生成作品集条目
9. **notify_professor_or_course_owner** — 平台飞书通知（学生 + 班级群）

## 付费授权（激活门，硬性）

- 除 help/license-check/plugin-version/health/本地预检外，**每个命令执行前运行时都会自动向平台做授权校验**（安装不授权、激活才计数）；
- 返回 `LICENSE_REQUIRED`（或 SEAT_NOT_LICENSED / COURSE_NOT_LICENSED）时：**立即停止课程操作**，
  如实告诉学生"该席位未授权，请联系学校/平台管理员开通"，**不得尝试绕过、不得改用本地文件瞎编挑战/评分**；
- `license-check` 命令可主动查询授权状态。

## 版本检查（skill 自动更新，硬性）

- 每次开始课程任务前，先执行 `plugin-version`：
  - `update_required: true` → **立即停止课程操作**，告诉学生"插件版本过低，必须升级"，
    并按《排障手册》升级步骤执行（随 CogSeed 发版自动升级（内置版），或联系学校管理员）；
  - `update_available: true` → 提示学生"有新版本，建议说「升级课程插件」"，不阻塞当前任务；
  - 已是最新 → 继续。
- 升级完成后再继续原任务；不得用旧版本强行执行被平台要求升级的功能。

## 输出契约

```yaml
outputs:
  submission_record_id: string        # 后端记录 ID（经 task 轮询获取）
  submission_status: enum             # draft|submitted|validated|failed
  validation_report: {checks:[{name,passed,detail}], passed_count, failed_count}
  evaluation_record_id: string|null
  portfolio_update_status: enum       # updated|skipped|failed
  summary_markdown: string            # 教授向摘要
```

## 错误分类

| 错误码 | 处理 |
|---|---|
| `INPUT_MISSING(field)` | 明确列出缺失字段 |
| `DUPLICATE_LINK` | AAR 与自评同链接 → 要求区分 |
| `AUTH_FAILED` / `CHALLENGE_CLOSED` | 报告原因，不重试不绕过 |
| `ROLE_DENIED` | 学生不可发布/越权（发布是教师命令） |

## 停止规则

用户停止；缺交付物且不补充；平台 401/503；挑战已关闭；**学生未确认提交摘要**。

## 失败行为

never_invent_submission_content；never_skip_local_check；never_submit_without_aar；
never_submit_without_user_confirm；return_completed_and_uncompleted_parts

输出必须包含：action_summary、evidence、open_questions、stop_reason
