# Agent 集成指南（桌面 Agent + 任意第三方 Skill + 强绑定）

本目录（07_agent_runtime）把扫描器升级为 Agent 的**内建安全网关**，覆盖 Skill
的完整生命周期，而不只是一次性扫描。

## 适用前提（已确认的产品决策）

1. 部署在**用户桌面** → 不假设有 Docker，隔离按来源分级降级。
2. 允许**任意第三方** Skill → 第三方来源默认最严 + 强制人工确认。
3. 扫描器与 Agent **强绑定** → 本网关是可信内建组件，用户不可替换。

## 两个网关，卡在 Agent 生命周期的两个点

```
用户 install <skill>            Agent 每次启动加载已装 skill
        │                               │
        ▼                               ▼
   install_gate()                   load_gate()
   扫描 + 来源策略 + 登记台账         重算哈希 + 台账比对（防 TOCTOU）
        │                               │
  allow/confirm/deny              allow_load / 拒绝(TAMPERED/UNKNOWN/DENIED)
```

## 用法

```python
import sys; sys.path.insert(0, "07_agent_runtime")
from skill_guard import install_gate, confirm_install, load_gate

# 安装时（source: official | community | thirdparty）
r = install_gate("/path/to/skill", source="thirdparty")
if r["decision"] == "deny":
    show(r["user_message"])                 # 直接拒绝
elif r["decision"] == "confirm":
    if user_confirms(r["user_message"]):     # 展示风险，让用户拍板
        confirm_install("/path/to/skill", source="thirdparty")
        do_install()
else:  # allow
    do_install()

# 每次 Agent 启动、加载某个已装 Skill 前
g = load_gate("/path/to/installed/skill")
if not g["allow_load"]:
    refuse_and_alert(g["user_message"])      # TAMPERED / UNKNOWN / DENIED
```

命令行等价：

```bash
python3 07_agent_runtime/skill_guard.py install <skill> --source thirdparty
python3 07_agent_runtime/skill_guard.py load <skill>
```

## 来源分级策略（skill_guard.SOURCE_POLICY）

| 来源 | 必须隔离 | 拒绝阈值 | 放行也需人工确认 |
|---|---|---|---|
| official | 否 | DO_NOT_INSTALL | 否 |
| community | 否 | CAUTION | 否 |
| thirdparty | **是** | CAUTION | **是** |

来源未知时按 thirdparty（最严）处理。第三方要求隔离，无 Docker 时 fail-closed 拒绝。

## 信任台账（trust_ledger.py）防 TOCTOU

- 扫描通过后记录 `skill_id@version → content_hash + verdict`。
- 加载前重算目录内容哈希与台账比对：
  - 一致 → TRUSTED，放行
  - 不一致 → TAMPERED（装后被改），拒绝并要求重扫
  - 无记录 → UNKNOWN（没扫过），拒绝
  - 曾判危 → DENIED，拒绝
- 台账默认 `~/.agent/skill_trust_ledger.json`，建议由 Agent 以受限权限持有，
  避免被普通 Skill 篡改。

## 已验证（真机 Docker）

| 场景 | 结果 |
|---|---|
| safe + official | allow，登记台账 |
| risky + thirdparty | deny（隔离扫描），用户可读原因 |
| 已登记 safe 加载 | TRUSTED，放行 |
| **登记后植入恶意文件再加载** | **TAMPERED，拒绝**（TOCTOU 防护生效） |
| 清理后再加载 | 恢复 TRUSTED |
| 未扫描 skill 加载 | UNKNOWN，拒绝 |

## 仍建议补的（按重要性）

1. ~~扫描器自身完整性自检~~ ✅ 已实现（trust_root.py，见下）
2. **无 Docker 的进程级隔离**：当前无 Docker 时是本地直跑（degraded），桌面场景
   建议加子进程 + 资源限额 + 只读的轻隔离，让非核心场景也有基础防护。
3. ~~台账防篡改~~ ✅ 台账工具已纳入信任根保护范围
4. **规则版本纳入重扫触发**：规则库升级后，用旧规则通过的 Skill 应触发重扫。

## 信任根（trust_root.py）—— 整条防护链的根

前面所有防护都假设“扫描器和规则是可信的”。信任根给这个假设一个保障：

- **基线 baseline**：记录 10 个关键文件（扫描器代码、规则库、网关、台账工具、
  Dockerfile 等）的 sha256，用 HMAC-SHA256 + Agent 密钥签名。
- **启动自检 verify_self()**：两个网关（install/load）在执行前都先自检。任一关键
  文件被改、或基线签名对不上 → COMPROMISED → fail-closed 停用网关拒绝操作。
- 攻击者能改文件，但没有密钥就伪造不出合法签名，篡改必被发现。

### 配置（与 Agent 部署一致，走环境变量）

| 环境变量 | 用途 |
|---|---|
| `AGENT_TRUST_KEY` | 直接提供 HMAC 密钥（推荐 Agent 启动注入） |
| `AGENT_TRUST_KEY_PATH` | 或密钥文件路径（默认 `~/.agent/trust_root.key`，0600） |
| `AGENT_TRUST_BASELINE` | 基线文件路径（默认 `07_agent_runtime/trust_baseline.json`） |

### 发布/部署流程

```bash
# 1) 发布打包时（可信环境）生成签名基线
AGENT_TRUST_KEY=<agent密钥> python3 07_agent_runtime/trust_root.py build

# 2) 运行时 Agent 每次启动先自检（install/load 网关已内建，也可单独调）
AGENT_TRUST_KEY=<agent密钥> python3 07_agent_runtime/trust_root.py verify
```

### 已验证（真机）

| 场景 | 结果 |
|---|---|
| 完好状态 install/load | 正常放行 |
| 篡改规则库后 install | COMPROMISED，fail-closed 拒绝 |
| 篡改扫描器代码后 load | COMPROMISED，拒绝加载 |
| 恢复文件后 | 恢复正常 |

### 边界

HMAC 是“防篡改”不是“防抵赖”。若攻击者已拿到 Agent 密钥（=已完全攻陷 Agent
本体），信任根无能为力——那已超出本模块威胁模型。强绑定分发中，密钥应随签名的
Agent 二进制保护，不落盘明文。
