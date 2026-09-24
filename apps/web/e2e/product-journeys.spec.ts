import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

test("completes both deterministic setup journeys", async ({ page }) => {
  for (const setup of [
    {
      field: "Deadline automation name",
      name: "Milestone release",
      path: "/fixtures/setup-deadline",
      title: "Deadline finalization",
    },
    {
      field: "Recurring automation name",
      name: "Monthly contributor payout",
      path: "/fixtures/setup-recurring",
      title: "Recurring distribution",
    },
  ]) {
    await page.goto(setup.path);
    await expect(page.getByRole("heading", { level: 1, name: setup.title })).toBeVisible();
    await page.getByLabel(setup.field).fill(setup.name);

    for (const step of ["timing", "funding", "review", "approval", "result"]) {
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.locator("[data-setup-step]")).toHaveAttribute("data-setup-step", step);
      await expect(page.locator("[data-preserved-value]")).toHaveText(setup.name);
    }

    await expect(page.getByRole("button", { name: "Return to automations" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("reproduces wallet outcomes and transaction progress", async ({ page }) => {
  await page.goto("/fixtures/transaction-submission");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("button", { name: "Approve and submit" }).click();
  await expect(page.getByText("The wallet request was rejected.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Close request" }).click();
  await page.getByRole("button", { name: "Approve and submit" }).click();
  await expect(page.getByText("The wallet request was closed.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: "Approve and submit" }).click();
  await expect(page.getByText("Transaction submitted", { exact: true })).toBeVisible();

  await page.goto("/fixtures/transaction-progress");
  await page.getByRole("button", { name: "submitted", exact: true }).click();
  await expect(page.locator("[data-progress-state]")).toHaveAttribute(
    "data-progress-state",
    "submitted",
  );
  await page.getByRole("button", { name: "confirmed", exact: true }).click();
  await expect(page.locator("[data-progress-state]")).toHaveAttribute(
    "data-progress-state",
    "confirmed",
  );
  await expect(page.getByText("3 / 3", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("shows recurring successors and separate owner escape reviews", async ({ page }) => {
  await page.goto("/fixtures/automation-detail");
  await page.getByRole("button", { name: "recurring", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Recurring distribution" }),
  ).toBeVisible();
  await expect(page.locator(".job-detail__summary").getByText("2", { exact: true })).toBeVisible();
  await expect(page.locator(".job-detail__summary").getByText("4", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("Review owner cancel", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("Race protection", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Recover", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("Review owner recover", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Recovery reason")).toHaveValue("terminal_operational_failure");
  await expectNoHorizontalOverflow(page);
});

test("filters activity and exercises private settings controls", async ({ page }) => {
  await page.goto("/fixtures/activity");
  await page.getByLabel("Evidence source").selectOption("operational");
  await page.getByLabel("Outcome").selectOption("dropped");
  await expect(page.getByText("dropped", { exact: true })).toBeVisible();
  await page.getByLabel("Outcome").selectOption("confirmed");
  await expect(page.getByRole("heading", { name: "No matching activity" })).toBeVisible();

  await page.goto("/fixtures/settings");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await page.getByLabel("Browser notifications").uncheck();
  await expect(page.getByLabel("Browser notifications")).not.toBeChecked();
  await expect(page.getByText("hooks.example.com/automata", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset settings" }).click();
  const dialog = page.getByRole("dialog");
  const deleteButton = dialog.getByRole("button", { name: "Delete private settings" });
  await expect(deleteButton).toBeDisabled();
  await dialog.getByLabel("Type RESET to confirm").fill("RESET");
  await expect(deleteButton).toBeEnabled();
  await expectNoHorizontalOverflow(page);
});
