"use client";

import { Button, InlineNotice } from "@ckb-automata/ui";

export function RouteError({ reset }: Readonly<{ error: Error; reset: () => void }>) {
  return (
    <section className="app-page" aria-labelledby="route-error-title">
      <h1 id="route-error-title">Something went wrong</h1>
      <InlineNotice title="This view could not be loaded" tone="danger">
        <p>Retry the request. No transaction was submitted.</p>
      </InlineNotice>
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </section>
  );
}
