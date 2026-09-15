/** 面包屑。超过 4 级中段折为「…」，末级为当前位置且不可点。 */
export interface BreadcrumbProps {
  /** 层级文本数组；用 '…' 表示折叠的中段 */
  items?: string[];
  /** 受控导航；末级和省略段不触发。缺省时所有层级只读。 */
  onNavigate?: (item: string, index: number) => void;
  style?: React.CSSProperties;
}
export declare function Breadcrumb(props: BreadcrumbProps): JSX.Element;
