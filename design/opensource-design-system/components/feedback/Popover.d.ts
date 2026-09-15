/** 弹出层与气泡提示。二者都不带箭头小三角。 */
export interface PopoverProps {
  title?: string;
  /** 头部右侧 Mono 徽标，如 '只读' */
  badge?: string;
  children?: React.ReactNode;
  /** 页脚一句说明，如「由管理员在连接器策略中配置」 */
  footer?: React.ReactNode;
  /** 默认 280 */
  width?: number | string;
  /** 传入 open 启用锚定模式；anchorRef 指向触发器容器，浮层通过 portal 避免滚动裁切。 */
  open?: boolean;
  /** 持续录音等状态浮层可关闭外部点击与 Escape 收起。 */
  dismissible?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchorRef?: React.RefObject<HTMLElement>;
  returnFocusRef?: React.RefObject<HTMLElement>;
  align?: 'start' | 'end';
  label?: string;
  style?: React.CSSProperties;
}
export interface TooltipProps {
  /** 一句解释，一行不超过 24 字；延迟 400ms 出现、80ms 消失 */
  label: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Popover(props: PopoverProps): JSX.Element;
export declare function Tooltip(props: TooltipProps): JSX.Element;

export interface PopoverItemProps {
  label: string;
  description?: string;
  icon?: string;
  /** 不传即添加动作；传入布尔值即单选项，当前项显示勾选。 */
  selected?: boolean;
  trailing?: React.ReactNode;
  onClick?: () => void;
}
export declare function PopoverItem(props: PopoverItemProps): JSX.Element;
