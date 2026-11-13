#!/usr/bin/env python3
"""Record the outcomes of scheduled listing searches."""
from __future__ import annotations
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

SOURCES = ("regional", "general", "ghana", "kenya", "china", "expansion", "products", "jobs", "guyana", "dubai_vehicles", "dubai_marketplace")


def record(state, outcomes, started_at, completed_at):
    sources = state.setdefault("sources", {})
    for source in SOURCES:
        outcome = outcomes.get(source, {}).get("outcome")
        if outcome in {"success", "failure", "cancelled"}:
            entry = sources.setdefault(source, {})
            entry.update(lastAttemptAt=completed_at, outcome=outcome)
            if outcome == "success":
                entry["lastSuccessfulSlot"] = started_at
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["record"])
    parser.add_argument("--state", type=Path, default=Path("data/listing-discovery-state.json"))
    args = parser.parse_args()
    state = json.loads(args.state.read_text()) if args.state.exists() else {"sources": {}}
    state.pop("intervalHours", None)
    outcomes = json.loads(os.environ["DISCOVERY_OUTCOMES"])
    completed_at = datetime.now(timezone.utc).isoformat()
    record(state, outcomes, os.environ["DISCOVERY_STARTED_AT"], completed_at)
    args.state.parent.mkdir(parents=True, exist_ok=True)
    args.state.write_text(json.dumps(state, indent=2) + "\n")
    summary = ["### Listing discovery", "", "| Source | This run | Last successful search |", "|---|---|---|"]
    for source in SOURCES:
        summary.append(f"| {source} | {outcomes.get(source, {}).get('outcome', 'skipped')} | {state['sources'].get(source, {}).get('lastSuccessfulSlot', 'Never')} |")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
            handle.write("\n".join(summary) + "\n")
    print("\n".join(summary))


if __name__ == "__main__":
    main()
