/** 文本域。行高 1.75，不可缩放，配 Field 使用。 */
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 最小高度，默认 64 */
  minHeight?: number;
  style?: React.CSSProperties;
}
export declare function Textarea(props: TextareaProps): JSX.Element;
