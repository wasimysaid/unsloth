# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.
"""Deterministic read-only frontier selection from native GitHub dependencies."""

from __future__ import annotations


def _number(issue: dict) -> int:
    if not isinstance(issue, dict) or type(issue.get("number")) is not int or issue["number"] <= 0:
        raise ValueError("Issue metadata must contain a positive integer number")
    return issue["number"]


def _repository(issue: dict) -> str | None:
    repository = issue.get("repository_url")
    if isinstance(repository, str):
        return repository.rstrip("/").casefold()
    url = issue.get("url")
    if isinstance(url, str) and "/issues/" in url:
        return url.rsplit("/issues/", 1)[0].rstrip("/").casefold()
    return None


def _labels(issue: dict) -> set[str]:
    labels = issue.get("labels", [])
    if not isinstance(labels, list):
        raise ValueError(f"Issue #{issue['number']} has invalid labels")
    names = set()
    for label in labels:
        name = label.get("name") if isinstance(label, dict) else label
        if not isinstance(name, str):
            raise ValueError(f"Issue #{issue['number']} has invalid label metadata")
        names.add(name)
    return names


def _closed_completed(issue: dict) -> bool:
    return issue.get("state") == "closed" and issue.get("state_reason") == "completed"


def _cycles(edges: dict[int, set[int]]) -> list[list[int]]:
    """Return sorted strongly connected components, including self-dependencies."""
    indexes = {}
    low = {}
    stack = []
    on_stack = set()
    cycles = []

    def visit(number: int) -> None:
        indexes[number] = low[number] = len(indexes)
        stack.append(number)
        on_stack.add(number)
        for blocker in sorted(edges[number]):
            if blocker not in indexes:
                visit(blocker)
                low[number] = min(low[number], low[blocker])
            elif blocker in on_stack:
                low[number] = min(low[number], indexes[blocker])
        if low[number] == indexes[number]:
            component = []
            while True:
                node = stack.pop()
                on_stack.remove(node)
                component.append(node)
                if node == number:
                    break
            if len(component) > 1 or number in edges[number]:
                cycles.append(sorted(component))

    for number in sorted(edges):
        if number not in indexes:
            visit(number)
    return sorted(cycles)


def plan(
    snapshot: dict,
    approved: set[int],
    completed: set[int] | None = None,
    owned: set[int] | None = None,
    human: set[int] | None = None,
) -> dict:
    """Select approved open ready-for-agent direct children in issue-number order.

    ``completed`` contains integration receipts, not merely closed issue numbers.
    ``owned`` contains tickets authoritatively owned by this runner; it allows an
    assigned ticket through the ownership gate. ``human`` always prevents dispatch.
    ``cycles`` lists cyclic strongly connected components in numeric order.

    Integrated closed/completed children are omitted from ready/blocked. New
    children are reported separately in ``unapproved`` and never dispatched.
    Missing dependency lists block their issue; malformed snapshot shapes raise
    ValueError. The input snapshot and sets are not changed.
    """
    approved = set(approved)
    completed = set(completed or ())
    owned = set(owned or ())
    human = set(human or ())
    parent = snapshot.get("parent")
    if not isinstance(parent, dict):
        raise ValueError("Snapshot must include the parent issue")
    issues = snapshot.get("issues")
    blockers = snapshot.get("blockers")
    if not isinstance(issues, list) or not isinstance(blockers, dict):
        raise ValueError("Snapshot must include issues and native blocker data")
    children = {}
    for issue in issues:
        number = _number(issue)
        if number in children or number == parent.get("number"):
            raise ValueError(f"Snapshot contains duplicate or parent child #{number}")
        children[number] = issue
    campaign_repo = _repository(parent)

    dependencies = {}
    edges = {number: set() for number in children}
    for number in children:
        entries = blockers.get(str(number))
        if entries is None:
            continue
        if not isinstance(entries, list) or any(not isinstance(item, dict) for item in entries):
            raise ValueError(f"Issue #{number} has invalid native blocker data")
        dependencies[number] = entries
        for blocker in entries:
            predecessor = blocker.get("number")
            if type(predecessor) is int and predecessor in children:
                repository = _repository(children[predecessor])
                if repository is None or _repository(blocker) == repository:
                    edges[number].add(predecessor)
    cycles = _cycles(edges)
    cyclic = {number for component in cycles for number in component}

    ready = []
    blocked = []
    for number, issue in sorted(children.items()):
        if number not in approved:
            continue
        in_repository = campaign_repo is None or _repository(issue) == campaign_repo
        if _closed_completed(issue) and number in completed and in_repository:
            continue
        reasons = []
        if not in_repository:
            reasons.append("issue repository is outside campaign scope or missing")
        if number in cyclic:
            reasons.append("dependency cycle")
        if number in human:
            reasons.append("human review")
        state = issue.get("state")
        if state == "closed":
            if issue.get("state_reason") != "completed":
                reasons.append("issue closed without completed state (cancelled or unknown)")
            if number not in completed:
                reasons.append("closed issue has no integration receipt")
        elif state != "open":
            reasons.append("issue state is missing or not open")
        elif number in completed:
            reasons.append("integration receipt conflicts with open issue state")
        labels = _labels(issue)
        if "ready-for-agent" not in labels:
            reasons.append("missing ready-for-agent label")
        if any(label.startswith("wayfinder:") for label in labels):
            reasons.append("wayfinder decision issue")
        assignees = issue.get("assignees")
        if not isinstance(assignees, list):
            reasons.append("assignee data missing or invalid")
        elif assignees and number not in owned:
            reasons.append("assigned to another owner")
        if number not in dependencies:
            reasons.append("native blocker data missing")
        else:
            entries = dependencies[number]
            # Ordering by number and repository also disambiguates external IDs.
            entries = sorted(entries, key = lambda item: (
                item["number"] if type(item.get("number")) is int else -1,
                _repository(item) or "",
            ))
            for blocker in entries:
                predecessor = blocker.get("number")
                if type(predecessor) is not int or predecessor <= 0:
                    reasons.append("blocker issue metadata missing")
                    continue
                prefix = f"blocker #{predecessor}"
                child = children.get(predecessor)
                if child is None or predecessor not in approved:
                    reasons.append(f"{prefix} outside approved direct-child scope")
                    continue
                repository = campaign_repo or _repository(child)
                if repository is not None and (
                    _repository(blocker) != repository or _repository(child) != repository
                ):
                    reasons.append(f"{prefix} repository outside scope or missing")
                    continue
                if not _closed_completed(blocker) or not _closed_completed(child):
                    if blocker.get("state_reason") in {"not_planned", "cancelled"} or child.get("state_reason") in {"not_planned", "cancelled"}:
                        reasons.append(f"{prefix} cancelled")
                    else:
                        reasons.append(f"{prefix} not closed completed (or inconsistent metadata)")
                if predecessor not in completed:
                    reasons.append(f"{prefix} has no integration receipt")
        if reasons:
            blocked.append({"number": number, "title": issue.get("title", ""), "reasons": list(dict.fromkeys(reasons))})
        else:
            ready.append(issue)
    return {
        "ready": ready,
        "blocked": blocked,
        "cycles": cycles,
        "unapproved": sorted(set(children) - approved),
    }
