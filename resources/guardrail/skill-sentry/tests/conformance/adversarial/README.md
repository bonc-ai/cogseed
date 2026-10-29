# 对抗向量门禁（adversarial）

把「已证实的绕过通道」变成随 `npm run test:resources` 一起跑的回归门禁。

## 判据

**escape = 本次裁决未达到该来源策略的 `fail_on` 阈值。**

来源策略取自 `runtime_trust/skill_guard.py::SOURCE_POLICY`（单一事实源，不在测试里
复制一份阈值）：`official=DO_NOT_INSTALL`、`community/thirdparty=CAUTION`。一条向量
必须**在所有来源上都被拒**才算没有逃脱。

不直接调 `install_gate` 的原因：它在沙箱可用时优先走 Docker，裁决来自镜像里那份
引擎（实测是 1.0.0，见下）。用 `install_gate` 当判据会让同一份向量在有 Docker 的
机器上测 1.0.0、没 Docker 的机器上测 2.2.0，门禁结论随环境漂移。本套件只测**当前
引擎**（`engine.scanner_core.scan`，无 Docker 依赖）；沙箱层单独做一致性检查。

## 测量前提：必须在完整规则集上跑

每次运行都会先打印本次实际用的规则集，并把它当作硬前提：

```
规则集  ruleset v1.1.0: secret-patterns.yaml, text-rules.yaml, 12 组规则 · 181 条规则 · 12 个组 · resolved=True
```

规则集读不到时引擎会**静默退回内置规则**——内置兜底 64 条规则、12 个组里的扩展
规则全部失效，完整规则集 181 条（原因与修法见
`engine/scanner_core/rule_loader.py::_import_yaml`）。那种状态下量出来的「逃脱率」
测的不是这个扫描器，所以 `full_ruleset_problem()` 一旦有话说，门禁直接判**本次
测量无效**并退出，`--update-baseline` 也会被拦住——不允许把残缺规则集下的结果冻
结成标准。守卫本身有测试（`TestMeasurementPrecondition`），不会失败的守卫不是守卫。

`baseline.json::ruleset` 记录这些数是在哪份规则集上量出来的（可追溯性，不是断言：
规则集一变分数就会变，届时本来就要重新冻结）。

## 向量

| 向量 | 类型 | 轴 | 通道 |
|---|---|---|---|
| `control-source-plain` | 对照 | — | 真源码里的 `rm -rf /`（判据零点） |
| `control-comment-marker` | 对照 | — | 反例标记写在注释里（正则不允许 `#` 前缀） |
| `control-indented-marker` | 对照 | — | 反例标记缩进深于载荷 |
| `attack-png-instruction` | 攻击 | 载体 | 图像 tEXt 块承载越权指令 |
| `attack-nested-archive` | 攻击 | 载体 | 嵌套归档内的脚本不被解包 |
| `attack-example-marker-doc` | 攻击 | 上下文 | 文档围栏 + 反例标记 → critical 洗成 info |
| `attack-example-marker-source` | 攻击 | 上下文 | 源码上下文同上 → 解除单条 critical 拒装 |
| `attack-assignment-docstring` | 攻击 | 变换 | `X = """…"""` 之后的真实代码被判成 comment |
| `attack-variable-mediated-b64` | 攻击 | 变换 | base64 落在资源文件 + 自研解码器还原 |

载体（PNG、zip、base64）在运行时生成，仓库里不提交二进制；`vectors.py` 的
`channel` / `root_cause` 说明每条通道是什么、根因在哪个文件。

## 基线语义（棘轮）

`baseline.json` 冻结每条向量的裁决、分数、`confirmed_critical`、`example_info`、
`max_severity` 与逃逸来源。

- 逃脱来源**变多** → 失败，真实回归。
- 逃脱来源**变少** → 也算失败，提示收紧基线：修复必须留下记账，不允许悄悄发生。
- 对照向量逃脱 → 失败并提示先修判据（判据零点失效时，攻击缺口没有解释力）。

```bash
# 校验（pytest / 直接跑都可以）
python3 -m pytest tests/conformance/adversarial -q
python3 tests/conformance/adversarial/run_adversarial.py

# 修复之后收紧基线（人工确认每条缺口后再提交）
python3 tests/conformance/adversarial/run_adversarial.py --update-baseline
```

## 沙箱层记录（当前仍是 known_gap）

沙箱裁决来自镜像内那份引擎，所以它是什么版本、给出什么结论，必须被记录。
实测 `skill-security-scanner:local` 内是 **1.0.0** 引擎，对
`os.system('rm -rf /')` 只给 `CAUTION/HIGH`（2.2.0 收紧前的行为），而
`sandbox/build.sh` 指向的 `06_sandbox/Dockerfile`、`Dockerfile` 里 COPY 的
`01_scanner/02_rules` 在当前树里都不存在——这个镜像重建不了。

**已止损**：`evaluate_skill` 改为两层取更严（隔离层可以加强结论、不能削弱结论），
两层结论与各自 `scanner_version` 都进 `tier_evidence`。于是落后镜像不再拉低安装
门禁：对照向量现在的最终裁决是 `DO_NOT_INSTALL`，`strictest_tier=degraded-local`。
但重建镜像前，隔离层作为「更强的证据」的价值仍然没有。不变量见
`test_gate_strictness.py`。

`baseline.json::sandbox_tier` 冻结了镜像的落后状态；本机没有 Docker 或没有镜像时，
`test_sandbox_tier.py` 跳过（跳过不是通过，报告里会写明这一层没测）。

```bash
python3 tests/conformance/adversarial/run_adversarial.py --record-sandbox-tier
```

## 不变量（比用例耐用）

1. 除 `hard_block` 外，任何降权不得把一份恶意样本从「被拒」推到「可装」。
   门禁层面由 `test_gate_strictness.py` 钉住：隔离层可以加强结论，不能削弱结论。
2. `scoring.py::is_confirmed_critical` 不得因文本变换而翻转。
3. 每个载体类型（文本 / 二进制 / 归档 / 图像 / 编码）至少有一条能被检出的对抗用例
   —— 目前**不满足**：图像与归档两条载体通道都是完全不可见（见上表）。
