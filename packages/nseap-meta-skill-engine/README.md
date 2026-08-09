# NSEAP Meta-Skill Engine v2

企业智能体能力进化控制面 — 读取本体、采集交互、通过 KSTAR 方法论进化技能库和本体库。

## 快速开始

### 1. 安装依赖
```bash
cd meta-skill-engine
npm install
```

### 2. 编译（已预编译，可跳过）
```bash
npm run build
```

### 3. 运行 MCP Server
```bash
npm start
# 或开发模式
npm run dev
```

### 4. 配置 MCP Client
在 Claude Code / Cursor / VS Code 的 MCP 配置中添加：
```json
{
  "mcpServers": {
    "meta-skill-engine": {
      "command": "node",
      "args": ["/path/to/meta-skill-engine/dist/index.js"],
      "env": {
        "NSEAP_ONTOLOGY_DIR": "/path/to/meta-skill-engine/ontologies"
      }
    }
  }
}
```

## 架构

```
meta-skill-engine/
├── src/
│   ├── index.ts                      # MCP stdio 服务器入口（26 个工具）
│   ├── engine.ts                     # 纯库入口（进程内 loadEngine 加载，不启服务器）
│   ├── config/engine-config.ts       # 引擎配置（身份合约 + 护栏）
│   ├── types/
│   │   ├── index.ts                  # 核心类型定义
│   │   ├── evolution.ts              # KSTAR 进化类型（步骤/评估/运行）
│   │   └── snapshot.ts               # 快照类型
│   ├── utils/ids.ts                  # ID/哈希生成
│   ├── modules/                      # 10 个业务模块
│   │   ├── ontology-reader.ts        # ① 本体读取（TBox/RBox/ABox/实例）
│   │   ├── ontology-writer.ts        # ② 本体写入（Patch 落地）
│   │   ├── evidence-collector.ts     # ③ 证据采集 + KSTAR Episode
│   │   ├── attribution-engine.ts     # ④ 归因 + 聚合 + 路由
│   │   ├── evolution-orchestrator.ts # ⑤ KSTAR 进化编排
│   │   ├── patch-generator.ts        # ⑥ Patch 生成（有界编辑）
│   │   ├── governance-gates.ts       # ⑦ 三闸治理
│   │   ├── skill-creator.ts          # ⑧ Skill-Creator（双通道 + 评估迭代）
│   │   ├── registry-manager.ts       # ⑨ 注册表管理
│   │   └── llm-port.ts               # ⑩ LLM 端口（回退 + 类型）
│   ├── migration/
│   │   ├── legacy-pc-import.ts       # 旧 PC 数据导入
│   │   └── snapshot-migrations.ts    # 快照迁移
│   └── persistence/
│       ├── canonical-json.ts         # 规范化 JSON
│       ├── snapshot-state.ts         # 快照状态
│       └── tool-catalog.ts           # 工具目录
├── agents/
│   ├── grader.md                     # 评分 Agent 指令
│   └── analyzer.md                   # 分析 Agent 指令
├── ontologies/
│   └── university_paper_writing/     # 示例本体（大学生写论文）
│       ├── scene_tbox.yaml           # 概念层 — 41 类
│       ├── scene_rbox.yaml           # 规则层 — 30 规则
│       ├── scene_abox.yaml           # 实例层 — 22 示例 + 5 实例
│       ├── scene_mapping.yaml        # 映射层
│       └── scene_package.yaml        # 包清单
├── references/
│   ├── ontology-mapping.md
│   ├── kstar-evolution.md
│   └── governance-boundaries.md
├── scripts/check-engine.ts           # 自检脚本
├── test/                             # Vitest 测试
├── SKILL.md                          # 自身 SkillPackage（同构原则）
└── package.json
```

## 26 个 MCP 工具

| 类别 | 工具 |
|------|------|
| **引擎** | get_engine_info |
| **本体** | read_ontology, list_ontologies, extract_ontology_slice |
| **证据** | capture_interaction, query_episodes |
| **归因** | analyze_attribution, analyze_no_match, route_recommendation |
| **补丁** | propose_patch, run_governance, human_review |
| **创建** | create_skill, create_skill_auto, capture_intent |
| **评估** | generate_eval_cases, run_eval, grade_eval, grade_eval_llm, benchmark_skill, improve_skill, generate_eval_viewer, optimize_description |
| **注册表** | register_skill, list_registry |
| **配置** | get_engine_config |

## 双入口加载路径

- `dist/index.js` — MCP stdio 服务器入口，由宿主（Mate Agent / MCP Client）作为子进程拉起。
- `dist/engine.js` — 纯库入口，宿主进程内 `loadEngine` 直接加载，绝不启动 stdio 服务器；与子进程入口互不干扰。

## 全流程

```
读取本体 → 生成 Skill → 意图采集 → 测试用例 → 评估 → 评分 → 基准 → 迭代 → 三闸治理 → 入库
```

### 双通道触发
- **通道 1**：用户主动调用 `create_skill`
- **通道 2**：引擎归因发现"无匹配 Skill"时自动触发 `create_skill_auto`

### 三闸治理
| 闸 | 检查 |
|----|------|
| Validation Gate | 证据 >= 2 + 操作 <= 2 |
| Governance Gate | 受保护表面零违反 |
| Canary Gate | 风险等级 < 4 |

## 验证

```bash
# 运行自检
npm run check

# 全流程演示（需要 tsx）
npx tsx /tmp/test-full-v2.ts
```

## 许可证

内部使用 — NSEAP Team
