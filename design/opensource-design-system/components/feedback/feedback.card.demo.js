/* Generated from components/feedback/feedback.card.demo.jsx by tools/build.cjs. */
(() => {
  const { InlineConfirm, StatusPill, StatusDot, StatusCapsule, Alert, Toast, InlineAuthBar, StepList, ProgressBar, Spinner, Skeleton, EmptyState, Dialog, Popover, PopoverItem, Button, Tooltip, Checkbox, Input, Field, Select } = window.CogSeedDesignSystem_f581b5;
  function Demo() {
    const [formOpen, setFormOpen] = React.useState(false), [title, setTitle] = React.useState(""), [frequency, setFrequency] = React.useState("\u6BCF\u5929");
    const anchorRef = React.useRef(null);
    const [panelOpen, setPanelOpen] = React.useState(false);
    const [permission, setPermission] = React.useState("\u8BF7\u6C42\u6279\u51C6");
    const [auth, setAuth] = React.useState("ask"), [dlg, setDlg] = React.useState(false), [cc, setCc] = React.useState(false);
    return /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--cs-space-4) var(--cs-space-6)", position: "relative" } }, /* @__PURE__ */ React.createElement("div", { className: "cs-col" }, /* @__PURE__ */ React.createElement("div", { className: "cs-row" }, /* @__PURE__ */ React.createElement(StatusPill, { tone: "success", check: true }, "\u5DF2\u5B8C\u6210"), /* @__PURE__ */ React.createElement(StatusPill, { tone: "attention" }, "\u8FD0\u884C\u4E2D \xB7 4/7"), /* @__PURE__ */ React.createElement(StatusPill, { tone: "critical" }, "\u5DF2\u5931\u8D25"), /* @__PURE__ */ React.createElement(StatusPill, null, "\u5DF2\u5F52\u6863")), /* @__PURE__ */ React.createElement("div", { className: "cs-row", style: { gap: "var(--cs-space-4)" } }, /* @__PURE__ */ React.createElement(StatusCapsule, { tone: "success" }, "\u6570\u636E\u4E0D\u51FA\u57DF"), /* @__PURE__ */ React.createElement(StatusDot, { tone: "attention", label: "\u8FD0\u884C\u4E2D" }), /* @__PURE__ */ React.createElement(StatusDot, { label: "\u7A7A\u95F2" })), /* @__PURE__ */ React.createElement("div", { className: "cs-row", style: { gap: "var(--cs-space-3)" } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "var(--cs-size-ui-sm)", color: "var(--cs-ink-70)" } }, "4 / 7"), /* @__PURE__ */ React.createElement(ProgressBar, { value: 4, max: 7, maxWidth: 200 }), /* @__PURE__ */ React.createElement(Spinner, { size: 13 }), /* @__PURE__ */ React.createElement(Spinner, { size: 16, tone: "attention" })), /* @__PURE__ */ React.createElement(StepList, { steps: [
      { label: "\u8BFB\u53D6\u6587\u4EF6 \xB7 \u9879\u76EE\u53F0\u8D26_2026Q3.xlsx", state: "done", meta: "0.8s" },
      { label: "\u7B5B\u9009 \xB7 \u547D\u4E2D 137 \u6761", state: "running", meta: "\u8FD0\u884C\u4E2D" },
      { label: "\u6309\u9879\u76EE\u7EC4\u6C47\u603B", state: "wait", meta: "\u5F85\u6267\u884C" }
    ] }), /* @__PURE__ */ React.createElement(
      InlineAuthBar,
      {
        state: auth,
        time: "14:04",
        message: "\u9700\u8981\u8BBF\u95EE\u300C\u5BA2\u6237\u7ECF\u7406\u901A\u8BAF\u5F55\u300D\u624D\u80FD\u586B\u5165\u6536\u4EF6\u4EBA",
        onAllow: () => setAuth("granted"),
        onDeny: () => setAuth("denied")
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "cs-col" }, /* @__PURE__ */ React.createElement(InlineConfirm, { title: "\u5220\u9664\u8FD9\u9879\u5BC6\u94A5\u914D\u7F6E\uFF1F", confirmLabel: "\u5220\u9664\u914D\u7F6E", onCancel: () => {
    }, onConfirm: () => {
    } }), /* @__PURE__ */ React.createElement(Alert, { title: "\u53E3\u5F84\u8BF4\u660E", onClose: () => {
    } }, "\u9884\u7B97\u4E3A\u672C\u91D1\u4F59\u989D\uFF0C\u4E0D\u542B\u8868\u5916\u4E0E\u627F\u8BFA\u672A\u63D0\u7528\u989D\u5EA6\u3002"), /* @__PURE__ */ React.createElement(Alert, { tone: "attention", title: "3 \u6237\u7F3A\u5C11\u6700\u65B0\u9879\u76EE\u62A5\u544A", action: "\u67E5\u770B\u8FD9 3 \u6237" }, "\u5DF2\u7528\u4E0A\u671F\u6570\u636E\u4F30\u7B97\uFF0C\u7ED3\u679C\u6807\u6CE8\u4E3A\u5F85\u6838\u3002"), /* @__PURE__ */ React.createElement(Alert, { tone: "critical", title: "\u6570\u4ED3\u8FDE\u63A5\u4E2D\u65AD", action: "\u91CD\u8BD5" }, "14:07 \u8D77\u8FDE\u63A5\u8D85\u65F6\uFF0C\u4EFB\u52A1\u5DF2\u5728\u7B2C 5 \u6B65\u6682\u505C\u3002"), /* @__PURE__ */ React.createElement(Toast, { title: "\u7B80\u62A5\u5DF2\u5B58\u5165\u534E\u4E1C\u56E2\u961F\u7A7A\u95F4", meta: "v3 \xB7 14:12 \xB7 3 \u4EBA\u53EF\u89C1", onClose: () => {
    } }), /* @__PURE__ */ React.createElement("div", { className: "cs-row", style: { alignItems: "flex-start", gap: "var(--cs-space-4)" } }, /* @__PURE__ */ React.createElement("div", { ref: anchorRef, style: { position: "relative" } }, /* @__PURE__ */ React.createElement(Button, { onClick: () => setPanelOpen((v) => !v), "aria-expanded": panelOpen }, permission), /* @__PURE__ */ React.createElement(Popover, { open: panelOpen, onOpenChange: setPanelOpen, anchorRef, label: "\u8BBF\u95EE\u6743\u9650", width: 180 }, ["\u5B8C\u5168\u8BBF\u95EE", "\u5E2E\u6211\u6279\u51C6", "\u8BF7\u6C42\u6279\u51C6"].map((mode) => /* @__PURE__ */ React.createElement(
      PopoverItem,
      {
        key: mode,
        label: mode,
        selected: permission === mode,
        onClick: () => {
          setPermission(mode);
          setPanelOpen(false);
        }
      }
    )))), /* @__PURE__ */ React.createElement(Popover, { title: "\u6743\u9650\u8303\u56F4", badge: "\u53EA\u8BFB", footer: "\u7531\u7BA1\u7406\u5458\u5728\u8FDE\u63A5\u5668\u7B56\u7565\u4E2D\u914D\u7F6E" }, "\u9879\u76EE\u5B58\u8D37 \xB7 \u5BA2\u6237 \xB7 \u8D26\u6237\u4E09\u4E2A\u4E3B\u9898\u57DF", /* @__PURE__ */ React.createElement("br", null), "\u67E5\u8BE2\u8D70\u8131\u654F\u89C6\u56FE\uFF0C\u7ED3\u679C\u4E0D\u843D\u76D8"), /* @__PURE__ */ React.createElement("div", { className: "cs-col", style: { flex: 1, gap: "var(--cs-space-3)" } }, /* @__PURE__ */ React.createElement(Tooltip, { label: "\u6570\u636E\u4E0D\u51FA\u57DF \xB7 \u67E5\u8BE2\u5728\u884C\u5185\u7F51\u6267\u884C" }, /* @__PURE__ */ React.createElement(StatusCapsule, { tone: "success" }, "\u60AC\u505C\u770B tooltip")), /* @__PURE__ */ React.createElement(Skeleton, { lines: [62, 100, 88] }), /* @__PURE__ */ React.createElement(EmptyState, { title: "\u8FD9\u4E2A\u7A7A\u95F4\u8FD8\u6CA1\u6709\u4EA7\u7269", reason: "\u4EFB\u52A1\u5B8C\u6210\u540E\u5728\u4EA7\u7269\u9875\u9009\u62E9\u300C\u5B58\u5165\u7A7A\u95F4\u300D\u3002", action: "\u65B0\u5EFA\u4EFB\u52A1" }), /* @__PURE__ */ React.createElement(Button, { onClick: () => setFormOpen(true) }, "\u6253\u5F00\u8868\u5355\u5BF9\u8BDD\u6846"), /* @__PURE__ */ React.createElement(Button, { variant: "danger", onClick: () => setDlg(true) }, "\u6253\u5F00\u786E\u8BA4\u5BF9\u8BDD\u6846")))), formOpen && /* @__PURE__ */ React.createElement(Dialog, { title: "\u65B0\u5EFA\u81EA\u52A8\u5316\u4EFB\u52A1", confirmLabel: "\u521B\u5EFA", initialFocus: "first", showClose: true, confirmDisabled: !title.trim(), onCancel: () => setFormOpen(false), onConfirm: () => setFormOpen(false) }, /* @__PURE__ */ React.createElement("div", { className: "cs-col" }, /* @__PURE__ */ React.createElement(Field, { label: "\u4EFB\u52A1\u5185\u5BB9" }, /* @__PURE__ */ React.createElement(Input, { value: title, onChange: (e) => setTitle(e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "\u9891\u7387" }, /* @__PURE__ */ React.createElement(Select, { options: ["\u4E0D\u91CD\u590D", "\u6BCF\u5929", "\u6BCF\u5468", "\u6BCF\u6708"], value: frequency, onChange: setFrequency })))), dlg ? /* @__PURE__ */ React.createElement(
      Dialog,
      {
        danger: true,
        title: "\u5220\u9664\u4EFB\u52A1\u4E0E\u5168\u90E8\u4EA7\u7269\uFF1F",
        confirmLabel: "\u5220\u9664",
        onCancel: () => setDlg(false),
        onConfirm: () => setDlg(false),
        description: "\u300C\u9879\u76EE\u91CC\u7A0B\u7891\u4E0E\u63D0\u9192\u300D\u53CA\u5176 3 \u4EFD\u4EA7\u7269\u5C06\u88AB\u79FB\u51FA\u7A7A\u95F4\u3002\u5BA1\u8BA1\u7559\u75D5\u4F1A\u4FDD\u7559 180 \u5929\uFF0C\u4EA7\u7269\u672C\u8EAB\u4E0D\u53EF\u6062\u590D\u3002",
        extra: /* @__PURE__ */ React.createElement(Checkbox, { checked: cc, onChange: setCc, label: "\u540C\u65F6\u901A\u77E5\u5DF2\u6284\u9001\u4EBA" })
      }
    ) : null);
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(Demo, null));
})();
