"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonTone = "primary" | "secondary" | "danger" | "ghost";

export interface ButtonProperties extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon?: ReactNode;
  readonly tone?: ButtonTone;
}

function classes(...values: readonly (string | false | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

export function Button({
  children,
  className,
  icon,
  tone = "primary",
  type = "button",
  ...properties
}: ButtonProperties) {
  return (
    <button
      className={classes("ui-button", `ui-button--${tone}`, className)}
      type={type}
      {...properties}
    >
      {icon === undefined ? null : <span className="ui-button__icon">{icon}</span>}
      <span className="ui-button__label">{children}</span>
    </button>
  );
}

export interface IconButtonProperties extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon: ReactNode;
  readonly label: string;
  readonly showTooltip?: boolean;
  readonly tone?: Exclude<ButtonTone, "primary">;
}

export function IconButton({
  className,
  icon,
  label,
  showTooltip = true,
  tone = "ghost",
  type = "button",
  ...properties
}: IconButtonProperties) {
  const control = (
    <button
      aria-label={label}
      className={classes("ui-icon-button", `ui-icon-button--${tone}`, className)}
      type={type}
      {...properties}
    >
      {icon}
    </button>
  );
  if (!showTooltip) return control;
  return (
    <TooltipPrimitive.Provider delayDuration={350}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{control}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className="ui-tooltip" sideOffset={6}>
            {label}
            <TooltipPrimitive.Arrow className="ui-tooltip__arrow" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export function Surface({
  children,
  className,
}: Readonly<{ children: ReactNode; className?: string }>) {
  return <section className={classes("ui-surface", className)}>{children}</section>;
}

export function CodeValue({ children }: Readonly<{ children: ReactNode }>) {
  return <code className="ui-code-value">{children}</code>;
}

export function Amount({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="ui-amount">{children}</span>;
}
