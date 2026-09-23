"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { IconButton } from "./primitives.tsx";

interface OverlayProperties {
  readonly children: ReactNode;
  readonly description: string;
  readonly footer?: ReactNode;
  readonly title: string;
  readonly trigger: ReactNode;
}

function Overlay({
  children,
  description,
  footer,
  kind,
  title,
  trigger,
}: OverlayProperties & Readonly<{ kind: "dialog" | "drawer" }>) {
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ui-overlay" />
        <DialogPrimitive.Content className={`ui-${kind}`}>
          <div className="ui-overlay-panel__header">
            <div>
              <DialogPrimitive.Title className="ui-overlay-panel__title">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="ui-overlay-panel__description">
                {description}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton
                icon={<X aria-hidden="true" size={18} />}
                label="Close"
                showTooltip={false}
              />
            </DialogPrimitive.Close>
          </div>
          <div className="ui-overlay-panel__body">{children}</div>
          {footer === undefined ? null : <div className="ui-overlay-panel__footer">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Dialog(properties: OverlayProperties) {
  return <Overlay kind="dialog" {...properties} />;
}

export function Drawer(properties: OverlayProperties) {
  return <Overlay kind="drawer" {...properties} />;
}

export function OverlayClose({ children }: Readonly<{ children: ReactNode }>) {
  return <DialogPrimitive.Close asChild>{children}</DialogPrimitive.Close>;
}
