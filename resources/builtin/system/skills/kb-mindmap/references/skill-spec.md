# kb-mindmap — 知识库多级脑图（本地化 notebooklm mind-map）

> 改造自 `NotebookLM相关skill/notebooklm`：**保留其 mind-map 产物协议**（层级 JSON，
> 供可视化工具），**执行引擎从 Google NotebookLM 云换为 CogSeed 本地**——
> 基于知识库文档要点，由本地 LLM（DeepSeek，`auth.listModels` 已配置模型）生成
> 3–4 层思维导图，全程不上云（符合 CogSeed「本地推理 · 资料不上云」）。

## 激活

- 知识库问答区「🧠 生成脑图」按钮（整库作用域）；或对话中意图「生成/梳理脑图 / 思维导图」。
- 知识库文件右键 / 「…」菜单「生成脑图（本文档）」：**文档级作用域**，根主题 = 这一份文档。

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
      { "label": "分支1", "children": [ { "label": "子节点1a", "children": [ { "label": "叶子1a-1", "children": [] } ] } ] },
      { "label": "分支2", "children": [] }
    ]
  }
}
```
- 一级分支 2–8 个、3–4 层、节点总数 ≤120；每个节点仅 `label` 与 `children` 两个字段
  （`source` 可选，用于溯源）；
- 与 `notebooklm download mind-map ./map.json` 的层级结构同构，可直接被第三方可视化工具消费。

## 数据源与缓存

- 输入作用域三档（`kb.mindmap` 的 `text` > `doc` > `dir`/`spaceId`）：
  - `dir` / `spaceId`：整库 ready 文档要点（**根主题 = 这个库是什么**，多文档库里一级分支
    容易退化成"按文件分"）；`mindKey` 为 `dir:<目录>` / `space:<空间>`；
  - `doc`：单文档（**根主题 = 这份文档的主题**，一级分支 = 它的章节），`mindKey` 为 `doc:<相对路径>`；
    共享库文件需同时传 `spaceId`；库里查不到该 ready 文件 → 降级原因 `not-found`；
  - 三档都复用 `kb_summary.collectReadyDocs`（标题块优先 + 全文等距取样，单文件 ≤12k 字、整库 ≤40k 字）；
- **作用域回执**：返回值带 `scope`（`doc`/`dir`/`space`/`text`）与 `files`（实际纳入的文件），
  渲染层必须校验"请求 doc ⇒ scope=doc 且 files 恰好是那一份"，不匹配就丢弃结果——
  防止主进程版本未重启/参数被忽略时，把整库脑图冒充成"本文档脑图"；
- 库指纹缓存（rel_path/mtime/chunks 哈希），同指纹不重复调模型；
- 无文档或模型失败 → 降级为单节点 `{label:"知识库",children:[]}`，不报错卡死。

## 边界

- 只读管线：不写 chats / artifacts；模型调用 `disableTools: true` 仅生成结构；
- 不依赖 Google NotebookLM 云 / OAuth / 网络。
