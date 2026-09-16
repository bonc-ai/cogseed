/* Generated from components/forms/settings-section.card.demo.jsx by tools/build.cjs. */
(() => {
  const { SettingsSection, Button, Switch } = window.CogSeedDesignSystem_f581b5;
  function Demo() {
    const [enabled, setEnabled] = React.useState(true), [notice, setNotice] = React.useState("");
    return /* @__PURE__ */ React.createElement("main", null, /* @__PURE__ */ React.createElement("h1", null, "\u8BBE\u7F6E\u5206\u7EC4"), /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u8BB0\u5FC6" }, /* @__PURE__ */ React.createElement("div", { className: "sample-row" }, /* @__PURE__ */ React.createElement("span", null, "\u4E2A\u4EBA\u8BB0\u5FC6"), /* @__PURE__ */ React.createElement(Button, { onClick: () => setNotice("\u7BA1\u7406\u8BB0\u5FC6\u5165\u53E3") }, "\u7BA1\u7406\u8BB0\u5FC6"))), /* @__PURE__ */ React.createElement(SettingsSection, { title: "\u901A\u7528" }, /* @__PURE__ */ React.createElement("div", { className: "sample-row" }, /* @__PURE__ */ React.createElement("span", null, "\u4EFB\u52A1\u901A\u77E5"), /* @__PURE__ */ React.createElement(Switch, { "aria-label": "\u4EFB\u52A1\u901A\u77E5", checked: enabled, onChange: setEnabled })), /* @__PURE__ */ React.createElement("div", { className: "sample-row" }, /* @__PURE__ */ React.createElement("span", null, "\u9ED8\u8BA4\u63A8\u7406\u5F3A\u5EA6"), /* @__PURE__ */ React.createElement("span", { className: "sample-status" }, "\u81EA\u52A8"))), /* @__PURE__ */ React.createElement("p", { className: "sample-status", role: "status" }, notice));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(Demo, null));
})();
