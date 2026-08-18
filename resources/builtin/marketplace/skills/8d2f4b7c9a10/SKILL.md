---
name: paper-repro
description_zh: "通过普通聊天引导用户复现论文对应的 GitHub 项目：先追问论文选区、仓库 URL、commit、本地 workspace 和成功标准，再生成 ProjectContext / TaskContract，用户确认后才协调 Commander、Hermes、Codex 或本地工具执行；适合“帮我跑一下这篇论文对应的 GitHub 项目”“复现这个 paper 的最小实验”“先跑通官方 example”。"
description_en: "Guide a user through reproducing a paper's GitHub project via normal chat: ask for the paper selection, repo URL, commit, local workspace, and success criteria; draft ProjectContext and TaskContract; execute through Commander, Hermes, Codex, or local tools only after user confirmation. For: 'run the GitHub project for this paper', 'reproduce this paper's minimal experiment', 'run the official example first'."
description: "Use for paper-to-GitHub reproduction tasks. Guide the user conversationally, establish traceable project context and task contract, require confirmation before execution, and keep evidence tied to files, logs, artifacts, and user decisions."
category: "research"
---

# Paper Repro

Use this skill when the user wants to run, reproduce, validate, or inspect a GitHub project associated with a research paper.

Typical triggers:

- “帮我跑一下这篇论文对应的 GitHub 项目”
- “复现这篇 paper 的最小实验”
- “run the GitHub repo for this paper”
- “can we reproduce the official example on my Mac?”
- “先把这个论文代码跑通”

This skill is a conversational workflow. Do not start from a forced form. The user should interact through the normal chat flow, while the system keeps structured state and evidence behind the scenes.

## Core Principle

Do not execute first. First establish the task.

```text
Natural user request
→ ask for missing paper/repo/workspace details
→ create ReferenceManifest
→ draft ProjectContext
→ draft TaskContract
→ ask for explicit user confirmation
→ execute through the appropriate agent/tool chain
→ summarize evidence, artifacts, and remaining uncertainty
```

## Conversation Flow

### 1. Start from the user's natural request

If the user says something like:

```text
帮我跑一下这篇论文对应的 GitHub 项目。
```

Respond conversationally:

```text
可以。我先帮你建立一个可追溯的论文复现任务。请先把你关心的论文段落或实验选区贴过来；如果你已经有 GitHub 仓库和 commit，也可以一起给我。
```

Do not ask the user to fill a schema manually unless they explicitly wants advanced editing.

### 2. Collect minimum inputs

Collect these fields in normal dialogue:

1. Paper selection or experiment paragraph.
2. GitHub repo URL.
3. Fixed commit, tag, or release version.
4. Local workspace path or confirmation that the repo needs to be cloned.
5. User's intended minimum result.
6. Success criteria if the user already knows them.

If a field is missing, ask only for the next missing field. Keep each question short.

### 3. Build ReferenceManifest

Once repo/commit/workspace are known, create or request a ReferenceManifest that answers:

- What did the system inspect?
- What did it skip?
- Why was it skipped?
- What sensitive boundary was respected?

Minimum shape:

```json
{
  "repo_url": "",
  "commit": "",
  "paper_selection": "",
  "included_files": [],
  "skipped_files": [],
  "sensitive_boundary": [],
  "read_time": ""
}
```

Important rules:

- Do not claim to have read files that were not inspected.
- Treat `.env`, credentials, secrets, keys, caches, dependency folders, build outputs, and very large files as excluded unless the user explicitly approves a bounded read.
- If the platform provides a Companion Repro state panel, rely on it as the source of truth for manifest state.

### 4. Draft ProjectContext

Use the manifest and user-selected paper text to draft a ProjectContext:

```json
{
  "project_goal": "",
  "tech_stack": [],
  "key_files": [],
  "sources": [],
  "uncertainties": [],
  "review_decisions": []
}
```

Always include uncertainties. Do not pretend the system understands the project completely.

Ask the user to correct important misunderstandings. Record corrections as review decisions:

```text
修正前：...
修正后：...
原因：...
```

### 5. Draft TaskContract

Before execution, produce a TaskContract:

```json
{
  "goal": "",
  "success_criteria": [],
  "context_refs": [],
  "plan": [],
  "risks": [],
  "requires_user_confirmation": true,
  "confirmed_by": null,
  "confirmed_at": null
}
```

Separate these concepts:

