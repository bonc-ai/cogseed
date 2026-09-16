/* Generated from ui_kits/enterprise-app/AgentCreateDialog.jsx by tools/build.cjs. */
(() => {
  window.CapabilityAgentStore = window.CapabilityAgentStore || { items: null, initialized: false, add(agent) {
    if (!this.items) this.items = [];
    this.items.push(agent);
  } };
  function AgentCreateDialog({ open, onClose, onCreated, initialMode = "create" }) {
    const { Dialog, Tabs, Field, Input, Select, Textarea } = window.CogSeedDesignSystem_f581b5;
    const [mode, setMode] = React.useState(initialMode === "external" ? 1 : 0), [name, setName] = React.useState(""), [intro, setIntro] = React.useState(""), [format, setFormat] = React.useState("\u81EA\u52A8\u9009\u62E9"), [cli, setCli] = React.useState("Codex"), [error, setError] = React.useState("");
    React.useEffect(() => {
      if (open) {
        setMode(initialMode === "external" ? 1 : 0);
        setName("");
        setIntro("");
        setError("");
      }
    }, [open, initialMode]);
    if (!open) return null;
    const save = () => {
      if (!name.trim() || !intro.trim()) {
        setError("\u8BF7\u586B\u5199\u540D\u79F0\u548C\u7B80\u4ECB");
        return;
      }
      if (!/^[A-Za-z0-9_一-鿿-]+$/.test(name)) {
        setError("\u540D\u79F0\u4EC5\u652F\u6301\u4E2D\u6587\u3001\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u4E0B\u5212\u7EBF\u548C\u77ED\u6A2A\u7EBF");
        return;
      }
      if (["cogseed", "commander"].includes(name.toLowerCase())) {
        setError("\u6B64\u540D\u79F0\u5DF2\u4FDD\u7559\uFF0C\u8BF7\u6362\u4E00\u4E2A\u540D\u79F0");
        return;
      }
      const agent = { id: `custom-${Date.now()}`, kind: 0, name, intro: intro.trim(), format, source: mode ? "external" : "custom", category: "\u901A\u7528", enabled: !mode, icon: mode ? "fileText" : "file", directory: "\u9ED8\u8BA4\u5DE5\u4F5C\u7A7A\u95F4", runtime: mode ? cli : void 0 };
      window.CapabilityAgentStore.add(agent);
      onCreated?.(agent);
      onClose?.();
    };
    return /* @__PURE__ */ React.createElement(Dialog, { title: "\u65B0\u5EFA\u667A\u80FD\u4F53", showClose: true, width: 520, onCancel: onClose, onConfirm: save, confirmLabel: "\u786E\u8BA4", initialFocus: "first" }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: "var(--cs-space-4)" } }, /* @__PURE__ */ React.createElement(Tabs, { items: ["\u521B\u5EFA", "\u5916\u63A5"], value: mode, onChange: (value) => {
      setMode(value);
      setError("");
    } }), mode === 1 && /* @__PURE__ */ React.createElement(Field, { label: "\u667A\u80FD\u4F53", help: "\u901A\u8FC7 P3394 \u534F\u8BAE\u63A5\u5165\uFF0C\u6CE8\u518C\u4E3A\u534F\u4F5C\u8282\u70B9\u3002" }, /* @__PURE__ */ React.createElement(Select, { options: ["Codex", "Claude Code", "Hermes", "OpenClaw", "WorkBuddy"], value: cli, onChange: (value) => {
      setCli(value);
      setName(value.replaceAll(" ", ""));
      setIntro(`\u901A\u8FC7 ${value} \u5904\u7406\u9879\u76EE\u4E2D\u7684\u5F00\u53D1\u4EFB\u52A1\u3002`);
    } })), /* @__PURE__ */ React.createElement(Field, { label: "\u540D\u79F0", error: error || void 0 }, /* @__PURE__ */ React.createElement(Input, { value: name, onChange: (e) => {
      setName(e.target.value);
      setError("");
    }, placeholder: "\u4F8B\u5982\uFF1A\u9879\u76EE\u5206\u6790\u5E08" })), mode === 0 && /* @__PURE__ */ React.createElement(Field, { label: "\u8F93\u51FA\u683C\u5F0F" }, /* @__PURE__ */ React.createElement(Select, { options: ["\u81EA\u52A8\u9009\u62E9", "\u666E\u901A\u56DE\u590D", "\u6570\u636E\u770B\u677F", "\u4EA4\u4E92\u5E94\u7528"], value: format, onChange: setFormat })), /* @__PURE__ */ React.createElement(Field, { label: "\u7B80\u4ECB", help: mode === 0 ? "\u4E00\u53E5\u8BDD\u8BF4\u660E\u5B83\u505A\u4EC0\u4E48\uFF0C\u4F5C\u4E3A\u5DE5\u4F5C\u6D41\u7A0B\u7684\u751F\u6210\u4F9D\u636E\u3002" : void 0 }, /* @__PURE__ */ React.createElement(Textarea, { value: intro, onChange: (e) => setIntro(e.target.value), placeholder: "\u63CF\u8FF0\u667A\u80FD\u4F53\u8D1F\u8D23\u7684\u5DE5\u4F5C" })), mode === 1 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h3", { style: { font: "var(--cs-type-ui)" } }, "\u5DF2\u63A5\u5165\u7684 P3394 \u8282\u70B9"), /* @__PURE__ */ React.createElement("p", { style: { font: "var(--cs-type-caption)", color: "var(--cs-text-secondary)" } }, "\u5DF2\u63A5\u5165\u8282\u70B9\u7684\u542F\u505C\u4E0E\u79FB\u9664\u5728\u667A\u80FD\u4F53\u603B\u89C8\u4E2D\u7BA1\u7406\u3002")), mode === 0 && /* @__PURE__ */ React.createElement("p", { style: { font: "var(--cs-type-caption)", color: "var(--cs-text-secondary)", margin: 0 } }, "\u786E\u8BA4\u540E\u53EF\u5728\u7BA1\u7406\u5DE5\u4F5C\u53F0\u7EE7\u7EED\u7F16\u8F91\u3002")));
  }
  window.AgentCreateDialog = AgentCreateDialog;
})();
