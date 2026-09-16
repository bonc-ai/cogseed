/* Generated from ui_kits/enterprise-app/MemorySettings.jsx by tools/build.cjs. */
(() => {
  const { Button, Icon, Input, Textarea } = window.CogSeedDesignSystem_f581b5;
  function MemorySettings({ value, onChange, onBack }) {
    const [transfer, setTransfer] = React.useState(null);
    const [editor, setEditor] = React.useState(null);
    const [deleting, setDeleting] = React.useState(null);
    const [notice, setNotice] = React.useState("");
    const trigger = React.useRef(null);
    const total = value.user.length + value.shared.length;
    const sections = [
      { key: "user", title: "\u504F\u597D", help: "\u8EAB\u4EFD\u3001\u504F\u597D\u4E0E\u6C9F\u901A\u98CE\u683C\u3002" },
      { key: "shared", title: "\u5168\u5C40\u5171\u4EAB\u8BB0\u5FC6", help: "\u5F53\u524D\u8D26\u53F7\u7684\u6240\u6709\u5BF9\u8BDD\u548C\u667A\u80FD\u4F53\u5171\u4EAB\u7684\u957F\u671F\u4E8B\u5B9E\u3002" },
      { key: "groups", title: "\u8BB0\u5FC6\u5206\u7EC4", help: "\u72EC\u7ACB\u7684\u8BB0\u5FC6\u5206\u7EC4\uFF0C\u53EF\u5728\u5BF9\u8BDD\u8F93\u5165\u6846\u901A\u8FC7 @ \u9009\u62E9\uFF0C\u4F5C\u4E3A\u672C\u8F6E\u91CD\u70B9\u53C2\u8003\u3002" }
    ];
    const restoreFocus = () => {
      trigger.current?.focus();
    };
    const closeEditor = () => {
      setEditor(null);
      restoreFocus();
    };
    const edit = (scope, entry, event) => {
      trigger.current = event.currentTarget;
      setDeleting(null);
      setEditor({ scope, id: entry?.id || null, title: entry?.title || "", text: entry?.text || "" });
      setNotice("");
    };
    const save = () => {
      if (!editor?.text.trim() || editor.scope === "groups" && !editor.title.trim()) return;
      const entry = { id: editor.id || `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`, text: editor.text.trim(), ...editor.scope === "groups" ? { title: editor.title.trim() } : {} };
      onChange({ ...value, [editor.scope]: editor.id ? value[editor.scope].map((item) => item.id === editor.id ? entry : item) : [...value[editor.scope], entry] });
      closeEditor();
      setNotice("\u8BB0\u5FC6\u5DF2\u4FDD\u5B58\u3002");
    };
    const remove = () => {
      onChange({ ...value, [deleting.scope]: value[deleting.scope].filter((item) => item.id !== deleting.id) });
      setDeleting(null);
      setNotice("\u8BB0\u5FC6\u5DF2\u5220\u9664\u3002");
    };
    const renderEditor = () => /* @__PURE__ */ React.createElement("div", { className: "cs-memory-editor", onKeyDown: (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
      }
    } }, editor.scope === "groups" ? /* @__PURE__ */ React.createElement(Input, { "aria-label": "\u5206\u7EC4\u540D\u79F0", placeholder: "\u5206\u7EC4\u540D\u79F0", value: editor.title, onChange: (event) => setEditor({ ...editor, title: event.target.value }) }) : null, /* @__PURE__ */ React.createElement(Textarea, { autoFocus: true, "aria-label": "\u8BB0\u5FC6\u5185\u5BB9", minHeight: 112, placeholder: "\u8BB0\u5F55\u9700\u8981\u5728\u540E\u7EED\u4EFB\u52A1\u4E2D\u4FDD\u7559\u7684\u4FE1\u606F", value: editor.text, onChange: (event) => setEditor({ ...editor, text: event.target.value }) }), /* @__PURE__ */ React.createElement("div", { className: "cs-memory-editor-actions" }, /* @__PURE__ */ React.createElement("span", { className: "cs-settings-muted" }, editor.text.length, " \u5B57"), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement(Button, { onClick: closeEditor }, "\u53D6\u6D88"), /* @__PURE__ */ React.createElement(Button, { variant: "primary", disabled: !editor.text.trim() || editor.scope === "groups" && !editor.title.trim(), onClick: save }, "\u4FDD\u5B58\u8BB0\u5FC6")));
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Button, { variant: "ghost", icon: /* @__PURE__ */ React.createElement(Icon, { name: "chevronLeft", size: 14 }), onClick: onBack, style: { marginBottom: "var(--cs-space-6)", paddingLeft: 0 } }, "\u8FD4\u56DE\u6570\u636E\u8BBE\u7F6E"), /* @__PURE__ */ React.createElement("div", { className: "cs-memory-heading" }, /* @__PURE__ */ React.createElement("div", { className: "cs-settings-heading" }, /* @__PURE__ */ React.createElement("h1", null, "\u8BB0\u5FC6 ", /* @__PURE__ */ React.createElement("span", { className: "cs-settings-muted" }, total, " \u6761"))), /* @__PURE__ */ React.createElement("div", { className: "cs-memory-actions" }, /* @__PURE__ */ React.createElement(Button, { onClick: () => setTransfer("export") }, "\u5BFC\u51FA\u8BB0\u5FC6"), /* @__PURE__ */ React.createElement(Button, { icon: /* @__PURE__ */ React.createElement(Icon, { name: "plus", size: 14 }), onClick: () => setTransfer("import") }, "\u5BFC\u5165\u8BB0\u5FC6"))), /* @__PURE__ */ React.createElement("div", { className: "cs-settings-notice", role: "status", "aria-live": "polite" }, notice || ""), transfer ? /* @__PURE__ */ React.createElement(MemoryTransfer, { mode: transfer, value, onChange, onClose: () => setTransfer(null) }) : null, sections.map((scope) => /* @__PURE__ */ React.createElement("section", { className: "cs-memory-section", key: scope.key }, /* @__PURE__ */ React.createElement("div", { className: "cs-memory-section-head" }, /* @__PURE__ */ React.createElement("h2", null, scope.title), /* @__PURE__ */ React.createElement("span", { className: "cs-settings-muted" }, value[scope.key].length, " ", scope.key === "groups" ? "\u4E2A" : "\u6761"), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", "aria-label": scope.key === "groups" ? "\u65B0\u5EFA\u8BB0\u5FC6\u5206\u7EC4" : `\u65B0\u589E${scope.title}`, icon: /* @__PURE__ */ React.createElement(Icon, { name: "plus", size: 14 }), onClick: (event) => edit(scope.key, null, event) }, scope.key === "groups" ? "\u65B0\u5EFA\u5206\u7EC4" : "\u65B0\u589E\u8BB0\u5FC6")), /* @__PURE__ */ React.createElement("p", { className: "cs-memory-section-help" }, scope.help), editor?.scope === scope.key && !editor.id ? renderEditor() : null, !value[scope.key].length && editor?.scope !== scope.key ? /* @__PURE__ */ React.createElement("p", { className: "cs-settings-muted" }, scope.key === "groups" ? "\u6682\u65E0\u5206\u7EC4" : "\u6682\u65E0\u5185\u5BB9") : null, value[scope.key].map((entry, index) => editor?.scope === scope.key && editor.id === entry.id ? /* @__PURE__ */ React.createElement(React.Fragment, { key: entry.id }, renderEditor()) : /* @__PURE__ */ React.createElement("div", { className: "cs-memory-entry", key: entry.id }, /* @__PURE__ */ React.createElement("div", { className: "cs-memory-entry-copy" }, entry.title ? /* @__PURE__ */ React.createElement("h3", null, entry.title) : null, /* @__PURE__ */ React.createElement("p", null, entry.text)), deleting?.scope === scope.key && deleting.id === entry.id ? /* @__PURE__ */ React.createElement("div", { className: "cs-memory-delete", role: "group", "aria-label": "\u5220\u9664\u786E\u8BA4" }, /* @__PURE__ */ React.createElement("span", null, "\u5220\u9664\u8FD9", scope.key === "groups" ? "\u4E2A\u5206\u7EC4" : "\u6761\u8BB0\u5FC6", "\uFF1F"), /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => setDeleting(null) }, "\u53D6\u6D88"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "danger", onClick: remove }, "\u5220\u9664", scope.key === "groups" ? "\u5206\u7EC4" : "\u8BB0\u5FC6")) : /* @__PURE__ */ React.createElement("div", { className: "cs-memory-entry-actions" }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", "aria-label": `\u7F16\u8F91${scope.title}\u7B2C ${index + 1} \u9879`, onClick: (event) => edit(scope.key, entry, event) }, "\u7F16\u8F91"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", "aria-label": `\u5220\u9664${scope.title}\u7B2C ${index + 1} \u9879`, onClick: () => {
      setEditor(null);
      setDeleting({ scope: scope.key, id: entry.id });
    } }, "\u5220\u9664")))))));
  }
  Object.assign(window, { MemorySettings });
})();
