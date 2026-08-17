# 交接文档:空间化落盘 + UI 优化 + 引用一次性化(2026-08-16 晚)

> 交接人:Hermes(本窗口)
> 仓库:`~/cog-seed`(develop 分支,**运行中的 app 就是这份代码**;重启脚本 `./scripts/restart-cogseed.sh restart`)
> 状态:**全部改动未提交**,工作区混合了 Hermes 上次的双 tab 改动 + 本次全部改动 + 用户原有改动

## 一、本次会话做了什么(按时间顺序)

### 1. 空间中心任务行:删除「＋引用」按钮和「引用 N」徽章
- `src/renderer/modules/workspace.js`(任务行渲染 + 事件绑定)
- `src/renderer/workspace.css`(网格 5 列 → 4 列;删 `.ws-row-ref-btn`/`.ws-row-ref-badge`)
- 遗留:引用选择器 `_openRefPicker` 成死代码(无入口,可留可清)

### 2. 侧栏 UI 大厂风优化
- `src/renderer/style.css`(分区标题轻量化、conv-item 紧凑+圆角 8px、active 品牌绿、未命名会话灰色、搜索框/底部按钮/导航按钮细化)
- `src/renderer/modules/conversation.js`(未命名会话加 `.conv-item-title-untitled`)
- 注:同文件里有 Hermes 的双 tab 改动(空间|最近任务 + 相对时间),勿回退

### 3. 「空间中心」改名「工作空间」
- 4 个 locale 的 `sidebar.workspace` / `ws.center_title` / `chat.conv_space_none`
- `index.html` fallback、`workspace.js` h1 fallback

### 4. 空间设置:能力可调整
- `workspace.js`:角色(主模板单选弹窗)、当前对话 Agent(多选弹窗)可调;能力卡片三列布局
- `spaces.ts`:新增 `base_agents: string[]` 字段(兼容 `base_agent` 单值,首项同步);`resolveSpaceResources` 的 opts 改为 `baseAgentAgentIds: string[]`
- `ipc/index.ts`:`spaces.create`/`spaces.update` 透传 `base_agents`

### 5. 引用改为一次性(发送后自动清除)
- `src/main/features/group_chat/index.ts`:groupChat.send() 成功入队后清空会话 `task_references`
- 排队消息不受影响(入队时已快照);发送失败不清空

### 6. ⭐ 附件/网页产物空间化落盘(本次最大工程)
背景:空间会话的上传附件/网页产物原本落全局 `cloud/chat_attachments|chat_artifacts/<cid>/`,不落空间目录。现在:新附件写入 `spaces/<sid>/chat_attachments/<cid>/`,旧数据有迁移函数。

| 文件 | 改动 |
|---|---|
| `util/project-layout.ts` | 5 个路径函数加 `spaceHint?` 参数(优先级 空间 > 项目 > 全局) |
| `features/chats.ts` | 新增 `conversationSpaceId(uid, cid)`(30s 缓存) |
| `features/chat_attachments.ts` | 空间缓存 `cachedConversationSpace`/`warmConversationSpace`;上传/导入/adopt 写空间目录;`purgeByCid` 双目录清理;adoptDraftAttachments 改 async |
| `features/chat_artifacts.ts` | 5 处目录调用走空间;`purgeByCid` 双目录清理 |
| `ipc/index.ts` | attachments 相关 handler 请求前 warm;回收站 relPath 带空间 |
| `group_chat/bus.ts` | 附件收集/引用附件根目录走空间(读缓存兜底) |
| `features/auto_tasks.ts` | 自动化附件复制源/目标走空间 |
| `model/core-agent/local-tools.ts` | create_artifact 前 warm |
| `features/spaces_artifacts.ts` | ⭐ 新增 `migrateSpaceAttachments()`(搬家工人,幂等)+ `listSpaceArtifacts` 触发 |
| `features/spaces.ts` | `deleteSpace` 兜底清理公共仓库该空间会话的附件/产物 |

### 7. 空间资产页删文案
- `workspace.js`:"引用资料不属于资产,也不在本页展示。"已删,只留"资产仅包含四类…"

### 8. 侧栏空间行「在访达中显示」按钮(最新)
- `ipc/index.ts`:`spaces.openInFinder`(shell.openPath 打开空间目录,不存在开父级)
- `conversation.js`:空间行渲染加 `span[role=button]`(行是 button 不能嵌套),hover 显现,点击不触发折叠
- `style.css`:`conv-space-reveal-btn`(默认隐藏,行 hover 淡入)
- 4 locale:`sidebar.space_open_folder`

## 二、已知预存失败(12 个测试,非本次引入,勿背锅)

`space_system_prompt_inject`×2(No model configured 环境)、`conversation-sidebar`×1(Project task 11,handoff 标注)、`kstar-single-core`×1(已提交代码含 buildRunner)、`cogseed-residual-identifiers`×1(CLAUDE.md 断言)、`lazy-features`×2(测试滞后于已提交的 spaces→workspace 重构)、`modal-close-consistency`×1(5717 行已提交代码)、`skills-frontmatter`×2 + `skills-nseap-declaration`×2(locale 预存缺失)

## 三、测试的正确姿势(重要)

**必须用 `node scripts/run-tests.mjs run` 跑全量测试,不要直接 `npx vitest run`** —— better-sqlite3 编译成 Electron ABI(NODE_MODULE_VERSION 145),系统 Node(127)不匹配,直接 vitest 会大面积误报失败。

```bash
cd ~/cog-seed
npm run typecheck
node scripts/run-tests.mjs run          # 全量(约 6-10 分钟)
npx vitest run test/main/features/spaces.test.ts   # 单文件可用 npx vitest
```

## 四、复现/验证步骤

```bash
./scripts/restart-cogseed.sh restart
# 日志:~/.cogseed/runtime-variants/cogseed/data/logs/2026-08-16.log
```

## 五、待办/可继续的方向

1. **12 个预存失败清理**(可选):lazy-features/modal-close/kstar 是纯测试滞后,更新测试即可
2. **`_openRefPicker` 死代码清理**(可选)
3. 空间化落盘的**打包/导出工具**(P3,方案里提过):空间打包时附件已随柜子,但导出入口未做
4. **Python 资源测试**未跑:缺 pytest 环境(`npm run test:resources:setup`)
5. 全部改动**未提交**,用户确认后按 GitLab MR 流程提交(develop 受保护)

## 六、用户最近的要求(可能继续)

- 用户在做 CogSeed 产品迭代,关注:空间产物/资产落位、@ 引用、UI 观感(参考大厂)
- 当前会话最后用户开了新窗口做交接,新窗口应继续支持产品迭代
