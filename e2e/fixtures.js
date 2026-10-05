// ─── Playwright fixtures ───────────────────────────────────────────
//
// Every test gets its own fake Jira + server.js, a fixed clock
// (Wed 2026-10-07 09:00 Europe/Berlin) and helpers to drive the app.
// ────────────────────────────────────────────────────────────────────

const base = require("@playwright/test");
const { startApp } = require("../test/helpers");
const { startJira, PAT } = require("./fake-jira");

const NOW = new Date("2026-10-07T09:00:00+02:00");
const TODAY = "2026-10-07";

const test = base.test.extend({
  jira: async ({}, use) => {
    const jira = await startJira();
    await use(jira);
    await jira.close();
  },

  server: async ({ jira }, use) => {
    const server = await startApp(jira.url);
    await use(server);
    await server.stop();
  },

  baseURL: async ({ server }, use) => {
    await use(`http://localhost:${server.port}`);
  },

  page: async ({ page }, use) => {
    // Web fonts are cosmetic; don't wait for Google
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await use(page);
  },

  // Opens the app. Seeds localStorage once (survives reloads).
  open: async ({ page }, use) => {
    await use(async ({ connected = true, entries, favorites, now = NOW, clock = "fixed" } = {}) => {
      const seed = {
        "jira-settings": { apiToken: connected ? PAT : "" },
        ...(entries ? { "jira-time-entries": entries } : {}),
        ...(favorites ? { "jira-favorites": favorites } : {}),
      };
      await page.addInitScript((seed) => {
        if (localStorage.getItem("__seeded")) return;
        for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, JSON.stringify(v));
        localStorage.setItem("__seeded", "1");
      }, seed);
      if (clock === "fixed") await page.clock.setFixedTime(now);
      else await page.clock.install({ time: now });
      await page.goto("/");
      await base.expect(page.getByRole("heading", { name: "Jira Time Tracker" })).toBeVisible();
    });
  },

  // Fills the manual entry form and clicks "+ Add".
  addEntry: async ({ page }, use) => {
    await use(async ({ ticket, description, start, h, m }) => {
      await page.getByLabel("Ticket").first().fill(ticket);
      if (description) await page.getByLabel("Description").first().fill(description);
      if (start) await page.getByLabel("Start time").first().fill(start);
      if (h !== undefined) await page.getByLabel("Hours").first().fill(String(h));
      if (m !== undefined) await page.getByLabel("Minutes").first().fill(String(m));
      await page.getByRole("button", { name: "+ Add" }).click();
    });
  },

  stored: async ({ page }, use) => {
    await use((key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key));
  },
});

module.exports = { test, expect: base.expect, NOW, TODAY, PAT };
