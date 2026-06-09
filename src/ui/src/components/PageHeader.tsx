import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  children?: ReactNode;
}

export const PageHeader = ({ title, children }: PageHeaderProps) => (
  <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-default pb-4">
    <h1 className="text-xl font-semibold leading-tight text-text-primary">{title}</h1>
    {children === undefined ? null : <div className="flex items-center gap-2">{children}</div>}
  </header>
);
