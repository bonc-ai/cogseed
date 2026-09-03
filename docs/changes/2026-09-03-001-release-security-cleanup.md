# 2026-09-03-001 发版安全清理

- 状态：`completed`
- 日期：2026-09-03
- 分支：`codex/release-cleanup-0.8.0`
- 基线：`origin/develop` @ `415ea2b01945c26565abd30b86085879bc663f2e`
- 类型：direct work，无单独 plan

## 目标

仅对远端 `origin/develop` 基线完成发版阶段的敏感内容收口，不带入本地开发分支或本地主工作区改动。

## 交付内容

- 将模型探测测试夹具中的真实服务域名、provider 和模型名替换为中性示例数据。
- 为公开测试中的邮箱和私网 IP 示例补充 `test fixture` 标识，避免误判为泄露。
- 按远端锁文件重新生成 SBOM，并更新内置资源 manifest。
- 未修改业务行为；模型探测测试逻辑保持不变。

## 变更文件

- `p3394-gateway/models-probe.cjs`
- `test/main/features/p3394_bridge/gateway-models-probe.test.ts`
- `resources/builtin/marketplace/agents/e064dca9e1bd/skills/seo-crawl/test/test_crawl.py`
- `resources/builtin-packages/eduseed-course-client/knowledge/git-github-guide.md`
- `sbom.cdx.json`
- `resources/builtin/_manifest.json`

## 验证

- 模型探测测试：37/37 passed
- `npm run test:resources`：308 passed
- `npm run typecheck`：passed
- `npm run lint`：passed
- `npm run reuse:check`：passed
- `npm run readme:check`：passed
- `npm run tokens:check`：passed
- `npm run builtin:manifest:check`：passed
- `npm run sbom:check`：626 components in sync
- 差异安全审计：`PASS_WITH_WARNINGS`，仅覆盖性提示
- `git diff --check`：passed

完整 JS 测试结果为 900 个测试文件通过、9 个失败、8 个跳过；失败位于本次未修改模块，主要涉及隔离环境缺少 embedding-model、workspace 迁移、协作/KStar 时序及 embedding 不可用，未归因于本任务。

## 遗留风险

- 旧 `scripts/check-sbom.cjs` 仍写死 624 个组件，并报告 `exif-parser` 缺少 license 元数据，需发布负责人另行确认。
- 全库审计会报告测试中的合成 token、路径和邮箱；差异范围未发现真实凭证。
- 本机未安装 `trufflehog`，未执行 verified-only 二次扫描。
