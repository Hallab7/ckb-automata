"use client";

import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { IconButton } from "@ckb-automata/ui";

export const APP_NOTIFICATION_EVENT = "automata:notification";

export type AppNotificationTone = "info" | "success" | "warning" | "danger";

export interface AppNotification {
  readonly dismissAfterMs?: number;
  readonly id: string;
  readonly message: string;
  readonly title: string;
  readonly tone: AppNotificationTone;
}

export function publishNotification(notification: AppNotification): void {
  window.dispatchEvent(new CustomEvent(APP_NOTIFICATION_EVENT, { detail: notification }));
}

const toneIcons = {
  danger: CircleX,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
} as const;

function NotificationItem({
  notification,
  onDismiss,
}: Readonly<{
  notification: AppNotification;
  onDismiss: (id: string) => void;
}>) {
  const Icon = toneIcons[notification.tone];

  useEffect(() => {
    if (notification.dismissAfterMs === undefined) return;
    const timeout = window.setTimeout(
      () => onDismiss(notification.id),
      notification.dismissAfterMs,
    );
    return () => window.clearTimeout(timeout);
  }, [notification.dismissAfterMs, notification.id, onDismiss]);

  return (
    <div
      className={`app-notification app-notification--${notification.tone}`}
      role={notification.tone === "danger" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" size={18} />
      <div>
        <strong>{notification.title}</strong>
        <p>{notification.message}</p>
      </div>
      <IconButton
        icon={<X aria-hidden="true" size={16} />}
        label={`Dismiss ${notification.title}`}
        onClick={() => onDismiss(notification.id)}
        showTooltip={false}
      />
    </div>
  );
}

export function NotificationCenter() {
  const [notifications, setNotifications] = useState<readonly AppNotification[]>([]);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    function receive(event: Event) {
      const notification = (event as CustomEvent<AppNotification>).detail;
      if (!notification?.id || !notification.title || !notification.message) return;
      setNotifications((current) => [
        ...current.filter((item) => item.id !== notification.id),
        notification,
      ]);
    }
    window.addEventListener(APP_NOTIFICATION_EVENT, receive);
    return () => window.removeEventListener(APP_NOTIFICATION_EVENT, receive);
  }, []);

  return (
    <div
      aria-atomic="false"
      aria-label="Notifications"
      aria-live="polite"
      className="app-notifications"
      role="region"
    >
      {notifications.map((notification) => (
        <NotificationItem
          key={notification.id}
          notification={notification}
          onDismiss={dismissNotification}
        />
      ))}
    </div>
  );
}
