# CogSeed 发版 AI 自查 Checklist

> 审核日期：2026-09-16（Asia/Shanghai）
> 审核对象：`develop` 当前工作区
> 执行方式：按《CogSeed-发版-AI提示词自查表》对完整增量和全库复核；本文件为审核记录，不替代发版负责人最终确认。

## 结论

- [x] 已覆盖完整增量，不按个人 PR 或个人负责模块缩小范围。
- [x] 本次清理后的敏感代号、品牌名、示例人名和构建产物转义命中已复核清零。
- [x] 测试、设计系统构建与离线校验已通过。
- [ ] **不能作为无条件发版通过**：`trufflehog` 未安装，检查未完成；提交历史仍有个人姓名，需发版负责人确认处理方式。

## 范围与状态

| 项目 | 结果 |
|---|---|
| 仓库 | `/Users/yinzhenyu1/Desktop/cogseed/cogseed` |
| 分支 | `develop` |
| 当前 HEAD | `9e63c7151e599bfca98d407b3d3b6b1741266a64` |
| 版本基线 | `ae0e3c8e`，v1.0.2 等价基线；v1.0.2 tag 不在 develop 祖先上 |
| package.json 版本 | `1.0.2`，发版版本号尚未 bump |
| 完整增量 | 25 个提交、893 个文件、672 新增 / 221 修改 / 0 删除、约 `+223108/-28871` 行 |
| 当前工作区 | 57 个未提交清理文件；本次仅新增本报告 |
| 扫描范围 | 全部代码、测试、脚本、文档、依赖、锁文件、资源和构建产物 |

## 26 项检查

