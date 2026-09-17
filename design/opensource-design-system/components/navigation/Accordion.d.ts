/** 折叠面板。箭头在左、恒定 13px；不用「＋／－」。默认只展开第一个。 */
export interface AccordionProps {
  items?: { title: string; /** 右侧 Mono 元数据，如 '3 项' / '14:04' */ meta?: string; body?: React.ReactNode }[];
  /** 默认展开的下标数组，默认 [0]；同组允许多个同时展开 */
  defaultOpen?: number[];
  style?: React.CSSProperties;
}
export declare function Accordion(props: AccordionProps): JSX.Element;
