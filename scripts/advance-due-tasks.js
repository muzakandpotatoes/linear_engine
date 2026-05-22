#!/usr/bin/env node
// Advances Linear "Self" team issues based on proximity to their due date:
//   - Backlog or Todo, due within 7 days   → Docket
//   - Backlog, Todo, or Docket, due within 1 day → In Progress
//
// The 1-day rule takes priority: an issue due tomorrow skips Docket and goes
// straight to In Progress. Overdue issues are treated as due "within 1 day".
//
// Requires LINEAR_API_KEY. Safe to re-run (already-advanced issues are skipped).

const LINEAR_API_URL = "https://api.linear.app/graphql";
const { LINEAR_API_KEY } = process.env;

if (!LINEAR_API_KEY) {
  console.error("LINEAR_API_KEY environment variable is required");
  process.exit(1);
}

const TEAM_NAME = "Self";

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
  return body.data;
}

// YYYY-MM-DD string for today in local system time (good enough for a daily job).
function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchTeam() {
  const data = await linearRequest(`
    query {
      teams(filter: { name: { eqIgnoreCase: "${TEAM_NAME}" } }) {
        nodes {
          id name
          states(first: 50) { nodes { id name } }
        }
      }
    }
  `);
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`Linear team "${TEAM_NAME}" not found`);
  return team;
}

async function fetchEligibleIssues(teamId) {
  const issues = [];
  let after = null;
  do {
    const data = await linearRequest(`
      query($after: String) {
        issues(
          first: 50
          after: $after
          filter: {
            team: { id: { eq: "${teamId}" } }
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
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { after });
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
  const todayStr = today();
  const withinWeek = addDays(todayStr, 7);
  const withinDay = addDays(todayStr, 1);

  console.log(`Advancing due tasks — today is ${todayStr}`);
  console.log(`  Week threshold : due <= ${withinWeek} → Docket`);
  console.log(`  Day threshold  : due <= ${withinDay} → In Progress\n`);

  const team = await fetchTeam();
  const statesByName = Object.fromEntries(
    team.states.nodes.map((s) => [s.name.toLowerCase(), s])
  );

  const docketState = statesByName["docket"];
  const inProgressState = statesByName["in progress"];
  if (!docketState) throw new Error('State "Docket" not found in Self team');
  if (!inProgressState) throw new Error('State "In Progress" not found in Self team');

  const issues = await fetchEligibleIssues(team.id);
  console.log(`Found ${issues.length} eligible issue(s) with a due date\n`);

  let toInProgress = 0;
  let toDocket = 0;
  let skipped = 0;
  let failed = 0;

  for (const issue of issues) {
    const { id, identifier, title, dueDate, state } = issue;
    const stateName = state.name.toLowerCase();

    try {
      if (dueDate <= withinDay) {
        // Due tomorrow or sooner (or overdue) — promote to In Progress
        if (stateName === "in progress") { skipped++; continue; }
        await updateIssueState(id, inProgressState.id);
        console.log(`  → In Progress  ${identifier}  (due ${dueDate})  "${title}"`);
        toInProgress++;
      } else if (dueDate <= withinWeek && (stateName === "backlog" || stateName === "todo")) {
        // Due within the week — move to Docket
        await updateIssueState(id, docketState.id);
        console.log(`  → Docket       ${identifier}  (due ${dueDate})  "${title}"`);
        toDocket++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`  ✗ ${identifier}: ${err.message}`);
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
