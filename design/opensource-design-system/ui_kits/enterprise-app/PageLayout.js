/* Generated from ui_kits/enterprise-app/PageLayout.jsx by tools/build.cjs. */
(() => {
  const { CollapsedSidebarControls, TrafficLights } = window;
  function PageFrame({ className = "", home = false, children, style }) {
    return /* @__PURE__ */ React.createElement("main", { className, style: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, position: "relative", background: "var(--cs-white)", ...style } }, home ? /* @__PURE__ */ React.createElement("div", { className: "cs-home-mist", "aria-hidden": "true" }) : null, children);
  }
  function PageHeader({ collapsed, onExpand, windowControls = false, leading, className = "", ...props }) {
    const SharedPageHeader = window.CogSeedDesignSystem_f581b5.PageHeader;
    return /* @__PURE__ */ React.createElement(
      SharedPageHeader,
      {
        ...props,
        className: "cs-app-titlebar " + className,
        "data-sidebar-collapsed": collapsed ? "true" : void 0,
        leading: collapsed || windowControls || leading ? /* @__PURE__ */ React.createElement(React.Fragment, null, collapsed ? /* @__PURE__ */ React.createElement(CollapsedSidebarControls, { onExpand }) : windowControls ? /* @__PURE__ */ React.createElement(TrafficLights, null) : null, leading) : void 0
      }
    );
  }
  function PageScroll({ className = "", children, style }) {
    return /* @__PURE__ */ React.createElement("div", { className, "data-cs-scroll": true, style: { position: "relative", flex: 1, minHeight: 0, overflow: "auto", overscrollBehavior: "contain", ...style } }, children);
  }
  function PageTabs({ items, value, onChange, actions, ariaLabel }) {
    const SharedTabs = window.CogSeedDesignSystem_f581b5.Tabs;
    return /* @__PURE__ */ React.createElement("div", { className: "cs-page-tabs" }, /* @__PURE__ */ React.createElement("div", { className: "cs-page-tabs-scroll" }, /* @__PURE__ */ React.createElement(SharedTabs, { items, value, onChange, ariaLabel, style: { borderBottom: 0 } })), actions ? /* @__PURE__ */ React.createElement("div", { className: "cs-page-tabs-actions" }, actions) : null);
  }
  Object.assign(window, { PageFrame, PageHeader, PageScroll, PageTabs });
})();
