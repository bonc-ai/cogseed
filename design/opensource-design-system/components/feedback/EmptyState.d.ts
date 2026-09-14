/** 空状态。内容水平居中对齐；线性图标（1.2px、ink-24）、一句原因、一句办法、最多一个次级按钮。 */
export interface EmptyStateProps {
  /** Icon 名，默认 'docLines' */
  icon?: string;
  title: string;
  /** 一句原因 + 一句办法 */
  reason?: string;
  /** 最多一个次级按钮 */
  action?: string;
  onAction?: () => void;
  style?: React.CSSProperties;
}
export declare function EmptyState(props: EmptyStateProps): JSX.Element;
