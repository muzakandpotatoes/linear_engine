#!/usr/bin/env node
// Fetches all completed/cancelled Linear issues closed more than 1 week ago
// and archives them. Requires LINEAR_API_KEY env var.

const LINEAR_API_URL = "https://api.linear.app/graphql";
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

const GET_CLOSED_ISSUES_QUERY = `
  query GetClosedIssues($after: String, $cutoff: DateTimeOrDuration!) {
    issues(
      filter: {
        archivedAt: { null: true }
        or: [
          { completedAt: { lt: $cutoff } }
          { canceledAt: { lt: $cutoff } }
        ]
      }
      first: 100
      after: $after
    ) {
      nodes {
        id
        identifier
        title
        completedAt
        canceledAt
        updatedAt
        team {
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ARCHIVE_ISSUE_MUTATION = `
  mutation ArchiveIssue($id: String!) {
    issueArchive(id: $id) {
      success
    }
  }
`;

async function fetchAllClosedIssues(cutoff) {
  const issues = [];
  let after = null;

  do {
    const data = await linearRequest(GET_CLOSED_ISSUES_QUERY, {
      after,
      cutoff: cutoff.toISOString(),
    });
    issues.push(...data.issues.nodes);
    after = data.issues.pageInfo.hasNextPage
      ? data.issues.pageInfo.endCursor
      : null;
  } while (after);

  return issues;
}

async function archiveIssue(id) {
  const data = await linearRequest(ARCHIVE_ISSUE_MUTATION, { id });
  return data.issueArchive.success;
}

async function main() {
  const cutoff = new Date(Date.now() - ONE_WEEK_MS);
  console.log(
    `Archiving issues closed before ${cutoff.toISOString()} (1 week ago)`
  );

  console.log("Fetching closed issues...");
  const eligible = await fetchAllClosedIssues(cutoff);

  if (eligible.length === 0) {
    console.log("No issues eligible for archiving.");
    return;
  }

  console.log(`${eligible.length} issue(s) eligible for archiving:\n`);

  let archived = 0;
  let failed = 0;

  for (const issue of eligible) {
    const closedAt = issue.completedAt ?? issue.canceledAt ?? issue.updatedAt;
    try {
      const success = await archiveIssue(issue.id);
      if (success) {
        console.log(`  ✓ [${issue.team.name}] ${issue.identifier} — ${issue.title} (closed ${closedAt})`);
        archived++;
      } else {
        console.warn(`  ✗ [${issue.team.name}] ${issue.identifier} — archive returned false`);
        failed++;
      }
    } catch (err) {
      console.error(`  ✗ [${issue.team.name}] ${issue.identifier} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Archived: ${archived}  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
