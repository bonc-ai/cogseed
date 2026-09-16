export type CsIconName =
  | 'terminal' | 'copy' | 'atSign' | 'messageSquare' | 'list' | 'brain' | 'bookOpen' | 'pencil'
  | 'arrowUp' | 'arrowDown' | 'loader' | 'stop' | 'lock' | 'space' | 'clock' | 'automation' | 'connector' | 'file' | 'fileText' | 'fileCheck'
  | 'shield' | 'database' | 'calendar' | 'docLines' | 'plus' | 'minus' | 'search'
  | 'check' | 'close' | 'chevronDown' | 'chevronRight' | 'chevronLeft' | 'dots'
  | 'send' | 'upload' | 'export' | 'info' | 'alert' | 'warning' | 'error'
  | 'trash' | 'sidebar' | 'settings' | 'logout' | 'mic';

export interface IconProps {
  /** 图标名。仅限共享注册表中的线性图标集。 */
  name: CsIconName;
  /** 显示尺寸。界面内 13–16，规范页示意 20。默认 16。 */
  size?: number | string;
  /** 描边宽度，默认 2（Lucide 24px 画板基准）。 */
  strokeWidth?: number | string;
  /** 描边颜色，默认 currentColor。 */
  color?: string;
  style?: React.CSSProperties;
}

export declare const csIcons: Record<CsIconName, string[]>;
export declare function Icon(props: IconProps): JSX.Element | null;
