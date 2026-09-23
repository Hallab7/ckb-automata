import type { ReactNode } from "react";

export function PageHeader({
  action,
  description,
  detail,
  title,
}: Readonly<{
  action?: ReactNode;
  description?: string | undefined;
  detail?: string | undefined;
  title: string;
}>) {
  return (
    <header className="app-page-header">
      <div className="app-page-header__copy">
        <h1 id="page-title">{title}</h1>
        {detail === undefined ? null : <code className="app-page-header__detail">{detail}</code>}
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {action === undefined ? null : <div className="app-page-header__actions">{action}</div>}
    </header>
  );
}
