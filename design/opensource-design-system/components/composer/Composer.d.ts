/**
 * 输入台。宽度限定 480–900px；窄布局使用图标入口，配置栏不折行。
 * 底栏顺序恒定：附件 → 接收者 / 空间 → 访问权限（已有对话） → 执行配置 → 语音 → 发送。
 * @startingPoint section="核心界面" subtitle="CogSeed 输入台 · 720/760px" viewport="960x680"
 */
export interface ComposerMentionItem {
  id: string;
  kind: 'agent' | 'skill' | 'artifact' | 'asset' | 'connector' | 'library';
  name: string;
  description?: string;
}
export interface ComposerProps {
  /** 正文高度：首页 80–260px，对话 64–200px（默认）；不含底栏或附件。 */
  placement?: 'home' | 'conversation' | 'automation';
  /** 自动化表单受控引用；单个 agent，其余按 kind/id 去重。 */
  selectedMentions?: ComposerMentionItem[];
  onMentionsChange?: (items: ComposerMentionItem[]) => void;
  spaceOptions?: { id: string; name: string }[];
  /** 空字符串表示默认工作区；不传时使用组件内预览选择。 */
  spaceId?: string;
  onSpaceChange?: (id: string) => void;
  defaultSpaceOpen?: boolean;
  /** 设计预览候选项；传 [] 可预览空列表。正式宿主负责权限及空间过滤。 */
  mentionItems?: ComposerMentionItem[];
  defaultPickerOpen?: boolean;
  /** 首页/对话接收者；null清空受控选择。自动化使用selectedMentions。 */
  recipient?: ComposerMentionItem | null;
  onRecipientChange?: (item: ComposerMentionItem) => void;
  /** 占位符始终说明「能做什么」，不写「请输入…」 */
  placeholder?: string;
  value?: string;
  /** 上下文标签：已选用描边（selected: true），未选用无边框文字按钮 */
  contextTags?: { label: string; selected?: boolean }[];
  /** 绑定空间后，占位符与选择器增加产物和资产。 */
  spaceBound?: boolean;
  /** 仅已有对话显示；首页没有权限预选流程。默认请求批准。 */
  permissionMode?: '完全访问' | '帮我批准' | '请求批准';
  onPermissionModeChange?: (value: '完全访问' | '帮我批准' | '请求批准') => void;
  modelName?: string;
  providerName?: string;
  /** 实际智能体能力；不可控时不提供可操作的配置项。 */
  modelSupported?: boolean;
  effortSupported?: boolean;
  reasoningEffort?: '自动' | '关闭' | '低' | '高';
  onReasoningEffortChange?: (value: '自动' | '关闭' | '低' | '高') => void;
  /** 由宿主接入模型选择；未提供时仅展示当前模型。 */
  onSelectModel?: () => void;
  /** 期望宽度；实际受布局 token 的 480–900px 范围约束。 */
  width?: number | string;
  onChange?: (value: string) => void;
  onSend?: () => void;
  /** 模板填入后聚焦选择；revision使相同范围可重复触发。 */
  editorSelection?: {start: number; end: number; revision?: number};
  /** 状态由宿主提供；设计预览不调用实际执行服务。 */
  phase?: 'idle' | 'submitting' | 'running' | 'stopping';
  onStop?: () => void;
  onQueue?: () => void;
  /** 提交是否允许；仅用于提交拦截，不直接禁用按钮。附件与消息引用判定由宿主提供。 */
  sendAllowed?: boolean;
  inputDisabled?: boolean;
  beforeInput?: React.ReactNode;
  editor?: React.ReactNode;
  afterInput?: React.ReactNode;
  onAttach?: () => void;
  onVoice?: () => void;
  /** 麦克风上方持续状态浮层，麦克风结束或面板取消，不随外部点击收起。 */
  voicePanel?: React.ReactNode;
  voiceActive?: boolean;
  style?: React.CSSProperties;
}
export declare function Composer(props: ComposerProps): JSX.Element;
