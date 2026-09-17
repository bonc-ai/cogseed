/* Generated from components/data/data.card.demo.jsx by tools/build.cjs. */
(() => {
  const { Avatar, AvatarGroup, Tag, GroupHeading, DataTable, TaskListItem, ScrollArea, AspectRatio, ConnectorCard } = window.CogSeedDesignSystem_f581b5;
  function Demo() {
    const [conn, setConn] = React.useState(true), [sortKey, setSortKey] = React.useState("due"), [dir, setDir] = React.useState(1);
    const [selected, setSelected] = React.useState(-1), [task, setTask] = React.useState("");
    const rows = window.ROWS;
    return /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--cs-space-4) var(--cs-space-6)" } }, /* @__PURE__ */ React.createElement("div", { className: "cs-col" }, /* @__PURE__ */ React.createElement("div", { className: "cs-row", style: { gap: "var(--cs-space-3)" } }, /* @__PURE__ */ React.createElement(Avatar, { name: "\u9648\u6631", self: true }), /* @__PURE__ */ React.createElement(Avatar, { name: "\u5434", size: 30 }), /* @__PURE__ */ React.createElement(Avatar, { name: "\u674E", size: 36 }), /* @__PURE__ */ React.createElement(AvatarGroup, { members: ["\u5434", "\u674E"], overflow: 3, ring: "var(--cs-canvas)" })), /* @__PURE__ */ React.createElement("div", { className: "cs-row", style: { gap: "var(--cs-space-2)" } }, /* @__PURE__ */ React.createElement(Tag, null, "\u9879\u76EE"), /* @__PURE__ */ React.createElement(Tag, null, "\u9879\u76EE"), /* @__PURE__ */ React.createElement(Tag, { variant: "outline" }, "\u5B63\u5EA6"), /* @__PURE__ */ React.createElement(Tag, { variant: "accent" }, "@ \u5BA2\u6237\u7ECF\u7406"), /* @__PURE__ */ React.createElement(Tag, { variant: "version" }, "v3"), /* @__PURE__ */ React.createElement(Tag, { variant: "mono" }, "XLSX \xB7 1.2MB"), /* @__PURE__ */ React.createElement(Tag, { variant: "success" }, "\u6570\u636E\u4E0D\u51FA\u57DF")), /* @__PURE__ */ React.createElement(GroupHeading, { label: "\u8FDB\u884C\u4E2D", action: "\u67E5\u770B\u5168\u90E8" }), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement(TaskListItem, { onClick: () => setTask("attention"), selected: task === "attention", status: "attention", title: "\u9879\u76EE\u91CC\u7A0B\u7891\u4E0E\u63D0\u9192", meta: "\u6B65\u9AA4 4/7", time: "2 \u5206\u949F\u524D" }), /* @__PURE__ */ React.createElement(TaskListItem, { onClick: () => setTask("success"), selected: task === "success", status: "success", title: "\u9879\u76EE\u6708\u5EA6\u8FDB\u5C55\u7B80\u62A5 v3", meta: "\u4EA7\u7269\u5F85\u786E\u8BA4", time: "\u4ECA\u5929 11:20", last: true })), /* @__PURE__ */ React.createElement(
      DataTable,
      {
        selectedIndex: selected,
        onSelect: setSelected,
        sortKey,
        sortDir: dir,
        onSort: (k) => {
          setDir(k === sortKey ? -dir : 1);
          setSortKey(k);
        },
        columns: [{ key: "name", label: "\u5BA2\u6237\u540D\u79F0", width: "1.5fr", primary: true }, { key: "branch", label: "\u9879\u76EE\u7EC4" }, { key: "due", label: "\u5230\u671F\u65E5", width: ".9fr", mono: true, sortable: true }, { key: "amt", label: "\u9884\u7B97/\u4E07", width: ".8fr", mono: true, align: "right", sortable: true }],
        rows
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "cs-col" }, /* @__PURE__ */ React.createElement(
      ConnectorCard,
      {
        name: "\u6838\u5FC3\u4E1A\u52A1\u6570\u4ED3",
        meta: "\u53EA\u8BFB \xB7 \u884C\u5185\u7F51",
        enabled: conn,
        onToggle: setConn,
        description: "\u9879\u76EE\u5B58\u8D37\u3001\u5BA2\u6237\u3001\u8D26\u6237\u4E3B\u9898\u57DF\uFF1B\u67E5\u8BE2\u7ECF\u8131\u654F\u89C6\u56FE\uFF0C\u4E0D\u843D\u76D8\u3002"
      }
    ), /* @__PURE__ */ React.createElement(ScrollArea, { header: "\u8FD0\u884C\u7559\u75D5", height: 150 }, /* @__PURE__ */ React.createElement("div", { className: "cs-col", style: { padding: "var(--cs-space-2) var(--cs-space-3)", gap: "var(--cs-space-2)" } }, [["14:02", "\u5EFA\u7ACB\u6570\u4ED3\u8FDE\u63A5"], ["14:03", "\u62C9\u53D6\u53F0\u8D26 1,842 \u6761"], ["14:04", "\u6309\u5230\u671F\u65E5\u7B5B\u51FA 137 \u6761"], ["14:05", "\u5173\u8054\u9879\u76EE\u7EC4\u5F52\u5C5E"], ["14:06", "\u6BD4\u5BF9\u4E0A\u671F\u9879\u76EE\u62A5\u544A\u53E3\u5F84"]].map(([t, x]) => /* @__PURE__ */ React.createElement("div", { key: t, className: "cs-row", style: { gap: "var(--cs-space-2)", fontSize: "var(--cs-size-ui-sm)", color: "var(--cs-ink-70)" } }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--cs-font-sans)", color: "var(--cs-text-placeholder)" } }, t), x)))), /* @__PURE__ */ React.createElement("div", { className: "cs-row", style: { gap: "var(--cs-space-3)", alignItems: "stretch" } }, /* @__PURE__ */ React.createElement(AspectRatio, { ratio: "16/9", style: { flex: 1 } }), /* @__PURE__ */ React.createElement(AspectRatio, { ratio: "1/1", style: { width: 74 } }), /* @__PURE__ */ React.createElement(AspectRatio, { ratio: "1/1.414", style: { width: 56, background: "var(--cs-white)" } }))));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(Demo, null));
})();
