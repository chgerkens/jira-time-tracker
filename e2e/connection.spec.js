const { test, expect, PAT } = require("./fixtures");

test.describe("Jira connection", () => {
  test("connects with a valid PAT", async ({ page, open, jira, stored }) => {
    await open({ connected: false });
    await expect(page.getByRole("button", { name: "↓ Import" })).toHaveCount(0);

    await page.getByRole("button", { name: "Connect Jira" }).click();
    await page.getByLabel("Personal Access Token").fill(PAT);
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText("Connected as Jane Doe (jdoe)")).toBeVisible();
    expect(jira.last().headers.authorization).toBe(`Bearer ${PAT}`);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Connected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "↓ Import" })).toBeVisible();
    expect(await stored("jira-settings")).toEqual({ apiToken: PAT });
  });

  test("explains an invalid PAT", async ({ page, open }) => {
    await open({ connected: false });
    await page.getByRole("button", { name: "Connect Jira" }).click();
    await page.getByLabel("Personal Access Token").fill("wrong-token");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText(/HTTP 401 → Check your Personal Access Token/)).toBeVisible();
  });

  test("Save is disabled without a token", async ({ page, open }) => {
    await open({ connected: false });
    await page.getByRole("button", { name: "Connect Jira" }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Test connection" })).toBeDisabled();
  });

  test("disconnects", async ({ page, open, addEntry, stored }) => {
    await open();
    await addEntry({ ticket: "ABC-1", h: 1 });
    await expect(page.getByRole("button", { name: "↑ Push", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Connected" }).click();
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByRole("button", { name: "Connect Jira" })).toBeVisible();
    await expect(page.getByRole("button", { name: "↑ Push", exact: true })).toHaveCount(0);
    expect(await stored("jira-settings")).toEqual({ apiToken: "" });
  });
});
