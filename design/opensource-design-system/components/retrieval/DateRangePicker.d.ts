/** 日期与区间；受控值，ISO 本地日期，不转换时区。 */
export interface DateRange { start: string; end: string; }
export interface DateRangePickerProps {
  /** 结构化日期范围；string 仅兼容旧版只读展示。 */
  value?: DateRange | string;
  /** 空字符串表示不限制该端；仅有效区间触发。无效草稿保留在组件内并显示错误。 */
  onChange?: (range: DateRange) => void;
  /** 宿主按财年口径提供快捷区间，组件不推算季度。 */
  presetRanges?: Record<string, DateRange>;
  /** 当前命中的快捷区间 */
  preset?: string;
  presets?: string[];
  onPreset?: (preset: string) => void;
  style?: React.CSSProperties;
}
export interface CalendarProps {
  /** 固定月份展示；日期选择回传该月日号。 */
  month?: string;
  onSelect?: (day: number) => void;
  days?: number;
  /** 首日在周内的偏移（0 = 周一） */
  startWeekday?: number;
  rangeStart?: number;
  rangeEnd?: number;
  /** 页脚左侧文案 */
  footer?: string;
  style?: React.CSSProperties;
}
export declare function DateRangePicker(props: DateRangePickerProps): JSX.Element;
export declare function Calendar(props: CalendarProps): JSX.Element;
