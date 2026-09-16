/** 骨架屏。形状必须与真实内容的行数、宽度一致，只做透明度呼吸，不做扫光。 */
export interface SkeletonProps {
  /** 每行宽度百分比；首行按标题（h 13），其余 h 10 */
  lines?: number[];
  /** 追加一个「30px 图标 + 两行文字」的媒体块 */
  withMedia?: boolean;
  style?: React.CSSProperties;
}
export declare function Skeleton(props: SkeletonProps): JSX.Element;
