import { Plus } from "lucide-react";
import Link from "next/link";

import { ScaffoldPage } from "../../../src/scaffold/scaffold-page.tsx";

export default function AutomationsPage() {
  return (
    <ScaffoldPage
      action={
        <Link className="ui-button ui-button--primary" href="/automations/new">
          <span className="ui-button__icon">
            <Plus aria-hidden="true" size={17} />
          </span>
          <span className="ui-button__label">New automation</span>
        </Link>
      }
      description="Monitor funding, eligibility, and on-chain execution."
      title="Automations"
    />
  );
}
