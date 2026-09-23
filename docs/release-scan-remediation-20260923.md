# CogSeed 发版扫描整改记录（2026-09-23）

对照《CogSeed v1.2.0 全量扫描》待关闭项。本文件记录证据、已落地改动与仍需负责人拍板项。
**树侧与历史改写均已在本轮落地**（`git filter-repo` + force-push）。既有 clone 必须重新 clone 或 reset。仍待项见矩阵 #5 / tag。

扫描环境摘要：

| 工具 | 版本 / 命令 | 结果摘要 |
|---|---|---|
| Gitleaks | 8.24.3 · `gitleaks dir . --config .gitleaks.toml --redact` | 工作树合成测试/夹具类命中（见 #6）；历史命中见历史改写节 |
| TruffleHog | 3.88.29 · `filesystem . --only-verified --no-update`（排除 `node_modules`） | **已验证命中 0**（2026-09-23 residual scrub 复跑） |
| license-checker | 对 `npm ci --ignore-scripts` 后依赖树 | 见 #9 |
| README 链接 | `npm run readme:check` + 人工 `curl -I` 抽查 | 本地链接脚本通过；外链抽查 9/9 HTTP 200（见 #10） |
| Release / tag | `gh release list` + matching-refs | 最新正式版 **v1.1.2**；**无 v1.2.0 tag**（留给打包同学） |

相关分支 / PR：

- 首轮隐私清理：`chore/release-scan-privacy-cleanup` · https://github.com/bonc-ai/cogseed/pull/370（已合入 `develop` @ `091a7db`）
- 本轮残留清理：`chore/release-scan-residual-scrub-20260923`（树侧）+ 历史改写 force-push（见下文）

---

## 矩阵（2026-09-23 residual scrub 后）

| # | 扫描项 | 状态 | 说明 |
|---|---|---|---|
| 1 | 可核验的 v1.2.0 基线 / tag | **元数据已齐 · tag 留给打包** | 源码版本字段已对齐 1.2.0；GitHub 上仍无 `v1.2.0` tag（按要求不在本轮创建）。最新正式 release 仍为 v1.1.2，直至打包同学打 tag。 |
| 2 | 版本元数据 vs 目标 1.2.0 | **已对齐** | `package.json` / `package-lock` / `publiccode.yml` / `sbom.cdx.json` / CHANGELOG `## [1.2.0] - 2026-09-23` / README 文案一致为 **1.2.0**。 |
| 3 | 旧产品名（prior brand）残留 | **本轮已清** | 对旧 CamelCase 产品名的大小写不敏感检索 → **0** 命中。CHANGELOG / 本整改文档改写为「旧产品名残留 / legacy product name」，不再出现该字面量。ASR 错误形态 `mesh seed` / `mesh c` 保留（测试需要），正确目标为 CogSeed。 |
| 4 | 内部会议材料用语 | **本轮已清** | `specs/001-kb-continuity/spec.md` 与 `checklists/requirements.md` 已去掉「内部讨论稿 / 讨论纪要 / 摸底会」等表述，改为「需求调研记录 / 现状盘点评审」等中性产品用语。 |
| 5 | BONC / `cogseed-open.bonc.com.cn` | **待负责人放行/豁免** | 功能域名出现在 API 基址、onboarding 隐私/条款、更新日志链、测试断言；组织署名在 LICENSE/NOTICE/联系邮箱。**删除域名会破坏发行构建默认 Hub。** 未获删除批准前全部保留。 |
| 6 | Gitleaks / TruffleHog | **树侧已核** | TruffleHog verified = **0**。Gitleaks 工作树命中均为合成测试/夹具/xterm 误报形状；**不删除安全测试合成密文**。历史树中已删扫描报告命中 → 见「历史改写」节（用户已书面批准 filter-repo + force-push）。 |
| 7 | 提交作者 PII | **历史已改写（已批准）** | 已自全部分支历史移除 `fzywind@gmail.com`、`184377817@qq.com` 及其他个人 `gmail`/`qq` 提交身份，映射到 GitHub noreply。`git log --all --format="%ae %ce"` 个人邮箱 → 0。 |
| 8 | docs / scripts / 根目录发布清单 | **清单已出 · keep 为主** | 见下文；默认保留产品/测试/打包脚本；偏本地审计脚本可在发行 tarball exclude（待拍板），**不删除有用产品/测试脚本**。 |
| 9 | 许可证 | **结论已写** | 根包 `UNLICENSED`（与闭源/专有发行策略一致，需产品确认对外叙事）。`jszip` 为 MIT OR GPL-3.0-or-later，`THIRD_PARTY_NOTICES.md` 已声明选用 MIT。 |
| 10 | README 外链 + 人工复核 | **抽查通过** | `curl -I` 抽查 9 条关键外链（README 中的上游/生态项目与 shields badges 等）均为 HTTP 200。本地 `readme:check` 覆盖仓库内链。 |
| 11 | EOF / 空白 + RFC1918 豁免 | **本轮已补全** | 本文件已去掉行尾空白与多余 EOF 空行。SECURITY.md「Synthetic private addresses」已显式列出 `10.0.0.1`、`10.0.0.5`、`192.168.1.1`、`172.16.0.1` 及 link-local 元数据地址与用途。 |
| 12 | 人名脱敏（文档/样例脚本） | **本轮已清** | 本整改文档不再罗列个人中文姓名；`scripts/transcript-recall-metrics.ts` / `transcript-clean-run.ts` 中示例讲者改为 `ExampleSpeaker` / `ExamplePerson`。 |
| 13 | SBOM 上游作者字段 | **豁免（保留）** | `sbom.cdx.json` 中 `JP Richardson` 等为上游 npm 包 author 元数据，**不得剥离**；属第三方归因，非本仓库 PII。 |

