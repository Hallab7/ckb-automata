import type { ReactNode } from "react";

import { PageHeader } from "../shell/page-header.tsx";

export function ScaffoldPage({
  action,
  description,
  detail,
  title,
}: Readonly<{
  action?: ReactNode;
  description?: string;
  detail?: string;
  title: string;
}>) {
  return (
    <section className="app-page" aria-labelledby="page-title">
      <PageHeader action={action} description={description} detail={detail} title={title} />
      <div className="app-empty-state">
        <h2>No records to show</h2>
        <p>Operational data will appear here when it becomes available.</p>
      </div>
    </section>
  );
}
