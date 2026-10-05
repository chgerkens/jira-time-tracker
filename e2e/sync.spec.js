const { test, expect, TODAY } = require("./fixtures");

const worklogWrites = (jira) => jira.writes().map((r) => `${r.method} ${r.url}`);
const body = (r) => JSON.parse(r.body);

test.describe("pushing to Jira", () => {
  test("pushes a single entry", async ({ page, open, addEntry, jira }) => {
    await open();
    await addEntry({ ticket: "ABC-1", description: "Pairing", start: "09:00", h: 1, m: 30 });
    const entry = page.getByTestId("entry");
    await entry.getByRole("button", { name: "↑ Push", exact: true }).click();

    await expect(entry).toContainText("✓ Jira");
    await expect(page.getByText("ABC-1: 1h 30m → Jira")).toBeVisible();
    await expect(entry.getByRole("button", { name: "↑ Push", exact: true })).toHaveCount(0);

    expect(worklogWrites(jira)).toEqual(["POST /rest/api/2/issue/ABC-1/worklog"]);
    expect(body(jira.writes()[0])).toEqual({
      timeSpentSeconds: 5400,
      started: "2026-10-07T07:00:00.000+0000", // 09:00 CEST
      comment: "Pairing",
    });
    await expect(entry.getByRole("link", { name: "ABC-1" }))
      .toHaveAttribute("href", new RegExp(`${jira.url}/browse/ABC-1\\?focusedWorklogId=10000`));
  });

  test("without start time the worklog starts at noon UTC and has no comment", async ({ page, open, addEntry, jira }) => {
    await open();
    await addEntry({ ticket: "ABC-1", m: 15 });
    await page.getByRole("button", { name: "↑ Push", exact: true }).click();
    await expect(page.getByTestId("entry")).toContainText("✓ Jira");
    expect(body(jira.writes()[0])).toEqual({
      timeSpentSeconds: 900,
      started: "2026-10-07T12:00:00.000+0000",
    });
  });

  test("editing a synced entry updates the same worklog, including a new date", async ({ page, open, addEntry, jira }) => {
    await open();
    await addEntry({ ticket: "ABC-1", description: "Pairing", start: "09:00", h: 1 });
    const entry = page.getByTestId("entry");
    await entry.getByRole("button", { name: "↑ Push", exact: true }).click();
    await expect(entry).toContainText("✓ Jira");

    await entry.getByTitle("Edit entry").click();
    await expect(entry.getByText("Already in Jira — next push will update the worklog")).toBeVisible();
    await entry.getByLabel("Date").fill("2026-10-08");
    await entry.getByLabel("Hours").fill("2");
    await entry.getByRole("button", { name: "Save", exact: true }).click();

    await page.getByLabel("Day").fill("2026-10-08");
    const moved = page.getByTestId("entry");
    await expect(moved).toContainText("Local");
    await moved.getByRole("button", { name: "↑ Push", exact: true }).click();
    await expect(moved).toContainText("✓ Jira");

    expect(worklogWrites(jira)).toEqual([
      "POST /rest/api/2/issue/ABC-1/worklog",
      "PUT /rest/api/2/issue/ABC-1/worklog/10000",
    ]);
    expect(body(jira.writes()[1])).toEqual({
      timeSpentSeconds: 7200,
      started: "2026-10-08T07:00:00.000+0000",
      comment: "Pairing",
    });
    expect(jira.allWorklogs()).toHaveLength(1);
  });

  test("changing the ticket moves the worklog to the new issue", async ({ page, open, addEntry, jira }) => {
    await open();
    await addEntry({ ticket: "ABC-1", h: 1 });
    const entry = page.getByTestId("entry");
    await entry.getByRole("button", { name: "↑ Push", exact: true }).click();
    await expect(entry).toContainText("✓ Jira");

    await entry.getByTitle("Edit entry").click();
    await entry.getByLabel("Ticket").fill("ABC-2");
    await entry.getByRole("button", { name: "Save", exact: true }).click();
    await entry.getByRole("button", { name: "↑ Push", exact: true }).click();
    await expect(entry).toContainText("✓ Jira");

    expect(worklogWrites(jira)).toEqual([
      "POST /rest/api/2/issue/ABC-1/worklog",
      "POST /rest/api/2/issue/ABC-2/worklog",
      "DELETE /rest/api/2/issue/ABC-1/worklog/10000",
    ]);
    expect(jira.allWorklogs().map((w) => w.key)).toEqual(["ABC-2"]);
  });

  test("shows an error and allows a retry", async ({ page, open, addEntry }) => {
    await open();
    await addEntry({ ticket: "NOPE-1", h: 1 });
    const entry = page.getByTestId("entry");
    await entry.getByRole("button", { name: "↑ Push", exact: true }).click();
    await expect(entry).toContainText("✗ Error");
    await expect(page.getByText(/Error: HTTP 404/)).toBeVisible();

    await entry.getByTitle("Edit entry").click();
    await entry.getByLabel("Ticket").fill("ABC-1");
    await entry.getByRole("button", { name: "Save", exact: true }).click();
    await entry.getByRole("button", { name: "↑ Push", exact: true }).click();
    await expect(entry).toContainText("✓ Jira");
  });

  test("pushes all unsynced entries of the day", async ({ page, open, addEntry, jira }) => {
    await open();
    await addEntry({ ticket: "ABC-1", h: 1 });
    await addEntry({ ticket: "ABC-2", m: 30 });
    await page.getByRole("button", { name: "↑ Push all to Jira (2)" }).click();

    await expect(page.getByText("2 logged")).toBeVisible();
    await expect(page.getByTestId("entry").filter({ hasText: "✓ Jira" })).toHaveCount(2);
    await expect(page.getByRole("button", { name: /Push all to Jira/ })).toHaveCount(0);
    expect(jira.allWorklogs().map((w) => w.key).sort()).toEqual(["ABC-1", "ABC-2"]);
  });

  test("push all reports failures", async ({ page, open, addEntry }) => {
    await open();
    await addEntry({ ticket: "ABC-1", h: 1 });
    await addEntry({ ticket: "NOPE-1", h: 1 });
    await page.getByRole("button", { name: "↑ Push all to Jira (2)" }).click();

    await expect(page.getByText("1 logged, 1 failed")).toBeVisible();
    await expect(page.getByTestId("entry").filter({ hasText: "NOPE-1" })).toContainText("✗ Error");
    await expect(page.getByRole("button", { name: "↑ Push all to Jira (1)" })).toBeVisible();
  });
});

