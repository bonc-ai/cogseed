/** 滑块。轨 3px、拖柄 14px。只用于「凭感觉给值」的连续参数。 */
export interface SliderProps {
  value?: number;
  min?: number;
  max?: number;
  /** 底部 Mono 刻度标签 */
  ticks?: (string | number)[];
  onChange?: (value: number) => void;
  style?: React.CSSProperties;
}
export declare function Slider(props: SliderProps): JSX.Element;
