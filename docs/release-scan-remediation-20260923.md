# CogSeed 发版扫描整改记录（2026-09-23）

对照《CogSeed v1.2.0 全量扫描》待关闭项。本文件记录证据、已落地改动与仍需负责人拍板项。
**在 #1/#2 版本基线未对齐且未获书面豁免前，不得宣称发版扫描通过。**

扫描环境摘要：

| 工具 | 版本 / 命令 | 结果摘要 |
|---|---|---|
| Gitleaks | 8.24.3 · `gitleaks dir . --config .gitleaks.toml --redact` | 工作树 28 条；几乎全部为测试/夹具/vendor 合成值（见下） |
| TruffleHog | 3.88.29 · `filesystem . --only-verified --no-update`（排除 `node_modules`） | **已验证命中 0** |
| license-checker | 对 `npm ci --ignore-scripts` 后依赖树 | 见 #9 |
| README 链接 | `npm run readme:check` | 本地 24 条通过；外链 22 条脚本跳过（需人工抽查） |
| Release / tag | `gh release list` + matching-refs | 最新正式版 **v1.1.2**；**无 v1.2.0 tag** |

分支与 PR：`chore/release-scan-privacy-cleanup` · https://github.com/bonc-ai/cogseed/pull/370

---

## 矩阵

| # | 扫描项 | 状态 | 说明 |
|---|---|---|---|
| 1 | 可核验的 v1.2.0 基线 / tag | **阻塞 · 待拍板** | 最新 release 为 v1.1.2；不存在 `v1.2.0` tag。禁止伪造 tag。 |
| 2 | 版本元数据 vs 目标 1.2.0 | **阻塞 · 待拍板** | `package.json` / `publiccode.yml` 仍为 **1.0.2**；README badge/文案写 **v1.2.0**；CHANGELOG 顶部为 `[Unreleased]`，最近版本节为 `1.0.2`。 |
| 3 | MeshSeed 残留 | **本分支已清** | `git grep -i MeshSeed` → 0。ASR 错误形态 `mesh seed` / `mesh c` 保留，正确目标为 CogSeed。 |
| 4 | 内部材料 | **大部分已清** | 已删内部汇报/台账 HTML。仍保留工程用 `docs/superpowers/plans|specs/*windows-release-gate-failures*`（失败复现设计，非隐私汇报）。 |
| 5 | BONC / `cogseed-open.bonc.com.cn` | **清单已出 · 待审批** | 约 113 处命中；功能域名出现在 API 基址、onboarding 隐私/条款、更新日志链、测试断言。组织署名出现在 LICENSE/NOTICE/联系邮箱。**删除域名会破坏发行构建默认 Hub。** |
| 6 | Gitleaks / TruffleHog | **已跑 · 分类完成** | TruffleHog verified = 0。Gitleaks 28 条均为合成测试/夹具/xterm 误报形状；仓库已有 `.gitleaks.toml` 精确豁免（SECURITY.md 要求 ≥8.30.1；本机 8.24.3 下 allowlist 未生效，建议 CI 升版本后复跑）。**不删除安全测试合成密文。** 历史树多出已删扫描报告中的命中。 |
| 7 | 提交作者 PII | **策略记录 · 不改写历史** | 唯一作者列表含 `海韵 <184377817@qq.com>`、`windsgone <fzywind@gmail.com>` 及中文姓名作者。email-gate 已允许部分地址。**未获书面批准前不做 history rewrite。** |
| 8 | docs / scripts / 根目录发布清单 | **清单已出 · keep 为主** | 见下文；默认保留产品/测试/打包脚本；标注偏本地审计的脚本供负责人决定是否移出发行源码包。 |
| 9 | 许可证 | **结论已写** | 根包 `UNLICENSED`（与闭源/专有发行策略一致，需产品确认对外叙事）。`jszip` 为 MIT OR GPL-3.0-or-later，`THIRD_PARTY_NOTICES.md` 已声明选用 MIT。另有 WTFPL / dual 依赖，均为传递依赖，见摘要。 |
| 10 | README 外链 + 人工复核 | **部分完成** | 本地链接检查通过。外链需人工抽查。ECS/Forge 误报需人工在扫描器侧复核（本仓库无自动化替代）。 |
| 11 | EOF 空行 + RFC1918 豁免 | **本分支处理** | `test/renderer/kb-glossary-manager.test.ts` 去掉文末多余空行。RFC1918/链路本地址用作断言输入的记录见 SECURITY.md「Synthetic private addresses」小节。 |

---

## #5 BONC / 域名分类（待审批）

### A. 建议保留（功能 / 归属 / 合规联系）

