/* Generated from ui_kits/enterprise-app/Sidebar.jsx by tools/build.cjs. */
(() => {
  const { Icon, IconButton, NavItem, UserMenu, SidebarTasks } = window.CogSeedDesignSystem_f581b5;
  function TrafficLights() {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { style: { width: 12, height: 12, borderRadius: "50%", background: "var(--cs-window-close)" } }), /* @__PURE__ */ React.createElement("span", { style: { width: 12, height: 12, borderRadius: "50%", background: "var(--cs-window-minimize)" } }), /* @__PURE__ */ React.createElement("span", { style: { width: 12, height: 12, borderRadius: "50%", background: "var(--cs-window-maximize)" } }));
  }
  function CollapsedSidebarControls({ onExpand }) {
    return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "var(--cs-space-2)", flex: "none" } }, /* @__PURE__ */ React.createElement(TrafficLights, null), /* @__PURE__ */ React.createElement("span", { style: { width: 8 } }), /* @__PURE__ */ React.createElement(IconButton, { variant: "quiet", size: "sm", title: "\u5C55\u5F00\u4FA7\u8FB9\u680F", "aria-label": "\u5C55\u5F00\u4FA7\u8FB9\u680F", onClick: onExpand }, /* @__PURE__ */ React.createElement(Icon, { name: "sidebar" })));
  }
  function SectionLabel({ children, action }) {
    return /* @__PURE__ */ React.createElement("div", { style: { padding: "var(--cs-space-4) var(--cs-space-6) var(--cs-space-2)", display: "flex", alignItems: "center", gap: "var(--cs-space-2)" } }, /* @__PURE__ */ React.createElement("span", { style: { font: "var(--cs-type-label)", letterSpacing: "var(--cs-tracking-label)", textTransform: "uppercase", color: "var(--cs-text-placeholder)" } }, children), action ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", color: "var(--cs-text-placeholder)", cursor: "pointer" } }, action)) : null);
  }
  const { SIDEBAR_RECENT, SIDEBAR_PINNED, SPACES } = window;
  const sidebarTupleIds = /* @__PURE__ */ new WeakMap();
  let sidebarTaskSerial = 0;
  function sidebarSpaceTasks(spaces) {
    return spaces.map((space) => ({ ...space, tasks: (space.tasks || []).map((task) => {
      if (!Array.isArray(task)) return typeof task === "string" ? { id: `${space.id || space.name}::${task}`, title: task } : task;
      if (!sidebarTupleIds.has(task)) sidebarTupleIds.set(task, `space-task-${++sidebarTaskSerial}`);
      return { id: task.id || sidebarTupleIds.get(task), title: task[1], running: task[0] === "running" ? 1 : 0 };
    }) }));
  }
  function Sidebar({ spaces = SPACES, route, onRoute, onCollapse, recent = SIDEBAR_RECENT, pinned = SIDEBAR_PINNED, openSpace, onToggleSpace, onSettings, onSignOut, taskItems, initialFolded, selectedTaskId, initialMenuId }) {
    return /* @__PURE__ */ React.createElement("aside", { className: "cs-sidebar", style: {
      height: "100%",
      minHeight: 0,
      overflow: "hidden",
      width: "var(--cs-sidebar-width)",
      minWidth: "var(--cs-sidebar-width)",
      flex: "none",
      background: "var(--cs-sidebar-top)",
      borderRight: "1px solid var(--cs-border-subtle)",
      display: "flex",
      flexDirection: "column"
    } }, /* @__PURE__ */ React.createElement("div", { style: { height: "var(--cs-titlebar-height)", display: "flex", alignItems: "center", gap: "var(--cs-space-2)", padding: "0 var(--cs-space-4)", flex: "none" } }, /* @__PURE__ */ React.createElement(TrafficLights, null), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement(IconButton, { variant: "quiet", size: "sm", title: "\u641C\u7D22", onClick: () => onRoute("command") }, /* @__PURE__ */ React.createElement(Icon, { name: "search" })), /* @__PURE__ */ React.createElement(IconButton, { variant: "quiet", size: "sm", title: "\u6536\u8D77\u4FA7\u8FB9\u680F", onClick: onCollapse }, /* @__PURE__ */ React.createElement(Icon, { name: "sidebar" }))), /* @__PURE__ */ React.createElement("div", { className: "cs-brand", style: { padding: "var(--cs-space-1) var(--cs-space-4) var(--cs-space-4)", display: "flex", alignItems: "center", gap: "var(--cs-space-2)", flex: "none" } }, /* @__PURE__ */ React.createElement("img", { src: "../../assets/brand/logo.png", width: "26", height: "26", alt: "", draggable: "false" }), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 15, fontWeight: 600, letterSpacing: "-.01em" } }, "CogSeed")), /* @__PURE__ */ React.createElement("nav", { style: { padding: "0 var(--cs-space-3)", display: "flex", flexDirection: "column", gap: "var(--cs-space-1)", flex: "none" } }, /* @__PURE__ */ React.createElement(NavItem, { icon: /* @__PURE__ */ React.createElement(Icon, { name: "plus" }), label: "\u65B0\u5EFA\u4EFB\u52A1", selected: route === "home", onClick: () => onRoute("home") }), /* @__PURE__ */ React.createElement(NavItem, { icon: /* @__PURE__ */ React.createElement(Icon, { name: "space" }), label: "\u5DE5\u4F5C\u7A7A\u95F4", selected: route === "spaces", onClick: () => onRoute("spaces") }), /* @__PURE__ */ React.createElement(NavItem, { icon: /* @__PURE__ */ React.createElement(Icon, { name: "clock" }), label: "\u8BA4\u77E5\u8D44\u4EA7", active: route === "cognition", onClick: () => onRoute("cognition") }), /* @__PURE__ */ React.createElement(NavItem, { icon: /* @__PURE__ */ React.createElement(Icon, { name: "automation" }), label: "\u81EA\u52A8\u5316", selected: route === "automation", onClick: () => onRoute("automation") }), /* @__PURE__ */ React.createElement(NavItem, { icon: /* @__PURE__ */ React.createElement(Icon, { name: "connector" }), label: "\u667A\u80FD\u4F53 / \u6280\u80FD / \u8FDE\u63A5", selected: route === "capabilities", onClick: () => onRoute("capabilities") })), /* @__PURE__ */ React.createElement(
      SidebarTasks,
      {
        recent,
        pinned,
        spaces: sidebarSpaceTasks(spaces),
        items: taskItems,
        initialFolded,
        initialMenuId,
        selectedId: route === "task" ? selectedTaskId : null,
        onOpen: (task) => onRoute("task", task),
        onDeleteActive: () => onRoute("home")
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { flex: "none", borderTop: "1px solid var(--cs-border-subtle)", padding: "var(--cs-space-1) var(--cs-space-3)", background: "var(--cs-sidebar-bottom)" } }, /* @__PURE__ */ React.createElement(UserMenu, { name: "\u9648\u6631", description: "\u4E2A\u4EBA\u5DE5\u4F5C\u7A7A\u95F4", onSettings, onSignOut })));
  }
  Object.assign(window, { Sidebar, TrafficLights, CollapsedSidebarControls, SectionLabel, SPACES, SIDEBAR_RECENT, SIDEBAR_PINNED });
})();
