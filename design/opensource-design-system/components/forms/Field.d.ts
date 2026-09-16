/** 字段组合。结构恒定：标签 · 控件 · 说明或错误。 */
export interface FieldProps {
  /** 标签永不用冒号 */
  label?: string;
  /** 用「选填」标注，不用「*」标必填 */
  optional?: boolean;
  help?: string;
  /** 有错误时替换 help 显示 */
  error?: string;
  /** 字数统计，仅在有上限时出现，如 '48 / 300' */
  count?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Field(props: FieldProps): JSX.Element;
