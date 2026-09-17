/** 对象相邻的页内确认，保留上下文；不承担模态焦点锁定。 */
export interface InlineConfirmProps {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onCancel?: () => void;
  onConfirm?: () => void;
  style?: React.CSSProperties;
}
export declare function InlineConfirm(props: InlineConfirmProps): JSX.Element;
