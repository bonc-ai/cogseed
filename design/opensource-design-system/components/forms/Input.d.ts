/** 输入框。六态：默认 / 焦点 / 错误 / 带前缀图标 / 禁用 / 前置附加。 */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** md 32 · lg 36（默认） */
  size?: 'md' | 'lg';
  /** 左侧图标名（如 'search'） */
  icon?: string;
  /** 右侧 Mono 后缀，如 '⌘K' */
  suffix?: string;
  /** 左侧 Mono 前置附加，如 'https://' */
  prefix?: string;
  /** 错误态：只加深描边 + 行内图标，文字说明由 Field 承担 */
  invalid?: boolean;
  /** 校验通过的绿勾 */
  valid?: boolean;
  disabled?: boolean;
  /** 数值/日期/文件名等一律等宽 */
  mono?: boolean;
  style?: React.CSSProperties;
}
export declare function Input(props: InputProps): JSX.Element;
