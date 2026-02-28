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

const GET_CLOSED_ISSUES_QUERY = `
  query GetClosedIssues($after: String) {
    issues(
      filter: {
        state: { type: { in: ["completed", "cancelled"] } }
        archivedAt: { null: true }
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

async function fetchAllClosedIssues() {
  const issues = [];
  let after = null;

  do {
    const data = await linearRequest(GET_CLOSED_ISSUES_QUERY, { after });
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

// Small delay between mutations to stay well within Linear's rate limits
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const cutoff = new Date(Date.now() - ONE_WEEK_MS);
  console.log(
    `Archiving issues closed before ${cutoff.toISOString()} (1 week ago)`
  );

  console.log("Fetching closed issues...");
  const allClosed = await fetchAllClosedIssues();
  console.log(`Found ${allClosed.length} unarchived closed issue(s) total`);

  const eligible = allClosed.filter((issue) => {
    const closedAt = issue.completedAt ?? issue.canceledAt;
    return closedAt && new Date(closedAt) < cutoff;
  });

  if (eligible.length === 0) {
    console.log("No issues eligible for archiving.");
    return;
  }

  console.log(`${eligible.length} issue(s) eligible for archiving:\n`);

  let archived = 0;
  let failed = 0;

  for (const issue of eligible) {
    const closedAt = issue.completedAt ?? issue.canceledAt;
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

    // 100ms between mutations; Linear rate limit is 1,500 req/hr
    await sleep(100);
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
