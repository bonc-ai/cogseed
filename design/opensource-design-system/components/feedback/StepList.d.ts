/**
 * 执行步骤组。完成用绿勾 + 灰文字，当前步骤底色 subtle + 琥珀旋转环。
 * @startingPoint section="反馈" subtitle="任务执行步骤组 · 行 h 40" viewport="700x180"
 */
export interface StepListProps {
  steps?: {
    label: string;
    state?: 'done' | 'running' | 'wait';
    /** 右侧 Mono 元数据：耗时 / '运行中' / '待执行' */
    meta?: string;
  }[];
  style?: React.CSSProperties;
}
export declare function StepList(props: StepListProps): JSX.Element;
