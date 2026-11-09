# Hub 模板模拟响应

S5 模板目录与引用解析的测试夹具。字段按 `specs/010-hub-workspace-task-templates/contracts/client-hub-templates.md` §2 的**客户端假设**编写（契约未冻结）；Hub 答复后，随映射层一起更新。

| 文件 · 模板 | 覆盖 |
|---|---|
| `workspace-templates.json` · `ws-tpl-a` | 空间模板 A：内置角色模板 + 未安装的 Hub 技能；线上传 `project_dir: required`，客户端应降级为可选；两处留空 |
| `workspace-templates.json` · `ws-tpl-disabled` | 停用的模板不展示 |
| `workspace-templates.json` · `ws-tpl-too-new` | `min_app_version` 高于当前版本：可见不可创建 |
| `workspace-templates.json` · `ws-tpl-unknown` | 未知 `kind`（`workflow`）与未知 `availability`（`quarantined`）→ `unknown` |
| `scheduled-tasks.json` · `task-tpl-b` | 每日、主智能体执行（无 `execution_agent`）、要求 `tencent-meeting`、一处留空 |
| `scheduled-tasks.json` · `task-tpl-c` | 单次（只有类型，无时间）、指定 Hub 执行智能体 |
| `scheduled-tasks.json` · `task-tpl-disabled` | 停用的模板不展示 |

列表沿用 S4 列表接口的 `{ list, total }` 形态；详情字段平铺在信封顶层（同 `/marketplace/agents/detail`）。Hub 侧 id 均为虚构的 12 位十六进制；内置角色模板 `student` 与连接器 `tencent-meeting` 为客户端真实 id。
