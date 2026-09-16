/** 侧栏导航项。不用左侧色条、不用阴影；选中态只加 9% 淡蓝底与略深文字，字重保持 400。 */
export interface NavItemProps {
  'aria-current'?: 'page' | 'true' | 'false';
  expanded?: boolean;
  /** 16px 线性图标，使用 <Icon />；最近/空间列表项可不带图标 */
  icon?: React.ReactNode;
  label: string;
  /** 计数右对齐；未传入时隐藏 */
  count?: number;
  selected?: boolean;
  /** 二级缩进（空间下的任务），左内边距 22 */
  indent?: boolean;
  /** md 36（一级导航）· sm 34（最近 / 空间列表） */
  size?: 'md' | 'sm';
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function NavItem(props: NavItemProps): JSX.Element;
