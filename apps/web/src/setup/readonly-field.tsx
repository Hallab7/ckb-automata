import type { ReactNode } from "react";

export function ReadonlyField({
  children,
  code = false,
  error,
  label,
  name,
}: Readonly<{
  children: ReactNode;
  code?: boolean;
  error?: string | undefined;
  label: string;
  name: string;
}>) {
  return (
    <div
      className="setup-readonly-field"
      data-field-name={name}
      data-invalid={error === undefined ? undefined : "true"}
      tabIndex={-1}
    >
      <span className="setup-readonly-field__label">{label}</span>
      <span
        className={
          code
            ? "setup-readonly-field__value setup-readonly-field__value--code"
            : "setup-readonly-field__value"
        }
      >
        {children}
      </span>
      {error === undefined ? null : (
        <span className="ui-field__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
