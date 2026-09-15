export interface ComposerNoticeProps { message: string; action?: string; onAction?: () => void; tone?: 'info' | 'error'; }
export declare function ComposerNotice(props: ComposerNoticeProps): JSX.Element;