- User success criteria: what counts as accepted completion.
- System prediction: what might happen.
- Execution plan: what the system will actually do.
- Risk boundary: operations that require additional user approval.

### 6. Require explicit confirmation

Before running commands, dispatching Codex, editing files, installing dependencies, or starting agent execution, ask:

```text
这是我理解的任务契约。请确认后我再开始执行。
```

Do not execute if the user has not confirmed.

Accept confirmations like:

- “确认”
- “可以执行”
- “按这个来”
- “go ahead”

If the user changes goal/success criteria/risks, update the TaskContract and ask for confirmation again.

### 7. Execute through the right owner

After confirmation, coordinate execution through the normal Mate Agent path:

- Commander / Hermes for orchestration.
- Codex or local coding agents for code and shell work.
- File and artifact tools for reading, producing, and verifying outputs.

Do not bypass platform execution gates. Do not spawn local CLI agents outside the approved runner. Do not launch MCP servers directly.

### 8. Preserve evidence

At the end, report:

- What command or agent action ran.
- Exit status or failure status.
- Files changed.
- Artifacts created.
- Logs or snippets that prove the result.
- Which success criteria passed/failed.
- Remaining uncertainty.

If evidence is insufficient, say so. Do not convert weak evidence into a durable experience or skill candidate.

## Default Conversation Pattern

```text
User: 帮我跑一下这篇论文对应的 GitHub 项目。
Assistant: 可以。我先帮你建立一个可追溯的论文复现任务。请把论文选区或核心实验段落贴过来。
User: <paper selection>
Assistant: 收到。请提供 GitHub 仓库 URL 和固定 commit/tag/release。
User: repo 是 ... commit 是 ...
Assistant: 收到。请提供本地 workspace 路径，或告诉我是否需要先 clone。
User: /path/to/workspace
Assistant: 我会先生成 ReferenceManifest，记录读取和跳过的文件，然后形成 ProjectContext。敏感文件会跳过。
Assistant: <ProjectContext summary + uncertainties>
User: 这里修正一下，只跑最小 CPU sample，不跑 full training。
Assistant: 已记录修正。下面是 TaskContract，确认后我再执行。
User: 确认。
Assistant: 已确认。现在交给 Commander / Hermes / Codex 执行，并保留日志和 artifact。
```

## Failure Handling

- Repo URL missing: ask for URL, do not infer from paper title.
- Commit missing: ask for commit/tag/release; if user refuses, label it as unfixed version risk.
- Workspace missing: ask for local path or clone permission.
- Dependency install needed: explain scope before running.
- Command fails: preserve logs and classify as environment, dependency, code, data, permission, or unknown.
- Artifact missing: do not claim success.
- User rejects contract: stop or revise; do not repeatedly ask the same confirmation.

## What Not To Do

- Do not turn the flow into a mandatory form-first experience.
- Do not expose KSTAR terminology to the user unless explicitly asked.
- Do not execute before confirmation.
- Do not treat model predictions as success criteria.
- Do not claim all repo files were read.
- Do not create experience candidates without evidence.
- Do not use Replay as a substitute for a second real comparable task.

## Output Style

Use concise Chinese if the user writes Chinese; otherwise match the user's language.

Keep the user-facing flow natural:

- Ask one missing thing at a time.
- Explain why the information is needed.
- Show evidence and uncertainty.
- Keep advanced JSON/schema details behind expandable status or summary unless the user asks.

<!-- NSEAP-GATE:BEGIN -->
## NSEAP Gate 契约

- `use_when`：用户想运行、复现、验证或检查研究论文关联的 GitHub 项目（“帮我跑一下这篇论文的项目”“复现最小实验”“先跑通官方 example”），且愿意提供论文选区、仓库 URL、commit 与本地工作区。
- `do_not_use_when`：用户没有明确论文/仓库/commit 任何一项时直接开跑；任务只是阅读论文、写综述或改代码；未获用户确认就执行外部命令；要求执行无 trace 的任意命令。
- `positive_examples`：`Run the GitHub project for this paper with the pinned commit on my workspace.`；`Reproduce this paper's minimal experiment and show me the evidence.`
- `negative_examples`：`Just run the repo without telling me which commit or workspace.`；`Reproduce the results and fix the paper's claims if they're wrong.`

本 Skill 是 `execution · L5 · Full · sub_skill · interpreted` 的共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。
<!-- NSEAP-GATE:END -->
