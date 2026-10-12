# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.
"""Explicit-repository GitHub REST access through the authenticated ``gh`` CLI.

Stage one only calls GET endpoints. The reusable request method does not retry:
if a future write times out, the coordinator must reconcile its outcome first.
"""

from __future__ import annotations

import json
import re
import subprocess
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

API_TIMEOUT_SECONDS = 60


class GitHubError(RuntimeError):
    """An API call failed or did not return the expected response shape."""


class GitHub:
    def __init__(self, repo: str):
        if not isinstance(repo, str) or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo, re.ASCII):
            raise ValueError("GitHub repository must be an explicit owner/name")
        self.repo = repo

    def _endpoint(self, endpoint: str) -> str:
        if not isinstance(endpoint, str):
            raise ValueError("GitHub endpoint must be a full repos/owner/name REST path")
        parts = urlsplit(endpoint)
        prefix = f"repos/{self.repo}/"
        if (
            parts.scheme
            or parts.netloc
            or parts.fragment
            or not (parts.path == prefix.rstrip("/") or parts.path.startswith(prefix))
            or any(segment in {".", ".."} for segment in parts.path.split("/"))
            or "%" in parts.path
        ):
            raise ValueError(f"GitHub endpoint must be scoped to {prefix}")
        return endpoint

    def _call(self, endpoint: str, method: str, payload, paginate: bool = False) -> str:
        endpoint = self._endpoint(endpoint)
        method = method.upper()
        if method not in {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}:
            raise ValueError(f"Unsupported HTTP method: {method}")
        args = [
            "gh", "api", endpoint, "--method", method,
            "--header", "Accept: application/vnd.github+json",
            "--header", "X-GitHub-Api-Version: 2022-11-28",
        ]
        if paginate:
            args.append("--paginate")
        body = None
        if payload is not None:
            body = json.dumps(payload, allow_nan = False)
            args.extend(["--input", "-"])
        try:
            result = subprocess.run(
                args,
                input = body,
                capture_output = True,
                text = True,
                encoding = "utf-8",
                check = True,
                shell = False,
                timeout = API_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise GitHubError(f"GitHub {method} {endpoint} timed out; outcome requires reconciliation") from exc
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or "").strip()
            raise GitHubError(f"GitHub {method} {endpoint} failed (exit {exc.returncode}): {detail}") from exc
        except OSError as exc:
            raise GitHubError(f"Cannot execute gh for {method} {endpoint}: {exc}") from exc
        return result.stdout

    def request(self, endpoint: str, method: str = "GET", payload = None):
        """Return one JSON response (or None for a successful no-content response)."""
        output = self._call(endpoint, method, payload)
        if not output.strip():
            return None
        try:
            return json.loads(output)
        except (ValueError, TypeError) as exc:
            raise GitHubError(f"GitHub {method} {endpoint} returned invalid JSON") from exc

    def pages(self, endpoint: str) -> list:
        """Flatten every JSON array emitted by ``gh api --paginate``.

        gh emits concatenated JSON documents, not one JSON document. Missing,
        malformed, or non-array pages are errors, never an empty-list fallback.
        """
        self._endpoint(endpoint)
        parts = urlsplit(endpoint)
        query = parse_qsl(parts.query, keep_blank_values = True)
        if not any(key == "per_page" for key, _ in query):
            query.append(("per_page", "100"))
        endpoint = urlunsplit(parts._replace(query = urlencode(query)))
        output = self._call(endpoint, "GET", None, paginate = True)
        decoder = json.JSONDecoder()
        items = []
        offset = 0
        page_count = 0
        try:
            while offset < len(output):
                while offset < len(output) and output[offset].isspace():
                    offset += 1
                if offset == len(output):
                    break
                page, offset = decoder.raw_decode(output, offset)
                if not isinstance(page, list):
                    raise ValueError("paginated endpoint did not return an array")
                items.extend(page)
                page_count += 1
            if not page_count:
                raise ValueError("paginated endpoint returned no pages")
        except (ValueError, TypeError) as exc:
            raise GitHubError(f"GitHub GET {endpoint} returned invalid paginated JSON: {exc}") from exc
        return items

    def snapshot(self, parent: int) -> dict:
        """Read full direct issues, native blockers, and comments, including parent.

        Native blockers can refer to external issues; those objects are retained
        for the planner to block. Cross-repository subissues fail closed rather
        than looking up a same-number issue in the campaign repository.
        """
        if type(parent) is not int or parent <= 0:
            raise ValueError("Parent issue number must be a positive integer")
        base = f"repos/{self.repo}/issues"
        parent_issue = self.request(f"{base}/{parent}")
        if not isinstance(parent_issue, dict) or parent_issue.get("number") != parent:
            raise GitHubError(f"GitHub parent #{parent} response is not the requested issue")
        issues = self.pages(f"{base}/{parent}/sub_issues")
        seen = {parent}
        for issue in issues:
            if not isinstance(issue, dict) or type(issue.get("number")) is not int or issue["number"] <= 0:
                raise GitHubError("GitHub subissue response contains invalid issue metadata")
            number = issue["number"]
            if number in seen:
                raise GitHubError(f"GitHub subissue response contains duplicate issue #{number}")
            seen.add(number)
            repository = issue.get("repository_url")
            url = issue.get("url")
            expected = f"https://api.github.com/repos/{self.repo}".casefold()
            if (
                (repository is None and url is None)
                or (repository is not None and (not isinstance(repository, str) or repository.casefold() != expected))
                or (url is not None and (not isinstance(url, str) or url.casefold() != f"{expected}/issues/{number}"))
            ):
                raise GitHubError(f"Subissue #{number} repository is missing or outside campaign repository {self.repo}")
        blockers = {}
        comments = {str(parent): self.pages(f"{base}/{parent}/comments")}
        for issue in sorted(issues, key = lambda item: item["number"]):
            number = issue["number"]
            blockers[str(number)] = self.pages(f"{base}/{number}/dependencies/blocked_by")
            comments[str(number)] = self.pages(f"{base}/{number}/comments")
        return {"parent": parent_issue, "issues": issues, "blockers": blockers, "comments": comments}
