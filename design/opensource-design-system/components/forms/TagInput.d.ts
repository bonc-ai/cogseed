/** 多选标签输入。容器高度随内容增长，不出现内部滚动。 */
export interface TagInputProps {
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  tags?: string[];
  /** 上限，配 Field 的 help 显示「已选 n / max」 */
  max?: number;
  placeholder?: string;
  onChange?: (tags: string[]) => void;
  style?: React.CSSProperties;
}
export declare function TagInput(props: TagInputProps): JSX.Element;
