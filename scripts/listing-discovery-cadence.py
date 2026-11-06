#!/usr/bin/env python3
"""Persist successful discovery slots; failed sources retry on the next check."""
from __future__ import annotations
import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

SOURCES = ("regional", "general", "ghana", "kenya", "china", "expansion", "products", "jobs", "guyana", "dubai_vehicles", "dubai_marketplace")


def due(state, source, now, force=False):
    if force:
        return True
    last = state.get("sources", {}).get(source, {}).get("lastSuccessfulSlot")
    try:
        parsed = datetime.fromisoformat(last.replace("Z", "+00:00"))
        return parsed > now or now - parsed >= timedelta(hours=48)
    except (AttributeError, ValueError, TypeError):
        return True


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
    parser.add_argument("action", choices=["plan", "record"])
    parser.add_argument("--state", type=Path, default=Path("data/listing-discovery-state.json"))
    args = parser.parse_args()
    state = json.loads(args.state.read_text()) if args.state.exists() else {"intervalHours": 48, "sources": {}}
    now = datetime.now(timezone.utc)
    if args.action == "plan":
        # Daily UTC slots preserve a two-day cadence across month boundaries
        # without adding another day when the runner starts a little late.
        slot = now.replace(hour=0, minute=0, second=0, microsecond=0)
        lines = [f"started_at={slot.isoformat()}"] + [f"{source}={str(due(state, source, now, os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch')).lower()}" for source in SOURCES]
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as handle:
                handle.write("\n".join(lines) + "\n")
        print("\n".join(lines))
    else:
        outcomes = json.loads(os.environ["DISCOVERY_OUTCOMES"])
        record(state, outcomes, os.environ["DISCOVERY_STARTED_AT"], now.isoformat())
        args.state.parent.mkdir(parents=True, exist_ok=True)
        args.state.write_text(json.dumps(state, indent=2) + "\n")
        summary = ["### Listing discovery (48-hour cadence)", "", "| Source | This run | Last successful search slot |", "|---|---|---|"]
        for source in SOURCES:
            summary.append(f"| {source} | {outcomes.get(source, {}).get('outcome', 'skipped')} | {state['sources'].get(source, {}).get('lastSuccessfulSlot', 'Never')} |")
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
                handle.write("\n".join(summary) + "\n")
        print("\n".join(summary))


if __name__ == "__main__":
    main()
