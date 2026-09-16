/** 开关。开为 ink 实底；条件开用琥珀，连接器正常用 success。 */
export interface SwitchProps {
  'aria-label'?: string;
  checked?: boolean;
  /** 打开时的轨道色：ink（默认）/ var(--cs-attention) 条件开 / var(--cs-success) 连接正常 */
  onColor?: string;
  /** sm 32×18（卡片内）· md 34×20 */
  size?: 'sm' | 'md';
  onChange?: (checked: boolean) => void;
  style?: React.CSSProperties;
}
export declare function Switch(props: SwitchProps): JSX.Element;
