# EduSeed 课程客户端（内置版）

> 本目录是 CogSeed 产品内置的课程客户端包（builtin package）。
> 首次启动时由 `src/main/features/builtin_packages.ts` 种子进用户包树，用户无需手动安装。

## 与平台的关系

- 课程内容与业务数据全部在 EduSeed 平台（飞书多维表 + GitHub 内容仓库），本包不含课程内容（做薄原则）；
- 课程由 course_id 决定：插件面板「平台配置」或 `EDUSEED_COURSE_ID` 注入，默认试点课程；
- 授权：安装不授权，**激活才计数**（license-check + 平台席位，服务端强制）。

## 激活（零配置）

1. CogSeed「连接 → 插件」→ 本插件卡片 →「平台配置」；
2. 粘贴 `/companion` 页生成的 API Key（新版密钥自带平台地址）；
3. 保存后身份自动识别，授权徽章显示「已激活」，对话说「看看我的挑战」开始使用。

## 升级

- 本包随 CogSeed 版本发版升级（`_builtin.json` 的 source_version 变更时自动重装）；
- 无 git 源，不支持 `cogseed-pkg update`，请勿手动执行。
