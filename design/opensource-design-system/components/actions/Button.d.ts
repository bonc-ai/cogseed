/**
 * 按钮。通用控件高度 28 / 32 / 36 三档，登录按钮保留 56px 特例；一屏只允许一个主要操作按钮。
 * @startingPoint section="操作" subtitle="主/次/文字/危险按钮与图标钮" viewport="700x150"
 */
export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  /** primary 蓝渐变主操作（一屏一个）· secondary 描边次操作 · ghost 文字按钮 · danger 描边危险 · dangerSolid 实心危险（仅对话框）· ink 近黑（内联授权“允许一次”） */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid' | 'ink' | 'suggestion';
  /** sm 28 · md 32 · lg 36 · login 56（仅登录） */
  size?: 'sm' | 'md' | 'lg' | 'login';
  disabled?: boolean;
  /** loading 时保持原宽度、禁用而不消失 */
  loading?: boolean;
  /** 左侧图标，使用 <Icon /> */
  icon?: React.ReactNode;
  children?: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  style?: React.CSSProperties;
}
export declare function Button(props: ButtonProps): JSX.Element;
