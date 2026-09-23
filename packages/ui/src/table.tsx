import type { ReactNode } from "react";

export interface DataTableColumn {
  readonly align?: "start" | "end";
  readonly key: string;
  readonly label: string;
  readonly width?: string;
}

export interface DataTableRow {
  readonly cells: Readonly<Record<string, ReactNode>>;
  readonly id: string;
}

export function DataTable({
  caption,
  columns,
  rows,
}: Readonly<{
  caption: string;
  columns: readonly DataTableColumn[];
  rows: readonly DataTableRow[];
}>) {
  return (
    <div aria-label={caption} className="ui-table-wrap" role="region" tabIndex={0}>
      <table className="ui-table">
        <caption className="ui-visually-hidden">{caption}</caption>
        <colgroup>
          {columns.map((column) => (
            <col
              key={column.key}
              style={column.width === undefined ? undefined : { width: column.width }}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th data-align={column.align ?? "start"} key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column) => (
                <td data-align={column.align ?? "start"} key={column.key}>
                  {row.cells[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
