const { test, expect, TODAY } = require("./fixtures");

const entry = (ticket, seconds, extra = {}) => ({
  id: `${ticket}-${seconds}-${Math.random()}`,
  ticket,
  seconds,
  description: "",
  startTime: null,
  timestamp: 0,
  syncStatus: "local",
  ...extra,
});

const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

test.describe("timer", () => {
  test("records the elapsed time with its start time", async ({ page, open, stored }) => {
    await open({ connected: false, clock: "install" });
    await page.getByRole("button", { name: /Timer/ }).click();
    await expect(page.getByRole("button", { name: /Start timer/ })).toBeDisabled();

    await page.getByLabel("Ticket").first().fill("ABC-1");
    await page.getByLabel("Description").first().fill("Deep work");
    await page.getByRole("button", { name: /Start timer/ }).click();
    await expect(page.getByText("ABC-1 — Deep work")).toBeVisible();

    await page.clock.fastForward("01:30:00");
    await expect(page.getByText("01:30:00")).toBeVisible();
    await page.getByRole("button", { name: /Stop & Save/ }).click();

    const row = page.getByTestId("entry");
    await expect(row).toContainText("ABC-1");
    await expect(row).toContainText("Deep work");
    await expect(row).toContainText("09:00 – 10:30");
    await expect(row).toContainText("1h 30m");
    expect((await stored("jira-time-entries"))[TODAY][0]).toMatchObject({ seconds: 5400, startTime: "09:00" });
  });
});

test.describe("history and copying", () => {
  const entries = {
    "2026-10-05": [entry("ABC-1", 27000)],                       // Mon 7.5 h
    [TODAY]: [
      entry("ABC-1", 3600, { description: "Pairing", syncStatus: "synced", jiraWorklogId: "1" }),
      entry("ABC-2", 1800),
      entry("ABC-1", 900),
    ],                                                           // Wed 1.75 h
    "2026-10-10": [entry("XYZ-7", 3600)],                        // Sat — not copied
    "2026-09-29": [entry("ABC-2", 7200)],                        // previous week
  };

  test("groups days into ISO weeks with totals", async ({ page, open }) => {
    await open({ connected: false, entries });
    await expect(page.getByText("W41")).toBeVisible();
    await expect(page.getByText("W40")).toBeVisible();
    // week total: 7.5 + 1.75 + 1 = 10.25 h
    await expect(page.getByText("10h 15m")).toBeVisible();

    // clicking a day cell selects it
    await page.getByRole("button", { name: /^5\s*7h 30m/ }).click();
    await expect(page.getByLabel("Day")).toHaveValue("2026-10-05");
    await expect(page.getByTestId("entry")).toHaveCount(1);
  });

  test("copies Mon–Fri hours of a week, tab-separated with decimal commas", async ({ page, open }) => {
    await open({ connected: false, entries });
    await page.getByTitle("Copy Mon–Fri hours (tab-separated)").first().click();
    expect(await readClipboard(page)).toBe("7,5\t0\t1,75\t0\t0");
  });

  test("copies all entries of the day", async ({ page, open }) => {
    await open({ connected: false, entries });
    await page.getByRole("button", { name: "📋 Copy all" }).click();
    await expect(page.getByRole("button", { name: "✓ Copied!" })).toBeVisible();
    expect(await readClipboard(page)).toBe("ABC-1: 1h — Pairing\nABC-2: 30m\nABC-1: 15m");
  });

  test("copies the day's distinct tickets", async ({ page, open }) => {
    await open({ connected: false, entries });
    await page.getByRole("button", { name: "📋 Tickets" }).click();
    expect(await readClipboard(page)).toBe("ABC-1, ABC-2");
  });
});