test.describe("deleting synced entries", () => {
  async function syncedEntry({ page, open, addEntry }) {
    await open();
    await addEntry({ ticket: "ABC-1", h: 1 });
    await page.getByRole("button", { name: "↑ Push", exact: true }).click();
    await expect(page.getByTestId("entry")).toContainText("✓ Jira");
  }

  test("deletes the Jira worklog after confirmation", async ({ page, open, addEntry, jira }) => {
    await syncedEntry({ page, open, addEntry });
    let message;
    page.once("dialog", (d) => { message = d.message(); d.accept(); });
    await page.getByRole("button", { name: "Delete entry" }).click();

    await expect(page.getByText("ABC-1: worklog deleted from Jira")).toBeVisible();
    await expect(page.getByText("No entries for this day")).toBeVisible();
    expect(message).toBe("This entry has a Jira worklog. Delete it from Jira too?");
    expect(jira.allWorklogs()).toEqual([]);
  });

  test("keeps everything when the confirmation is dismissed", async ({ page, open, addEntry, jira }) => {
    await syncedEntry({ page, open, addEntry });
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: "Delete entry" }).click();

    await expect(page.getByTestId("entry")).toHaveCount(1);
    expect(jira.allWorklogs()).toHaveLength(1);
  });

  test("still deletes locally when the worklog is already gone in Jira", async ({ page, open, addEntry, jira }) => {
    await syncedEntry({ page, open, addEntry });
    jira.worklogs["ABC-1"] = [];
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete entry" }).click();
    await expect(page.getByText("No entries for this day")).toBeVisible();
  });
});

test.describe("importing from Jira", () => {
  test("imports my worklogs for the selected day", async ({ page, open, jira }) => {
    jira.addWorklog("ABC-1", { started: "2026-10-07T08:00:00.000+0200", seconds: 3600, comment: "Standup" });
    jira.addWorklog("XYZ-7", { started: "2026-10-07T14:00:00.000+0200", seconds: 1800 });
    jira.addWorklog("ABC-1", { author: jira.other, started: "2026-10-07T10:00:00.000+0200", seconds: 7200 });
    jira.addWorklog("ABC-2", { started: "2026-10-06T10:00:00.000+0200", seconds: 600 });

    await open();
    await page.getByRole("button", { name: "↓ Import", exact: true }).click();
    await expect(page.getByText(`${TODAY} · 2 entries found · Total: 1h 30m`)).toBeVisible();
    await expect(page.getByText("2 selected · 1h 30m")).toBeVisible();

    // deselect one, then select all again
    await page.getByText("Release 2.0").click();
    await expect(page.getByText("1 selected · 1h")).toBeVisible();
    await page.getByRole("button", { name: "Select all" }).click();
    await page.getByRole("button", { name: "↓ Import 2 entries" }).click();

    await expect(page.getByText("2 worklogs imported")).toBeVisible();
    const entries = page.getByTestId("entry");
    await expect(entries).toHaveCount(2);
    await expect(entries.filter({ hasText: "ABC-1" })).toContainText("Standup");
    await expect(entries.filter({ hasText: "XYZ-7" })).toContainText("Release 2.0"); // summary as fallback
    await expect(entries.filter({ hasText: "✓ Jira" })).toHaveCount(2);

    // a second import marks them as already imported
    await page.getByRole("button", { name: "↓ Import", exact: true }).click();
    await expect(page.getByText("imported", { exact: true })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "↓ Import 0 entries" })).toBeDisabled();
  });

  test("shows an empty state", async ({ page, open }) => {
    await open();
    await page.getByRole("button", { name: "↓ Import", exact: true }).click();
    await expect(page.getByText("No worklogs found for this day.")).toBeVisible();
  });
});
