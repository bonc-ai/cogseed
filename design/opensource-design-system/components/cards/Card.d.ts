/** 卡片与分组标题。层级靠版式与分割线，不靠阴影与色块。 */
export interface CardProps {
  layout?: 'tile' | 'row';
  className?: string;
  /** 默认 16 */
  padding?: number | string;
  /** 可点击卡片：hover 加深描边至 .14 并上 shadow-lg */
  hoverable?: boolean;
  children?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export interface CardFooterProps {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export interface GroupHeadingProps {
  /** Mono 小标签，如 '已连接 · 4' / '进行中' */
  label: string;
  /** 右侧文字动作，如 '查看全部'；组件统一附加右箭头 */
  action?: string;
  /** 标签后的延伸细线，默认 true */
  rule?: boolean;
  style?: React.CSSProperties;
}
export declare function Card(props: CardProps): JSX.Element;
export declare function CardFooter(props: CardFooterProps): JSX.Element;
export declare function GroupHeading(props: GroupHeadingProps): JSX.Element;

export interface ResourceCardProps {
  variant?: 'workspace' | 'automation' | 'capability' | 'template';
  layout?: 'tile' | 'row';
  icon?: string;
  title: string;
  description?: string;
  status?: React.ReactNode;
  action?: string;
  onAction?: () => void;
  disabled?: boolean;
  loading?: boolean;
  control?: React.ReactNode;
  automation?: {schedule: React.ReactNode; lastRun?: React.ReactNode; device?: string; runCount?: number; expanded?: boolean};
  onToggleRuns?: () => void;
  /** Workspace content metadata; ignored by other variants. */
  workspace?: {updatedAt?: string; roles?: string[]; recentTask?: string};
  /** Separate title navigation to workspace details. */
  onOpen?: () => void;
  menu?: {
    details?: {label: string; value: React.ReactNode}[];
    groups: import('../navigation/DropdownMenu').DropdownMenuGroup[];
  };
  children?: React.ReactNode;
}
export declare function ResourceCard(props: ResourceCardProps): JSX.Element;
export declare function CardGrid(props: {children?: React.ReactNode}): JSX.Element;
