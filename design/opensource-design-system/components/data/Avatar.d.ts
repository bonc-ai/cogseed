/** 头像。只用单字姓氏，不用图片、不用双字。仅本人头像用开源绿色，他人一律中性灰。 */
export interface AvatarProps {
  /** 取首字符作为姓氏字 */
  name?: string;
  /** 26 / 30 / 36 */
  size?: number;
  /** 本人：开源绿色底 */
  self?: boolean;
  /** 叠放时的描边色（通常是所在容器底色） */
  ring?: string;
  style?: React.CSSProperties;
}
export interface AvatarGroupProps {
  /** 字符串或 { name, self } */
  members?: (string | { name: string; self?: boolean })[];
  /** 超出人数，折为「+n」 */
  overflow?: number;
  ring?: string;
  size?: number;
  style?: React.CSSProperties;
}
export declare function Avatar(props: AvatarProps): JSX.Element;
export declare function AvatarGroup(props: AvatarGroupProps): JSX.Element;
