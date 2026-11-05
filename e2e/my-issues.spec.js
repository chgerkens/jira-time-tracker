const { test, expect, TODAY } = require("./fixtures");

test.describe("my issues", () => {
  const myIssues = (page) => page.getByRole("button", { name: "📌 My issues" });

  test("lists my unresolved and recently resolved issues, recently updated first", async ({ page, open, jira }) => {
    await open();
    await myIssues(page).click();

    const dialog = page.getByRole("dialog", { name: "My issues" });
    await expect(dialog).toContainText("3 found");
    const rows = dialog.getByTestId("my-issue");
    // ABC-1 is someone else's, XYZ-7 was resolved more than a week ago
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("ABC-2");
    await expect(rows.nth(0)).toContainText("Write docs");
    await expect(rows.nth(0)).toContainText("To Do");
    await expect(rows.nth(0)).not.toContainText("resolved");
    // resolved 23:30 UTC = 01:30 the next day in Berlin
    await expect(rows.nth(1)).toContainText("ABC-4");
    await expect(rows.nth(1)).toContainText("✓ resolved 2026-10-06");
    await expect(rows.nth(2)).toContainText("ABC-3"); // unresolved, however old
    await expect(rows.nth(2).getByRole("link", { name: "ABC-3" }))
      .toHaveAttribute("href", `${jira.url}/browse/ABC-3`);

    const jql = new URL(jira.last().url, "http://jira").searchParams.get("jql");
    expect(jql).toBe("assignee = currentUser() AND (resolution = Unresolved OR resolved >= -7d) ORDER BY updated DESC");

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("prefills the manual entry form via Log time", async ({ page, open, stored }) => {
    await open();
    await page.getByRole("button", { name: /Timer/ }).click(); // Log time must switch back to the manual tab
    await myIssues(page).click();
    await page.getByTestId("my-issue").filter({ hasText: "ABC-4" })
      .getByRole("button", { name: "+ Log time" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("Ticket").first()).toHaveValue("ABC-4");
    await expect(page.getByLabel("Description").first()).toHaveValue("Upgrade database");

    await page.getByLabel("Hours").first().fill("1");
    await page.getByRole("button", { name: "+ Add" }).click();
    await expect(page.getByTestId("entry")).toContainText("ABC-4");
    const [entry] = (await stored("jira-time-entries"))[TODAY];
    expect(entry).toMatchObject({ ticket: "ABC-4", issueSummary: "Upgrade database", description: "Upgrade database", seconds: 3600 });
  });

  test("shows an empty state", async ({ page, open, jira }) => {
    const handler = jira.handler;
    jira.handler = (req, res, record) => {
      if (req.url.includes("assignee")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ issues: [] }));
      }
      handler(req, res, record);
    };
    await open();
    await myIssues(page).click();
    await expect(page.getByText("No unresolved or recently resolved issues assigned to you.")).toBeVisible();
  });

  test("shows Jira errors", async ({ page, open, jira }) => {
    jira.handler = (req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errorMessages: ["Field 'resolved' does not exist"] }));
    };
    await open();
    await myIssues(page).click();
    await expect(page.getByText(/Error: HTTP 400 .*resolved/)).toBeVisible();
  });

  test("is hidden when not connected", async ({ page, open }) => {
    await open({ connected: false });
    await expect(myIssues(page)).toHaveCount(0);
  });
});
