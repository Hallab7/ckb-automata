import type { SetupDraft } from "./setup-flow.ts";

const STORAGE_KEY = "ckb-automata.automation-titles.v1";
export const AUTOMATION_TITLE_MAX_LENGTH = 80;

export function automationTitle(draft: SetupDraft): string | undefined {
  const value = draft["title"]?.trim();
  return value ? value : undefined;
}

export function validateAutomationTitle(draft: SetupDraft): string | undefined {
  const value = automationTitle(draft);
  if (value === undefined) return undefined;
  if (value.length > AUTOMATION_TITLE_MAX_LENGTH) {
    return `Keep the title to ${AUTOMATION_TITLE_MAX_LENGTH} characters or fewer.`;
  }
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return "Remove control characters from the title.";
  }
  return undefined;
}

export function readAutomationTitles(
  storage: Pick<Storage, "getItem">,
): Readonly<Record<string, string>> {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).filter(
          ([jobId, title]) =>
            /^0x[0-9a-f]{64}$/.test(jobId) &&
            typeof title === "string" &&
            title.trim().length > 0 &&
            title.length <= AUTOMATION_TITLE_MAX_LENGTH,
        ),
      ),
    );
  } catch {
    return {};
  }
}

export function writeAutomationTitle(
  storage: Pick<Storage, "getItem" | "setItem">,
  jobId: string,
  title: string | undefined,
): boolean {
  if (title === undefined || !/^0x[0-9a-f]{64}$/.test(jobId)) return false;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readAutomationTitles(storage), [jobId]: title }),
    );
    return true;
  } catch {
    return false;
  }
}
