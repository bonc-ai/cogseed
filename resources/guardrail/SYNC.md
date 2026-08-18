# Guardrail 上游同步清单（SYNC.md）

两个 Guardrail 引擎的运行时源码 vendored 自桌面 `/Users/wu.j.y/Desktop/安全skill/`。
**同步原则：merge，永不 replace**——仓库里有上游没有的加固件，单向覆盖会删掉它们。

## 1. skill-sentry

| 项 | 值 |
|---|---|
| 上游源 | `/Users/wu.j.y/Desktop/安全skill/skill-sentry/` |
| 仓库树 | `resources/guardrail/skill-sentry/`（发布时随 extraResources 整树打包） |
| 版本 | SKILL.md frontmatter `version` + `engine/VERSION`（当前 2.1.0） |

同步内容：上游 `SKILL.md`、`engine/`、`runtime_trust/*.py`、`sandbox/`、`tools/`、`pyproject.toml`、`README.md`。

**仓库自有加固（merge 时保留，禁止上游覆盖）：**

- `vendor/yaml/` + `vendor/PyYAML-LICENSE` —— vendored PyYAML 6.0.3（W6），消除"机器是否装有系统 Python 决定规则覆盖"的差异。sentry-adapter 的探测与运行 env 注入 `PYTHONPATH=vendor`。
- 不放入 `tests/`、`docs/` —— 测试放 `resources/test/skill-sentry/`（见下），文档不进发布树。

**测试（`resources/test/skill-sentry/`）**，从上游 `tests/` + `runtime_trust/tests/` 复制，含三处 repo shim（同步时保留）：

1. `conftest.py` —— sys.path 注入引擎根与 sandbox 目录；`collect_ignore=['tests/fixtures']`（fixture 样例自带测试依赖样例自身路径，属样例质检而非引擎回归）。
2. `runtime_trust_tests/test_trust_root.py`、`test_trust_ledger.py` 的 `RUNTIME_TRUST_DIR` —— 指到仓库引擎路径（上游按自身目录布局计算，见文件中 `# REPO-SHIM` 注释）。

上游 `tests/conftest.py` 原样复制保留（插入无害路径）。

**同步后必跑：**

```bash
python3 -m pytest resources/test/skill-sentry -q          # 当前 153 passed
node scripts/run-python-tests.mjs resources/test/skill-sentry -q
node --import tsx scripts/pin-scanner-integrity.mjs       # 重生成 pin（发布时由打包流程执行）
node scripts/run-tests.mjs run test/main/features/security # TS 适配层回归
```

## 2. skill-declaration-core

| 项 | 值 |
|---|---|
| 上游源 | `/Users/wu.j.y/Desktop/安全skill/security-skills/nseap-skill-security-core/` |
| 仓库树 | `resources/guardrail/skill-declaration-core/` |
| 版本 | `VERSION`（当前 1.3.0；Ontology `ecs.security.skill@1.1.1`） |

同步内容：上游 `security_core/`、`scripts/`、`ontologies/`、`fixtures/`、`tests/`、`exit-code-registry.yaml`、`pyproject.toml`、`README.md`、`VERSION`。

**仓库自有加固（保留）：** `vendor/yaml/`（PyYAML 6.0.3）、`SKILL.md`（平台用法约定：判决在平台侧、风险派生已停用、冻结链无触发点）。上游的 `.gitignore`/`__pycache__` 不带入。

**同步后必跑：**

```bash
PYTHONPATH="$PWD/resources/guardrail/skill-declaration-core/vendor:$PWD/resources/guardrail/skill-declaration-core" \
  python3 resources/guardrail/skill-declaration-core/tests/run_conformance_smoke.py
# 引擎树有变更时重生成 skill-declaration-core.INTEGRITY（先清 __pycache__）
```

## 3. 上游还有、仓库未纳入的资产（有意不接）

- `security-skills/skills/` 下 5 个 ecs-* Cursor Skills + `nseap-skill-creator` —— 引擎 SKILL.md 保留用法约定；Creator 不接（产出协议不同层），`check_skill.py` 不接（TS 移植已是校验链）。
- `skill-sentry/docs/`、`skill-sentry/.pytest_cache/` —— 过程资产。

## 4. 打包契约（不得破坏）

- `package.json` extraResources：`resources/guardrail → guardrail`（matrix.test.ts 锁）。内部/开发构建整树随包（两引擎 + SYNC.md）。
- `scripts/strip-closed-source-scanner.mjs`：开源构建剥离四块——`skill-sentry/`、`skill-declaration-core/`（含其 `.INTEGRITY`）、`SYNC.md`、`resources/test/skill-sentry/`；写入 `SCANNER_ABSENT`；保留 `scan_gate.py`。
- `skill-sentry.INTEGRITY` / `SCANNER_ABSENT` 均 gitignored，发布时生成；`skill-declaration-core.INTEGRITY` 由 strip 移除。
- 公开仓库导出清单必须显式排除上述四块（gitignore 对已跟踪文件不生效，导出时按清单剔除；见 .gitignore 尾部注释）。
