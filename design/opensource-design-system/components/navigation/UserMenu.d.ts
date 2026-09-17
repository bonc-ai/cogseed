export interface UserMenuProps {
  name: string;
  description?: string;
  onSettings: () => void;
  onSignOut: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  style?: React.CSSProperties;
}
export declare function UserMenu(props: UserMenuProps): JSX.Element;