---

## #5 BONC / 域名分类（待负责人放行/豁免）

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

## #6 Gitleaks / TruffleHog

### 工作树

- TruffleHog 3.88.29 verified_secrets = **0**（排除 `node_modules`，`--only-verified --no-update`）。
- Gitleaks 工作树命中落在：`test/**`、`resources/guardrail/skill-sentry/**`、`src/core-agent/test/tools.test.ts`、`src/renderer/vendor/xterm/xterm.js`（合成/误报）。
- 处置：保留测试；CI 建议 gitleaks ≥ 8.30.1 + 现有 allowlist。

### 历史（用户已批准；已执行）

- 已删文件 `CogSeed-发版扫描报告-牛保康-20260916.md`：已从**全部分支**历史移除；`git rev-list --objects --all` 无该路径。
- 个人邮箱：已映射并清除（含 `fzywind@gmail.com`、`184377817@qq.com` 及全库扫到的其他个人 gmail/qq）。
- `gitleaks detect --log-opts=v1.1.2..HEAD` → **no leaks found**。
- **所有既有 clone 必须重新 clone 或 hard-reset。**

---

## #7 / 历史改写策略

| 目标 | 映射 / 动作 |
|---|---|
| `fzywind@gmail.com` | → `3690992+windsgone@users.noreply.github.com`（保留既有 noreply 惯例） |
| `184377817@qq.com`（作者名「海韵」等） | → `Usernames686@users.noreply.github.com` / `Usernames686` |
| 其他个人 `gmail.com` / `qq.com` 提交身份 | → 对应已有 GitHub noreply，或 `Usernames686@users.noreply.github.com` |
| `business@bonc.com.cn` / `*@users.noreply.github.com` | **保留** |
| 路径 `CogSeed-发版扫描报告-牛保康-20260916.md` | 自**全部历史**删除 |
| `JP Richardson`（SBOM） | **豁免保留**（上游包 author） |

**未再使用「仅记录、不改写」默认**——本轮已获用户明确批准。

---

## #8 docs / scripts 清单（摘录）

**建议保留（产品 / 测试 / 打包）**

- 打包/原生/签名：`ensure-*-abi*`、`prepare-*-native-deps*`、`codesign-*`、`verify-packaged-*`、`verify-release-gates.mjs`
- 质量门：`check-readme-links.mjs`、`check-line-endings.mjs`、`sbom-check.cjs`、`reuse-check.cjs`、`run-tests.mjs`
- 产品诊断：`diagnose-local-agents.*`
- 转写评测：`transcript-recall-metrics.ts`、`transcript-clean-run.ts`（人名已脱敏为 Example*）

**偏本地/审计（默认保留源码；发行 tarball 可考虑 exclude，待拍板）**

