/** 单选。圆点 15；行式 Radio 与带说明的 RadioCard（选中 accent 9% 底）。 */
export interface RadioProps {
  name?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  label?: string;
  onChange?: (checked: true) => void;
  style?: React.CSSProperties;
}
export interface RadioCardProps {
  disabled?: boolean;
  name?: string;
  value?: string;
  checked?: boolean;
  title?: string;
  help?: string;
  onChange?: (checked: true) => void;
  style?: React.CSSProperties;
}
export declare function Radio(props: RadioProps): JSX.Element;
export declare function RadioCard(props: RadioCardProps): JSX.Element;
