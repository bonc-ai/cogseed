/** 标签 h 20 · r 4。同一处最多 4 个，超出折为「+n」；不参与交互，无 hover。 */
export interface TagProps {
  /** solid 中性实底（主题）· outline 描边（次级维度）· accent 淡底（@ 引用）· mono 文件元数据 · version 版本号 · success 合规声明 */
  variant?: 'solid' | 'outline' | 'accent' | 'mono' | 'version' | 'success';
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Tag(props: TagProps): JSX.Element;
