#!/usr/bin/env node
// Manages recurring Linear tasks defined in config/recurring-tasks.yaml.
// Linear is the source of truth — iterations are tagged with a label
// `recurring:<task-id>` so prior runs can be found without external state.
//
// Each run, for each enabled task:
//   1. Compute the "current iteration" due date based on the schedule mode.
//   2. Look up Linear issues with the recurring label.
//   3. If no issue exists for that due date and we're inside the create
//      window, create it (honoring `if_open`).
//   4. If a reminder offset has fired and no reminder has been set yet,
//      create one (Linear reminders are per-viewer — only the API token
//      owner is notified).
//   5. For any state transition whose offset has fired, advance the issue
//      — but only if the user hasn't manually moved it past our list.
//
// Requires LINEAR_API_KEY. Run once per day; safe to re-run.

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const LINEAR_API_URL = "https://api.linear.app/graphql";
const { LINEAR_API_KEY } = process.env;

if (!LINEAR_API_KEY) {
  console.error("LINEAR_API_KEY environment variable is required");
  process.exit(1);
}

async function linearRequest(query, variables = {}) {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API HTTP error: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`Linear API errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

// --- Date utilities (timezone-aware) ---------------------------------------

// YYYY-MM-DD in the given IANA timezone for "now".
function todayInTz(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Parse YYYY-MM-DD into a UTC-midnight Date so day arithmetic stays safe
// across DST transitions.
function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// "3d", "2w", "0d" → integer days.
function parseOffsetDays(s) {
  if (s == null || s === "") return 0;
  const m = /^(\d+)([dw])$/.exec(String(s).trim());
  if (!m) throw new Error(`Invalid offset "${s}" (use e.g. "3d", "2w")`);
  const n = Number(m[1]);
  return m[2] === "w" ? n * 7 : n;
}

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function weekdayNum(name) {
  const k = String(name).toLowerCase();
  if (!(k in WEEKDAYS)) throw new Error(`Invalid weekday "${name}"`);
  return WEEKDAYS[k];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function isoWeekNum(date) {
  const d = new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()
  ));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function templateVars(dueDate) {
  const d = parseDate(dueDate);
  const wd = d.getUTCDay();
  return {
    due_date: dueDate,
    date: dueDate,
    year: String(d.getUTCFullYear()),
    month: MONTHS[d.getUTCMonth()],
    month_num: String(d.getUTCMonth() + 1).padStart(2, "0"),
    day: String(d.getUTCDate()).padStart(2, "0"),
    weekday: Object.keys(WEEKDAYS).find((k) => WEEKDAYS[k] === wd),
    iso_week: String(isoWeekNum(d)).padStart(2, "0"),
  };
}

function render(str, vars) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

// --- Schedule resolution ---------------------------------------------------

// Compute the current iteration's due date. Returns YYYY-MM-DD, or null for
// after_completion (which depends on a Linear lookup, handled separately).
function computeCurrentDueDate(schedule, today) {
  const t = parseDate(today);
  switch (schedule.mode) {
    case "weekly": {
      const target = weekdayNum(schedule.day);
      const delta = (target - t.getUTCDay() + 7) % 7;
      return formatDate(addDays(t, delta));
    }
    case "monthly": {
      const day = Number(schedule.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        throw new Error(`monthly day must be 1-31, got ${schedule.day}`);
      }
      const clamp = (y, m, d) =>
        Math.min(d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
      const y = t.getUTCFullYear();
      const m = t.getUTCMonth();
      let candidate = new Date(Date.UTC(y, m, clamp(y, m, day)));
      if (candidate < t) {
        const ny = m === 11 ? y + 1 : y;
        const nm = (m + 1) % 12;
        candidate = new Date(Date.UTC(ny, nm, clamp(ny, nm, day)));
      }
      return formatDate(candidate);
    }
    case "interval": {
      const every = parseOffsetDays(schedule.every);
      if (!every) throw new Error("interval requires `every` (e.g. \"3d\")");
      const anchor = schedule.anchor ? parseDate(schedule.anchor) : t;
      const diff = Math.floor((t - anchor) / 86400000);
      const stepsPassed = Math.floor(diff / every);
      const onAnchorDay = diff >= 0 && diff % every === 0;
      const next = addDays(
        anchor,
        (stepsPassed + (onAnchorDay ? 0 : 1)) * every
      );
      return formatDate(next);
    }
    case "after_completion":
      return null;
    default:
      throw new Error(`Unknown schedule mode "${schedule.mode}"`);
  }
}

// The next scheduled due date strictly after `fromDate`. Used to skip past
// iterations that have already been closed within the current period.
function nextDueDate(schedule, fromDate) {
  const t = parseDate(fromDate);
  switch (schedule.mode) {
    case "weekly":
      return formatDate(addDays(t, 7));
    case "monthly": {
      const day = Number(schedule.day);
      const clamp = (y, m, d) =>
        Math.min(d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
      const y = t.getUTCFullYear();
      const m = t.getUTCMonth();
      const ny = m === 11 ? y + 1 : y;
      const nm = (m + 1) % 12;
      return formatDate(new Date(Date.UTC(ny, nm, clamp(ny, nm, day))));
    }
    case "interval": {
      const every = parseOffsetDays(schedule.every);
      return formatDate(addDays(t, every));
    }
    default:
      return fromDate;
  }
}

function isClosed(issue) {
  return !!(issue.completedAt || issue.canceledAt || issue.archivedAt);
}

// --- Linear name → ID resolver --------------------------------------------

class Resolver {
  constructor() {
    this.teams = {};
    this.users = [];
    this.projects = {};
    this.viewerId = null;
  }

  async load() {
    const data = await linearRequest(`
      query Bootstrap {
        viewer { id }
        teams(first: 100) {
          nodes {
            id name
            states(first: 100) { nodes { id name type } }
            labels(first: 250) { nodes { id name } }
          }
        }
        users(first: 250) {
          nodes { id name displayName email active }
        }
        projects(first: 250) { nodes { id name } }
      }
    `);
    this.viewerId = data.viewer.id;
    for (const t of data.teams.nodes) {
      this.teams[t.name.toLowerCase()] = {
        id: t.id,
        name: t.name,
        states: Object.fromEntries(
          t.states.nodes.map((s) => [s.name.toLowerCase(), s])
        ),
        labels: Object.fromEntries(
          t.labels.nodes.map((l) => [l.name.toLowerCase(), l])
        ),
      };
    }
    this.users = data.users.nodes.filter((u) => u.active);
    this.projects = Object.fromEntries(
      data.projects.nodes.map((p) => [p.name.toLowerCase(), p])
    );
  }

  team(name) {
    const t = this.teams[String(name).toLowerCase()];
    if (!t) throw new Error(`Linear team "${name}" not found`);
    return t;
  }

  state(team, name) {
    const s = team.states[String(name).toLowerCase()];
    if (!s) throw new Error(`State "${name}" not found in team "${team.name}"`);
    return s;
  }

  project(name) {
    const p = this.projects[String(name).toLowerCase()];
    if (!p) throw new Error(`Project "${name}" not found`);
    return p;
  }

  user(spec) {
    if (spec === "me") return { id: this.viewerId };
    const lc = String(spec).toLowerCase();
    const u = this.users.find(
      (u) =>
        u.email?.toLowerCase() === lc ||
        u.name?.toLowerCase() === lc ||
        u.displayName?.toLowerCase() === lc
    );
    if (!u) throw new Error(`Linear user "${spec}" not found`);
    return u;
  }

  async ensureLabel(team, name) {
    const existing = team.labels[name.toLowerCase()];
    if (existing) return existing.id;
    const data = await linearRequest(
      `mutation L($name: String!, $teamId: String!) {
        issueLabelCreate(input: { name: $name, teamId: $teamId }) {
          success
          issueLabel { id name }
        }
      }`,
      { name, teamId: team.id }
    );
    if (!data.issueLabelCreate.success) {
      throw new Error(`Failed to create label "${name}"`);
    }
    const l = data.issueLabelCreate.issueLabel;
    team.labels[l.name.toLowerCase()] = l;
    return l.id;
  }
}

// --- Iteration lookup ------------------------------------------------------

async function findIterations(teamId, recurringLabel) {
  const data = await linearRequest(
    `query Iter($teamId: ID!, $label: String!) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          labels: { name: { eq: $label } }
        }
        first: 50
        orderBy: createdAt
      ) {
        nodes {
          id identifier title
          state { id name type }
          dueDate completedAt canceledAt archivedAt
          labels { nodes { id name } }
        }
      }
    }`,
    { teamId, label: recurringLabel }
  );
  return data.issues.nodes;
}

// --- Issue mutations -------------------------------------------------------

async function createIssue(fields, dueDate, vars, team, resolver, recurringLabelId) {
  const input = {
    teamId: team.id,
    title: render(fields.name, vars),
    dueDate,
    labelIds: [recurringLabelId],
  };
  if (fields.description) input.description = render(fields.description, vars);
  if (fields.assignee) input.assigneeId = resolver.user(fields.assignee).id;
  if (fields.project) input.projectId = resolver.project(fields.project).id;
  if (fields.initial_state) input.stateId = resolver.state(team, fields.initial_state).id;
  if (fields.priority != null) input.priority = Number(fields.priority);
  if (Array.isArray(fields.labels)) {
    for (const name of fields.labels) {
      input.labelIds.push(await resolver.ensureLabel(team, name));
    }
  }

  const data = await linearRequest(
    `mutation Create($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id identifier title dueDate
          state { id name }
          labels { nodes { id name } }
        }
      }
    }`,
    { input }
  );
  if (!data.issueCreate.success) {
    throw new Error("issueCreate returned success=false");
  }
  return data.issueCreate.issue;
}

async function updateIssueDueDate(issueId, dueDate) {
  await linearRequest(
    `mutation U($id: String!, $dueDate: TimelessDate) {
      issueUpdate(id: $id, input: { dueDate: $dueDate }) { success }
    }`,
    { id: issueId, dueDate }
  );
}

async function updateIssueState(issueId, stateId) {
  await linearRequest(
    `mutation S($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issueId, stateId }
  );
}

