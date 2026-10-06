// ─── Jira Time Tracker – Helpers ───────────────────────────────────
//
// Pure date/time helpers shared by the app (loaded as a classic script,
// so every function is a global) and the unit tests (via require).
// Plain JavaScript only — no JSX.
// ────────────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function formatHM(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
function toJiraFormat(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return parts.join(" ") || "0m";
}
// YYYY-MM-DD in the browser's local time zone (not UTC)
function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
function todayKey(now = new Date()) { return localDateKey(now); }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function toHHMM(date) {
  return `${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
}
function isoWeekKey(dateStr) {
  // Use noon to avoid DST boundary issues in millisecond-based week calculation
  const d = new Date(dateStr + "T12:00:00");
  // ISO week: week 1 contains the year's first Thursday
  const thu = new Date(d); thu.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const isoYear = thu.getFullYear();
  const jan4 = new Date(isoYear, 0, 4, 12);
  const startOfW1 = new Date(jan4); startOfW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const week = Math.round((thu - startOfW1) / 604800000) + 1;
  return { year: isoYear, week, key: `${isoYear}-W${String(week).padStart(2,"0")}` };
}
// The seven day keys (Mon–Sun) of the week containing dateStr
function weekDays(dateStr) {
  const ref = new Date(dateStr + "T12:00:00");
  const mon = new Date(ref); mon.setDate(ref.getDate() - (ref.getDay() + 6) % 7);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon); d.setDate(mon.getDate() + i);
    days.push(localDateKey(d));
  }
  return days;
}
// Mon–Fri decimal hours, tab-separated, comma as decimal separator
function weekHoursTSV(fullWeek, entries) {
  return fullWeek.slice(0, 5).map(dk => {
    const sec = (entries[dk] || []).reduce((s, e) => s + e.seconds, 0);
    return String(Math.round(sec / 3600 * 100) / 100).replace(".", ",");
  }).join("\t");
}
function calcEndTime(startTime, seconds) {
  if (!startTime) return null;
  const [h, m] = startTime.split(":").map(Number);
  const totalMin = h * 60 + m + Math.round(seconds / 60);
  return `${String(Math.floor(totalMin / 60) % 24).padStart(2,"0")}:${String(totalMin % 60).padStart(2,"0")}`;
}
function buildStartedISO(startTime, day) {
  // Stryker disable next-line ConditionalExpression: equivalent — without a start time the date is invalid and falls through
  if (startTime) {
    const d = new Date(`${day}T${startTime}:00`);
    if (!isNaN(d.getTime())) return d.toISOString().replace("Z", "+0000");
  }
  return new Date(day + "T12:00:00.000+0000").toISOString().replace("Z", "+0000");
}

// Stryker disable next-line all: only false in the browser, which the unit tests don't run in
if (typeof module !== "undefined") {
  module.exports = {
    formatDuration, formatHM, toJiraFormat, localDateKey, todayKey, generateId,
    toHHMM, isoWeekKey, weekDays, weekHoursTSV, calcEndTime, buildStartedISO,
  };
}
