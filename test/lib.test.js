// ─── Helper tests ──────────────────────────────────────────────────
//
// Unit tests for public/lib.js. Date-dependent helpers run in several
// time zones (Node picks up process.env.TZ changes at runtime).
// ────────────────────────────────────────────────────────────────────

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../public/lib.js");

const ZONES = [
  "UTC",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Pacific/Auckland",
];

const originalTZ = process.env.TZ;
after(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

function inTZ(tz, fn) {
  process.env.TZ = tz;
  return fn();
}

// ─── Formatting ─────────────────────────────────────────────────────

describe("formatDuration", () => {
  test("pads hours, minutes and seconds", () => {
    assert.equal(lib.formatDuration(0), "00:00:00");
    assert.equal(lib.formatDuration(3725), "01:02:05");
    assert.equal(lib.formatDuration(36000), "10:00:00");
  });
});

describe("formatHM", () => {
  test("shows only the non-zero parts", () => {
    assert.equal(lib.formatHM(0), "0m");
    assert.equal(lib.formatHM(59), "0m");
    assert.equal(lib.formatHM(2700), "45m");
    assert.equal(lib.formatHM(3600), "1h");
    assert.equal(lib.formatHM(5400), "1h 30m");
  });
});

describe("toJiraFormat", () => {
  test("produces Jira duration strings", () => {
    assert.equal(lib.toJiraFormat(0), "0m");
    assert.equal(lib.toJiraFormat(2700), "45m");
    assert.equal(lib.toJiraFormat(7200), "2h");
    assert.equal(lib.toJiraFormat(9000), "2h 30m");
  });
});

describe("toHHMM", () => {
  test("formats local hours and minutes", () => {
    for (const tz of ZONES) {
      inTZ(tz, () => {
        assert.equal(lib.toHHMM(new Date(2026, 9, 5, 9, 5)), "09:05", tz);
        assert.equal(lib.toHHMM(new Date(2026, 9, 5, 23, 59)), "23:59", tz);
      });
    }
  });
});

describe("generateId", () => {
  test("returns distinct ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, lib.generateId));
    assert.equal(ids.size, 1000);
  });
});

// ─── Days and weeks ─────────────────────────────────────────────────

describe("todayKey", () => {
  test("uses the local date, not the UTC date", () => {
    // 00:30 on Oct 6 in Berlin is still Oct 5 in UTC
    const justAfterMidnightBerlin = new Date("2026-10-05T22:30:00Z");
    inTZ("Europe/Berlin", () =>
      assert.equal(lib.todayKey(justAfterMidnightBerlin), "2026-10-06"));
    inTZ("UTC", () =>
      assert.equal(lib.todayKey(justAfterMidnightBerlin), "2026-10-05"));

    // 22:00 on Oct 5 in New York is already Oct 6 in UTC
    const lateEveningNewYork = new Date("2026-10-06T02:00:00Z");
    inTZ("America/New_York", () =>
      assert.equal(lib.todayKey(lateEveningNewYork), "2026-10-05"));
  });

  test("defaults to now", () => {
    inTZ("Europe/Berlin", () =>
      assert.equal(lib.todayKey(), lib.localDateKey(new Date())));
  });
});

describe("isoWeekKey", () => {
  const cases = [
    // ISO week-year boundaries
    ["2025-12-29", "2026-W01"], // Monday, belongs to 2026
    ["2026-01-01", "2026-W01"],
    ["2027-01-01", "2026-W53"], // 2026 has 53 weeks
    ["2027-01-03", "2026-W53"],
    ["2027-01-04", "2027-W01"],
    ["2021-01-03", "2020-W53"],
    ["2024-12-30", "2025-W01"],
    // Ordinary weeks
    ["2026-10-05", "2026-W41"],
    ["2026-10-11", "2026-W41"], // Sunday ends the week
    ["2026-10-12", "2026-W42"],
    // DST switches (EU: Mar 29 / Oct 25, US: Mar 8 / Nov 1)
    ["2026-03-29", "2026-W13"],
    ["2026-03-30", "2026-W14"],
    ["2026-10-25", "2026-W43"],
    ["2026-10-26", "2026-W44"],
    ["2026-03-08", "2026-W10"],
    ["2026-03-09", "2026-W11"],
    ["2026-11-01", "2026-W44"],
  ];

  for (const tz of ZONES) {
    test(`returns ISO 8601 weeks in ${tz}`, () => {
      inTZ(tz, () => {
        for (const [day, key] of cases) {
          const result = lib.isoWeekKey(day);
          assert.equal(result.key, key, `${day} in ${tz}`);
          assert.equal(result.key, `${result.year}-W${String(result.week).padStart(2, "0")}`);
        }
      });
    });
  }
});

