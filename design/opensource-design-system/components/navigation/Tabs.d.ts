/** 页签。1.5px 下压线，不用胶囊背景。负责「同一对象的不同视图」。 */
export interface TabsProps {
  /** 字符串或 { label, count, disabled }；无权限项保留可见但置灰 */
  items?: (string | { label: string; count?: number; disabled?: boolean })[];
  value?: number;
  onChange?: (index: number) => void;
  /** 可访问的页签组名称 */
  ariaLabel?: string;
  style?: React.CSSProperties;
}
export declare function Tabs(props: TabsProps): JSX.Element;
