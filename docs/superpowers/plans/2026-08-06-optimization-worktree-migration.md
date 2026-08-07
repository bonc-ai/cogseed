# optimization 工作树迁移实施计划

> **供代理执行者使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项执行本计划；步骤使用复选框（`- [ ]`）追踪进度。

**目标：** 将 `mate-agent-optimization` 中全部未提交改动迁移到 `dev/niubaokang` 分支上的 `mate-agent-dev` 工作树，且不得覆盖该工作树已有的改动。

**方案：** `dev/niubaokang` 已比 optimization 分支多 7 个提交，因此只迁移 optimization 工作树中的脏补丁。对无重叠的文件使用 Git 三方补丁应用；保留 dev 中已存在的等价改动；再为 `style.css` 追加仅存在于 optimization 中的群聊消息编辑样式，并复制其中两个新增测试文件。

**技术栈：** Git worktree、Git 三方补丁应用、Vitest、TypeScript、JavaScript、CSS。

## 全局约束

- 目标工作树：`/Users/an/东方国信项目/开源companion agent/mate-agent-dev`，分支为 `dev/niubaokang`。
- 源工作树：`/Users/an/东方国信项目/开源companion agent/mate-agent-optimization`，分支为 `codex/mate-agent-optimization`。
- 不得删除、重置、提交或以其他方式修改源工作树。
- 对双方都修改的文件，必须保留 dev 工作树当前的改动。
- `src/renderer/style.css` 必须同时保留侧栏品牌样式和群聊消息编辑样式。
- 不推送到 `origin`；前期检查时 Git 服务器不可访问。

---

### 任务 1：迁移不重叠的 optimization 改动

**文件：**
- 修改：`/Users/an/东方国信项目/开源companion agent/mate-agent-optimization` 中仅由 optimization 修改的所有已跟踪文件。
- 保留：`src/main/features/marketplace_reconcile.ts`
- 保留：`src/renderer/modules/model-authorization.js`
- 保留：`src/renderer/style.css`
- 保留：`test/main/features/marketplace_reconcile.test.ts`
- 保留：`test/renderer/model-authorization-ui.test.ts`

**接口：**
- 输入：通过 `git -C mate-agent-optimization diff --binary` 生成的未提交补丁。
- 输出：目标 dev 工作树获得全部不重叠的源改动。

- [ ] **步骤 1：记录当前工作树状态与补丁哈希**

运行：

```bash
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-dev' status --short --branch
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-dev' diff --binary | shasum -a 256
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-optimization' status --short --branch
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-optimization' diff --binary | shasum -a 256
```

预期：两个工作树均有未提交改动；dev 跟踪 `origin/dev/niubaokang`；optimization 保持不变。

- [ ] **步骤 2：生成源补丁，并排除 dev 中已有等价改动的五个文件**

运行：

```bash
cd '/Users/an/东方国信项目/开源companion agent/mate-agent-optimization'
git diff --binary > /tmp/mate-agent-optimization.patch
git diff --binary -- . \
  ':!src/main/features/marketplace_reconcile.ts' \
  ':!src/renderer/modules/model-authorization.js' \
  ':!src/renderer/style.css' \
  ':!test/main/features/marketplace_reconcile.test.ts' \
  ':!test/renderer/model-authorization-ui.test.ts' \
  > /tmp/mate-agent-optimization-nonoverlap.patch
```

预期：不重叠补丁包含源工作树的全部修改，但不包含上述五个重叠文件。

- [ ] **步骤 3：使用 Git 三方合并语义应用不重叠补丁**

运行：

```bash
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-dev' apply --3way --whitespace=nowarn /tmp/mate-agent-optimization-nonoverlap.patch
```

预期：命令以退出码 0 完成，且源工作树没有任何改动。

- [ ] **步骤 4：检查目标工作树的补丁是否存在空白错误**

运行：

```bash
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-dev' diff --check
```

预期：无输出，退出码为 0。

### 任务 2：合并 optimization 独有的群聊编辑样式与测试文件

**文件：**
- 修改：`src/renderer/style.css`
- 新增：`test/main/features/group_chat/message-edit.test.ts`
- 新增：`test/renderer/conversation-message-edit.test.ts`
- 保留：`test/renderer/sidebar-branding.test.ts`

**接口：**
- 输入：源工作树中的 CSS 差异，以及两个未跟踪的群聊编辑测试文件。
- 输出：dev 同时具备侧栏品牌、消息编辑展示样式及其测试覆盖。

- [ ] **步骤 1：确认侧栏样式块相同，并定位源工作树独有的 CSS 差异块**

