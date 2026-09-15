/** 通知。浮于全局右下角，只报告「刚刚发生了什么」。同时最多 2 条。 */
export interface ToastProps {
  tone?: 'success' | 'critical';
  title: string;
  /** 一句细节或时间地点 */
  meta?: string;
  /** 最多一个动作，默认「查看」；传 '' 去掉 */
  action?: string;
  onAction?: () => void;
  onClose?: () => void;
  style?: React.CSSProperties;
}
export declare function Toast(props: ToastProps): JSX.Element;