describe("weekDays", () => {
  const cases = [
    ["2026-10-07", "2026-10-05", "2026-10-11"],
    ["2026-10-05", "2026-10-05", "2026-10-11"], // Monday
    ["2026-10-11", "2026-10-05", "2026-10-11"], // Sunday
    ["2026-01-01", "2025-12-29", "2026-01-04"], // across the new year
    ["2026-03-29", "2026-03-23", "2026-03-29"], // EU DST start
    ["2026-10-25", "2026-10-19", "2026-10-25"], // EU DST end
    ["2026-03-08", "2026-03-02", "2026-03-08"], // US DST start
  ];

  for (const tz of ZONES) {
    test(`returns seven consecutive days Mon–Sun in ${tz}`, () => {
      inTZ(tz, () => {
        for (const [day, mon, sun] of cases) {
          const days = lib.weekDays(day);
          assert.equal(days.length, 7, `${day} in ${tz}`);
          assert.equal(days[0], mon, `${day} in ${tz}`);
          assert.equal(days[6], sun, `${day} in ${tz}`);
          assert.ok(days.includes(day));
          assert.equal(new Set(days).size, 7);
          // all days of a week share its ISO week key
          const keys = new Set(days.map((d) => lib.isoWeekKey(d).key));
          assert.equal(keys.size, 1, `${day} in ${tz}: ${[...keys]}`);
        }
      });
    });
  }
});

describe("weekHoursTSV", () => {
  test("copies Mon–Fri decimal hours with comma separator", () => {
    const week = lib.weekDays("2026-10-05");
    const entries = {
      "2026-10-05": [{ seconds: 27000 }],                 // 7.5 h
      "2026-10-07": [{ seconds: 2700 }],                  // 0.75 h
      "2026-10-08": [{ seconds: 1200 }],                  // 0.333… h
      "2026-10-09": [{ seconds: 3600 }, { seconds: 1800 }], // 1.5 h
      "2026-10-10": [{ seconds: 3600 }],                  // Saturday — not copied
    };
    assert.equal(lib.weekHoursTSV(week, entries), "7,5\t0\t0,75\t0,33\t1,5");
  });

  test("an empty week is all zeros", () => {
    assert.equal(lib.weekHoursTSV(lib.weekDays("2026-10-05"), {}), "0\t0\t0\t0\t0");
  });
});

// ─── Start / end times ──────────────────────────────────────────────

describe("calcEndTime", () => {
  test("adds the duration to the start time", () => {
    assert.equal(lib.calcEndTime("09:00", 5400), "10:30");
    assert.equal(lib.calcEndTime("08:45", 900), "09:00");
  });

  test("returns null without a start time", () => {
    assert.equal(lib.calcEndTime(null, 3600), null);
    assert.equal(lib.calcEndTime("", 3600), null);
  });

  test("wraps past midnight", () => {
    assert.equal(lib.calcEndTime("23:30", 3600), "00:30");
  });

  test("rounds to whole minutes", () => {
    assert.equal(lib.calcEndTime("09:00", 89), "09:01");
    assert.equal(lib.calcEndTime("09:00", 29), "09:00");
  });
});

describe("buildStartedISO", () => {
  test("converts a local start time to UTC in Jira's format", () => {
    const expected = {
      "UTC": "2026-10-05T09:15:00.000+0000",
      "Europe/Berlin": "2026-10-05T07:15:00.000+0000",     // CEST, UTC+2
      "America/New_York": "2026-10-05T13:15:00.000+0000",  // EDT, UTC-4
      "Asia/Kolkata": "2026-10-05T03:45:00.000+0000",      // UTC+5:30
      "Pacific/Auckland": "2026-10-04T20:15:00.000+0000",  // NZDT, UTC+13
    };
    for (const [tz, iso] of Object.entries(expected)) {
      inTZ(tz, () => assert.equal(lib.buildStartedISO("09:15", "2026-10-05"), iso, tz));
    }
  });

  test("respects winter time", () => {
    inTZ("Europe/Berlin", () =>
      assert.equal(lib.buildStartedISO("09:00", "2026-01-15"), "2026-01-15T08:00:00.000+0000"));
  });

  test("works on a DST switch day", () => {
    // Mar 29 2026: Berlin clocks jump from 02:00 to 03:00 (UTC+1 → UTC+2)
    inTZ("Europe/Berlin", () => {
      assert.equal(lib.buildStartedISO("01:30", "2026-03-29"), "2026-03-29T00:30:00.000+0000");
      assert.equal(lib.buildStartedISO("03:30", "2026-03-29"), "2026-03-29T01:30:00.000+0000");
    });
  });

  test("falls back to noon UTC without a valid start time", () => {
    for (const tz of ZONES) {
      inTZ(tz, () => {
        assert.equal(lib.buildStartedISO(null, "2026-10-05"), "2026-10-05T12:00:00.000+0000", tz);
        assert.equal(lib.buildStartedISO("", "2026-10-05"), "2026-10-05T12:00:00.000+0000", tz);
        assert.equal(lib.buildStartedISO("xx", "2026-10-05"), "2026-10-05T12:00:00.000+0000", tz);
      });
    }
  });
});
