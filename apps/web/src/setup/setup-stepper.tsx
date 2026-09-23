"use client";

import { ArrowLeft, ArrowRight, Check, Circle } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { Button, InlineNotice } from "@ckb-automata/ui";

import { TEMPLATE_CATALOG } from "../templates/template-catalog.ts";
import {
  FIRST_SETUP_STEP,
  SETUP_STEPS,
  parseSetupStep,
  parseStoredDraft,
  setupStepUrl,
  setupStorageKey,
  stepIndex,
  type SetupDraft,
  type SetupErrors,
  type SetupStepId,
  type SetupTemplateId,
} from "./setup-flow.ts";

export interface SetupStepRenderContext {
  readonly draft: SetupDraft;
  readonly errors: SetupErrors;
  readonly setField: (name: string, value: string) => void;
  readonly step: SetupStepId;
  readonly template: SetupTemplateId;
}

export interface SetupStepperProperties {
  readonly initialDraft?: SetupDraft;
  readonly renderStep?: (context: SetupStepRenderContext) => ReactNode;
  readonly storageId?: string;
  readonly template: SetupTemplateId;
  readonly validateStep?: (
    step: SetupStepId,
    draft: SetupDraft,
  ) => SetupErrors | Promise<SetupErrors>;
}

const EMPTY_DRAFT = Object.freeze({});

const STEP_EMPTY_COPY: Record<Exclude<SetupStepId, "template">, readonly [string, string]> = {
  approval: ["Wallet approval", "No transaction is ready for wallet approval."],
  details: ["Details", "No automation details have been entered."],
  funding: ["Funding", "No funding quote has been requested."],
  result: ["Result", "No transaction has been submitted."],
  review: ["Review", "No automation details are ready for review."],
  timing: ["Timing", "No block timing has been entered."],
};

function DefaultStep({
  step,
  template,
}: Readonly<{ step: SetupStepId; template: SetupTemplateId }>) {
  if (step === "template") return null;
  const selected = TEMPLATE_CATALOG.find((item) => item.id === template);
  const [title, empty] = STEP_EMPTY_COPY[step];
  return (
    <div className="setup-step__empty">
      <h2>{title}</h2>
      {step === "details" && selected !== undefined ? (
        <p>{selected.description}</p>
      ) : (
        <p>{empty}</p>
      )}
    </div>
  );
}

function focusFirstError(errors: SetupErrors): void {
  const first = Object.keys(errors)[0];
  if (first === undefined) return;
  requestAnimationFrame(() => {
    const escaped = typeof CSS === "undefined" ? first : CSS.escape(first);
    document
      .querySelector<HTMLElement>(`[name="${escaped}"], [data-field-name="${escaped}"]`)
      ?.focus();
  });
}

function readSessionDraft(key: string): SetupDraft | undefined {
  try {
    return parseStoredDraft(window.sessionStorage.getItem(key));
  } catch {
    return undefined;
  }
}

function writeSessionDraft(key: string, draft: SetupDraft): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // The in-memory draft remains usable when browser storage is unavailable.
  }
}

function removeSessionDraft(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // There is no persisted draft to remove when browser storage is unavailable.
  }
}

