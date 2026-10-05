// ─── Stateful fake Jira for e2e tests ──────────────────────────────
//
// Implements the slice of the Jira REST API v2 the app uses:
// /myself, /search (JQL subset), and worklog CRUD on issues.
// ────────────────────────────────────────────────────────────────────

const { startFakeJira } = require("../test/helpers");

const PAT = "test-pat";
const ME = { name: "jdoe", key: "jdoe", displayName: "Jane Doe" };
const OTHER = { name: "msmith", key: "msmith", displayName: "Max Smith" };

const ISSUES = {
  "ABC-1": { summary: "Fix login bug", status: "In Progress", type: "Bug" },
  "ABC-2": { summary: "Write docs", status: "To Do", type: "Task" },
  "XYZ-7": { summary: "Release 2.0", status: "Done", type: "Story" },
};

async function startJira() {
  const jira = await startFakeJira();
  jira.me = ME;
  jira.other = OTHER;
  jira.worklogs = {}; // issue key → worklog[]
  let nextId = 10000;

  // Add an existing worklog (e.g. for import tests)
  jira.addWorklog = (key, { author = ME, started, seconds, comment }) => {
    const wl = { id: String(nextId++), author, started, timeSpentSeconds: seconds };
    if (comment !== undefined) wl.comment = comment;
    (jira.worklogs[key] ||= []).push(wl);
    return wl;
  };
  jira.allWorklogs = () =>
    Object.entries(jira.worklogs).flatMap(([key, wls]) => wls.map((wl) => ({ key, ...wl })));
  jira.writes = () => jira.requests.filter((r) => r.method !== "GET");

  const issueJson = (key) => ({
    key,
    fields: {
      summary: ISSUES[key].summary,
      status: { name: ISSUES[key].status },
      issuetype: { name: ISSUES[key].type },
    },
  });

  function search(jql) {
    let m;
    let keys = Object.keys(ISSUES);
    if ((m = /key = "([^"]+)"/.exec(jql))) {
      keys = keys.filter((k) => k === m[1]);
    } else if ((m = /project = "([^"]+)"/.exec(jql))) {
      keys = keys.filter((k) => k.startsWith(`${m[1]}-`));
    } else if ((m = /summary ~ "([^"]+)"/.exec(jql))) {
      const q = m[1].toLowerCase();
      keys = keys.filter((k) => ISSUES[k].summary.toLowerCase().includes(q));
    } else if ((m = /worklogDate = "([^"]+)"/.exec(jql))) {
      const day = m[1];
      keys = keys.filter((k) =>
        (jira.worklogs[k] || []).some(
          (wl) => wl.author.name === ME.name && wl.started.startsWith(day)
        )
      );
    }
    return { issues: keys.map(issueJson) };
  }

  jira.handler = (req, res, record) => {
    const send = (status, body) => {
      if (body === undefined) {
        res.writeHead(status);
        return res.end();
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.headers.authorization !== `Bearer ${PAT}`) {
      return send(401, { errorMessages: ["You are not authenticated."] });
    }

    const url = new URL(req.url, "http://jira");
    const p = url.pathname;
    let m;

    if (req.method === "GET" && p === "/rest/api/2/myself") return send(200, ME);

    if (req.method === "GET" && p === "/rest/api/2/search") {
      return send(200, search(url.searchParams.get("jql") || ""));
    }

    if ((m = /^\/rest\/api\/2\/issue\/([^/]+)\/worklog(?:\/([^/]+))?$/.exec(p))) {
      const [, key, id] = m;
      if (!ISSUES[key]) return send(404, { errorMessages: ["Issue Does Not Exist"] });
      const list = (jira.worklogs[key] ||= []);
      const body = record.body ? JSON.parse(record.body) : {};

      if (req.method === "GET" && !id) {
        return send(200, { startAt: 0, total: list.length, worklogs: list });
      }
      if (req.method === "POST" && !id) {
        return send(201, jira.addWorklog(key, {
          started: body.started,
          seconds: body.timeSpentSeconds,
          comment: body.comment,
        }));
      }
      const wl = list.find((w) => w.id === id);
      if (!wl) return send(404, { errorMessages: ["Cannot find worklog"] });
      if (req.method === "PUT") {
        wl.started = body.started;
        wl.timeSpentSeconds = body.timeSpentSeconds;
        wl.comment = body.comment;
        return send(200, wl);
      }
      if (req.method === "DELETE") {
        list.splice(list.indexOf(wl), 1);
        return send(204);
      }
    }

    send(404, { errorMessages: [`No fake for ${req.method} ${p}`] });
  };

  return jira;
}

module.exports = { startJira, PAT, ISSUES };
