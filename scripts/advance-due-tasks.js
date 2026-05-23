#!/usr/bin/env node
// Advances Linear issues across all teams based on proximity to their due date:
//   - Backlog or Todo, due within 7 days   → Docket
//   - Backlog, Todo, or Docket, due within 1 day → In Progress
//
// The 1-day rule takes priority: an issue due tomorrow skips Docket and goes
// straight to In Progress. Overdue issues are treated as due "within 1 day".
//
// Teams that don't have both "Docket" and "In Progress" states are skipped
// (with a warning). Requires LINEAR_API_KEY. Safe to re-run.

const LINEAR_API_URL = "https://api.linear.app/graphql";
const TIMEZONE = "America/Los_Angeles";
const { LINEAR_API_KEY } = process.env;

if (!LINEAR_API_KEY) {
  console.error("LINEAR_API_KEY environment variable is required");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Linear API HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  const body = JSON.parse(text);
  if (body.errors?.length) {
    throw new Error(`Linear API errors: ${JSON.stringify(body.errors)}`);
  }
  if (/^\s*mutation/i.test(query)) await sleep(100);
  return body.data;
}

// YYYY-MM-DD for "now" in the configured timezone.
function todayInTz(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchTeams() {
  const teams = [];
  let after = null;
  do {
    const data = await linearRequest(`
      query Teams($after: String) {
        teams(first: 50, after: $after) {
          nodes {
            id name
            states(first: 50) { nodes { id name } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { after });
    teams.push(...data.teams.nodes);
    after = data.teams.pageInfo.hasNextPage ? data.teams.pageInfo.endCursor : null;
  } while (after);
  return teams;
}

async function fetchEligibleIssues(teamIds) {
  const issues = [];
  let after = null;
  do {
    const data = await linearRequest(`
      query Eligible($after: String, $teamIds: [ID!]!) {
        issues(
          first: 50
          after: $after
          filter: {
            team: { id: { in: $teamIds } }
            archivedAt: { null: true }
            completedAt: { null: true }
            canceledAt: { null: true }
            dueDate: { null: false }
            state: { name: { in: ["Backlog", "Todo", "Docket"] } }
          }
        ) {
          nodes {
            id identifier title dueDate
            state { id name }
            team { id name }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { after, teamIds });
    issues.push(...data.issues.nodes);
    after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
  } while (after);
  return issues;
}

async function updateIssueState(issueId, stateId) {
  await linearRequest(`
    mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }
  `, { id: issueId, stateId });
}

async function main() {
  const todayStr = todayInTz(TIMEZONE);
  const withinWeek = addDays(todayStr, 7);
  const withinDay = addDays(todayStr, 1);

  console.log(`Advancing due tasks — today is ${todayStr} (${TIMEZONE})`);
  console.log(`  Week threshold : due <= ${withinWeek} → Docket`);
  console.log(`  Day threshold  : due <= ${withinDay} → In Progress\n`);

  const teams = await fetchTeams();
  const teamStateMap = {};
  for (const team of teams) {
    const states = Object.fromEntries(
      team.states.nodes.map((s) => [s.name.toLowerCase(), s])
    );
    const docket = states["docket"];
    const inProgress = states["in progress"];
    if (!docket || !inProgress) {
      console.log(`  ⚠ Skipping team "${team.name}" — missing Docket and/or In Progress`);
      continue;
    }
    teamStateMap[team.id] = { docketId: docket.id, inProgressId: inProgress.id };
  }

  const teamIds = Object.keys(teamStateMap);
  if (teamIds.length === 0) {
    console.log("No teams have both Docket and In Progress states. Nothing to do.");
    return;
  }
  console.log(`Processing ${teamIds.length} eligible team(s)\n`);

  const issues = await fetchEligibleIssues(teamIds);
  console.log(`Found ${issues.length} eligible issue(s) with a due date\n`);

  let toInProgress = 0;
  let toDocket = 0;
  let skipped = 0;
  let failed = 0;

  for (const issue of issues) {
    const { id, identifier, title, dueDate, state, team } = issue;
    const stateName = state.name.toLowerCase();
    const mapping = teamStateMap[team.id];
    if (!mapping) { skipped++; continue; }

    try {
      if (dueDate <= withinDay) {
        if (stateName === "in progress") { skipped++; continue; }
        await updateIssueState(id, mapping.inProgressId);
        console.log(`  → In Progress  [${team.name}] ${identifier}  (due ${dueDate})  "${title}"`);
        toInProgress++;
      } else if (dueDate <= withinWeek && (stateName === "backlog" || stateName === "todo")) {
        await updateIssueState(id, mapping.docketId);
        console.log(`  → Docket       [${team.name}] ${identifier}  (due ${dueDate})  "${title}"`);
        toDocket++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`  ✗ [${team.name}] ${identifier}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. → In Progress: ${toInProgress}  → Docket: ${toDocket}  Unchanged: ${skipped}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
