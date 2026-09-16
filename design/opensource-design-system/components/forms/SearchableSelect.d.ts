/** 可搜索选择器。与普通下拉共用菜单几何，只多一条搜索行与页脚计数。 */
export interface SearchableSelectProps {
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  options?: string[];
  value?: string | null;
  /** 标记为「最近」的选项 */
  recent?: string[];
  /** 服务端总条数，用于页脚计数 */
  total?: number;
  placeholder?: string;
  onChange?: (value: string) => void;
  style?: React.CSSProperties;
}
export declare function SearchableSelect(props: SearchableSelectProps): JSX.Element;
