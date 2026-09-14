/** 下拉菜单。最多两级、单级不超过 8 项；危险项放最后一组且永不是第一项。 */
export interface DropdownMenuGroup {
  /** Mono 分组小标题，如 '危险操作' */
  label?: string;
  /** 整组以 critical 呈现 */
  danger?: boolean;
  items: {
    label: string;
    /** Icon 名，左置 */
    icon?: string;
    /** 右置 Mono 快捷键，如 '⌘S' */
    shortcut?: string;
    /** 有二级菜单：显示右向箭头而非展开 */
    submenu?: boolean;
    onSelect?: () => void;
  }[];
}
export interface DropdownMenuProps {
  /** 触发器节点，通常是 IconButton + dots 图标 */
  trigger?: React.ReactNode;
  groups?: DropdownMenuGroup[];
  /** 受控开合；不传则组件内部管理 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 200–248，默认 232 */
  width?: number | string;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  header?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function DropdownMenu(props: DropdownMenuProps): JSX.Element;
