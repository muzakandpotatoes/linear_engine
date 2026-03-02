#!/usr/bin/env node
// Fetches Todoist tasks whose names begin with "triage" (case insensitive),
// creates them in the matching Linear team's triage, then marks them complete
// in Todoist. Requires LINEAR_API_KEY and TODOIST_API_KEY env vars.

const LINEAR_API_URL = "https://api.linear.app/graphql";
const TODOIST_API_URL = "https://api.todoist.com/api/v1";

const { LINEAR_API_KEY, TODOIST_API_KEY } = process.env;

if (!LINEAR_API_KEY) {
  console.error("LINEAR_API_KEY environment variable is required");
  process.exit(1);
}
if (!TODOIST_API_KEY) {
  console.error("TODOIST_API_KEY environment variable is required");
  process.exit(1);
}

// Team names to look for as a suffix on the Todoist task (case insensitive)
const KNOWN_TEAMS = ["Hop", "Self"];

// --- Linear helpers ---

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

const GET_TEAMS_QUERY = `
  query GetTeams {
    teams {
      nodes {
        id
        name
        states {
          nodes {
            id
            type
          }
        }
      }
    }
  }
`;

const CREATE_ISSUE_MUTATION = `
  mutation CreateIssue($teamId: String!, $title: String!, $stateId: String) {
    issueCreate(input: { teamId: $teamId, title: $title, stateId: $stateId }) {
      success
      issue {
        id
        identifier
        title
      }
    }
  }
`;

// Returns a map of uppercase team name → { id, name, triageStateId }
// for the teams listed in KNOWN_TEAMS.
async function getLinearTeamMap() {
  const data = await linearRequest(GET_TEAMS_QUERY);
  const knownUpper = new Set(KNOWN_TEAMS.map((t) => t.toUpperCase()));
  const teamMap = {};

  for (const team of data.teams.nodes) {
    const key = team.name.toUpperCase();
    if (!knownUpper.has(key)) continue;

    const triageState = team.states.nodes.find((s) => s.type === "triage");
    if (!triageState) {
      console.warn(
        `  ⚠ Linear team "${team.name}" has no triage state — issues will use the default state`
      );
    }

    teamMap[key] = {
      id: team.id,
      name: team.name,
      triageStateId: triageState?.id ?? null,
    };
  }

  return teamMap;
}

// --- Todoist helpers ---

async function todoistRequest(method, path) {
  const res = await fetch(`${TODOIST_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TODOIST_API_KEY}` },
  });

  if (!res.ok) {
    throw new Error(`Todoist API HTTP error: ${res.status} ${res.statusText}`);
  }

  return res.status === 204 ? null : res.json();
}

async function fetchAllTodoistTasks() {
  const tasks = [];
  let cursor = null;

  do {
    const url = cursor ? `/tasks?cursor=${cursor}` : "/tasks";
    const page = await todoistRequest("GET", url);
    tasks.push(...page.results);
    cursor = page.next_cursor ?? null;
  } while (cursor);

  return tasks;
}

// --- Task name parsing ---

// "triage Fix the bug Hop" → { title: "Fix the bug", team: "HOP" }
// "TRIAGE Update docs"     → { title: "Update docs",  team: null  }
function parseTriageTask(content) {
  // Strip leading "triage" word (with optional trailing whitespace)
  const withoutPrefix = content.replace(/^triage\s*/i, "").trim();

  for (const teamName of KNOWN_TEAMS) {
    // Team name must be preceded by whitespace (not embedded in another word)
    const suffix = new RegExp(`\\s+${teamName}$`, "i");
    if (suffix.test(withoutPrefix)) {
      return {
        title: withoutPrefix.replace(suffix, "").trim(),
        team: teamName.toUpperCase(),
      };
    }
  }

  return { title: withoutPrefix, team: null };
}

// --- Main ---

async function main() {
  console.log("Fetching Linear teams...");
  const teamMap = await getLinearTeamMap();
  const foundTeams = Object.values(teamMap)
    .map((t) => t.name)
    .join(", ");
  console.log(`Found Linear team(s): ${foundTeams || "(none matching)"}\n`);

  console.log("Fetching Todoist tasks...");
  const allTasks = await fetchAllTodoistTasks();

  const triageTasks = allTasks.filter((task) => /^triage\b/i.test(task.content));
  console.log(`Found ${triageTasks.length} triage task(s) in Todoist`);

  if (triageTasks.length === 0) return;
  console.log();

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const task of triageTasks) {
    const { title, team } = parseTriageTask(task.content);

    const linearTeam = teamMap[team ?? "SELF"];
    if (!linearTeam) {
      console.warn(
        `  ⚠ Skipping "${task.content}" — team "${team}" not found in Linear`
      );
      skipped++;
      continue;
    }

    try {
      const data = await linearRequest(CREATE_ISSUE_MUTATION, {
        teamId: linearTeam.id,
        title,
        stateId: linearTeam.triageStateId,
      });

      if (!data.issueCreate.success) {
        throw new Error("issueCreate returned success=false");
      }

      const issue = data.issueCreate.issue;
      console.log(
        `  ✓ Created ${issue.identifier} "${issue.title}" in ${linearTeam.name} triage`
      );

      await todoistRequest("POST", `/tasks/${task.id}/close`);
      console.log(`    ✓ Completed Todoist task "${task.content}"`);
      created++;
    } catch (err) {
      console.error(`  ✗ Failed for "${task.content}": ${err.message}`);
      failed++;
    }
  }

  console.log(
    `\nDone. Created: ${created}  Skipped: ${skipped}  Failed: ${failed}`
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