export function SetupStepper({
  initialDraft = EMPTY_DRAFT,
  renderStep,
  storageId,
  template,
  validateStep = () => ({}),
}: SetupStepperProperties) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawStep = searchParams.get("step");
  const currentStep = parseSetupStep(rawStep);
  const currentIndex = stepIndex(currentStep);
  const [draft, setDraft] = useState<SetupDraft>(initialDraft);
  const [errors, setErrors] = useState<SetupErrors>({});
  const [hydrated, setHydrated] = useState(false);
  const [validating, setValidating] = useState(false);
  const [maxReached, setMaxReached] = useState(currentIndex);
  const storageKey = setupStorageKey(template, storageId);
  const dirty = hydrated && JSON.stringify(draft) !== JSON.stringify(initialDraft);

  useEffect(() => {
    const stored = readSessionDraft(storageKey);
    if (stored !== undefined) setDraft({ ...initialDraft, ...stored });
    setHydrated(true);
  }, [initialDraft, storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    writeSessionDraft(storageKey, draft);
  }, [draft, hydrated, storageKey]);

  useEffect(() => {
    if (rawStep === null || rawStep === currentStep) return;
    router.replace(setupStepUrl(pathname, FIRST_SETUP_STEP), { scroll: false });
  }, [currentStep, pathname, rawStep, router]);

  useEffect(() => {
    setMaxReached((current) => Math.max(current, currentIndex));
  }, [currentIndex]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const captureLinks = (event: MouseEvent) => {
      const target =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (target === null || target.target === "_blank") return;
      const destination = new URL(target.href, window.location.href);
      if (destination.origin !== window.location.origin || destination.pathname === pathname)
        return;
      if (!window.confirm("Leave setup and discard the unsaved draft?")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else {
        removeSessionDraft(storageKey);
      }
    };
    const guardHistory = () => {
      if (window.location.pathname === pathname) return;
      if (!window.confirm("Leave setup and discard the unsaved draft?")) {
        window.history.forward();
      } else {
        removeSessionDraft(storageKey);
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", guardHistory);
    document.addEventListener("click", captureLinks, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", guardHistory);
      document.removeEventListener("click", captureLinks, true);
    };
  }, [dirty, pathname, storageKey]);

  const setField = useCallback((name: string, value: string) => {
    setDraft((current) => ({ ...current, [name]: value }));
    setErrors((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }, []);

  const goTo = useCallback(
    (step: SetupStepId) => {
      setErrors({});
      router.push(setupStepUrl(pathname, step), { scroll: false });
    },
    [pathname, router],
  );

  const leaveSetup = useCallback(
    (href: string) => {
      if (dirty && !window.confirm("Leave setup and discard the unsaved draft?")) return;
      removeSessionDraft(storageKey);
      router.push(href);
    },
    [dirty, router, storageKey],
  );

  const continueForward = useCallback(async () => {
    if (validating) return;
    setValidating(true);
    try {
      const validation = await validateStep(currentStep, draft);
      if (Object.keys(validation).length > 0) {
        setErrors(validation);
        focusFirstError(validation);
        return;
      }
      const next = SETUP_STEPS[currentIndex + 1];
      if (next !== undefined) goTo(next.id);
    } finally {
      setValidating(false);
    }
  }, [currentIndex, currentStep, draft, goTo, validateStep, validating]);

  const previous = SETUP_STEPS[currentIndex - 1];
  const next = SETUP_STEPS[currentIndex + 1];
  const context = useMemo<SetupStepRenderContext>(
    () => ({ draft, errors, setField, step: currentStep, template }),
    [currentStep, draft, errors, setField, template],
  );

  return (
    <section
      className="app-page setup-flow"
      aria-labelledby="page-title"
      data-dirty={dirty ? "true" : "false"}
    >
      <header className="app-page-header">
        <div className="app-page-header__copy">
          <p className="setup-flow__eyebrow">CKB Pudge Testnet</p>
          <h1 id="page-title">
            {template === "deadline" ? "Deadline finalization" : "Recurring distribution"}
          </h1>
          <p>
            Step {currentIndex + 1} of {SETUP_STEPS.length}
          </p>
        </div>
      </header>

      <nav aria-label="Automation setup progress" className="setup-progress">
        <ol>
          {SETUP_STEPS.map((step, index) => {
            const complete = index < currentIndex;
            const active = step.id === currentStep;
            const available = step.id === "template" || index <= maxReached;
            return (
              <li
                data-active={active ? "true" : undefined}
                data-complete={complete ? "true" : undefined}
                key={step.id}
              >
                <button
                  aria-current={active ? "step" : undefined}
                  disabled={!available}
                  onClick={() =>
                    step.id === "template" ? leaveSetup("/automations/new") : goTo(step.id)
                  }
                  type="button"
                >
                  <span className="setup-progress__marker">
                    {complete ? (
                      <Check aria-hidden="true" size={14} />
                    ) : (
                      <Circle aria-hidden="true" size={12} />
                    )}
                  </span>
                  <span>{step.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {Object.keys(errors).length === 0 ? null : (
        <InlineNotice title="Check the highlighted fields" tone="danger">
          <p>Correct the first invalid value before continuing.</p>
        </InlineNotice>
      )}

      <div className="setup-step" data-setup-step={currentStep}>
        {renderStep === undefined ? (
          <DefaultStep step={currentStep} template={template} />
        ) : (
          renderStep(context)
        )}
      </div>

      <footer className="setup-actions">
        <Button
          icon={<ArrowLeft aria-hidden="true" size={17} />}
          onClick={() =>
            previous?.id === "template"
              ? leaveSetup("/automations/new")
              : previous && goTo(previous.id)
          }
          tone="secondary"
        >
          Back
        </Button>
        {next === undefined ? (
          <Button
            onClick={() => {
              removeSessionDraft(storageKey);
              router.push("/automations");
            }}
          >
            Return to automations
          </Button>
        ) : (
          <Button
            disabled={validating}
            icon={<ArrowRight aria-hidden="true" size={17} />}
            onClick={() => void continueForward()}
          >
            {validating ? "Checking..." : "Continue"}
          </Button>
        )}
      </footer>
    </section>
  );
}
