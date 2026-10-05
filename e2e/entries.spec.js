const { test, expect, TODAY } = require("./fixtures");

test.describe("manual entries", () => {
  test("adds an entry with start time", async ({ page, open, stored }) => {
    await open({ connected: false });
    const add = page.getByRole("button", { name: "+ Add" });
    await expect(add).toBeDisabled();

    await page.getByLabel("Ticket").first().fill("abc-1");
    await expect(page.getByLabel("Ticket").first()).toHaveValue("ABC-1");
    await page.getByLabel("Description").first().fill("Pairing");
    await page.getByLabel("Start time").first().fill("09:00");
    await expect(add).toBeDisabled(); // no duration yet
    await page.getByLabel("Hours").first().fill("1");
    await page.getByLabel("Minutes").first().fill("30");
    await add.click();

    const entry = page.getByTestId("entry");
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("ABC-1");
    await expect(entry).toContainText("Pairing");
    await expect(entry).toContainText("Local");
    await expect(entry).toContainText("09:00 – 10:30");
    await expect(entry).toContainText("1h 30m");
    await expect(page.getByText("Σ 1h 30m", { exact: true })).toBeVisible();

    // form is reset
    await expect(page.getByLabel("Ticket").first()).toHaveValue("");
    await expect(page.getByLabel("Hours").first()).toHaveValue("");

    const saved = await stored("jira-time-entries");
    expect(saved[TODAY]).toHaveLength(1);
    expect(saved[TODAY][0]).toMatchObject({
      ticket: "ABC-1", description: "Pairing", seconds: 5400, startTime: "09:00", syncStatus: "local",
    });
  });

  test("Enter in the description adds the entry; no start time shows --:--", async ({ page, open }) => {
    await open({ connected: false });
    await page.getByLabel("Ticket").first().fill("ABC-2");
    await page.getByLabel("Minutes").first().fill("45");
    await page.getByLabel("Description").first().fill("Review");
    await page.getByLabel("Description").first().press("Enter");

    const entry = page.getByTestId("entry");
    await expect(entry).toContainText("--:--");
    await expect(entry).toContainText("45m");
  });

  test("entries survive a reload", async ({ page, open, addEntry }) => {
    await open({ connected: false });
    await addEntry({ ticket: "ABC-1", h: 2 });
    await page.reload();
    await expect(page.getByTestId("entry")).toContainText("2h");
  });

  test("edits an entry", async ({ page, open, addEntry }) => {
    await open({ connected: false });
    await addEntry({ ticket: "ABC-1", description: "Old", start: "09:00", h: 1 });
    const entry = page.getByTestId("entry");

    await entry.getByTitle("Edit entry").click();
    await entry.getByLabel("Description").fill("New");
    await entry.getByLabel("Start time").fill("13:15");
    await entry.getByLabel("Minutes").fill("15");
    await entry.getByRole("button", { name: "Save", exact: true }).click();

    await expect(entry).toContainText("New");
    await expect(entry).toContainText("13:15 – 14:30");
    await expect(entry).toContainText("1h 15m");
  });

  test("cancelling an edit keeps the entry unchanged", async ({ page, open, addEntry }) => {
    await open({ connected: false });
    await addEntry({ ticket: "ABC-1", description: "Keep", h: 1 });
    const entry = page.getByTestId("entry");

    await entry.getByTitle("Edit entry").click();
    await entry.getByLabel("Description").fill("Discard");
    await entry.getByRole("button", { name: "Cancel" }).click();
    await expect(entry).toContainText("Keep");
  });

  test("deletes a local entry without asking", async ({ page, open, addEntry }) => {
    await open({ connected: false });
    await addEntry({ ticket: "ABC-1", h: 1 });
    await page.getByRole("button", { name: "Delete entry" }).click();
    await expect(page.getByText("No entries for this day")).toBeVisible();
  });

  test("adds entries to the selected day", async ({ page, open, addEntry, stored }) => {
    await open({ connected: false });
    await page.getByLabel("Day").fill("2026-10-06");
    await addEntry({ ticket: "ABC-1", h: 1 });

    await page.getByRole("button", { name: "Today" }).click();
    await expect(page.getByLabel("Day")).toHaveValue(TODAY);
    await expect(page.getByText("No entries for this day")).toBeVisible();

    const saved = await stored("jira-time-entries");
    expect(Object.keys(saved)).toEqual(["2026-10-06"]);
  });

  test("moves an entry to another day", async ({ page, open, addEntry, stored }) => {
    await open({ connected: false });
    await addEntry({ ticket: "ABC-1", h: 1 });
    const entry = page.getByTestId("entry");
    await entry.getByTitle("Edit entry").click();
    await entry.getByLabel("Date").fill("2026-10-08");
    await entry.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByText("No entries for this day")).toBeVisible();
    await page.getByLabel("Day").fill("2026-10-08");
    await expect(page.getByTestId("entry")).toContainText("ABC-1");
    expect(Object.keys(await stored("jira-time-entries"))).toEqual(["2026-10-08"]);
  });

  test("uses the local date just after midnight", async ({ page, open }) => {
    // 00:30 in Berlin is still the previous day in UTC
    await open({ connected: false, now: new Date("2026-10-06T00:30:00+02:00") });
    await expect(page.getByLabel("Day")).toHaveValue("2026-10-06");
  });
});

test.describe("ticket search and favorites", () => {
  test("searches Jira by summary and fills in the ticket", async ({ page, open, addEntry }) => {
    await open();
    await page.getByLabel("Ticket").first().fill("login");
    const result = page.getByText("Fix login bug");
    await expect(result).toBeVisible();
    await result.click();

    await expect(page.getByLabel("Ticket").first()).toHaveValue("ABC-1");
    await expect(page.getByLabel("Description").first()).toHaveValue("Fix login bug");
    await page.getByLabel("Hours").first().fill("1");
    await page.getByRole("button", { name: "+ Add" }).click();
    // issue summary is shown under the ticket key
    await expect(page.getByTestId("entry").getByTitle("Fix login bug")).toBeVisible();
  });

  test("a project prefix lists that project's tickets", async ({ page, open, jira }) => {
    await open();
    await page.getByLabel("Ticket").first().fill("ABC-");
    await expect(page.getByText("Write docs")).toBeVisible();
    await expect(page.getByText("Fix login bug")).toBeVisible();
    await expect(page.getByText("Release 2.0")).toHaveCount(0);
    const search = jira.requests.find((r) => r.url.startsWith("/rest/api/2/search"));
    expect(new URL(search.url, "http://x").searchParams.get("jql")).toBe('project = "ABC" ORDER BY updated DESC');
  });

  test("starred tickets show up as favorites and persist", async ({ page, open, addEntry, stored }) => {
    await open({ connected: false });
    await addEntry({ ticket: "XYZ-7", h: 1 });
    const star = page.getByRole("button", { name: "Toggle favorite" });
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    expect(await stored("jira-favorites")).toEqual(["XYZ-7"]);

    await page.reload();
    await page.getByLabel("Ticket").first().fill("XY");
    await expect(page.getByText("★ Favorites")).toBeVisible();
    await page.getByText("XYZ-7", { exact: true }).first().click();
    await expect(page.getByLabel("Ticket").first()).toHaveValue("XYZ-7");
  });
});
