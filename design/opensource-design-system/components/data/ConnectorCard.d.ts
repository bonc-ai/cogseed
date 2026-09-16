/**
 * 连接器卡片。Card 的标准落地形态：图标+标题+元数据+开关 / 一句说明 / 状态页脚。
 * @startingPoint section="数据展示" subtitle="连接器卡片与状态页脚" viewport="700x200"
 */
export interface ConnectorCardProps {
  /** Icon 名，默认 'database' */
  icon?: string;
  name: string;
  /** Mono 元数据，如 '只读 · 行内网' */
  meta?: string;
  /** 一句说明：范围与落盘策略 */
  description?: string;
  enabled?: boolean;
  onToggle?: (enabled: boolean) => void;
  /** 页脚动作文字，默认 '权限范围'；组件统一附加右箭头。 */
  footerAction?: string;
  style?: React.CSSProperties;
}
export declare function ConnectorCard(props: ConnectorCardProps): JSX.Element;
