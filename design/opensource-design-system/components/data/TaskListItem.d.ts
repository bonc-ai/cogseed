/** 任务列表项。四段结构固定：状态点 · 标题 · 进度元数据 · 时间。主区用细分割线而非卡片。 */
export interface TaskListItemProps {
  status?: 'success' | 'attention' | 'critical' | 'idle';
  title: string;
  /** Mono 进度元数据，如 '步骤 4/7' / '产物待确认' */
  meta?: string;
  /** 相对或绝对时间，如 '2 分钟前' / '今天 11:20' */
  time?: string;
  selected?: boolean;
  /** 末项不画分割线 */
  last?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function TaskListItem(props: TaskListItemProps): JSX.Element;
