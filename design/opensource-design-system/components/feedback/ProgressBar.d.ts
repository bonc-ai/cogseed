/** 进度条与转圈。能预估进度就用 3px 进度条，只有「不知道要多久」才用转圈。 */
export interface ProgressBarProps {
  value?: number;
  max?: number;
  /** ink 主区（默认）· attention 侧栏卡片内 */
  tone?: 'ink' | 'attention';
  maxWidth?: number | string;
  style?: React.CSSProperties;
}
export interface SpinnerProps {
  /** 13 行内 · 16 区块 · 12 按钮内 */
  size?: number;
  /** ink 中性 · attention 当前执行步骤（1.1s）· light 深底上 */
  tone?: 'ink' | 'attention' | 'light';
  style?: React.CSSProperties;
}
export declare function ProgressBar(props: ProgressBarProps): JSX.Element;
export declare function Spinner(props: SpinnerProps): JSX.Element;
