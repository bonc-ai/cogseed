/* Generated from components/retrieval/retrieval.card.demo.jsx by tools/build.cjs. */
(() => {
  const { CommandPalette, Button, DateRangePicker, Calendar, Dropzone, FileRow } = window.CogSeedDesignSystem_f581b5;
  function Demo() {
    const [range, setRange] = React.useState({ start: "2026-09-01", end: "2026-09-15" });
    const [p, setP] = React.useState("");
    const [history, setHistory] = React.useState([]), [opened, setOpened] = React.useState(null), [modal, setModal] = React.useState(false);
    const groups = [
      { id: "chat", label: "\u4EFB\u52A1", items: [{ id: "task-1-message-1", title: "\u9879\u76EE\u91CC\u7A0B\u7891\u4E0E\u63D0\u9192", meta: "\u4F60 \xB7 \u4ECA\u5929 11:20", snippet: "\u6838\u5BF9\u672C\u5B63\u5EA6\u5230\u671F\u9879\u76EE\u53F0\u8D26\u3002" }, { id: "task-1-message-2", title: "\u9879\u76EE\u91CC\u7A0B\u7891\u4E0E\u63D0\u9192", meta: "AI \xB7 \u4ECA\u5929 11:21", snippet: "\u5DF2\u6574\u7406\u5230\u671F\u5BA2\u6237\u6E05\u5355\u4E0E\u63D0\u9192\u65E5\u671F\u3002" }] },
      { id: "agent", label: "\u667A\u80FD\u4F53", items: [{ id: "agent-credit", title: "\u9879\u76EE\u5206\u6790", meta: "\u5DF2\u5B89\u88C5", snippet: "\u6838\u5BF9\u5BA2\u6237\u8D44\u6599\u4E0E\u9879\u76EE\u98CE\u9669\u3002" }] },
      { id: "skill", label: "\u6280\u80FD", items: [{ id: "skill-report", title: "\u6574\u7406\u6587\u6863", meta: "\u5DF2\u5B89\u88C5", snippet: "\u6574\u7406\u9879\u76EE\u6750\u6599\u548C\u5230\u671F\u62A5\u544A\u3002" }] },
      { id: "context", label: "\u8D44\u6599\u5E93", items: [{ id: "context-1", title: "\u9879\u76EE\u53F0\u8D26\u8BF4\u660E.md", meta: "\u8D44\u6599\u5E93", snippet: "\u9879\u76EE\u5230\u671F\u65E5\u671F\u7684\u6838\u5BF9\u53E3\u5F84\u3002" }] }
    ];
    const select = (item, group) => {
      setOpened({ item, group });
      setModal(false);
    };
    return /* @__PURE__ */ React.createElement("div", { className: "cs-col", style: { gap: "var(--cs-space-4)" } }, /* @__PURE__ */ React.createElement(CommandPalette, { groups, history, onHistoryChange: setHistory, onSelect: select }), /* @__PURE__ */ React.createElement(Button, { onClick: () => setModal(true) }, "\u6253\u5F00\u5168\u5C40\u641C\u7D22"), modal && /* @__PURE__ */ React.createElement(CommandPalette, { modal: true, groups, history, onHistoryChange: setHistory, onSelect: select, onClose: () => setModal(false) }), opened && /* @__PURE__ */ React.createElement("section", { "aria-label": "\u5185\u5BB9\u8BE6\u60C5" }, /* @__PURE__ */ React.createElement("h2", { style: { font: "var(--cs-type-title)" } }, opened.item.title), /* @__PURE__ */ React.createElement("p", null, opened.group.label, " \xB7 ", opened.item.meta), /* @__PURE__ */ React.createElement("p", null, opened.item.snippet), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => setOpened(null) }, "\u5173\u95ED\u8BE6\u60C5")), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 276px", gap: "var(--cs-space-6)", alignItems: "start" } }, /* @__PURE__ */ React.createElement("div", { className: "cs-col", style: { gap: "var(--cs-space-3)" } }, /* @__PURE__ */ React.createElement(DateRangePicker, { value: range, onChange: (r) => {
      setRange(r);
      setP("");
    }, presets: ["\u672C\u5B63\u5EA6"], presetRanges: { "\u672C\u5B63\u5EA6": { start: "2026-07-01", end: "2026-09-30" } }, preset: p, onPreset: setP }), /* @__PURE__ */ React.createElement(Dropzone, null), /* @__PURE__ */ React.createElement(FileRow, { name: "\u9879\u76EE\u53F0\u8D26_2026Q3.xlsx", meta: "1.2MB \xB7 \u5DF2\u5C31\u7EEA \xB7 \u53EA\u8BFB" }), /* @__PURE__ */ React.createElement(FileRow, { name: "\u56E2\u961F\u9879\u76EE\u62A5\u544A\u6C47\u603B.pdf", state: "uploading", progress: 62 }), /* @__PURE__ */ React.createElement(FileRow, { name: "\u5BA2\u6237\u8054\u7CFB\u8868.csv", state: "blocked", action: "\u7533\u8BF7\u6388\u6743", meta: "\u542B\u4E2A\u4EBA\u8054\u7CFB\u4FE1\u606F\uFF0C\u9700\u5728\u4EFB\u52A1\u5185\u5355\u6B21\u6388\u6743\u540E\u624D\u80FD\u89E3\u6790\u3002" })), /* @__PURE__ */ React.createElement(Calendar, { month: "2026 \u5E74 9 \u6708", rangeStart: range.start < "2026-09-01" ? 1 : range.start > "2026-09-30" ? 31 : Number(range.start.slice(-2)), rangeEnd: range.end > "2026-09-30" ? 30 : range.end < "2026-09-01" ? 0 : Number(range.end.slice(-2)), onSelect: (d) => {
      setRange({ start: "2026-09-01", end: "2026-09-" + String(d).padStart(2, "0") });
      setP("");
    }, footer: range.start + " \u2192 " + range.end })));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(Demo, null));
})();
