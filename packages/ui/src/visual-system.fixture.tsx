"use client";

import { Copy, MoreHorizontal, Plus, RefreshCcw, Trash2 } from "lucide-react";

import {
  Amount,
  Button,
  CheckboxField,
  CodeValue,
  DataTable,
  Dialog,
  Drawer,
  IconButton,
  InlineNotice,
  OverlayClose,
  SelectField,
  StatusBadge,
  Surface,
  TextAreaField,
  TextField,
} from "./index.ts";
import {
  VISUAL_STORY_LARGE_AMOUNT,
  VISUAL_STORY_LONG_JOB_ID,
} from "./visual-system.fixture-data.ts";

const rows = [
  {
    id: "confirmed",
    cells: {
      automation: <CodeValue>{VISUAL_STORY_LONG_JOB_ID}</CodeValue>,
      amount: <Amount>{VISUAL_STORY_LARGE_AMOUNT}</Amount>,
      status: <StatusBadge state="confirmed" />,
      action: (
        <IconButton icon={<MoreHorizontal aria-hidden="true" size={18} />} label="More actions" />
      ),
    },
  },
  {
    id: "recovery",
    cells: {
      automation: <CodeValue>{`${VISUAL_STORY_LONG_JOB_ID.slice(0, -1)}b`}</CodeValue>,
      amount: <Amount>100,000,000.00000000 CKB</Amount>,
      status: <StatusBadge state="recovery_required" />,
      action: <IconButton icon={<Copy aria-hidden="true" size={18} />} label="Copy job ID" />,
    },
  },
] as const;

export function VisualSystemFixture() {
  return (
    <main className="ui-story">
      <header className="ui-story__header">
        <div>
          <p className="ui-story__eyebrow">Interface fixture</p>
          <h1>CKB Automata visual system</h1>
          <p>Review testnet automation state, funding, and transaction evidence.</p>
        </div>
        <StatusBadge state="submitted" />
      </header>

      <section className="ui-story__section" aria-labelledby="actions-title">
        <div className="ui-story__section-heading">
          <h2 id="actions-title">Actions and status</h2>
          <p>Current transaction outcomes and available commands.</p>
        </div>
        <Surface>
          <div className="ui-story__row">
            <Button icon={<Plus aria-hidden="true" size={17} />}>New automation</Button>
            <Button icon={<RefreshCcw aria-hidden="true" size={17} />} tone="secondary">
              Refresh
            </Button>
            <Button icon={<Trash2 aria-hidden="true" size={17} />} tone="danger">
              Remove
            </Button>
            <IconButton
              icon={<Copy aria-hidden="true" size={18} />}
              label="Copy transaction hash"
            />
          </div>
          <div className="ui-story__row">
            <StatusBadge state="confirmed" />
            <StatusBadge state="proposed" />
            <StatusBadge state="recovery_required" />
            <StatusBadge state="conflicted" />
            <StatusBadge state="cancelled" />
          </div>
        </Surface>
      </section>

      <section className="ui-story__section" aria-labelledby="forms-title">
        <div className="ui-story__section-heading">
          <h2 id="forms-title">Form controls</h2>
          <p>Configure owner, network, funding, and operator details.</p>
        </div>
        <div className="ui-story__form-grid">
          <TextField
            defaultValue={VISUAL_STORY_LONG_JOB_ID}
            hint="The owner lock is verified before review."
            label="Owner lock hash"
          />
          <SelectField defaultValue="testnet" label="Network">
            <option value="testnet">CKB testnet</option>
          </SelectField>
          <TextField
            defaultValue="922337203685477580.80000000"
            error="The amount exceeds the supported uint64 range."
            label="Funded amount"
          />
          <TextAreaField
            defaultValue="Notify the operations team only after canonical confirmation and the configured depth."
            label="Operator note"
          />
          <CheckboxField
            defaultChecked
            description="Shows exact shannons alongside the formatted amount."
            label="Show technical values"
          />
        </div>
      </section>

      <section className="ui-story__section" aria-labelledby="table-title">
        <div className="ui-story__section-heading">
          <h2 id="table-title">Dense data</h2>
          <p>Recent automation jobs and their current funded values.</p>
        </div>
        <DataTable
          caption="Automation fixture rows"
          columns={[
            { key: "automation", label: "Automation", width: "42%" },
            { key: "status", label: "Status", width: "20%" },
            { align: "end", key: "amount", label: "Recipient amount", width: "30%" },
            { align: "end", key: "action", label: "Actions", width: "8%" },
          ]}
          rows={rows}
        />
      </section>

      <section className="ui-story__section" aria-labelledby="overlays-title">
        <div className="ui-story__section-heading">
          <h2 id="overlays-title">Overlays</h2>
          <p>Review and confirm automation changes.</p>
        </div>
        <div className="ui-story__row">
          <Dialog
            description="Review the exact identifier before continuing."
            footer={
              <>
                <OverlayClose>
                  <Button tone="secondary">Cancel</Button>
                </OverlayClose>
                <Button>Continue</Button>
              </>
            }
            title="Confirm automation"
            trigger={<Button tone="secondary">Open dialog</Button>}
          >
            <InlineNotice title="Exact transaction evidence" tone="warning">
              <CodeValue>{VISUAL_STORY_LONG_JOB_ID}</CodeValue>
            </InlineNotice>
          </Dialog>
          <Drawer
            description="Review canonical and operational details."
            footer={
              <OverlayClose>
                <Button>Done</Button>
              </OverlayClose>
            }
            title="Automation details"
            trigger={<Button tone="secondary">Open drawer</Button>}
          >
            <CodeValue>{VISUAL_STORY_LONG_JOB_ID}</CodeValue>
          </Drawer>
        </div>
      </section>
    </main>
  );
}
