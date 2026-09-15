/* Generated from ui_kits/enterprise-app/HomeFlows.jsx by tools/build.cjs. */
(() => {
  const { Dialog, Checkbox, Input, Button } = window.CogSeedDesignSystem_f581b5;
  const CONTINUE_SESSIONS = [
    { id: "carry-codex-1", source: "Codex", title: "\u5DE5\u4F5C\u7A7A\u95F4\u5BFC\u822A\u8C03\u6574", time: "\u4ECA\u5929 11:20", summary: "\u76EE\u6807\uFF1A\u6574\u7406\u5DE5\u4F5C\u7A7A\u95F4\u5BFC\u822A\u3002\n\u5F53\u524D\u8FDB\u5C55\uFF1A\u5DF2\u786E\u8BA4\u9875\u9762\u5165\u53E3\u4E0E\u4EFB\u52A1\u5206\u7EC4\u3002\n\u5DF2\u786E\u8BA4\u7EA6\u675F\uFF1A\u4FDD\u7559\u73B0\u6709\u4EFB\u52A1\u5185\u5BB9\u3002\n\u4E0B\u4E00\u6B65\uFF1A\u6838\u5BF9\u7A7A\u95F4\u8BBE\u7F6E\u4E0E\u4EFB\u52A1\u8DF3\u8F6C\u3002" },
    { id: "carry-codex-2", source: "Codex", title: "\u9879\u76EE\u6750\u6599\u6838\u5BF9\u5DE5\u5177", time: "\u6628\u5929 17:40", summary: "\u76EE\u6807\uFF1A\u6838\u5BF9\u9879\u76EE\u6750\u6599\u3002\n\u5F53\u524D\u8FDB\u5C55\uFF1A\u5DF2\u6574\u7406\u6750\u6599\u6E05\u5355\u3002\n\u5DF2\u786E\u8BA4\u7EA6\u675F\uFF1A\u53EA\u5904\u7406\u63D0\u4F9B\u7684\u6750\u6599\u3002\n\u4E0B\u4E00\u6B65\uFF1A\u590D\u6838\u7F3A\u5931\u9879\u5E76\u6574\u7406\u8BF4\u660E\u3002" },
    { id: "carry-claude-1", source: "Claude Code", title: "\u56E2\u961F\u62A5\u8868\u6C47\u603B", time: "\u4ECA\u5929 09:30", summary: "\u76EE\u6807\uFF1A\u6C47\u603B\u56E2\u961F\u62A5\u8868\u3002\n\u5F53\u524D\u8FDB\u5C55\uFF1A\u5DF2\u786E\u8BA4\u7EDF\u8BA1\u53E3\u5F84\u3002\n\u5DF2\u786E\u8BA4\u7EA6\u675F\uFF1A\u4FDD\u7559\u6765\u6E90\u4E0E\u8BA1\u7B97\u4F9D\u636E\u3002\n\u4E0B\u4E00\u6B65\uFF1A\u6838\u5BF9\u6570\u636E\u5DEE\u5F02\u3002" }
  ];
  function ContinueWorkDialog({ onClose, onOpenTask }) {
    const [step, setStep] = React.useState(0), [sources, setSources] = React.useState(["Codex"]), [selected, setSelected] = React.useState([]), [query, setQuery] = React.useState(""), [error, setError] = React.useState(""), [ready, setReady] = React.useState(false);
    const available = CONTINUE_SESSIONS.filter((s) => sources.includes(s.source));
    const visible = available.filter((s) => `${s.title} ${s.source}`.toLowerCase().includes(query.toLowerCase().trim()));
    const records = available.filter((s) => selected.includes(s.id));
    const changeSource = (source, checked) => {
      setSources((list) => checked ? [...list, source] : list.filter((s) => s !== source));
      setSelected([]);
      setError("");
    };
    function advance() {
      if (step === 0 && !sources.length) {
        setError("\u9009\u62E9\u81F3\u5C11\u4E00\u4E2A\u6765\u6E90\u3002");
        return;
      }
      if (step === 1 && !records.length) {
        setError("\u9009\u62E9\u81F3\u5C11\u4E00\u4E2A\u4F1A\u8BDD\u3002");
        return;
      }
      setError("");
      if (step < 2) setStep(step + 1);
      else if (!ready) setReady(true);
      else onClose();
    }
    return /* @__PURE__ */ React.createElement(
      Dialog,
      {
        title: "\u5BFC\u5165\u5386\u53F2\u4F1A\u8BDD\u5E76\u63A5\u7EED",
        width: 640,
        onCancel: onClose,
        cancelLabel: "\u53D6\u6D88",
        confirmLabel: step < 2 ? "\u4E0B\u4E00\u6B65" : ready ? "\u5B8C\u6210" : "\u5F00\u59CB\u51C6\u5907",
        onConfirm: advance,
        confirmDisabled: step === 0 ? !sources.length : step === 1 ? !records.length : false,
        extra: /* @__PURE__ */ React.createElement("div", { className: "cs-continue-content" }, /* @__PURE__ */ React.createElement("ol", { className: "cs-continue-steps", "aria-label": "\u63A5\u7EED\u6B65\u9AA4" }, ["\u9009\u62E9\u6765\u6E90", "\u9009\u62E9\u4F1A\u8BDD", "\u51C6\u5907\u63A5\u7EED"].map((label, i) => /* @__PURE__ */ React.createElement("li", { key: label, "aria-current": i === step ? "step" : void 0 }, i + 1, " \xB7 ", label))), step === 0 ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h3", null, "\u4ECE\u54EA\u4E2A Agent \u5BFC\u5165\u5386\u53F2\u4F1A\u8BDD\uFF1F"), /* @__PURE__ */ React.createElement("div", { className: "cs-continue-list" }, ["Codex", "Claude Code"].map((source) => /* @__PURE__ */ React.createElement(Checkbox, { key: source, label: source, help: `${CONTINUE_SESSIONS.filter((s) => s.source === source).length} \u4E2A\u53EF\u9009\u4F1A\u8BDD`, checked: sources.includes(source), onChange: (checked) => changeSource(source, checked) })))) : null, step === 1 ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h3", null, "\u9009\u62E9\u8981\u63A5\u7EED\u7684\u4F1A\u8BDD"), /* @__PURE__ */ React.createElement(Input, { "aria-label": "\u641C\u7D22\u6807\u9898\u3001\u9879\u76EE\u6216 Agent", placeholder: "\u641C\u7D22\u6807\u9898\u3001\u9879\u76EE\u6216 Agent", value: query, onChange: (e) => setQuery(e.target.value) }), /* @__PURE__ */ React.createElement("div", { className: "cs-continue-selection" }, /* @__PURE__ */ React.createElement("span", null, "\u5DF2\u9009 ", records.length, " / ", available.length), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setSelected((list) => Array.from(/* @__PURE__ */ new Set([...list, ...visible.map((s) => s.id)]))) }, "\u5168\u9009\u5F53\u524D\u7ED3\u679C"), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setSelected([]) }, "\u53D6\u6D88\u5168\u9009")), /* @__PURE__ */ React.createElement("div", { className: "cs-continue-list" }, visible.map((s) => /* @__PURE__ */ React.createElement(Checkbox, { key: s.id, label: s.title, help: `${s.source} \xB7 ${s.time}`, checked: selected.includes(s.id), onChange: (checked) => {
          setSelected((list) => checked ? [...list, s.id] : list.filter((id) => id !== s.id));
          setError("");
        } })), !visible.length ? /* @__PURE__ */ React.createElement("p", { role: "status" }, "\u6CA1\u6709\u5339\u914D\u7684\u4F1A\u8BDD\u3002") : null)) : null, step === 2 ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h3", null, ready ? "\u63A5\u7EED\u4EFB\u52A1\u5DF2\u51C6\u5907\u597D" : "\u51C6\u5907\u63A5\u7EED"), /* @__PURE__ */ React.createElement("p", null, "\u5DF2\u9009 ", records.length, " \u4E2A\u4F1A\u8BDD"), /* @__PURE__ */ React.createElement("div", { className: "cs-continue-list" }, records.map((s) => /* @__PURE__ */ React.createElement("section", { key: s.id }, /* @__PURE__ */ React.createElement("h4", null, s.title), /* @__PURE__ */ React.createElement("p", { className: "cs-continue-summary" }, s.summary), ready ? /* @__PURE__ */ React.createElement(Button, { onClick: () => {
          onClose();
          onOpenTask({ id: s.id, title: s.title, agentName: "cogseed", content: "empty", initialMessage: s.summary });
        } }, "\u6253\u5F00\u4EFB\u52A1") : null)))) : null, error ? /* @__PURE__ */ React.createElement("p", { role: "alert", className: "cs-continue-error" }, error) : null, step > 0 && !ready ? /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => {
          setStep(step - 1);
          setError("");
        } }, "\u4E0A\u4E00\u6B65") : null)
      }
    );
  }
  Object.assign(window, { ContinueWorkDialog });
})();
