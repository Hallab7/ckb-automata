import { ArrowRight, CircleCheck, Flag, Landmark, Repeat2, type LucideIcon } from "lucide-react";
import Link from "next/link";

import { TEMPLATE_CATALOG } from "./template-catalog.ts";

const TEMPLATE_ICONS: Readonly<Record<"dao-harvest" | "deadline" | "recurring", LucideIcon>> = {
  "dao-harvest": Landmark,
  deadline: Flag,
  recurring: Repeat2,
};

const CREATION_TEMPLATES = TEMPLATE_CATALOG.filter(
  (
    template,
  ): template is (typeof TEMPLATE_CATALOG)[number] & {
    readonly id: "dao-harvest" | "deadline" | "recurring";
  } => template.capability === "executable",
);

export function TemplateGallery() {
  return (
    <section className="app-page template-gallery" aria-labelledby="page-title">
      <header className="app-page-header">
        <div className="app-page-header__copy">
          <h1 id="page-title">New automation</h1>
          <p>Choose what you want CKAutomata to handle on CKB Testnet.</p>
        </div>
      </header>

      <div className="template-gallery__grid">
        {CREATION_TEMPLATES.map((template) => {
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
                  <span className="ui-status ui-status--success">
                    <CircleCheck aria-hidden="true" size={14} strokeWidth={2.25} />
                    <span>Available</span>
                  </span>
                </div>
              </header>
              <p className="template-card__description">{template.description}</p>
              <footer className="template-card__footer">
                <Link
                  className="ui-button ui-button--primary"
                  data-create-action="true"
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