| 勾选 | # | 检查项 | 实际命令 / 范围 | 结果与证据 |
|---|---:|---|---|---|
| [x] | 1 | NSEAP | `git grep -in NSEAP` | 0 命中 |
| [x] | 2 | MeshSeed | `git grep -in MeshSeed` | 0 命中 |
| [x] | 3 | ECS | `git grep -in ECS`；逐条判读实词 | 仅 `sbom.cdx.json` 中 AWS/ECS 依赖描述，按先例放行 |
| [x] | 4 | Forge | `git grep -in Forge`；排除 `forget`、`forged`、`forgery`、`.forge-meta`、`fire-and-forget` | 无独立内部代号命中；`unforgeable` 和 `.forge-meta` 为正常技术词 |
| [x] | 5 | Nexus | `git grep -in Nexus` | 0 命中 |
| [x] | 6 | Raymond | `git grep -in Raymond`；逐条判读 | 0 命中；SBOM 中第三方依赖作者信息不属于该标识 |
| [x] | 7 | 本版新增标识 | 本版未定义新增标识 | 不适用 |
| [x] | 8 | BONC / 东方国信 | `git grep -inE 'BONC\|东方国信'` | 命中均为 LICENSE、NOTICE、README、package.json、SBOM、公开接口、CI 联系方式等合法自我署名或公开入口 |
| [x] | 9 | 会议纪要 / 汇报 / 分工 / 待办 | `git grep -inE '纪要\|汇报\|分工\|待办' -- '*.md'`；人工抽查语境 | 命中为产品功能文案、公开技能文档或设计审核记录；无真实会议材料。按语境放行 |
| [x] | 10 | 内网地址 | `git grep -inE '10\.[0-9]+\.|192\.168\.|172\.(1[6-9]\|2[0-9]\|3[01])\.'` | 无真实内网地址；命中均为 SBOM/依赖版本、SVG 坐标或 SSRF 合成测试 IP，保留测试留痕 |
| [x] | 11 | 真实密钥 / token / 密码 | `gitleaks detect --source . --verbose --redact` | 退出码 1，共 9 条命中；均为测试用合成凭据或历史已删除文件，当前未发现真实凭据。命中详见下方 |
| [ ] | 12 | trufflehog 二次验证 | `trufflehog filesystem . --only-verified --max-symlink-depth=0 --json` | **未完成**：当前环境 `trufflehog: command not found`，不能写成通过 |
| [x] | 13 | `.env` / 配置样例 | `git ls-files` 检查 `.env`；人工检查 sample/example 文件 | 无追踪 `.env` 文件；未发现配置样例中的真实值 |
| [x] | 14 | 注释 / 人名 | `git grep -in @author`；按人名词表扫描源码和构建产物 | `@author` 0；源码及构建产物人名复扫 0。SBOM 中的第三方作者信息不属于源码人名 |
| [ ] | 15 | 提交记录个人姓名 | `git log --format='%an' \| sort \| uniq -c` | **待负责人确认**：历史仍有个人作者名；未做历史重写 |
| [x] | 16 | 提交记录非公司邮箱 | `git log --format='%ae' \| sort -u \| grep -vE '@bonc\.com\.cn\|@users\.noreply\.github\.com'` | 0 命中；仅公司邮箱和 GitHub noreply 邮箱 |
| [x] | 17 | `docs/` 内部文档 | `git ls-files \| grep '^docs/'`；逐个判性质 | 仅 `docs/DEVELOPMENT.md`，为通用开发指南 |
| [x] | 18 | `design-qa/` | `git ls-files \| grep '^design-qa/'` | 0 命中，已删除 |
| [x] | 19 | 内部脚本 | `git ls-files scripts/`；逐个判性质 | 77 个，均为构建、CI、运行时、联调或测试工具，无内部专用脚本 |
| [x] | 20 | 根目录残留 | `git ls-files`；人工核查根目录 | 31 个根目录文件，均为项目、许可证、公开说明、运行脚本或构建配置 |
| [x] | 21 | 新引入 GPL 等强传染协议 | 依赖 diff、SBOM、archify 锁文件许可证复核 | 根依赖与锁文件无变更；新增 archify 依赖为 MIT / BSD / ISC / CC0；无新增 GPL/AGPL/LGPL |
| [x] | 22 | 上游授权 / 署名 | 人工核对 LICENSE、NOTICE、README、第三方清单 | 许可证和 Orkas / OpenClaw / Hermes-Agent 来源声明完整；现有双许可证条目未在本版新增 |
| [x] | 23 | README 地址 / 占位符 | `grep -nE 'YOUR-ORG\|10\.' README*.md` | 0 命中 |
| [x] | 24 | README 死链 | 对 README 两个文件提取 URL 后逐条 `fetch` | 9 个链接：8 个 `200`，GitHub `.git` 地址 `301` 到规范地址；无死链 |
| [x] | 25 | 构建产物 unicode 转义复扫 | 解码 `git ls-files '*.js' resources/ dist/` 后扫描人名词表 | 1654 个文件，0 命中 |
| [x] | 26 | 依赖变更 SBOM 重核 | 比较基线与当前 `package.json` / `package-lock.json`，检查新增 archify 锁文件 | 根依赖无变更；新增 archify 为开发工具，锁文件与 package.json 一致，许可证已复核 |

## 工具与测试证据

- [x] `node tools/build.cjs`：`Built 58 components, 38 preview scripts, 32 cards.`
- [x] `node tools/verify.cjs`：38 项离线契约、92 个源码哈希通过。
- [x] `node tools/verify-agents.cjs`：10 项 Agent 离线契约通过。
- [x] 转写相关测试：11 个测试文件、238 个测试全部通过。
- [x] 4 个 EduSeed `runtime.js`：`node --check` 全部通过。
- [x] `git diff --check`：通过。

## 待处理项

1. 安装并重新执行 `trufflehog filesystem . --only-verified --max-symlink-depth=0 --json`，把 #12 补成有证据的结论。
2. 由发版负责人确认 #15 的提交历史个人姓名处理方式；如不重写历史，应在最终发版记录中明确放行依据。
3. package.json 当前仍为 `1.0.2`，正式发版前按发版流程确定并 bump 版本号、更新 CHANGELOG 和对应 SBOM。

## gitleaks 命中判读

`gitleaks` 共报告 9 条：8 条来自历史测试夹具（包括已删除文件），1 条来自当前 `test/main/features/p3394_bridge/remote-nodes.test.ts` 的 `tok-a` 合成测试 token；另有测试中的 JWT、Bearer、AWS/GitLab/Stripe 格式字符串，均用于脱敏或安全检测断言，未发现真实凭据。由于工具退出码为 1，本项保留“已核查的合成误报”而不是伪造为零命中。
