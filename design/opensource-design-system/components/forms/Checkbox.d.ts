/** 复选框 15×15、r 4。选中为 ink 实底 + 白勾。 */
export interface CheckboxProps {
  checked?: boolean;
  /** 部分选中：白色横杠 */
  indeterminate?: boolean;
  disabled?: boolean;
  label?: string;
  /** 标签下的一句说明 */
  help?: string;
  onChange?: (checked: boolean) => void;
  style?: React.CSSProperties;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