async function addLabelToIssue(issueId, currentLabelIds, newLabelId) {
  const labelIds = Array.from(new Set([...currentLabelIds, newLabelId]));
  await linearRequest(
    `mutation AL($id: String!, $labelIds: [String!]!) {
      issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
    }`,
    { id: issueId, labelIds }
  );
}

async function setReminder(issueId, dueDate) {
  // Reminder fires at 9am Pacific on the due date.
  const reminderAt = new Date(`${dueDate}T17:00:00Z`).toISOString();
  await linearRequest(
    `mutation R($issueId: String!, $reminderAt: DateTime!) {
      issueReminderCreate(input: { issueId: $issueId, reminderAt: $reminderAt }) {
        success
      }
    }`,
    { issueId, reminderAt }
  );
}

// --- Per-task pipeline -----------------------------------------------------

const REMINDED_LABEL = "reminded";

async function processTask(task, defaults, today, resolver) {
  const id = task.id;
  if (!id) throw new Error("task entry is missing `id`");
  if (task.enabled === false) {
    console.log(`[${id}] disabled, skipping`);
    return;
  }

  const fields = { ...defaults, ...(task.fields ?? {}) };
  if (!fields.name) throw new Error(`[${id}] fields.name is required`);
  const teamName = fields.team || defaults.team;
  if (!teamName) throw new Error(`[${id}] team is required (set in defaults or fields)`);

  const team = resolver.team(teamName);
  const recurringLabel = `recurring:${id}`;
  const recurringLabelId = await resolver.ensureLabel(team, recurringLabel);

  const iterations = await findIterations(team.id, recurringLabel);

  // 1. Compute due date. If the iteration for this period is already closed
  //    (or in after_completion mode, a prior iteration is closed), advance to
  //    the next one — the new instance should appear as soon as the previous
  //    one is closed and no active one is observed.
  let dueDate;
  let advancedPastClosed = false;
  if (task.schedule.mode === "after_completion") {
    const lastCompleted = iterations
      .filter((i) => i.completedAt)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
    if (!lastCompleted) {
      dueDate = today;
    } else {
      const interval = parseOffsetDays(task.schedule.interval);
      const base = parseDate(lastCompleted.completedAt.slice(0, 10));
      dueDate = formatDate(addDays(base, interval));
      advancedPastClosed = true;
    }
  } else {
    dueDate = computeCurrentDueDate(task.schedule, today);
    let existing = iterations.find((i) => i.dueDate === dueDate);
    let safety = 0;
    while (existing && isClosed(existing) && safety++ < 12) {
      dueDate = nextDueDate(task.schedule, dueDate);
      existing = iterations.find((i) => i.dueDate === dueDate);
      advancedPastClosed = true;
    }
  }

  const vars = templateVars(dueDate);
  const createOffset = parseOffsetDays(task.create_offset);
  const createDate = formatDate(addDays(parseDate(dueDate), -createOffset));
  const inCreateWindow = advancedPastClosed || today >= createDate;

  // 2. Find iteration for this due date.
  let issue = iterations.find((i) => i.dueDate === dueDate);

  // 3. Create if needed (respecting if_open).
  if (!issue) {
    if (!inCreateWindow) {
      console.log(
        `[${id}] not yet in create window (today=${today}, create=${createDate}, due=${dueDate})`
      );
      return;
    }

    const openOther = iterations.find(
      (i) => i.dueDate !== dueDate && !i.completedAt && !i.canceledAt && !i.archivedAt
    );
    const ifOpen = task.if_open ?? defaults.if_open ?? "skip";

    if (openOther && ifOpen === "skip") {
      console.log(`[${id}] ${openOther.identifier} still open — if_open=skip, not creating`);
      return;
    }
    if (openOther && ifOpen === "rollover") {
      await updateIssueDueDate(openOther.id, dueDate);
      console.log(`[${id}] rolled ${openOther.identifier} dueDate → ${dueDate}`);
      issue = { ...openOther, dueDate };
    } else {
      issue = await createIssue(fields, dueDate, vars, team, resolver, recurringLabelId);
      console.log(`[${id}] created ${issue.identifier} "${issue.title}" due ${dueDate}`);
    }
  }

  // 4. Reminder (idempotent via the `reminded` label).
  if (task.reminder_offset != null) {
    const reminderOffset = parseOffsetDays(task.reminder_offset);
    const reminderDate = formatDate(addDays(parseDate(dueDate), -reminderOffset));
    const alreadyReminded = issue.labels?.nodes?.some((l) => l.name === REMINDED_LABEL);
    if (today >= reminderDate && !alreadyReminded) {
      try {
        await setReminder(issue.id, dueDate);
        const remindedId = await resolver.ensureLabel(team, REMINDED_LABEL);
        const currentLabelIds = (issue.labels?.nodes ?? []).map((l) => l.id);
        await addLabelToIssue(issue.id, currentLabelIds, remindedId);
        console.log(`[${id}] reminder set on ${issue.identifier} for ${dueDate}`);
      } catch (err) {
        console.warn(`[${id}] reminder failed on ${issue.identifier}: ${err.message}`);
      }
    }
  }

  // 5. State transitions.
  if (Array.isArray(task.transitions) && task.transitions.length > 0) {
    await applyTransitions(task, fields, issue, dueDate, today, team, resolver);
  }
}

