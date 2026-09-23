import {
  ArrowRight,
  Beaker,
  CircleCheck,
  FlaskConical,
  Flag,
  Repeat2,
  RotateCcw,
  ShieldAlert,
  UserRoundCheck,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

import { TEMPLATE_CATALOG, type TemplateCapability } from "./template-catalog.ts";

const CAPABILITY_PRESENTATION: Record<
  TemplateCapability,
  Readonly<{ icon: LucideIcon; label: string; tone: "info" | "success" | "warning" }>
> = {
  demo: { icon: Beaker, label: "Demo only", tone: "info" },
  executable: { icon: CircleCheck, label: "Available on testnet", tone: "success" },
  research: { icon: FlaskConical, label: "Research only", tone: "warning" },
};

const TEMPLATE_ICONS: Record<(typeof TEMPLATE_CATALOG)[number]["id"], LucideIcon> = {
  deadline: Flag,
  demo: Beaker,
  nervdao: FlaskConical,
  recurring: Repeat2,
};

export function TemplateGallery() {
  return (
    <section className="app-page template-gallery" aria-labelledby="page-title">
      <header className="app-page-header">
        <div className="app-page-header__copy">
          <h1 id="page-title">New automation</h1>
          <p>Choose an executable CKB Pudge Testnet workflow or inspect non-executable material.</p>
        </div>
      </header>

      <div className="template-gallery__legend" aria-label="Template availability">
        {Object.values(CAPABILITY_PRESENTATION).map((presentation) => {
          const Icon = presentation.icon;
          return (
            <span className={`ui-status ui-status--${presentation.tone}`} key={presentation.label}>
              <Icon aria-hidden="true" size={14} strokeWidth={2.25} />
              <span>{presentation.label}</span>
            </span>
          );
        })}
      </div>

      <div className="template-gallery__grid">
        {TEMPLATE_CATALOG.map((template) => {
          const availability = CAPABILITY_PRESENTATION[template.capability];
          const AvailabilityIcon = availability.icon;
          const TemplateIcon = TEMPLATE_ICONS[template.id];
          return (
            <article
              className="template-card"
              data-capability={template.capability}
              key={template.id}
            >
              <header className="template-card__header">
                <span className="template-card__icon">
                  <TemplateIcon aria-hidden="true" size={22} />
                </span>
                <div>
                  <h2>{template.name}</h2>
                  <span className={`ui-status ui-status--${availability.tone}`}>
                    <AvailabilityIcon aria-hidden="true" size={14} strokeWidth={2.25} />
                    <span>{availability.label}</span>
                  </span>
                </div>
              </header>
              <p className="template-card__description">{template.description}</p>
              <dl className="template-card__facts">
                <div>
                  <dt>
                    <ShieldAlert aria-hidden="true" size={16} /> Risk
                  </dt>
                  <dd>{template.risk}</dd>
                </div>
                <div>
                  <dt>
                    <UserRoundCheck aria-hidden="true" size={16} /> Approval
                  </dt>
                  <dd>{template.approval}</dd>
                </div>
                <div>
                  <dt>
                    <RotateCcw aria-hidden="true" size={16} /> Recovery
                  </dt>
                  <dd>{template.recoverability}</dd>
                </div>
              </dl>
              <footer className="template-card__footer">
                <Link
                  className={`ui-button ${template.capability === "executable" ? "ui-button--primary" : "ui-button--secondary"}`}
                  data-create-action={template.capability === "executable" ? "true" : undefined}
                  href={template.action.href}
                >
                  <span className="ui-button__label">{template.action.label}</span>
                  <span className="ui-button__icon">
                    <ArrowRight aria-hidden="true" size={17} />
                  </span>
                </Link>
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
