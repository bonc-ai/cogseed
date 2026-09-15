/* Generated from ui_kits/enterprise-app/ResourcePage.jsx by tools/build.cjs. */
(() => {
  const { PageFrame, PageHeader, PageScroll } = window;
  const { Button, Input, SegmentedControl, Icon } = window.CogSeedDesignSystem_f581b5;
  function ResourceToolbar({ leading, search, actions }) {
    return /* @__PURE__ */ React.createElement("div", { className: "cs-resource-toolbar" }, leading && /* @__PURE__ */ React.createElement("div", { className: "cs-resource-toolbar-leading" }, leading), /* @__PURE__ */ React.createElement("div", { className: "cs-resource-toolbar-controls" }, search && /* @__PURE__ */ React.createElement("div", { className: "cs-resource-toolbar-search" }, search), actions));
  }
  function ResourcePage({ title, collapsed, onExpand, action, onAction, query, onQuery, filters, filter, onFilter, count, notice, children }) {
    return /* @__PURE__ */ React.createElement(PageFrame, null, /* @__PURE__ */ React.createElement(PageHeader, { collapsed, onExpand, title, actions: action && /* @__PURE__ */ React.createElement(Button, { icon: /* @__PURE__ */ React.createElement(Icon, { name: "plus" }), onClick: onAction }, action) }), /* @__PURE__ */ React.createElement(PageScroll, { className: "cs-resource-page-scroll" }, /* @__PURE__ */ React.createElement("div", { className: "cs-resource-page-content" }, /* @__PURE__ */ React.createElement(ResourceToolbar, { leading: filters?.length > 0 && /* @__PURE__ */ React.createElement(SegmentedControl, { items: filters, value: filter, onChange: onFilter }), search: /* @__PURE__ */ React.createElement(Input, { size: "md", icon: "search", "aria-label": `\u641C\u7D22${title}`, placeholder: "\u641C\u7D22\u540D\u79F0\u6216\u8BF4\u660E", value: query, onChange: (e) => onQuery(e.target.value) }) }), /* @__PURE__ */ React.createElement("div", { className: "cs-resource-page-caption" }, /* @__PURE__ */ React.createElement("span", null, count, " \u9879")), notice && /* @__PURE__ */ React.createElement("p", { className: "cs-resource-page-notice", role: "status" }, notice), children)));
  }
  function PreviewNameEditor({ title, initial = "", onSave, onCancel }) {
    const [value, setValue] = React.useState(initial);
    return /* @__PURE__ */ React.createElement("form", { className: "cs-preview-editor", onSubmit: (e) => {
      e.preventDefault();
      if (value.trim()) onSave(value.trim());
    } }, /* @__PURE__ */ React.createElement("label", { htmlFor: "preview-name" }, title), /* @__PURE__ */ React.createElement(Input, { id: "preview-name", autoFocus: true, value, onChange: (e) => setValue(e.target.value), onKeyDown: (e) => {
      if (e.isComposing || e.keyCode === 229) {
        if (e.key === "Enter") e.preventDefault();
      }
    } }), /* @__PURE__ */ React.createElement("div", { className: "cs-resource-page-toolbar" }, /* @__PURE__ */ React.createElement(Button, { type: "submit", disabled: !value.trim() }, "\u4FDD\u5B58\u540D\u79F0"), /* @__PURE__ */ React.createElement(Button, { onClick: onCancel }, "\u53D6\u6D88")));
  }
  Object.assign(window, { ResourceToolbar, ResourcePage, PreviewNameEditor });
})();
