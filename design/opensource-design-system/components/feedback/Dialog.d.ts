/**
 * 确认对话框。仅用于不可撤销操作与需跨字段输入的表单；进度与授权都不弹窗。
 * 标题是问句、按钮是动词，永不用「确定／是」。遮罩 ink 28%，无模糊。
 */
export interface DialogProps {
  /** 问句形式的标题，如「删除任务与全部产物？」 */
  title: string;
  /** 必须说明「什么会保留、什么不可恢复」 */
  description?: string;
  /** 按钮行左侧的附加控件，如一个 Checkbox */
  extra?: React.ReactNode;
  children?: React.ReactNode;
  confirmDisabled?: boolean;
  /** 表单聚焦首个输入字段；确认默认聚焦取消。 */
  initialFocus?: 'cancel' | 'first';
  showClose?: boolean;
  cancelLabel?: string;
  /** 动词，如「删除」「存入空间」；主按钮位于最右 */
  confirmLabel?: string;
  /** 破坏性操作：主按钮实心 critical */
  danger?: boolean;
  /** 420–520，默认 420 */
  width?: number;
  onCancel?: () => void;
  onConfirm?: () => void;
  style?: React.CSSProperties;
}
export declare function Dialog(props: DialogProps): JSX.Element;
