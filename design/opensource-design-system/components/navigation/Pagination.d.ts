/** 分页。页码 28×28 · r 7；结果少于一页时整条隐藏。 */
export interface PaginationProps {
  page?: number;
  pageCount?: number;
  /** 传入总量则右侧显示 Mono 计数行 */
  total?: number;
  pageSize?: number;
  onChange?: (page: number) => void;
  locale?: string;
  style?: React.CSSProperties;
}
export declare function Pagination(props: PaginationProps): JSX.Element;
