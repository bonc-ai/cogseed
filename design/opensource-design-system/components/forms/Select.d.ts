/** 下拉选择。选中项用勾而非高亮色块，勾位固定 22px 缩进。 */
export interface SelectProps {
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  options?: string[];
  value?: string | null;
  placeholder?: string;
  /** 菜单顶部 系统非衬线分组小标题，如 '按分部' */
  groupLabel?: string;
  /** 无权限项：保留可见但置灰，让权限边界可被理解 */
  disabledOptions?: string[];
  disabled?: boolean;
  size?: 'md' | 'lg';
  onChange?: (value: string) => void;
  style?: React.CSSProperties;
}
export declare function Select(props: SelectProps): JSX.Element;
