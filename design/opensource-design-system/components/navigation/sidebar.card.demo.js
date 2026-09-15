/* Generated from components/navigation/sidebar.card.demo.jsx by tools/build.cjs. */
(() => {
  const { Button } = window.CogSeedDesignSystem_f581b5;
  const EXAMPLE_TASKS = [
    { id: "credit", title: "\u9879\u76EE\u91CC\u7A0B\u7891\u4E0E\u63D0\u9192", running: 2, queued: 1, plan: { done: 4, total: 7, active: 1 }, time: "2\u5206" },
    { id: "monthly", title: "\u9879\u76EE\u6708\u5EA6\u8FDB\u5C55\u7B80\u62A5 v3", auto: true, plan: { done: 7, total: 7 }, time: "3\u5C0F\u65F6", pinned: true },
    { id: "reconcile", title: "\u6838\u5BF9 T+1 \u4EA4\u6613\u5BF9\u8D26\u5DEE\u5F02", plan: { done: 2, total: 5, failed: 1 }, time: "\u6628\u5929" },
    { id: "review", title: "\u8D44\u6599\u6765\u6E90\u4E0E\u5F15\u7528\u590D\u6838", plan: { done: 1, total: 4, blocked: 1 }, time: "\u6628\u5929" },
    { id: "queued", title: "\u5B63\u5EA6\u9879\u76EE\u53F0\u8D26\u6C47\u603B", queued: 2, time: "2\u5929" },
    { id: "untitled", title: "", time: "3\u5929" },
    { id: "channel", title: "\u5C0F\u7EC4\u8FD0\u8425\u95EE\u9898\u8DDF\u8FDB", channel: "\u98DE\u4E66", time: "1\u5C0F\u65F6" },
    { id: "space-credit", title: "\u9879\u76EE\u6750\u6599\u6E05\u5355\u6838\u9A8C", spaceId: "\u4EA7\u54C1\u7814\u53D1", running: 1, plan: { done: 2, total: 6, active: 1 }, time: "5\u5206" },
    { id: "space-risk", title: "\u8DE8\u9879\u76EE\u4F9D\u8D56\u5173\u7CFB\u56FE\u8C31", spaceId: "\u4EA7\u54C1\u7814\u53D1", time: "1\u5929" },
    { id: "space-wealth", title: "\u4EA7\u54C1\u8BF4\u660E\u4E66\u8981\u70B9\u63D0\u53D6", spaceId: "\u5185\u5BB9\u521B\u4F5C", time: "2\u5929" }
  ];
  const variants = [["default", "\u9ED8\u8BA4"], ["task", "\u4EFB\u52A1\u9009\u4E2D"], ["closed", "\u7A7A\u95F4\u6536\u8D77"], ["long", "\u957F\u5217\u8868\u4E0E\u957F\u540D\u79F0"], ["empty", "\u7A7A\u6570\u636E"], ["collapsed", "\u4FA7\u680F\u6536\u8D77"]];
  function SidebarSpecimen({ variant }) {
    const [route, setRoute] = React.useState(variant === "task" ? "task" : "home");
    const [selected, setSelected] = React.useState(variant === "task" ? "credit" : null);
    const [collapsed, setCollapsed] = React.useState(variant === "collapsed");
    const [notice, setNotice] = React.useState("");
    const [liveTasks, setLiveTasks] = React.useState([]);
    const tasks = variant === "empty" ? [] : variant === "long" ? Array.from({ length: 24 }, (_, i) => ({ id: `long-${i}`, title: `${i + 1} \xB7 \u534E\u4E1C\u56E2\u961F\u9879\u76EE\u5BA2\u6237\u9879\u76EE\u989D\u5EA6\u4E0E\u5230\u671F\u98CE\u9669\u6838\u9A8C\u5DE5\u4F5C\u8BB0\u5F55`, time: `${i + 1}\u5929`, ...i === 0 ? { running: 1, queued: 3, plan: { done: 3, total: 8, active: 1 } } : {} })) : EXAMPLE_TASKS;
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: collapsed ? "stage is-collapsed" : "stage" }, collapsed ? /* @__PURE__ */ React.createElement("div", { className: "collapsed-controls" }, /* @__PURE__ */ React.createElement(window.CollapsedSidebarControls, { onExpand: () => setCollapsed(false) })) : /* @__PURE__ */ React.createElement(
      window.Sidebar,
      {
        route,
        onRoute: (next, task) => {
          setRoute(next);
          setSelected(task?.id);
          setNotice(next === "task" ? task.title || "\u65B0\u4EFB\u52A1" : next === "home" ? "\u5DF2\u6253\u5F00\u65B0\u5EFA\u4EFB\u52A1" : `\u5DF2\u9009\u62E9${{ spaces: "\u5DE5\u4F5C\u7A7A\u95F4", automation: "\u81EA\u52A8\u5316", capabilities: "\u667A\u80FD\u4F53 / \u6280\u80FD / \u8FDE\u63A5", command: "\u641C\u7D22" }[next] || next}`);
        },
        selectedTaskId: selected,
        initialFolded: variant === "closed" ? Object.fromEntries(window.SPACES.map((s) => [s.id || s.name, true])) : {},
        onCollapse: () => setCollapsed(true),
        taskItems: [...liveTasks, ...tasks],
        spaces: variant === "empty" ? [] : window.SPACES,
        onSettings: () => setNotice("\u5DF2\u9009\u62E9\u8BBE\u7F6E"),
        onSignOut: () => setNotice("\u5DF2\u9009\u62E9\u9000\u51FA\u767B\u5F55")
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "specimen-toolbar" }, /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => setLiveTasks((rows) => [{ id: `live-${rows.length}`, title: "\u4E0A\u6E38\u65B0\u589E\u4EFB\u52A1", time: "\u521A\u521A" }, ...rows]) }, "\u52A0\u5165\u4E0A\u6E38\u4EFB\u52A1"), /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => setLiveTasks([]) }, "\u79FB\u9664\u4E0A\u6E38\u4EFB\u52A1")), notice && /* @__PURE__ */ React.createElement("div", { className: "notice", role: "status" }, notice));
  }
  function readVariant() {
    const hash = window.location.hash.slice(1);
    return variants.some(([id]) => id === hash) ? hash : "default";
  }
  function Demo() {
    const [variant, setVariant] = React.useState(readVariant);
    const [revision, setRevision] = React.useState(0);
    React.useEffect(() => {
      const change = () => setVariant(readVariant());
      window.addEventListener("hashchange", change);
      return () => window.removeEventListener("hashchange", change);
    }, []);
    return /* @__PURE__ */ React.createElement("main", null, /* @__PURE__ */ React.createElement("h1", null, "\u4FA7\u8FB9\u680F\u5BFC\u822A"), /* @__PURE__ */ React.createElement("div", { className: "specimen-toolbar" }, /* @__PURE__ */ React.createElement("label", null, "\u72B6\u6001 ", /* @__PURE__ */ React.createElement("select", { value: variant, onChange: (e) => {
      setVariant(e.target.value);
      window.location.hash = e.target.value;
    } }, variants.map(([id, label]) => /* @__PURE__ */ React.createElement("option", { key: id, value: id }, label)))), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => setRevision((n) => n + 1) }, "\u91CD\u7F6E")), /* @__PURE__ */ React.createElement(SidebarSpecimen, { key: `${variant}-${revision}`, variant }));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(Demo, null));
})();
