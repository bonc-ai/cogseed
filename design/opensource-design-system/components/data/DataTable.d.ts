/**
 * 数据表。原生表格，数值可右对齐；字体统一系统非衬线。
 * @startingPoint section="数据展示" subtitle="可排序数据表 · 行 h 44" viewport="700x220"
 */
export interface DataTableColumn {
  key: string;
  label: string;
  /** 支持 CSS 列宽；fr 比例换算为百分比，省略时按 1fr。 */
  width?: string;
  align?: 'left' | 'right';
  /** 兼容旧参数；字体统一系统非衬线。 */
  mono?: boolean;
  /** 主列：ink 而非 ink-60 */
  primary?: boolean;
  sortable?: boolean;
}
export interface DataTableProps {
  columns?: DataTableColumn[];
  rows?: Record<string, React.ReactNode>[];
  sortKey?: string;
  /** 1 升序 · -1 降序 */
  sortDir?: 1 | -1;
  selectedIndex?: number;
  onSort?: (key: string) => void;
  onSelect?: (index: number) => void;
  label?: string;
  style?: React.CSSProperties;
}
export declare function DataTable(props: DataTableProps): JSX.Element;
