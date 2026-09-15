/** 分段控件。负责「同一列表的不同筛选」，容器 h 28（内项 24）。 */
export interface SegmentedControlProps {
  ariaLabel?: string;
  items?: React.ReactNode[];
  value?: number;
  onChange?: (index: number) => void;
  style?: React.CSSProperties;
}
export declare function SegmentedControl(props: SegmentedControlProps): JSX.Element;
