---
name: kb-mindmap
description: Generate a local multi-level mind map from knowledge-base documents (NotebookLM-style hierarchical JSON for tree visualization), powered by the configured local model with no cloud upload. Use for 生成脑图/思维导图, 梳理文档结构/要点, or when the user opens the mind-map action in the knowledge-base Q&A panel. Do not use when the request targets a single conversation message instead of KB materials, or when no KB documents are selected.
---

# kb-mindmap — 知识库多级脑图（本地化 notebooklm mind-map）

> 改造自 `NotebookLM相关skill/notebooklm`：**保留其 mind-map 产物协议**（层级 JSON，
> 供可视化工具），**执行引擎从 Google NotebookLM 云换为 CogSeed 本地**——
> 基于知识库文档要点，由本地 LLM（DeepSeek，`auth.listModels` 已配置模型）生成
> 2–3 层思维导图，全程不上云（符合 CogSeed「本地推理 · 资料不上云」）。

## 激活

- 知识库问答区「🧠 生成脑图」按钮；或对话中意图「生成/梳理脑图 / 思维导图」。

## 能力

| 能力 | 本地实现 | 产物 |
|---|---|---|
| 多级思维导图 | `IPC kb.mindmap`（`features/kb_mindmap.ts`）：库内 ready 文档要点 → 本地 LLM → 层级 JSON | 层级 JSON（协议对齐 NotebookLM mind-map） |
| 渲染 | renderer `_mmTreeSvg`：多级水平树，渐变圆角节点、曲线连线、hover 高亮 | 对话区可交互 SVG |

## 产物协议（层级 JSON）

```json
{
  "root": {
    "label": "中心主题",
    "children": [
      { "label": "分支1", "children": [ { "label": "子节点1a", "children": [] } ] },
      { "label": "分支2", "children": [] }
    ]
  }
}
```
- 2–3 层；每个节点仅 `label` 与 `children` 两个字段；
- 与 `notebooklm download mind-map ./map.json` 的层级结构同构，可直接被第三方可视化工具消费。

## 数据源与缓存

- 输入：`contexts` 个人库（`dir`）或空间库（`spaceId`）的 ready 文档 chunk 要点
  （复用 `kb_summary.collectReadyDocLines`）；
- 库指纹缓存（rel_path/mtime/chunks 哈希），同指纹不重复调模型；
- 无文档或模型失败 → 降级为单节点 `{label:"知识库",children:[]}`，不报错卡死。

## 边界

- 只读管线：不写 chats / artifacts；模型调用 `disableTools: true` 仅生成结构；
- 不依赖 Google NotebookLM 云 / OAuth / 网络。
