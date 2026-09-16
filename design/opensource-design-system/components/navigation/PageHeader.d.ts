import * as React from 'react';
export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title?: React.ReactNode;
  leading?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
}
export declare function PageHeader(props: PageHeaderProps): React.JSX.Element;
