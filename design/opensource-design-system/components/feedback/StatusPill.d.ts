/** 状态胶囊、状态点与描边胶囊。列表里只用状态点，标题栏用胶囊。 */
export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: 'success' | 'attention' | 'critical' | 'neutral';
  /** 前置绿勾（配 success） */
  check?: boolean;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}
export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** success 已完成 · attention 运行中 · critical 失败 · idle 空闲 */
  tone?: 'success' | 'attention' | 'critical' | 'idle';
  label?: React.ReactNode;
  /** 列表 6px、胶囊内 5px */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}
export interface StatusCapsuleProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: 'success' | 'attention' | 'critical' | 'idle';
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}
export declare function StatusPill(props: StatusPillProps): JSX.Element;
export declare function StatusDot(props: StatusDotProps): JSX.Element;
export declare function StatusCapsule(props: StatusCapsuleProps): JSX.Element;
