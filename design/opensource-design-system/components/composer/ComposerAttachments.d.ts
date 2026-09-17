export interface ComposerAttachment { id: string; name: string; size: string; status: 'ready' | 'uploading' | 'error'; error?: string; thumbnail?: string; video?: boolean; }
export interface ComposerAttachmentsProps { items?: ComposerAttachment[]; onRemove?: (id: string) => void; onAdd?: () => void; dragging?: boolean; }
export declare function ComposerAttachments(props: ComposerAttachmentsProps): JSX.Element;
