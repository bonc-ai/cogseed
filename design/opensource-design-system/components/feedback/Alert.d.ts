/** 提示条。内联在内容流里，说明「这份结果的前提或问题」。一句结论 + 一句细节 + 最多一个动作。 */
export interface AlertProps {
  tone?: 'info' | 'attention' | 'critical' | 'success';
  title?: string;
  children?: React.ReactNode;
  /** 单个文字动作，如「重试」「查看这 3 户」 */
  action?: string;
  onAction?: () => void;
  /** 传入则显示关闭叉 */
  onClose?: () => void;
  style?: React.CSSProperties;
}
export declare function Alert(props: AlertProps): JSX.Element;
