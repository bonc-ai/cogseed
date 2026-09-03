# 2026-09-03-001 发版安全清理

- 状态：`completed`
- 日期：2026-09-03
- 分支：`codex/release-cleanup-0.8.0`
- 基线：`origin/develop` @ `882cb82399e61d5d82bcb0b4db645477b61968c9`
- 类型：direct work，无单独 plan

## 目标

仅对远端 `origin/develop` 基线完成发版阶段的敏感内容收口，不带入本地开发分支或本地主工作区改动。

## 交付内容

- 将模型探测测试夹具中的真实服务域名、provider 和模型名替换为中性示例数据。
- 按远端锁文件重新生成 SBOM。
- 确认正式门禁为 `npm run sbom:check` → `scripts/sbom-check.cjs`，删除未被工作流或 package script 引用、写死 624 组件的旧 `scripts/check-sbom.cjs`。
- 核验 `exif-parser@0.1.12` npm tarball与上游固定 commit 的许可证文本一致，将 MIT 原文和校验证据纳入第三方声明。
- 复核测试 fixture 命中均为公开合成数据；按发布负责人决定保留代码原状，以本记录作为豁免依据。
- 未修改业务行为；模型探测测试逻辑保持不变。

## 变更文件

- `p3394-gateway/models-probe.cjs`
- `test/main/features/p3394_bridge/gateway-models-probe.test.ts`
- `sbom.cdx.json`
- `scripts/check-sbom.cjs`（删除）
- `THIRD_PARTY_NOTICES.md`
- `third_party_licenses/exif-parser/LICENSE.md`

## Fixture 豁免依据

- `resources/builtin/marketplace/agents/e064dca9e1bd/skills/seo-crawl/test/test_crawl.py` 中的 RFC1918、6to4 和十进制 IP 是 SSRF 拒绝路径的公开测试输入；测试邮箱属于 HTML 链接解析 fixture。
- `resources/builtin-packages/eduseed-course-client/knowledge/git-github-guide.md` 中的 `git@github.com` 是 GitHub 官方 SSH 用户/主机语法，不是个人邮箱。
- 安全与鉴权测试中的 token、路径和邮箱用于验证脱敏、拒绝或投影边界，值为合成测试数据；不对这些文件做仅为消除扫描告警的改写。
- 上述豁免只适用于已复核的测试语境，不覆盖同一文件中未来新增的真实凭证或真实环境信息。

## 验证

- 模型探测测试：37/37 passed
- `npm run test:resources`：308 passed
- `npm run typecheck`：passed
- `npm run lint`：passed
- `npm run reuse:check`：passed
- `npm run readme:check`：passed
- `npm run tokens:check`：passed
- `npm run builtin:manifest:check`：passed（1288 files）
- `npm run sbom:check`：626 components in sync
- 最新 guardrail 专项测试：40/40 passed
- `exif-parser` tarball integrity：与 `package-lock.json` 的 SHA-512 一致
- `exif-parser` license：保留副本与 npm tarball、上游固定 commit 文本一致，SHA-256 为 `3c58bdcad5b1313456b7cf639574708a84a80ee6bddf1a26f0c5fc4d7ab1830b`
- `exif-parser` 许可证中的作者邮箱属于上游公开版权声明，必须原样保留；差异审计仅对 `third_party_licenses/exif-parser/LICENSE.md` 使用路径级 `PRIVACY_CONTACT` 豁免。
- 差异安全审计：`PASS_WITH_WARNINGS`，仅覆盖性提示。审计器按 CycloneDX `name` 裸字段比较 scoped package，曾将 9 个已存在组件误报为缺失；逐项确认它们均以标准 `group` + `name` 结构存在后，仅对 `sbom.cdx.json` 的该规则使用路径级豁免，正式 `npm run sbom:check` 仍独立通过。
- `npm audit --omit=dev`：发现当前锁文件中 7 个生产依赖告警（4 high、2 moderate、1 low、0 critical）；本任务未修改依赖或锁文件，需在最终 release 审核中另行处置或接受风险。
- `git diff --check`：passed

在基线 `415ea2b0` 上运行的完整 JS 测试结果为 900 个测试文件通过、9 个失败、8 个跳过；失败位于本次未修改模块，主要涉及隔离环境缺少 embedding-model、workspace 迁移、协作/KStar 时序及 embedding 不可用，未归因于本任务。同步最新 `origin/develop` @ `882cb823` 后未重新运行全量 JS，合并审核以 PR CI 为准。

## 遗留风险

- 全库审计会报告测试中的合成 token、路径和邮箱；已确认相关值为公开合成 fixture，本记录保留豁免依据，差异范围未发现真实凭证。
- 本机未安装 `trufflehog`，verified-only 二次扫描仍为 0.8.0 最终 release 阻断条件；本次只进入 `develop` 合并审核，不代表最终发版批准。
- 当前锁文件的生产依赖审计仍有 7 个告警；不阻止 cleanup 进入合并审核，但本记录不据此批准最终 release。
