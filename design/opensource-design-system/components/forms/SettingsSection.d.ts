import type { ReactNode } from 'react';
export interface SettingsSectionProps {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}
export declare function SettingsSection(props: SettingsSectionProps): JSX.Element;