async function applyTransitions(task, fields, issue, dueDate, today, team, resolver) {
  const fired = task.transitions
    .map((tr) => ({
      state: tr.state,
      offsetDays: parseOffsetDays(tr.offset),
      fireDate: formatDate(addDays(parseDate(dueDate), -parseOffsetDays(tr.offset))),
    }))
    .filter((tr) => today >= tr.fireDate)
    .sort((a, b) => a.offsetDays - b.offsetDays);

  if (fired.length === 0) return;
  const target = fired[0];

  const currentName = issue.state?.name?.toLowerCase();
  if (currentName === target.state.toLowerCase()) return;

  // Only advance if the issue is still in a state we put it in — don't
  // override manual moves to e.g. Done or a custom state.
  const ours = new Set(
    [fields.initial_state, ...task.transitions.map((t) => t.state)]
      .filter(Boolean)
      .map((s) => s.toLowerCase())
  );
  if (!ours.has(currentName)) {
    console.log(
      `[${task.id}] ${issue.identifier} is in "${issue.state?.name}" — leaving alone (manual state)`
    );
    return;
  }

  const newState = resolver.state(team, target.state);
  await updateIssueState(issue.id, newState.id);
  console.log(`[${task.id}] ${issue.identifier} → ${target.state}`);
}

// --- Entry point -----------------------------------------------------------

async function main() {
  const configPath = path.join(__dirname, "..", "config", "recurring-tasks.yaml");
  const cfg = yaml.load(fs.readFileSync(configPath, "utf8"));

  const tz = cfg.timezone || "UTC";
  const today = todayInTz(tz);
  const defaults = cfg.defaults || {};
  console.log(`Recurring tasks — today is ${today} (${tz})`);

  const resolver = new Resolver();
  await resolver.load();

  let failed = 0;
  for (const task of cfg.tasks || []) {
    try {
      await processTask(task, defaults, today, resolver);
    } catch (err) {
      console.error(`[${task?.id || "<no-id>"}] ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