- `LICENSE` / `NOTICE` / `.reuse/dep5` / `CODE_OF_CONDUCT.md`：BONC 版权与 `business@bonc.com.cn`
- `src/main/features/api_base.ts`、`hub_account/client.ts`、`run.sh`：默认 `https://cogseed-open.bonc.com.cn`
- `src/renderer/index.html`、`onboarding.js`：更新日志 / 隐私 / 条款外链
- 对应单测中的期望 URL
- GitHub org `bonc-ai`、CODEOWNERS `@bonc-ai/reviewers`

### B. 设计原型中的同域链接（可择一替换为相对路径或占位）

- `design/opensource-design-system/ui_kits/enterprise-app/SettingsPanels.{js,jsx}`

### C. 不在未批准情况下批量删除

批量抹掉 BONC/域名会破坏发行默认 Hub、法律联系与归属信息，**不属于「无用内容清理」**。

---

## #6 Gitleaks 分类（工作树 28）

全部落在：

- `test/**` 凭证检测 / 脱敏 / 泄漏边界测试
- `resources/guardrail/skill-sentry/**` 风险技能夹具与规则样例
- `src/core-agent/test/tools.test.ts` 合成 token
- `src/renderer/vendor/xterm/xterm.js` 已知误报（已在 `.gitleaks.toml` 记录）

处置：保留测试；CI 使用 gitleaks ≥ 8.30.1 + 现有 allowlist；禁止为「扫干净」而掏空安全测试。

---

## #7 提交 PII 策略

| 作者形态 | 示例 | 处置 |
|---|---|---|
| GitHub noreply | `*@users.noreply.github.com` | 可接受 |
| 组织联系 | `business@bonc.com.cn` | 可接受 |
| 个人邮箱 | `184377817@qq.com`、`fzywind@gmail.com` | 记录；改写历史需书面批准 |
| 中文姓名作者 | 冯静雯、张浩、海韵、陈万康 等 | 开源协作常见；是否匿名化由负责人定 |

默认：**不** `git filter-repo` / force-push。

---

## #8 docs / scripts 清单（摘录）

**建议保留**

- 打包/原生/签名：`ensure-*-abi*`、`prepare-*-native-deps*`、`codesign-*`、`verify-packaged-*`、`verify-release-gates.mjs`
- 质量门：`check-readme-links.mjs`、`check-line-endings.mjs`、`sbom-check.cjs`、`reuse-check.cjs`、`run-tests.mjs`
- 产品诊断：`diagnose-local-agents.*`

**偏本地/审计（默认保留源码；发行 tarball 可考虑 exclude，待拍板）**

- `audit-branch-diff.mjs`、`audit-kstar-precipitation.mjs`、`audit-local-workspace.mjs`
- `dev-delete-space-builder-conv.ts`、`dev-import-cogseed-review3.py`、`observe-skill-attribution.sh`
- `docs/superpowers/plans|specs/2026-09-21-windows-release-gate-failures*`（工程复现文档，非隐私汇报）

**已删除（隐私）**

- `design/` 下内部汇报 / 台账 HTML（见 PR #370 既有提交）

---

## #9 许可证结论

| 包 | SPDX | 处置 |
|---|---|---|
| `cogseed@1.0.2` | UNLICENSED | 与根 LICENSE 专有声明并存；对外叙事需产品确认 |
| `jszip@3.10.1` | MIT OR GPL-3.0-or-later | 已在 `THIRD_PARTY_NOTICES.md` 声明选 MIT |
| `truncate-utf8-bytes` | WTFPL | 传递依赖，可接受 |
| `sanitize-filename` | WTFPL OR ISC | 传递依赖 |
| `expand-template` | MIT OR WTFPL | 传递依赖 |
| 其余 | 以 MIT/Apache-2.0/ISC/BSD 为主 | 无额外动作 |

---

## #1 / #2 版本对齐选项（待拍板）

1. **正式发 1.2.0**：对齐 `package.json` / `publiccode.yml` / CHANGELOG / README，打 tag `v1.2.0` 并发 GitHub Release（需发布权限与完整门禁绿）。
2. **文档降级到现状**：README 去掉虚假 v1.2.0 badge/文案，改与最新 release（如 v1.1.2）或 `package.json` 一致。
3. **书面豁免**：扫描报告接受「目标版本尚未打 tag」，本轮仅关闭隐私/密钥/许可证类项。

未选一项前，**不**自动 bump 或打 tag。

---

## 本 PR 已落地（隐私与可自动修复）

1. 删除内部设计汇报/台账材料  
2. MeshSeed → CogSeed 品牌清理  
3. specs 内部证据标题/人名脱敏  
4. EOF 多余空行（本提交）  
5. 本整改记录 + SECURITY.md RFC1918 豁免说明  

