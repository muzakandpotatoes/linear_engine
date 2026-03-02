#!/usr/bin/env python3
"""Query the Todoist API and print the raw response shape. No third-party packages needed.

Usage:
    TODOIST_API_KEY=your_key python3 scripts/check-todoist-api.py
"""

import json
import os
import urllib.request

API_KEY = os.environ.get("TODOIST_API_KEY")
if not API_KEY:
    raise SystemExit("TODOIST_API_KEY environment variable is required")

req = urllib.request.Request(
    "https://api.todoist.com/api/v1/tasks",
    headers={"Authorization": f"Bearer {API_KEY}"},
)

with urllib.request.urlopen(req) as res:
    body = json.loads(res.read())

print(f"HTTP status : {res.status}")
print(f"Type        : {type(body).__name__}")

if isinstance(body, dict):
    print(f"Top-level keys: {list(body.keys())}")
    for key, val in body.items():
        preview = val[:2] if isinstance(val, list) else val
        print(f"\n  [{key}] ({type(val).__name__}): {json.dumps(preview, indent=4)}")
elif isinstance(body, list):
    print(f"Length: {len(body)}")
    if body:
        print(f"\nFirst item keys: {list(body[0].keys())}")
        print(f"\nFirst item:\n{json.dumps(body[0], indent=2)}")
