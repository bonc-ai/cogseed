/**
 * 内联授权条。合规只在此处显形：内联、单行、可继续；不弹窗、不打断、不做全屏遮罩。
 * @startingPoint section="反馈" subtitle="内联单次授权与绿色回执" viewport="700x150"
 */
export interface InlineAuthBarProps {
  /** ask 待授权 · granted 已授权（原地转绿色回执）· denied 已拒绝 */
  state?: 'ask' | 'granted' | 'denied';
  /** ask 态的一句请求，如「需要访问「客户经理通讯录」才能填入收件人」 */
  message?: string;
  /** Mono 时间戳 */
  time?: string;
  onAllow?: () => void;
  onDeny?: () => void;
  style?: React.CSSProperties;
}
export declare function InlineAuthBar(props: InlineAuthBarProps): JSX.Element;
