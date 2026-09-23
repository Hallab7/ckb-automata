"use client";

import { RouteError } from "../src/scaffold/route-error.tsx";

export default function GlobalError(properties: Readonly<{ error: Error; reset: () => void }>) {
  return (
    <html lang="en">
      <body>
        <RouteError {...properties} />
      </body>
    </html>
  );
}
