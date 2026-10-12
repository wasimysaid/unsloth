# Mimir ticket runner

A single-host coordinator for the Studio–Mimir implementation campaign. It selects tickets; Mimir implements only the assigned slice. GitHub Issues in `wasimysaid/unsloth` is authoritative. The completed Wayfinder decision map is not an implementation queue.

## Commands

Requires Python 3.11+, Git, authenticated `gh`, the configured Mimir executable/model, and the build tools required by each ticket. Run from this repository:

```sh
python3 -m scripts.mimir_ticket_runner doctor
python3 -m scripts.mimir_ticket_runner plan
python3 -m scripts.mimir_ticket_runner run --apply
python3 -m scripts.mimir_ticket_runner status
python3 -m scripts.mimir_ticket_runner resume --apply
python3 -m scripts.mimir_ticket_runner stop --drain
python3 -m scripts.mimir_ticket_runner launch
```

Use `--config <file>` **before** the command for a separately approved campaign. `doctor` and `plan` do not write GitHub, launch models, or create worktrees. Authentication is not proved by checking executable versions: live execution verifies it. Installation does not start the real backlog.

The default campaign targets the 23 children of [Build a polished Mimir coding experience in Studio](https://github.com/wasimysaid/unsloth/issues/233). Feature PRs target `mimir-studio` in the Unsloth fork and the private Mimir repository, never either `main` or upstream Unsloth. GitHub's generic auto-merge setting is not changed.

## Determinism and safety

- Fixed waves, sorted by issue number, at most two workers by default. A wave is persisted before dispatch. Integration is serialized in the same order.
- A dependency is satisfied by a closed-completed issue **and** a verified integration receipt, not a closed/cancelled issue, a model's completion promise, a successful process exit, or an open PR.
- All pages of native sub-issues and native blockers are read. Unknown/error/cyclic dependencies fail closed. Unapproved newly added children are reported, never silently added to the campaign.
- Each attempt has paired isolated worktrees; existing checkout content and main branches are not modified. Worktrees are not a security sandbox. This runner assumes trusted workers operating under the user's native OS/tool policy.
- SQLite and a single-host campaign lock own scheduling. Assignment is the visible claim, not a distributed lease. Running a second coordinator on another machine is unsupported.
- Policy and the runner-side executable are frozen for a campaign. Shared provider credentials are not copied. Native project overrides request GPT-6.1 Sol with xhigh implementation effort and high review effort; missing models never trigger fallback.
- Only the coordinator may commit/push, create/merge PRs, and close tickets. Worker environments exclude inherited GitHub token variables and use an empty GitHub CLI configuration directory. This reduces accidental publication, not filesystem sandboxing.
- JSONL must include a valid `mimir.run.v2` completion and the supervised process must settle successfully. Interaction-required, timeouts, malformed output, and cleanup failures cannot pass.
- Verification is performed by the coordinator, followed by an independent Plan-mode review bound to exact candidate revisions. Existing failed tests cannot be weakened to obtain a pass. Missing required CI contexts block merging.
- Model output is not deterministic. The scheduler and its recorded decisions are deterministic for the same snapshot and wave outcomes.

## Integration and launch

Paired tickets merge the private Mimir PR first, pin its resulting revision in the Studio candidate, reverify the final pair, then merge Studio. Partial transactions stay recorded and block further integration; restart reconciles remote state instead of repeating side effects. Previously integrated Studio remains pinned to its previous runtime meanwhile.

The launcher resolves the current configured integration branch into an owned checkout; it does not use or switch the original checkout's `main`. The feature branch contains `studio/mimir-runtime.lock.json`. Its frontend descriptor is populated by the initial Studio–Mimir integration ticket, not invented by this scheduler. The launch command refuses an incomplete descriptor. Once available it obtains/builds the pinned private runtime and plugin, builds the frontend, and uses the existing backend startup command on localhost. It never vendors private Mimir source into the public fork.

## Human and resource gates

The final implemented-UI review is human work. An operator must provide a review URL tied to the current integrated revisions; a worker may not approve itself. Resource grants are explicit, recorded, and time-bounded; GPU 7 is excluded unless repair is independently confirmed. GPU visibility does not reserve capacity. No new paid services or purchases are authorized by a campaign configuration.

Default limits are two attempts per ticket, a one-hour implementation deadline, a thirty-minute review deadline, and a six-hour invocation budget. No-ready-work distinguishes fully drained from failed, interrupted, resource-blocked, human-blocked, and dependency-blocked. A blocked campaign is not reported as accepted.

Retries preserve work and need explicit operator intent after ambiguity. `resume` resumes the scheduler, not a nonexistent `mimir run --resume` operation. Stop sends native interruption and waits for cleanup. A PID alone never establishes process ownership.

## Evidence and tests

Logs, prompts, source snapshots, traces, native IDs, check results, reviewer records, and PR/merge receipts stay in the campaign storage directory. They may contain private source and credentials in provider error text: do not publish raw traces. Public comments contain only sanitized summaries and receipt references.

```sh
python3 -m unittest discover -s tests/ticket_runner -v
```

Unit/subprocess/fake-GitHub tests are deterministic contract coverage, not real-model proof. The smoke campaign uses separate tickets and disposable feature branches; it must never close production tickets or pass fixture results off as Studio acceptance.

## Versioned acceptance policy

Policy v1 combines the pinned TOML command/evidence profiles with the exact checkbox criteria and A-row mappings in GitHub. At the first apply, **all** approved ticket scopes, dependencies, comments, and parent specification are fingerprinted in SQLite. Material edits stop the active campaign; they do not silently change the work. The worker report must cover each exact criterion once. Typed evidence links each criterion to scoped commands that the controller reruns. Browser evidence needs local artifacts; live evidence additionally needs native workload IDs. An independent reviewer checks whether those artifacts actually establish the claimed category; classification alone is not proof.

| Ticket | Parent acceptance rows | Additional gate |
|---|---|---|
| 234 | A1, A6, A10 | Actual browser driver |
| 235 | A1, A2, A7, A9, A10 | Real provider request |
| 236 | A1, A6, A7, A10 | Reconnect browser scenarios |
| 237 | A2, A7, A10 | Question/answer browser scenarios |
| 238 | A1, A3, A10 | Live/historical diff browser scenarios |
| 239–240 | A2, A7, A10 | Plan/goal browser scenarios |
| 241–242 | A2, A10 | Subagent/input browser scenarios |
| 243 | A2, A7, A10 | Command/context browser scenarios |
| 244–245 | A4, A5, A10 | Model/catalog browser scenarios |
| 246 | A5, A7, A9, A10 | Coordinated GPU + real workload |
| 247 | A1, A6, A7, A10 | Concurrent browser scenarios |
| 248 | A6, A7 | Idle/visibility browser scenarios |
| 249 | A6, A7, A8, A10 | Recovery browser scenarios |
| 250 | A1, A8, A10 | MCP settings browser scenarios |
| 251 | A1, A7, A8, A10 | Apply/reconnect browser scenarios |
| 252 | A1, A8, A10 | Maintenance browser scenarios |
| 253 | A3, A10 | Long-conversation browser scenarios |
| 254 | A1–A9, automated A10 | Full integrated automated suite |
| 255 | A2–A10 using 254's A1 | Coordinated GPU + real route workloads |
| 256 | A10 and final A1–A10 reconciliation | Human approval only |

For a GPU-gated ticket, create a task-owned `gpu-grant.json` in the campaign storage only **after coordinating capacity**. Its fields are `devices` (distinct integers 0–6), `peak_memory_mib` (positive per-device peak), `coordinated_by: "wasimysaid"`, and `expires` (Unix seconds beyond the whole worker deadline). Check current GPU use before the workload. The file is a record of coordination, not a reservation system; device 7 is rejected.

Human completion requires an operator-authored comment on the exact human ticket containing `HUMAN-REVIEW approved studio=<current full SHA> mimir=<current full SHA>` plus the actual review evidence. Then use `approve <issue> --evidence-url <comment URL> --apply`. The runner validates the author, ticket, and exact current revision pair. This never lets an agent approve itself.

A settled unsuccessful attempt can be retried with `retry <issue> --apply`, then `resume --apply`, within the two-attempt budget. Use `retry <issue> --verify --apply` after fixing a local setup/check problem to reuse the existing candidate instead of launching another implementation session. For an interrupted integration, retry creates a new verification/review attempt while preserving merged revisions and prior evidence; it never replays completed merges. Unknown process settlement and scope changes still require reconciliation. A stopped check/review is not a passed check.

## Primary-source research

- [Matt Pocock: Wayfinder](https://github.com/mattpocock/skills/blob/main/skills/engineering/wayfinder/SKILL.md): native blockers, claimed frontier, resolution comments, human decision gates.
- [Matt Pocock: to-tickets](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md): implementation slices, explicit blockers, fresh contexts.
- [Matt's actual Ralph script](https://github.com/mattpocock/ralph-workshop-repo-001/blob/2f36ec7e4d0c86ff76bbfb61b261a9572c50eb3e/plans/afk-claude.sh): useful bounded fresh-context iterations, but agent-selected work/completion rather than deterministic DAG scheduling.
- [OpenAI Symphony specification](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md): reconciliation, concurrency, workspace and retry patterns. Its inspected GitHub adapter leaves blockers empty; it is not a drop-in native-dependency runner.
- Local Mimir source: `crates/mimir-cli/src/headless/args.rs`, `headless/runner.rs`, and `headless/events/records.rs` establish the real CLI, terminal record, interaction-required outcome, and awaited cleanup. The runner uses that existing CLI, not another Studio frontend plugin.
