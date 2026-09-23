export function LoadingShell() {
  return (
    <section className="app-loading" aria-busy="true" aria-live="polite">
      <span className="app-loading__bar" />
      <span className="app-loading__bar app-loading__bar--short" />
      <span className="ui-visually-hidden">Loading</span>
    </section>
  );
}
