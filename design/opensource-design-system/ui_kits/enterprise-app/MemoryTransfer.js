/* Generated from ui_kits/enterprise-app/MemoryTransfer.jsx by tools/build.cjs. */
(() => {
  const { Button, Textarea, Input, Checkbox, SettingsSection } = window.CogSeedDesignSystem_f581b5;
  function MemoryTransfer({ mode, value, onChange, onClose }) {
    const [text, setText] = React.useState(""), [rows, setRows] = React.useState(null), [notice, setNotice] = React.useState("");
    const raw = (scope) => value[scope].map((x) => x.text).join("\n\n");
    const parse = () => {
      setRows(text.split(/\n+/).map((t) => t.trim()).filter(Boolean).map((text2, i) => ({ id: `import-${Date.now()}-${i}`, text: text2, target: "user", keep: true })));
      setNotice("\u8BF7\u786E\u8BA4\u9700\u8981\u5BFC\u5165\u7684\u8BB0\u5FC6\u3002");
    };
    const merge = () => {
      const next = { ...value, user: [...value.user], shared: [...value.shared] };
      let count = 0;
      rows.filter((r) => r.keep).forEach((r) => {
        if (!next[r.target].some((x) => x.text === r.text)) {
          next[r.target].push({ id: r.id, text: r.text });
          count++;
        }
      });
      onChange(next);
      setRows(null);
      setText("");
      setNotice(`\u5DF2\u5408\u5E76 ${count} \u6761\u8BB0\u5FC6\uFF0C\u91CD\u590D\u5185\u5BB9\u5DF2\u8DF3\u8FC7\u3002`);
    };
    return /* @__PURE__ */ React.createElement(SettingsSection, { title: mode === "export" ? "\u5BFC\u51FA\u8BB0\u5FC6" : rows ? "\u5BA1\u6838\u5BFC\u5165\u5185\u5BB9 \xB7 2 / 2" : "\u5BFC\u5165\u8BB0\u5FC6 \xB7 1 / 2", actions: /* @__PURE__ */ React.createElement(Button, { onClick: onClose }, "\u5173\u95ED") }, mode === "export" ? ["user", "shared"].map((scope) => /* @__PURE__ */ React.createElement("div", { key: scope }, /* @__PURE__ */ React.createElement(SettingsRow, { title: scope === "user" ? "\u504F\u597D" : "\u5168\u5C40\u5171\u4EAB\u8BB0\u5FC6", help: `${value[scope].length} \u6761` }, /* @__PURE__ */ React.createElement(SettingsActions, null, /* @__PURE__ */ React.createElement(Button, { onClick: async () => {
      try {
        await navigator.clipboard.writeText(raw(scope));
        setNotice("\u5185\u5BB9\u5DF2\u590D\u5236\u3002");
      } catch {
        setNotice("\u65E0\u6CD5\u8BBF\u95EE\u526A\u8D34\u677F\uFF0C\u8BF7\u5728\u4E0B\u65B9\u9009\u62E9\u5E76\u590D\u5236\u5185\u5BB9\u3002");
      }
    } }, "\u590D\u5236\u5185\u5BB9"), /* @__PURE__ */ React.createElement(Button, { onClick: () => setNotice("\u6682\u65E0\u53EF\u5B9A\u4F4D\u7684\u6587\u4EF6\u3002") }, "\u5B9A\u4F4D\u6587\u4EF6"))), /* @__PURE__ */ React.createElement(Textarea, { "aria-label": scope === "user" ? "\u5BFC\u51FA\u504F\u597D\u5185\u5BB9" : "\u5BFC\u51FA\u5171\u4EAB\u8BB0\u5FC6\u5185\u5BB9", readOnly: true, value: raw(scope) }))) : rows ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cs-settings-options" }, rows.map((r, i) => /* @__PURE__ */ React.createElement("div", { key: r.id }, /* @__PURE__ */ React.createElement(Checkbox, { label: r.text, checked: r.keep, onChange: (keep) => setRows((old) => old.map((x, j) => i === j ? { ...x, keep } : x)) }), /* @__PURE__ */ React.createElement(SettingsChoice, { label: `\u7B2C ${i + 1} \u6761\u5B58\u5165\u4F4D\u7F6E`, options: ["\u504F\u597D", "\u5168\u5C40\u5171\u4EAB\u8BB0\u5FC6"], value: r.target === "user" ? "\u504F\u597D" : "\u5168\u5C40\u5171\u4EAB\u8BB0\u5FC6", onChange: (target) => setRows((old) => old.map((x, j) => i === j ? { ...x, target: target === "\u504F\u597D" ? "user" : "shared" } : x)) })))), /* @__PURE__ */ React.createElement(SettingsActions, null, /* @__PURE__ */ React.createElement(Button, { onClick: () => setRows(null) }, "\u8FD4\u56DE\u7F16\u8F91"), /* @__PURE__ */ React.createElement(Button, { variant: "primary", disabled: !rows.some((r) => r.keep), onClick: merge }, "\u5408\u5E76 ", rows.filter((r) => r.keep).length, " \u6761\u8BB0\u5FC6"))) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Textarea, { "aria-label": "\u5F85\u5BFC\u5165\u8BB0\u5FC6", placeholder: "\u7C98\u8D34\u9700\u8981\u5BFC\u5165\u7684\u5185\u5BB9\uFF0C\u6BCF\u884C\u4E00\u6761", value: text, onChange: (e) => setText(e.target.value) }), /* @__PURE__ */ React.createElement(SettingsRow, { title: "\u4ECE\u6587\u4EF6\u5BFC\u5165" }, /* @__PURE__ */ React.createElement(Input, { type: "file", "aria-label": "\u9009\u62E9\u8BB0\u5FC6\u6587\u4EF6", accept: ".txt,.md", onChange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 1024 * 1024) {
        setNotice("\u8BF7\u9009\u62E9 1 MB \u4EE5\u5185\u7684\u6587\u672C\u6587\u4EF6\u3002");
        return;
      }
      try {
        setText(await file.text());
        setNotice(`\u5DF2\u8BFB\u53D6\u300C${file.name}\u300D\uFF0C\u5C1A\u672A\u5BFC\u5165\u3002`);
      } catch {
        setNotice("\u65E0\u6CD5\u8BFB\u53D6\u6587\u4EF6\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u3002");
      }
    } })), /* @__PURE__ */ React.createElement(SettingsActions, null, /* @__PURE__ */ React.createElement(Button, { onClick: onClose }, "\u53D6\u6D88\u5BFC\u5165"), /* @__PURE__ */ React.createElement(Button, { variant: "primary", disabled: !text.trim(), onClick: parse }, "\u89E3\u6790\u5185\u5BB9"))), /* @__PURE__ */ React.createElement(SettingsFeedback, null, notice));
  }
  window.MemoryTransfer = MemoryTransfer;
})();
