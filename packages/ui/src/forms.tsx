"use client";

import { Check, ChevronDown } from "lucide-react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useId } from "react";

interface FieldFrameProperties {
  readonly children: (inputId: string, describedBy: string | undefined) => ReactNode;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly id?: string | undefined;
  readonly label: string;
  readonly required?: boolean | undefined;
}

function FieldFrame({ children, error, hint, id, label, required = false }: FieldFrameProperties) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint === undefined ? undefined : `${inputId}-hint`;
  const errorId = error === undefined ? undefined : `${inputId}-error`;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="ui-field" data-invalid={error === undefined ? undefined : "true"}>
      <label className="ui-field__label" htmlFor={inputId}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children(inputId, describedBy)}
      {hint === undefined ? null : (
        <span className="ui-field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {error === undefined ? null : (
        <span className="ui-field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export interface TextFieldProperties extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "size"
> {
  readonly error?: string;
  readonly hint?: string;
  readonly id?: string;
  readonly label: string;
}

export function TextField({
  error,
  hint,
  id,
  label,
  required,
  ...properties
}: TextFieldProperties) {
  return (
    <FieldFrame error={error} hint={hint} id={id} label={label} required={required}>
      {(inputId, describedBy) => (
        <input
          aria-describedby={describedBy}
          aria-invalid={error === undefined ? undefined : true}
          className="ui-input"
          id={inputId}
          required={required}
          {...properties}
        />
      )}
    </FieldFrame>
  );
}

export interface TextAreaFieldProperties extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "id"
> {
  readonly error?: string;
  readonly hint?: string;
  readonly id?: string;
  readonly label: string;
}

export function TextAreaField({
  error,
  hint,
  id,
  label,
  required,
  ...properties
}: TextAreaFieldProperties) {
  return (
    <FieldFrame error={error} hint={hint} id={id} label={label} required={required}>
      {(inputId, describedBy) => (
        <textarea
          aria-describedby={describedBy}
          aria-invalid={error === undefined ? undefined : true}
          className="ui-textarea"
          id={inputId}
          required={required}
          {...properties}
        />
      )}
    </FieldFrame>
  );
}

export interface SelectFieldProperties extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  readonly children: ReactNode;
  readonly error?: string;
  readonly hint?: string;
  readonly id?: string;
  readonly label: string;
}

export function SelectField({
  children,
  error,
  hint,
  id,
  label,
  required,
  ...properties
}: SelectFieldProperties) {
  return (
    <FieldFrame error={error} hint={hint} id={id} label={label} required={required}>
      {(inputId, describedBy) => (
        <span className="ui-select-wrap">
          <select
            aria-describedby={describedBy}
            aria-invalid={error === undefined ? undefined : true}
            className="ui-select"
            id={inputId}
            required={required}
            {...properties}
          >
            {children}
          </select>
          <ChevronDown aria-hidden="true" className="ui-select__icon" size={16} />
        </span>
      )}
    </FieldFrame>
  );
}

export interface CheckboxFieldProperties extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "type"
> {
  readonly description?: string;
  readonly id?: string;
  readonly label: string;
}

export function CheckboxField({ description, id, label, ...properties }: CheckboxFieldProperties) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <label className="ui-checkbox" htmlFor={inputId}>
      <span className="ui-checkbox__control">
        <input className="ui-checkbox__input" id={inputId} type="checkbox" {...properties} />
        <Check aria-hidden="true" className="ui-checkbox__icon" size={14} strokeWidth={3} />
      </span>
      <span>
        <span className="ui-checkbox__label">{label}</span>
        {description === undefined ? null : (
          <span className="ui-checkbox__description">{description}</span>
        )}
      </span>
    </label>
  );
}