- `scripts/audit-branch-diff.mjs`、`audit-kstar-precipitation.mjs`、`audit-local-workspace.mjs`
- `dev-delete-space-builder-conv.ts`、`dev-import-cogseed-review3.py`、`observe-skill-attribution.sh`
- `docs/superpowers/plans|specs/2026-09-21-windows-release-gate-failures*`（工程复现文档，非隐私汇报）
- 根目录 `README-源码包说明.txt`：保留；发行包是否附带由打包同学决定

**已删除（隐私）**

- `design/` 下内部汇报 / 台账 HTML（PR #370）
- 历史中的 `CogSeed-发版扫描报告-牛保康-20260916.md`（本轮 filter-repo）

---

## #9 许可证结论

| 包 | SPDX | 处置 |
|---|---|---|
| `cogseed` | UNLICENSED | 与根 LICENSE 专有声明并存；对外叙事需产品确认 |
| `jszip@3.10.1` | MIT OR GPL-3.0-or-later | 已在 `THIRD_PARTY_NOTICES.md` 声明选 MIT |
| `truncate-utf8-bytes` | WTFPL | 传递依赖，可接受 |
| `sanitize-filename` | WTFPL OR ISC | 传递依赖 |
| `expand-template` | MIT OR WTFPL | 传递依赖 |
| 其余 | 以 MIT/Apache-2.0/ISC/BSD 为主 | 无额外动作 |

---

## #10 README 外链抽查（2026-09-23）

| HTTP | URL |
|---|---|
| 200 | `https://github.com/openclaw/openclaw` |
| 200 | `https://github.com/NousResearch/hermes-agent` |
| 200 | shields.io Release / platform / downloads / license / stars badges |

未阻塞：其余仓库外链未全量探测；本地 `readme:check` 覆盖站内链接。

---

## #1 / #2 版本与 tag（待打包）

1. **正式发 1.2.0**：源码元数据已对齐；打 tag `v1.2.0` 并发 GitHub Release（需发布权限与完整门禁绿）——**留给打包同学**。
2. 本轮**不**自动创建 `v1.2.0` tag / 安装包。

---

## 本轮 residual scrub 已落地（树侧）

1. 旧产品名字面量自 CHANGELOG / 整改文档清除（大小写不敏感检索 → 0）
2. specs 内部会议用语中性化（需求调研记录 / 现状盘点评审）
3. 整改文档去掉个人中文姓名罗列；转写样例脚本人名 → ExampleSpeaker / ExamplePerson
4. SECURITY.md 补全 RFC1918 合成地址清单
5. 本文件行尾空白 / EOF 修复
6. TruffleHog verified=0 复跑记录
7. README 外链抽查记录
8. SBOM 上游作者（JP Richardson）显式豁免说明

---

## 历史改写与 force-push（用户已批准）

执行工具：`git-filter-repo`（路径删除 + 邮箱/作者映射）。

改写后核验目标：

- `git log --all --format='%ae %ce' | grep -E 'fzywind@gmail.com|184377817@qq.com'` → 空
- `git log --all --full-history -- '**/CogSeed-发版扫描报告*'` → 空
- `gitleaks detect` 在改写范围内不再报告该已删扫描报告路径

**警告**：force-push 后所有既有 clone / fork 必须 `git fetch` + reset 或重新 clone；勿在旧历史上继续提交。

### 仍待负责人 / 打包同学

| 项 | 状态 |
|---|---|
| BONC / `cogseed-open.bonc.com.cn` 功能默认 | **待负责人放行/豁免**（建议保留） |
| `v1.2.0` tag + 安装包 | **待打包同学** |
| 发行 tarball 是否 exclude `scripts/audit-*` | **可选，待拍板** |
| 中文姓名作为 GitHub noreply 显示名是否进一步匿名化 | 可选；本轮优先处理个人邮箱与已删报告 |

### 门禁（树侧，改写前后均应复跑）

| 命令 | 期望 |
|---|---|
| 旧 CamelCase 产品名检索（大小写不敏感） | 0 |
| `npm run audit:identity` | 通过 |
| `npm run readme:check` | 通过（或仅外链跳过） |
| `git diff --check`（本轮改动文件） | 无行尾空白 / EOF 问题 |
