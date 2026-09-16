/** 纯图标按钮。附件键、发送键、工具栏钮。 */
export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  /** sm 28 · md 32 · lg 36 */
  size?: 'sm' | 'md' | 'lg';
  /** outline 描边 · quiet 无底色（hover 上 ink 6%）· accent 蓝渐变（仅发送键） */
  variant?: 'outline' | 'quiet' | 'accent';
  /** quiet 变体的选中态 */
  active?: boolean;
  disabled?: boolean;
  title?: string;
  children?: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  style?: React.CSSProperties;
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