运行：

```bash
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-dev' diff -- src/renderer/style.css
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-optimization' diff -- src/renderer/style.css
```

预期：两个补丁均包含相同的侧栏样式块；只有 optimization 包含 `.chat-msg-header-user` 附近的群聊消息编辑样式块。

- [ ] **步骤 2：只应用群聊消息编辑 CSS 差异块**

从源工作树复制以下起始内容：

```css
.chat-msg-header-user {
  justify-content: flex-end;
  gap: 4px;
}
```

以及以下结尾内容：

```css
@media (max-width: 720px) {
  .chat-message.is-message-editing {
    width: 92%;
    max-width: 92%;
  }
}
```

将完整差异块插入 `src/renderer/style.css`，位置为现有 ``/* `@<token>` mentions inside a chat bubble`` 注释之前。保留 dev 工作树已有的侧栏 CSS，不作变更。

- [ ] **步骤 3：只复制源工作树独有的两个未跟踪群聊测试文件**

运行：

```bash
cp '/Users/an/东方国信项目/开源companion agent/mate-agent-optimization/test/main/features/group_chat/message-edit.test.ts' \
  '/Users/an/东方国信项目/开源companion agent/mate-agent-dev/test/main/features/group_chat/message-edit.test.ts'
cp '/Users/an/东方国信项目/开源companion agent/mate-agent-optimization/test/renderer/conversation-message-edit.test.ts' \
  '/Users/an/东方国信项目/开源companion agent/mate-agent-dev/test/renderer/conversation-message-edit.test.ts'
```

预期：dev 中新增两个测试文件，同时保留已有的 `test/renderer/sidebar-branding.test.ts`。

- [ ] **步骤 4：验证合并后的 CSS 同时具备两个功能块**

运行：

```bash
rg -n 'container-type: inline-size|chat-message-edit-btn|chat-message-edit-composer' \
  '/Users/an/东方国信项目/开源companion agent/mate-agent-dev/src/renderer/style.css'
```

预期：三个选择器均存在。

### 任务 3：在不提交、不推送的前提下验证迁移结果

**文件：**
- 测试：`test/main/features/group_chat/message-edit.test.ts`
- 测试：`test/renderer/conversation-message-edit.test.ts`
- 测试：`test/main/features/marketplace_reconcile.test.ts`
- 测试：`test/renderer/model-authorization-ui.test.ts`
- 测试：`test/main/ipc/conversations-send-stream.test.ts`
- 测试：`test/main/runtime-variant.test.ts`
- 测试：`test/main/util/runtime-launcher.test.ts`
- 测试：`test/main/util/source-branding.test.ts`
- 测试：`test/main/util/source-runtime-bundle.test.ts`

**接口：**
- 输入：已完成迁移的 dev 工作树。
- 输出：已验证的本地迁移状态，以及保持未改变的 optimization 源工作树。

- [ ] **步骤 1：运行直接受影响的 JavaScript 与 TypeScript 测试**

运行：

```bash
cd '/Users/an/东方国信项目/开源companion agent/mate-agent-dev'
npx vitest run \
  test/main/features/group_chat/message-edit.test.ts \
  test/renderer/conversation-message-edit.test.ts \
  test/main/features/marketplace_reconcile.test.ts \
  test/renderer/model-authorization-ui.test.ts \
  test/main/ipc/conversations-send-stream.test.ts \
  test/main/runtime-variant.test.ts \
  test/main/util/runtime-launcher.test.ts \
  test/main/util/source-branding.test.ts \
  test/main/util/source-runtime-bundle.test.ts
```

预期：Vitest 以退出码 0 完成，且没有失败用例。

- [ ] **步骤 2：运行 TypeScript 校验**

运行：

```bash
cd '/Users/an/东方国信项目/开源companion agent/mate-agent-dev'
npm run typecheck
```

预期：退出码为 0。

- [ ] **步骤 3：确认源工作树在补丁级别保持完全不变**

运行：

```bash
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-optimization' diff --binary | shasum -a 256
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-optimization' status --short --branch
```

预期：SHA-256 为 `ebf30d06d8d091eb70c540b6daa0ff74294f780a9d8b75ebd051dd4910cb03a3`，且源工作树保留原始未提交状态。

- [ ] **步骤 4：检查最终目标工作树的改动范围**

运行：

```bash
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-dev' diff --check
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-dev' status --short --branch
git -C '/Users/an/东方国信项目/开源companion agent/mate-agent-dev' diff --stat
```

预期：没有空白错误；当前分支仍为 `dev/niubaokang`；不产生提交，也不执行推送。
