"use client";

export function RouteError({ reset }: Readonly<{ error: Error; reset: () => void }>) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <button onClick={reset} type="button">
        Try again
      </button>
    </main>
  );
}
