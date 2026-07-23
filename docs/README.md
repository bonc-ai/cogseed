# Mate Agent 第三版文稿总目录

> 适用目录：`~/Documents/Mate Agent/`
>
> 这里汇总第三版 Mate Agent / Mate 智伴 的设计依据、规格文稿、实施计划与后续扩展材料。

---

## 1. 目录定位

第三版是基于 Orkas 基座开发的 Mate Agent / Mate 智伴 品牌版 MVP。当前重点是：

- 保留 Orkas Conversation / Agent Runtime 作为底层事实源
- 引入 P3394 的 Wake、KSTAR、Experience 闭环
- 将对外品牌切换为 Mate Agent
- 为指挥官增加可切换的后端配置（Orkas Core Agent / Hermes CLI）

---

## 2. 最快阅读顺序

如果你想最快理解第三版，建议按下面顺序看：

1. `../README.zh-CN.md` — 项目中文总说明
2. `./README.md` — 当前文稿总目录
3. `../目录说明.md` — 中文目录职责说明
4. `./superpowers/specs/2026-07-22-mate-agent-brand-design.md` — 品牌设计依据
5. `./superpowers/specs/2026-07-22-mate-agent-commander-backend-design.md` — 指挥官后端与模型配置设计
6. `./superpowers/plans/2026-07-22-mate-agent-brand-implementation.md` — 品牌实现计划
7. `./superpowers/plans/2026-07-22-mate-agent-commander-backend-implementation.md` — 指挥官后端实现计划

---

## 3. 设计依据

### 3.1 仓库级基座依据

- `../README.md` — Orkas 产品概述、核心设计、运行方式
- `../CLAUDE.md` — 当前仓库的设计约束、实现边界和工作规则

### 3.2 Mate Agent 品牌设计

- `./superpowers/specs/2026-07-22-mate-agent-brand-design.md`
- `./superpowers/plans/2026-07-22-mate-agent-brand-implementation.md`

### 3.3 指挥官后端与模型配置设计

- `./superpowers/specs/2026-07-22-mate-agent-commander-backend-design.md`
- `./superpowers/plans/2026-07-22-mate-agent-commander-backend-implementation.md`

---

## 4. 当前已确认的核心原则

1. **Orkas 是基座，不是新产品的对外品牌。**
2. **Mate Agent 是对外品牌，Mate 智伴是中文名。**
3. **P3394 负责治理闭环：Wake Gate、KSTAR、ExperienceCandidate。**
4. **指挥官默认仍可走 Orkas Core Agent。**
5. **Hermes CLI 可以作为指挥官后端，但必须通过 Adapter 接入。**
6. **云模型授权继续由现有 `auth` 体系负责，不再新建第二套密钥系统。**

---

## 5. 文稿索引

### 5.1 规格文档

- `./superpowers/specs/2026-07-22-mate-agent-brand-design.md`
- `./superpowers/specs/2026-07-22-mate-agent-commander-backend-design.md`

### 5.2 实施计划

- `./superpowers/plans/2026-07-22-mate-agent-brand-implementation.md`
- `./superpowers/plans/2026-07-22-mate-agent-commander-backend-implementation.md`

### 5.3 代码实现与测试依据

- `../src/main/features/p3394/wake-service.ts`
- `../src/main/features/p3394/kstar-runtime.ts`
- `../src/main/features/group_chat/bus.ts`
- `../src/main/features/local_agents/backends/hermes.ts`
- `../src/main/features/auth.ts`
- `../src/main/features/config.ts`
- `../test/main/features/p3394/kstar-runtime.test.ts`
- `../test/main/features/p3394/wake-service.test.ts`
- `../test/renderer/p3394-experience-controls.test.ts`

---

## 6. 已完成状态

- 品牌独立化：已完成
- P3394 Wake / KSTAR / Experience 最小闭环：已完成
- KSTAR 历史恢复修复：已完成
- 指挥官后端设计：已完成
- 指挥官后端实施计划：已完成
- 指挥官后端代码实施：待开始

---

## 7. 备注

如果后续继续扩展 PRM Agent、角色级模型绑定、多 Agent 协作或云同步，应优先先更新这里的索引页，再补对应的规格和实施计划，避免文稿分散。
