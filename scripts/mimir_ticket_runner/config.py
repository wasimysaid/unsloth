"""Versioned campaign policy, loaded before agents can edit any worktree."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import shutil
import tomllib

from .common import RunnerError, digest

DEFAULT_CONFIG = Path(__file__).resolve().parents[2] / "docs/agents/mimir-ticket-runner.toml"
ALLOWED_REPOS = {"wasimysaid/unsloth", "wasimysaid/mimir"}
STORAGE = Path("/mnt/disks/unslothai/mugi/mimir-ticket-runner")


@dataclass(frozen=True)
class Config:
    path: Path
    data: dict

    @classmethod
    def load(cls, path=DEFAULT_CONFIG):
        path = Path(path).resolve()
        with path.open("rb") as stream:
            data = tomllib.load(stream)
        config = cls(path, data)
        config.validate()
        return config

    @property
    def campaign(self):
        return self.data["campaign"]

    @property
    def repositories(self):
        return self.data["repositories"]

    @property
    def tickets(self):
        return {int(k): v for k, v in self.data["tickets"].items()}

    @property
    def approved(self):
        return set(self.tickets)

    @property
    def root(self):
        return Path(self.campaign["storage_root"]).expanduser().resolve()

    @property
    def fingerprint(self):
        return digest(self.data)

    def validate(self):
        c = self.campaign
        if self.data.get("version") != 1 or c.get("repo") != "wasimysaid/unsloth":
            raise RunnerError("Only schema v1 and the explicitly authorized Unsloth fork are supported")
        if not isinstance(c.get("parent"), int) or c["parent"] <= 0:
            raise RunnerError("A positive parent issue number is required")
        if self.root.parent != STORAGE:
            raise RunnerError(f"Campaign storage must be an immediate named child of {STORAGE}")
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", c.get("id", "")):
            raise RunnerError("Campaign id must be a safe path component")
        if not self.root.name == c["id"]:
            raise RunnerError("Storage basename must equal the stable campaign id")
        for key in ("max_workers", "max_attempts", "worker_timeout", "review_timeout", "budget_seconds"):
            if type(c.get(key)) is not int or c[key] <= 0:
                raise RunnerError(f"Positive {key} required")
        if c["max_workers"] > 4:
            raise RunnerError("This shared-host runner caps concurrency at four")
        if c.get("provider") != "chatgpt" or c.get("model") != "gpt-6.1-sol":
            raise RunnerError("This campaign requires configured ChatGPT GPT-6.1 Sol; no silent fallback")
        if set(self.repositories) != {"studio", "mimir"}:
            raise RunnerError("Paired studio/mimir repository declarations required")
        seen = set()
        for name, repo in self.repositories.items():
            if repo["github"] not in ALLOWED_REPOS or repo["github"] in seen:
                raise RunnerError("Repository target is not allowlisted or is duplicated")
            seen.add(repo["github"])
            expected = "wasimysaid/unsloth" if name == "studio" else "wasimysaid/mimir"
            if repo["github"] != expected:
                raise RunnerError("Repository roles cannot be swapped")
            branch = repo["branch"]
            if branch != "mimir-studio" and not re.fullmatch(r"mimir-runner-smoke-[a-zA-Z0-9_-]+", branch):
                raise RunnerError("Only mimir-studio or an isolated smoke branch may be targeted")
            if not Path(repo["source"]).is_absolute():
                raise RunnerError("Repository source paths must be absolute")
        profiles = self.data.get("profiles", {})
        if not self.tickets:
            raise RunnerError("An explicit approved ticket set is required")
        for number, policy in self.tickets.items():
            if number <= 0 or not policy.get("profiles"):
                raise RunnerError("Each ticket requires a nonempty verification profile")
            for profile in policy["profiles"]:
                checks = profiles.get(profile, {}).get("checks", [])
                if not checks:
                    raise RunnerError(f"Missing checks for profile {profile}")
                for check in checks:
                    if check.get("repo") not in self.repositories:
                        raise RunnerError("Checks must name an owned repository")
                    if not isinstance(check.get("argv"), list) or not check["argv"] or not all(isinstance(x, str) for x in check["argv"]):
                        raise RunnerError("Check commands must be nonempty argument arrays")
                    if check.get("timeout", 1800) <= 0:
                        raise RunnerError("Check timeout must be positive")
            if policy.get("resource") not in (None, "gpu"):
                raise RunnerError("Unknown resource gate")
        binary = shutil.which(c.get("mimir", "mimir"))
        if not binary:
            raise RunnerError("Configured Mimir executable not found")

    def check_commands(self, number):
        checks = []
        for profile in self.tickets[number]["profiles"]:
            for check in self.data["profiles"][profile]["checks"]:
                if check not in checks:
                    checks.append(check)
        return checks
