/* Generated from ui_kits/enterprise-app/App.jsx by tools/build.cjs. */
(() => {
  const { Toast, CommandPalette } = window.CogSeedDesignSystem_f581b5;
  const TASKS = window.SIDEBAR_RECENT;
  const PREVIEW_ROUTES = ["login", "home", "spaces", "space", "space-task", "cognition", "automation", "capabilities", "task", "settings"];
  function readPreviewRoute() {
    const page = new URLSearchParams(location.search).get("page") || document.getElementById("root")?.dataset.previewPage;
    return PREVIEW_ROUTES.includes(page) ? page : "login";
  }
  function readCapabilityTab() {
    return new URLSearchParams(location.search).get("tab") || "agents";
  }
  function readTask() {
    const q = new URLSearchParams(location.search);
    return {
      ...TASKS[0],
      title: q.get("task") || TASKS[0].title,
      spaceId: q.get("space") || void 0,
      content: q.get("content") || void 0,
      agentName: q.get("actor") || void 0,
      reference: q.get("reference") || void 0
    };
  }
  function App() {
    const previousWorkspace = React.useRef("home");
    const [route, setRoute] = React.useState(readPreviewRoute);
    const [spaces, setSpaces] = React.useState(() => window.SPACE_CARDS.map((s, i) => ({ ...s, id: `space-${i}`, owned: i < 2, archived: false })));
    const [spaceId, setSpaceId] = React.useState(() => new URLSearchParams(location.search).get("space") || "space-0");
    const [task, setTask] = React.useState(readTask);
    const [collapsed, setCollapsed] = React.useState(false), [openSpace, setOpenSpace] = React.useState("\u4EA7\u54C1\u7814\u53D1");
    const [toast, setToast] = React.useState(null), [cmd, setCmd] = React.useState(false), [searchHistory, setSearchHistory] = React.useState([]);
    const [capabilityFilter, setCapabilityFilter] = React.useState(readCapabilityTab);
    const [agentDialog, setAgentDialog] = React.useState(false);
    React.useEffect(() => {
      const restore = () => {
        setRoute(readPreviewRoute());
        setSpaceId(new URLSearchParams(location.search).get("space") || "space-0");
        setTask(readTask());
        setCapabilityFilter(readCapabilityTab());
        setCmd(false);
        setToast(null);
        setAgentDialog(false);
      };
      addEventListener("popstate", restore);
      return () => removeEventListener("popstate", restore);
    }, []);
    React.useEffect(() => {
      const key = (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
          e.preventDefault();
          setCmd((v) => !v);
        }
      };
      addEventListener("keydown", key);
      return () => removeEventListener("keydown", key);
    }, []);
    const go = (next, payload) => {
      if (next === "command") {
        setCmd(true);
        return;
      }
      if (!PREVIEW_ROUTES.includes(next)) return;
      if (next === "settings" && route !== "settings" && route !== "login") previousWorkspace.current = route;
      const url = new URL(location.href);
      url.searchParams.set("page", next);
      ["section", "detail", "tab", "agent", "edit", "view", "scene", "all", "task", "content", "actor", "reference", "query", "action", "market", "skill"].forEach((k) => url.searchParams.delete(k));
      if (next === "task" || next === "space-task") {
        const value = { ...payload };
        if (!value.title) value.title = "\u65B0\u4EFB\u52A1";
        if (value.spaceId) {
          setSpaceId(value.spaceId);
          url.searchParams.set("space", value.spaceId);
        } else url.searchParams.delete("space");
        if (!value.content && (value.reference || value.title === "\u65B0\u4EFB\u52A1" || value.title === "\u7A7A\u95F4\u6A21\u5F0F")) value.content = "empty";
        setTask(value);
        url.searchParams.set("task", value.title);
        if (value.content) url.searchParams.set("content", value.content);
        if (value.agentName) url.searchParams.set("actor", value.agentName);
        if (value.reference) url.searchParams.set("reference", value.reference);
      } else if (next === "space") {
        const id = payload?.id || spaceId;
        setSpaceId(id);
        url.searchParams.set("space", id);
      } else url.searchParams.delete("space");
      history.pushState(null, "", url);
      setRoute(next);
      setCmd(false);
      setToast(null);
    };
    const openCapabilities = (tab, item) => {
      go("capabilities");
      setCapabilityFilter(tab);
      const url = new URL(location.href);
      url.searchParams.set("tab", tab);
      if (item?.agentId) url.searchParams.set("agent", item.agentId);
      if (item?.title) url.searchParams.set("query", item.title);
      history.replaceState(null, "", url);
    };
    const chooseResult = (item, group) => {
      setCmd(false);
      if (group.id === "chat") go(item.spaceId ? "space-task" : "task", item);
      else openCapabilities({ agent: "agents", skill: "skills", context: "library" }[group.id] || "agents", item);
    };
    const searchGroups = (window.SEARCH_PREVIEW || []).map((g) => g.id === "chat" ? { ...g, items: [...g.items, ...spaces.flatMap((s) => s.tasks.map((t, i) => ({ id: s.id + "-" + i, title: t[1], spaceId: s.id, meta: s.name, snippet: "\u7A7A\u95F4\u4EFB\u52A1 \xB7 " + s.name, icon: "message" })))] } : g);
    const taskSpace = spaces.find((s) => s.id === task.spaceId);
    const gallery = route === "task" && document.getElementById("root")?.dataset.previewPage === "task" && !new URLSearchParams(location.search).has("task");
    const taskView = /* @__PURE__ */ React.createElement(
      TaskScreen,
      {
        key: [task.title, task.spaceId, task.reference].join(":"),
        title: task.title,
        content: task.content || "analysis",
        agentName: task.agentName || taskSpace?.agents?.[0] || (task.content === "empty" ? "cogseed" : "\u9879\u76EE\u52A9\u7406"),
        initialMessage: task.initialMessage,
        initialReference: task.reference,
        workspace: taskSpace || null,
        initialState: task.content === "empty" ? "idle" : "running",
        onOpenSpace: () => go("space", taskSpace),
        onBack: () => go(taskSpace ? "space" : "home", taskSpace),
        collapsed,
        onExpand: () => setCollapsed(false)
      }
    );
    return /* @__PURE__ */ React.createElement("div", { className: "cs-window", style: { position: "relative" } }, route === "login" ? /* @__PURE__ */ React.createElement(LoginScreen, { onLogin: () => go("home") }) : route === "settings" ? /* @__PURE__ */ React.createElement(SettingsScreen, { onBack: () => go(previousWorkspace.current), onLibrary: () => openCapabilities("library") }) : gallery ? /* @__PURE__ */ React.createElement(TaskStateSheet, null) : /* @__PURE__ */ React.createElement(React.Fragment, null, !collapsed && /* @__PURE__ */ React.createElement(Sidebar, { spaces: spaces.filter((s) => !s.archived), route, onRoute: go, recent: TASKS, selectedTaskId: task.id || task.title, openSpace, onSettings: () => go("settings"), onSignOut: () => go("login"), onToggleSpace: setOpenSpace, onCollapse: () => setCollapsed(true) }), route === "home" && /* @__PURE__ */ React.createElement(HomeScreen, { spaces, collapsed, onExpand: () => setCollapsed(false), onConnectAgent: () => setAgentDialog(true), onOpenTask: (t) => go(t.spaceId ? "space-task" : "task", t), onSubmit: (value) => {
      const t = typeof value === "string" ? { title: value.trim(), initialMessage: value.trim(), content: "empty" } : value;
      if (t?.title?.trim()) go(t.spaceId ? "space-task" : "task", t);
    } }), route === "spaces" && /* @__PURE__ */ React.createElement(SpaceHubScreen, { spaces, setSpaces, collapsed, onExpand: () => setCollapsed(false), onOpenTask: (t) => go("space-task", t), onOpenSpace: (s) => go("space", s) }), route === "space" && /* @__PURE__ */ React.createElement(SpaceDetailScreen, { key: spaceId, space: spaces.find((s) => s.id === spaceId), setSpaces, collapsed, onExpand: () => setCollapsed(false), onBack: () => go("spaces"), onOpenTask: (t) => go("space-task", t) }), (route === "task" || route === "space-task") && taskView, route === "cognition" && /* @__PURE__ */ React.createElement(CognitionScreen, { collapsed, onExpand: () => setCollapsed(false), onHome: () => go("home") }), route === "automation" && /* @__PURE__ */ React.createElement(AutomationScreen, { onOpenTask: (t) => go("task", t), collapsed, onExpand: () => setCollapsed(false) }), route === "capabilities" && /* @__PURE__ */ React.createElement(CapabilitiesScreen, { initialFilter: capabilityFilter, collapsed, onExpand: () => setCollapsed(false), onUse: (t) => go("task", t), onSearch: () => setCmd(true) })), cmd && /* @__PURE__ */ React.createElement(CommandPalette, { modal: true, groups: searchGroups, history: searchHistory, onHistoryChange: setSearchHistory, onSelect: chooseResult, onClose: () => setCmd(false) }), agentDialog && window.AgentCreateDialog && /* @__PURE__ */ React.createElement(window.AgentCreateDialog, { open: true, initialMode: "external", onClose: () => setAgentDialog(false), onCreated: (agent) => {
      setAgentDialog(false);
      openCapabilities("agents");
      const url = new URL(location.href);
      url.searchParams.set("agent", agent.id);
      url.searchParams.set("edit", "1");
      history.replaceState(null, "", url);
    } }), toast && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", right: 24, bottom: 24, zIndex: "var(--cs-layer-toast)" } }, /* @__PURE__ */ React.createElement(Toast, { title: toast, onClose: () => setToast(null) })));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(App, null));
})();
