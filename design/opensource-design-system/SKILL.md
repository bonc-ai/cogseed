---
name: cogseed-opensource-design
description: 基于已有组件维护 CogSeed 开源版设计系统的主题、品牌规范与页面样例，生成可供设计确认的本地预览。
user-invocable: true
---

先读 HANDOFF.md、readme.md 与目录 AGENTS.md，按「规范 → 共享组件 → 页面样例」修改。

当前任务只处理本设计包。复用现有组件、系统非衬线字体与本地 Lucide 图标，保留原开源绿色、CogSeed Logo 和松鼠品牌图形；不要把企业来源的品牌或业务专属场景当作开源要求。

普通图标继续走 Icon；品牌图形使用 assets/brand 中从客户端复制的现有资源。页面文案用简体中文与通用工作场景，模拟状态只保存在预览中。

修改 JSX、tokens 或卡片元数据后运行 node tools/build.cjs 和 node tools/verify.cjs，更新 verification.md。优先使用已有 esbuild 环境，可通过 COGSEED_ESBUILD_PATH 指定。

设计调整、浏览器检查、用户确认、正式客户端实施分别记录。未经用户另行明确要求，不修改客户端源码，不启动客户端实施、提交、推送或发布。
