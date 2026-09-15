/**
 * 文件上传。四态：拖悬（accent 虚线 + 淡底）· 就绪 · 上传中（行内 3px 进度）· 被拦下。
 * @startingPoint section="检索与录入" subtitle="拖入区与文件行四态" viewport="700x300"
 */
export interface DropzoneProps {
  label?: string;
  /** Mono 格式与体积说明 */
  hint?: string;
  style?: React.CSSProperties;
}
export interface FileRowProps {
  name: string;
  /** Mono 元数据，如 '1.2MB · 已就绪 · 只读'；被拦下时为一句原因 */
  meta?: string;
  state?: 'ready' | 'uploading' | 'blocked';
  /** state='uploading' 时的百分比 */
  progress?: number;
  /** 被拦下时的动作文案，如 '申请授权' */
  action?: string;
  onRemove?: () => void;
  style?: React.CSSProperties;
}
export declare function Dropzone(props: DropzoneProps): JSX.Element;
export declare function FileRow(props: FileRowProps): JSX.Element;
