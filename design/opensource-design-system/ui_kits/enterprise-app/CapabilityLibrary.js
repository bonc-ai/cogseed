/* Generated from ui_kits/enterprise-app/CapabilityLibrary.jsx by tools/build.cjs. */
(() => {
  (() => {
    const { Button, IconButton, Icon, Input, Textarea, Field, DropdownMenu, Dialog, EmptyState, Select } = window.CogSeedDesignSystem_f581b5;
    const seed = [
      { id: "policies", parent: null, name: "\u5236\u5EA6\u6587\u4EF6", kind: "dir" },
      { id: "templates", parent: null, name: "\u4E1A\u52A1\u6A21\u677F", kind: "dir" },
      { id: "policy", parent: "policies", name: "\u9879\u76EE\u7BA1\u7406\u529E\u6CD5.md", kind: "file", text: "# \u9879\u76EE\u7BA1\u7406\u529E\u6CD5\n\n## \u6750\u6599\u6838\u9A8C\n\u6838\u5BF9\u4F01\u4E1A\u57FA\u672C\u4FE1\u606F\u3001\u8D22\u52A1\u62A5\u8868\u4E0E\u9879\u76EE\u7533\u8BF7\u6750\u6599\u3002\n\n## \u98CE\u9669\u590D\u6838\n\u9010\u9879\u8BB0\u5F55\u5F02\u5E38\u8D22\u52A1\u6307\u6807\u3001\u62C5\u4FDD\u53D8\u5316\u53CA\u6750\u6599\u7F3A\u5931\u9879\u3002" },
      { id: "checklist", parent: "templates", name: "\u8C03\u7814\u6750\u6599\u6E05\u5355.md", kind: "file", text: "# \u8C03\u7814\u6750\u6599\u6E05\u5355\n\n- \u4F01\u4E1A\u57FA\u672C\u4FE1\u606F\n- \u6700\u8FD1\u4E09\u5E74\u8D22\u52A1\u62A5\u8868\n- \u9879\u76EE\u7528\u9014\u53CA\u8FD8\u6B3E\u6765\u6E90\n- \u62C5\u4FDD\u6750\u6599\n- \u5F85\u8865\u5145\u6750\u6599\u4E0E\u590D\u6838\u610F\u89C1" },
      { id: "report", parent: "templates", name: "\u8FDB\u5C55\u7B80\u62A5\u6A21\u677F.md", kind: "file", text: "# \u8FDB\u5C55\u7B80\u62A5\n\n\u7EDF\u8BA1\u671F\u95F4\uFF1A\n\u6838\u5FC3\u6307\u6807\uFF1A\n\u53D8\u5316\u539F\u56E0\uFF1A\n\u5F85\u6838\u9A8C\u4E8B\u9879\uFF1A" }
    ];
    let libraryNodes = seed;
    const row = { display: "flex", alignItems: "center", gap: "var(--cs-space-2)" };
    const textExtensions = /\.(md|txt|csv|json|yaml|yml|log|xml|html|css|js)$/i;
    function CapabilityLibrary({ onSearch, onUse }) {
      const [nodes, setNodes] = React.useState(() => libraryNodes), [selected, setSelected] = React.useState(null), [expanded, setExpanded] = React.useState(["policies", "templates"]);
      const [rename, setRename] = React.useState(null), [draft, setDraft] = React.useState(null), [dialog, setDialog] = React.useState(null), [notice, setNotice] = React.useState(""), [busy, setBusy] = React.useState(false);
      const picker = React.useRef(null), target = React.useRef(null), counter = React.useRef(0), root = React.useRef(null), renameRow = React.useRef(null);
      const chosen = nodes.find((n) => n.id === selected), count = nodes.filter((n) => n.kind === "file").length;
      React.useEffect(() => {
        libraryNodes = nodes;
      }, [nodes]);
      const newId = () => `library-${Date.now()}-${counter.current++}`;
      const expand = (id) => {
        if (id) setExpanded((old) => old.includes(id) ? old : [...old, id]);
      };
      const descendants = (id) => {
        const ids = /* @__PURE__ */ new Set([id]);
        let changed = true;
        while (changed) {
          changed = false;
          nodes.forEach((n) => {
            if (ids.has(n.parent) && !ids.has(n.id)) {
              ids.add(n.id);
              changed = true;
            }
          });
        }
        return ids;
      };
      const nameError = (name, parent, id) => !name.trim() ? "\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A" : /[\\/\x00-\x1f]/.test(name) || name === "." || name === ".." ? "\u540D\u79F0\u4E0D\u80FD\u5305\u542B\u659C\u6760\u6216\u8DEF\u5F84\u7B26\u53F7" : nodes.some((n) => n.id !== id && n.parent === parent && n.name === name.trim()) ? "\u540C\u4E00\u6587\u4EF6\u5939\u4E0B\u5DF2\u6709\u6B64\u540D\u79F0" : "";
      React.useEffect(() => {
        if (rename) {
          const el = renameRow.current?.querySelector("input");
          el?.focus();
          el?.select();
        }
      }, [rename?.id]);
      const beginRename = (n) => {
        setRename({ id: n.id, name: n.name, error: "" });
      };
      const saveName = () => {
        if (!rename) return;
        const n = nodes.find((n2) => n2.id === rename.id);
        const error = nameError(rename.name, n.parent, n.id);
        if (error) {
          setRename({ ...rename, error });
          return;
        }
        setNodes((old) => old.map((n2) => n2.id === rename.id ? { ...n2, name: rename.name.trim() } : n2));
        setRename(null);
      };
      const create = (kind, parent) => {
        if (draft !== null) {
          setNotice("\u8BF7\u5148\u4FDD\u5B58\u6216\u53D6\u6D88\u6B63\u5728\u7F16\u8F91\u7684\u6587\u4EF6");
          return;
        }
        expand(parent);
        let name = kind === "dir" ? "\u65B0\u5EFA\u6587\u4EF6\u5939" : "\u672A\u547D\u540D.md", i = 1;
        while (nodes.some((n2) => n2.parent === parent && n2.name === name)) name = kind === "dir" ? `\u65B0\u5EFA\u6587\u4EF6\u5939 ${i++}` : `\u672A\u547D\u540D ${i++}.md`;
        const n = { id: newId(), kind, parent, name, text: kind === "file" ? "" : void 0 };
        setNodes((old) => [...old, n]);
        if (kind === "file") setSelected(n.id);
        beginRename(n);
        setNotice("");
      };
      const choose = (n) => {
        if (draft !== null && selected !== n.id) {
          setDialog({ type: "discard", next: n.id });
          return;
        }
        setSelected(n.id);
        setNotice("");
      };
      const upload = (parent) => {
        target.current = parent;
        picker.current?.click();
      };
      const importFiles = async (event) => {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        if (!files.length) return;
        setBusy(true);
        setNotice("\u6B63\u5728\u8BFB\u53D6\u6240\u9009\u6587\u4EF6");
        try {
          const additions = [];
          let conflicts = 0;
          for (const file of files) {
            if (nodes.concat(additions).some((n) => n.parent === target.current && n.name === file.name)) {
              conflicts++;
              continue;
            }
            const readable = textExtensions.test(file.name) && file.size <= 2 * 1024 * 1024;
            additions.push({ id: newId(), kind: "file", parent: target.current, name: file.name, text: readable ? await file.text() : null, size: file.size });
          }
          setNodes((old) => [...old, ...additions]);
          expand(target.current);
          setNotice(`\u5DF2\u6DFB\u52A0 ${additions.length} \u4E2A\u6587\u4EF6${conflicts ? `\uFF0C${conflicts} \u4E2A\u540C\u540D\u6587\u4EF6\u672A\u6DFB\u52A0` : ""}`);
        } catch {
          setNotice("\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u6587\u4EF6");
        } finally {
          setBusy(false);
        }
      };
      const edit = (n) => {
        if (n.text === null) return;
        choose(n);
        if (draft === null || selected === n.id) setDraft(n.text);
      };
      const rootItems = (parent) => [{ label: "\u65B0\u5EFA\u6587\u672C", onSelect: () => create("file", parent) }, { label: "\u65B0\u5EFA\u6587\u4EF6\u5939", onSelect: () => create("dir", parent) }, { label: "\u6DFB\u52A0\u6587\u4EF6", onSelect: () => upload(parent) }];
      const menuGroups = (n) => n.kind === "dir" ? [{ items: rootItems(n.id) }, { items: [{ label: "\u91CD\u547D\u540D", onSelect: () => beginRename(n) }, { label: "\u6574\u7406\u5230\u6587\u4EF6\u5939", onSelect: () => setDialog({ type: "move", node: n, destination: "" }) }] }, { danger: true, items: [{ label: "\u5220\u9664", onSelect: () => setDialog({ type: "delete", node: n }) }] }] : [{ items: [...n.text !== null ? [{ label: "\u7F16\u8F91", onSelect: () => edit(n) }] : [], { label: "\u91CD\u547D\u540D", onSelect: () => beginRename(n) }] }, { danger: true, items: [{ label: "\u5220\u9664", onSelect: () => setDialog({ type: "delete", node: n }) }] }, { items: [{ label: "\u8BE2\u95EE\u4E3B\u667A\u80FD\u4F53", onSelect: () => onUse ? onUse({ name: n.name, text: n.text || "", reference: n.name }) : setNotice("\u8BF7\u4ECE\u4EFB\u52A1\u8F93\u5165\u53F0\u5F15\u7528\u6B64\u6587\u4EF6") }, { label: "\u6574\u7406\u5230\u6587\u4EF6\u5939", onSelect: () => setDialog({ type: "move", node: n, destination: "" }) }, { label: "\u5728\u7CFB\u7EDF\u4E2D\u6253\u5F00", onSelect: () => setNotice("\u5F53\u524D\u9875\u9762\u65E0\u6CD5\u6253\u5F00\u7CFB\u7EDF\u6587\u4EF6\uFF0C\u8BF7\u4F7F\u7528\u684C\u9762\u5BA2\u6237\u7AEF") }] }];
      const renderBranch = (parent, depth = 0) => nodes.filter((n) => n.parent === parent).sort((a, b) => a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1).map((n) => /* @__PURE__ */ React.createElement(React.Fragment, { key: n.id }, /* @__PURE__ */ React.createElement("div", { style: { ...row, paddingLeft: `calc(var(--cs-space-2) + ${depth} * var(--cs-space-4))`, minHeight: "var(--cs-row-list)", background: selected === n.id ? "var(--cs-accent-wash)" : void 0, borderRadius: "var(--cs-radius-md)" } }, rename?.id === n.id ? /* @__PURE__ */ React.createElement("div", { ref: renameRow, style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Field, { error: rename.error }, /* @__PURE__ */ React.createElement(Input, { "aria-label": `\u91CD\u547D\u540D ${n.name}`, size: "md", value: rename.name, onChange: (e) => setRename({ ...rename, name: e.target.value, error: "" }), onKeyDown: (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") {
          e.preventDefault();
          saveName();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setRename(null);
        }
      } })), /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: saveName }, "\u4FDD\u5B58\u540D\u79F0"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => setRename(null) }, "\u53D6\u6D88")) : /* @__PURE__ */ React.createElement(Button, { variant: "ghost", "aria-expanded": n.kind === "dir" ? expanded.includes(n.id) : void 0, "aria-pressed": n.kind === "file" ? selected === n.id : void 0, style: { flex: 1, minWidth: 0, justifyContent: "flex-start", padding: "0 var(--cs-space-1)" }, icon: /* @__PURE__ */ React.createElement(Icon, { name: n.kind === "dir" ? expanded.includes(n.id) ? "chevronDown" : "chevronRight" : "fileText", size: 14 }), onClick: () => n.kind === "dir" ? setExpanded((old) => old.includes(n.id) ? old.filter((id) => id !== n.id) : [...old, n.id]) : choose(n) }, /* @__PURE__ */ React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis" }, title: n.name }, n.name)), /* @__PURE__ */ React.createElement(DropdownMenu, { align: "start", trigger: /* @__PURE__ */ React.createElement(IconButton, { variant: "quiet", size: "sm", title: `${n.name} \u66F4\u591A\u64CD\u4F5C` }, /* @__PURE__ */ React.createElement(Icon, { name: "dots", size: 14 })), groups: menuGroups(n) })), n.kind === "dir" && expanded.includes(n.id) && renderBranch(n.id, depth + 1)));
      const folderPath = (n) => {
        const parent = nodes.find((p) => p.id === n.parent);
        return parent ? `${folderPath(parent)} / ${n.name}` : n.name;
      };
      const destinations = dialog?.type === "move" ? [{ id: "", label: "\u8D44\u6599\u5E93\u6839\u76EE\u5F55" }, ...nodes.filter((n) => n.kind === "dir" && !descendants(dialog.node.id).has(n.id)).map((n) => ({ id: n.id, label: folderPath(n) }))] : [];
      const closeDialog = () => setDialog(null);
      const confirmDialog = () => {
        if (dialog.type === "discard") {
          setSelected(dialog.next);
          setDraft(null);
          closeDialog();
          return;
        }
        if (dialog.type === "delete") {
          const removed = descendants(dialog.node.id);
          setNodes((old) => old.filter((n) => !removed.has(n.id)));
          if (removed.has(selected)) {
            setSelected(null);
            setDraft(null);
          }
          if (removed.has(rename?.id)) setRename(null);
          closeDialog();
          setNotice("\u5DF2\u5220\u9664");
          return;
        }
        if (dialog.type === "move") {
          const parent = dialog.destination || null;
          if (nameError(dialog.node.name, parent, dialog.node.id)) {
            setDialog({ ...dialog, error: "\u76EE\u6807\u6587\u4EF6\u5939\u5DF2\u6709\u540C\u540D\u6587\u4EF6\uFF0C\u8BF7\u9009\u62E9\u5176\u4ED6\u4F4D\u7F6E" });
            return;
          }
          setNodes((old) => old.map((n) => n.id === dialog.node.id ? { ...n, parent } : n));
          expand(parent);
          closeDialog();
          setNotice("\u5DF2\u79FB\u52A8");
        }
      };
      return /* @__PURE__ */ React.createElement("section", { ref: root, "aria-label": "\u8D44\u6599\u5E93", style: { display: "flex", flexDirection: "column", gap: "var(--cs-space-4)", minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: row }, /* @__PURE__ */ React.createElement("h2", { style: { margin: 0, font: "var(--cs-type-title)" } }, "\u8D44\u6599\u5E93"), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement(IconButton, { title: "\u641C\u7D22\u8D44\u6599\u5E93", onClick: () => onSearch?.() }, /* @__PURE__ */ React.createElement(Icon, { name: "search", size: 15 }))), /* @__PURE__ */ React.createElement("div", { style: row }, /* @__PURE__ */ React.createElement("span", { style: { font: "var(--cs-type-ui)", color: "var(--cs-text-secondary)" } }, "\u6587\u4EF6 ", count), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement(DropdownMenu, { align: "end", trigger: /* @__PURE__ */ React.createElement(IconButton, { title: "\u8D44\u6599\u5E93\u66F4\u591A\u64CD\u4F5C" }, /* @__PURE__ */ React.createElement(Icon, { name: "dots", size: 15 })), groups: [{ items: rootItems(null) }] })), /* @__PURE__ */ React.createElement("input", { ref: picker, type: "file", multiple: true, hidden: true, "aria-label": "\u4E0A\u4F20\u8D44\u6599\u6587\u4EF6", onChange: importFiles }), notice && /* @__PURE__ */ React.createElement("div", { role: "status", "aria-live": "polite", style: { font: "var(--cs-type-caption)", color: "var(--cs-text-secondary)" } }, notice), /* @__PURE__ */ React.createElement("div", { "aria-busy": busy || void 0, style: { display: "grid", gridTemplateColumns: "minmax(180px, 30%) minmax(0, 1fr)", minHeight: 420, border: "1px solid var(--cs-border)", borderRadius: "var(--cs-radius-card)", overflow: "hidden" } }, /* @__PURE__ */ React.createElement("nav", { "aria-label": "\u8D44\u6599\u5E93\u6587\u4EF6\u6811", style: { borderRight: "1px solid var(--cs-border)", padding: "var(--cs-space-2)", overflow: "auto", maxHeight: 620 } }, nodes.length ? renderBranch(null) : /* @__PURE__ */ React.createElement(EmptyState, { icon: "fileText", title: "\u6682\u65E0\u6587\u4EF6", reason: "\u901A\u8FC7\u66F4\u591A\u64CD\u4F5C\u65B0\u5EFA\u6216\u4E0A\u4F20\u6587\u4EF6" })), /* @__PURE__ */ React.createElement("div", { style: { minWidth: 0, padding: "var(--cs-space-6)", overflow: "auto", maxHeight: 620 } }, !chosen ? /* @__PURE__ */ React.createElement("div", { style: { display: "grid", placeItems: "center", minHeight: 320 } }, /* @__PURE__ */ React.createElement(EmptyState, { icon: "fileText", title: "\u9009\u62E9\u4E00\u4E2A\u6587\u4EF6\u67E5\u770B\u5185\u5BB9", reason: "\u4ECE\u5DE6\u4FA7\u8D44\u6599\u5E93\u4E2D\u9009\u62E9\u6587\u4EF6" })) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { ...row, flexWrap: "wrap", marginBottom: "var(--cs-space-4)" } }, /* @__PURE__ */ React.createElement("strong", { style: { flex: 1, overflowWrap: "anywhere", font: "var(--cs-type-title)" } }, chosen.name), draft === null ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: chosen.text === null, onClick: () => setDraft(chosen.text) }, "\u7F16\u8F91"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "danger", onClick: () => setDialog({ type: "delete", node: chosen }) }, "\u5220\u9664")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ink", onClick: () => {
        setNodes((old) => old.map((n) => n.id === selected ? { ...n, text: draft } : n));
        setDraft(null);
        setNotice("\u5DF2\u4FDD\u5B58");
      } }, "\u4FDD\u5B58"), /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => setDraft(null) }, "\u53D6\u6D88\u7F16\u8F91"))), draft !== null ? /* @__PURE__ */ React.createElement(Textarea, { "aria-label": `\u7F16\u8F91 ${chosen.name}`, minHeight: 320, value: draft, onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          setNodes((old) => old.map((n) => n.id === selected ? { ...n, text: draft } : n));
          setDraft(null);
          setNotice("\u5DF2\u4FDD\u5B58");
        }
      } }) : chosen.text === null ? /* @__PURE__ */ React.createElement(EmptyState, { icon: "fileText", title: "\u6B64\u6587\u4EF6\u6682\u4E0D\u652F\u6301\u9884\u89C8", reason: "\u53EF\u5728\u684C\u9762\u5BA2\u6237\u7AEF\u4E2D\u6253\u5F00\u539F\u6587\u4EF6" }) : /* @__PURE__ */ React.createElement("article", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "var(--cs-type-body)", lineHeight: 1.75 } }, chosen.text || "\u6B64\u6587\u4EF6\u6682\u65E0\u5185\u5BB9")))), dialog && /* @__PURE__ */ React.createElement(Dialog, { title: dialog.type === "delete" ? `\u5220\u9664\u300C${dialog.node.name}\u300D\uFF1F` : dialog.type === "discard" ? "\u653E\u5F03\u5C1A\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\uFF1F" : "\u6574\u7406\u5230\u6587\u4EF6\u5939", description: dialog.type === "delete" ? `\u6B64\u64CD\u4F5C\u5C06\u5220\u9664${dialog.node.kind === "dir" ? "\u6B64\u6587\u4EF6\u5939\u53CA\u5176\u4E2D\u5168\u90E8\u6587\u4EF6" : "\u6B64\u6587\u4EF6"}\uFF0C\u65E0\u6CD5\u6062\u590D\u3002` : dialog.type === "discard" ? "\u5C1A\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\u5C06\u4E22\u5931\u3002" : void 0, danger: dialog.type === "delete", confirmLabel: dialog.type === "delete" ? "\u5220\u9664" : dialog.type === "discard" ? "\u653E\u5F03\u4FEE\u6539" : "\u79FB\u52A8\u6587\u4EF6", onCancel: closeDialog, onConfirm: confirmDialog, extra: dialog.type === "move" ? /* @__PURE__ */ React.createElement("div", { style: { width: "100%" } }, /* @__PURE__ */ React.createElement(Field, { label: "\u76EE\u6807\u6587\u4EF6\u5939", error: dialog.error }, /* @__PURE__ */ React.createElement(Select, { value: destinations.find((n) => n.id === dialog.destination)?.label, onChange: (value) => setDialog({ ...dialog, destination: destinations.find((n) => n.label === value)?.id || "", error: "" }), options: destinations.map((n) => n.label) }))) : void 0 }));
    }
    window.CapabilityLibrary = CapabilityLibrary;
  })();
})();
