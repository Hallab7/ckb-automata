export function ScaffoldPage({ detail, title }: Readonly<{ detail?: string; title: string }>) {
  return (
    <main>
      <h1>{title}</h1>
      {detail === undefined ? null : <p>{detail}</p>}
    </main>
  );
}
