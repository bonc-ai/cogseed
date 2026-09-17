export interface ComposerQueueItem { id: string; text: string; }
export interface ComposerQueueProps { items?: ComposerQueueItem[]; onChange?: (items: ComposerQueueItem[]) => void; initialEditingId?: string | null; }
export declare function ComposerQueue(props: ComposerQueueProps): JSX.Element;
