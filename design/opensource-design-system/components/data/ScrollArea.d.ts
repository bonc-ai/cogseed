/** 滚动区与固定宽高比容器。 */
export interface ScrollAreaProps {
  /** 吸顶的 Mono 分组标题 */
  header?: React.ReactNode;
  height?: number | string;
  /** 底部 28px 白色渐隐提示，默认 true */
  fade?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export interface AspectRatioProps {
  /** 只用四种：'16/9' 产物缩略图与图表预览 · '4/3' 截图引用 · '1/1' 头像与图标位 · '1/1.414' A4 纸张 */
  ratio?: '16/9' | '4/3' | '1/1' | '1/1.414';
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function ScrollArea(props: ScrollAreaProps): JSX.Element;
export declare function AspectRatio(props: AspectRatioProps): JSX.Element;
