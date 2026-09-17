/**
 * 全局内容搜索，保留 CommandPalette 导出以兼容调用路径。
 * @startingPoint section="检索与录入" subtitle="全局搜索 ⌘K · 任务与资料库内容" viewport="700x400"
 */
export interface CommandItem {
  /** 同一任务的不同命中消息使用不同 id；由调用方保存路由、消息定位等额外字段。 */
  id?: string;
  title: string;
  icon?: string;
  meta?: string;
  snippet?: string;
  [key: string]: unknown;
}
export interface CommandGroup {
  /** 推荐 chat / agent / skill / context；省略时以 label 为标识。 */
  id?: string;
  label: string;
  items: CommandItem[];
}
export interface CommandPaletteProps {
  /** 受控查询，须配套 onQueryChange；不传时使用内部状态。 */
  query?: string;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  /** 已授权的本地内容集合。组件按标题、元信息和摘要过滤，不请求服务。 */
  groups?: CommandGroup[];
  onSelect?: (item: CommandItem, group: CommandGroup) => void;
  onClose?: () => void;
  history?: string[];
  /** 选择或关闭时记入去重后的最近 12 项；清空传 []，调用方负责保存。 */
  onHistoryChange?: (history: string[]) => void;
  /** 模态模式包含 portal、遮罩、焦点限制/返回与 Escape；不要再套业务遮罩。 */
  modal?: boolean;
  open?: boolean;
  footer?: string;
  style?: React.CSSProperties;
}
export declare function CommandPalette(props: CommandPaletteProps): JSX.Element;
