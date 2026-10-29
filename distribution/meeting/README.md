# 智能会议：按新内容从 Hub 分发

Agent 和两个 Skill 是 1.4.0 新内容，首次导入走普通新建流程。**不指定旧 contentId，不走种子接管，不增加历史 ID 迁移。**

## 发布源和版本

- `skills/meeting-minutes/`：会议纪要 Skill。
- `skills/meeting-task-breakdown/`：任务拆分 Skill。
- `agents/meeting-assistant/agent.json`：Agent 模板，`skill_list` 暂用上述源键标识依赖；模板不可直接上传 Hub。
- `release.json`：各内容自己的版本、最低客户端版本、默认安装设置。

本目录不在 Electron 打包清单中。会议工作流与两个 Skill 的正文及辅助文件迁移保留；Agent 的一条停止条件改为明确禁止未确认建单；宿主纠错工具、确认、知识库归档和本体写入仍由客户端提供。
Agent 不携带用户的连接器授权或模型配置；腾讯会议连接器依照现有会话授权使用。
首次导入由目标 Hub 分配 ID。不同环境的 ID 可能不同，不能把本地联调 ID 当成生产 ID。

## 两阶段生成与正常导入

1. 先生成两个独立 Skill 的输入包：

   ```sh
   node --import tsx scripts/build-meeting-hub-packages.ts dist/meeting-skills-1.0.0
   ```

2. 在目标 Hub 正常导入两个 Skill：提交文件、版本、来源档位与最低客户端版本，**省略 `contentId`**。
   发布成功后，把 Hub 返回的 ID 和已发布版本记录成该环境的绑定文件：

   ```json
   {
     "hub_origin": "https://目标Hub域名",
     "skills": {
       "meeting-minutes": { "content_id": "Hub返回的12位ID", "version": "1.0.0" },
       "meeting-task-breakdown": { "content_id": "Hub返回的另一个12位ID", "version": "1.0.0" }
     }
   }
   ```

3. 用绑定文件生成可导入的 Agent 包：

   ```sh
   node --import tsx scripts/build-meeting-hub-packages.ts dist/meeting-bound-1.0.0 /path/to/published-skill-bindings.json
   ```

   生成器将模板中的依赖替换成目标 Hub ID。没有完整绑定时只生成 Skill 包，不生成含占位引用的 Agent 包。
   输出目录还包含两份相同的 Skill 输入包，已发布的 Skill 无需重复新建。

4. Agent 首次导入也**省略 `contentId`**，由 Hub 分配新 ID；确认两个引用均解析为已发布的独立 Skill 后发布。
5. 三项均设为默认安装；最低客户端版本按 `release.json` 设置为 `1.4.0`。
   RC 版本低于正式版本下限，本地验收使用独立的 `1.4.0` 测试构建，不降低发布内容的版本门。
6. 确认目录、默认安装清单和发布物下载正常，再发布客户端。

生成器不联网、不发布、不改用户安装目录；拒绝覆盖已有输出目录。
`import-manifest.json` 记录输入包摘要，不能当作 Hub 发布物摘要或发布回执。
版本、发布时间由 Hub 在发布时写入 `_meta.json`。

## 后续迭代

创建后保存 Hub 返回的内容 ID 和内容行 ID。后续升级同一内容：Skill 走新增草稿版本接口，Agent 导入新版本时携带已创建的 contentId；不要重复“新建”生成新 ID。

- 纪要/拆分规则变更：发布相应 Skill 的新版本。
- 编排变更：发布 Agent 新版本，继续引用同一 Hub Skill ID。
- 新增宿主工具或修改确认/数据协议：客户端也需更新，并提高最低版本。

安装、更新和管理界面复用现有 Marketplace 链路。独立 Skill 当前采用“本机已可用则复用”，没有 Agent 到 Skill 的最低版本约束；破坏兼容的跨内容改动需另行设计，不能假设多个包原子升级。
第一次获取会议内容需要连接 Hub；下载成功后可继续使用已有本地内容。
先前开发机中按旧 ID 安装的试验内容不属于本次面向新用户的迁移范围，不自动删改用户数据。

## 本次联调修复

- Hub `defaults` 的 `agent_json_url` 对新版包返回空串。详情 API 路径不是旧式 JSON 下载直链；客户端据此走已有 B-02 安装与依赖解析。
- 客户端后台更新查询同时给 Agent、Skill 目录传 `app_version`，与手动目录查询一致。
- 两端同源扫描器按合法 JSON 字符串的实际换行判定组合风险，避免把跨段落的确认凭证和提交动作误判成外发；保留同句外发、非法 JSON 检测，并覆盖 Unicode 编码。完整性 pin 同步更新，没有降低门禁。

Hub 对应本地改动在 `cogseed-hub` 仓库；实际发版需一并交付 Hub 修复，不能只发客户端。

## 验证状态

前一轮指定旧 ID 得到的 422 只证明“旧 ID 接管请求被拒绝”，不构成正常新建分发失败的证据。
本轮真实本地 Hub → 隔离 macOS 1.4.0 客户端已通过：正常新建导入与发布、默认下载、两个独立 Skill 引用就绪、界面可见、冷启动保持内容与引用。结果见
`docs/acceptance-evidence/v1.4.0-meeting-hub-20261028/initial-client-result.json`。
按用户要求停止后续验证；1.0.0 → 1.0.1 自动升级未执行，未进行真实会议或模型生成测试。本地结果不代表生产发布。
