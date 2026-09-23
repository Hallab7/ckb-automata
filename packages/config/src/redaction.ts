export const REDACTED_VALUE = "[REDACTED]";

export const SECRET_ENV_KEYS = [
  "AUTH_SESSION_SECRET",
  "DATABASE_URL",
  "ERROR_TRACKING_DSN",
  "EXECUTOR_FEE_PRIVATE_KEY",
  "NOTIFICATION_EMAIL_API_KEY",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "REDIS_URL",
  "WEBHOOK_ENCRYPTION_KEY",
] as const;

const sensitiveKeys = new Set<string>([
  ...SECRET_ENV_KEYS,
  "AUTHORIZATION",
  "COOKIE",
  "MNEMONIC",
  "PASSWORD",
  "PRIVATE_KEY",
  "SEED_PHRASE",
  "SET_COOKIE",
  "SIGNATURE",
  "TOKEN",
  "WALLET_EXPORT",
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll("-", "_")
    .toUpperCase();
  return (
    sensitiveKeys.has(normalized) ||
    /(?:^|_)(?:PASSWORD|PRIVATE_KEY|SECRET|SEED|SIGNATURE|TOKEN)(?:_|$)/.test(normalized)
  );
}

function redactString(value: string, configuredSecrets: readonly string[]): string {
  const configured = configuredSecrets
    .filter((secret) => secret.length > 0)
    .reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED_VALUE), value);
  return configured
    .replace(
      /\bauthorization\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s,;]+/gi,
      `authorization=${REDACTED_VALUE}`,
    )
    .replace(
      /\b(password|private[_-]?key|secret|seed[_-]?phrase|signature|token)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi,
      `$1=${REDACTED_VALUE}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED_VALUE}`);
}

function redactValue(
  value: unknown,
  configuredSecrets: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return redactString(value, configuredSecrets);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, configuredSecrets, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key)
      ? REDACTED_VALUE
      : redactValue(nestedValue, configuredSecrets, seen);
  }
  return redacted;
}

export function redactLogRecord(
  record: unknown,
  configuredSecrets: readonly string[] = [],
): unknown {
  return redactValue(record, configuredSecrets, new WeakSet());
}
