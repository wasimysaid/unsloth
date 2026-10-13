# Ticket 252: real Settings browser acceptance

Run from the Studio repository root **after** the paired native executable,
`studio.frontend` package, and production frontend have been rebuilt with ticket
252. This uses the existing actual coding-route driver; no GPU is used.

```sh
.venv/bin/python -m unittest discover -s studio/tools -p 'test_coding_browser_acceptance.py' -v
.venv/bin/python -m py_compile studio/tools/coding_browser_acceptance.py studio/tools/coding_extension_scenarios.py studio/tools/test_coding_browser_acceptance.py
.venv/bin/python studio/tools/coding_browser_acceptance.py \
  --mimir /absolute/path/to/current/mimir \
  --plugin-package /absolute/path/to/current/studio-frontend-package \
  --extensions --workload deterministic --browser firefox \
  --evidence-dir /mnt/disks/unslothai/mugi/mimir-ticket-runner/studio-233/attempts/252/1/worker/browser-252
```

Use a fresh evidence directory per attempt. Instead of supplying built artifacts,
`--mimir-source /absolute/path/to/paired/mimir` builds both before starting (native
build timeout 1200 seconds; plugin build timeout 1000 seconds). Firefox Playwright
must be installed in this Python environment; Chromium also works via
`--browser chromium --chrome /usr/bin/google-chrome`. Backend acceptance app
requirements are unchanged. A complete driver run should receive a 600-second
outer timeout with prebuilt artifacts; individual browser/native checks have
60-second deadlines. `--extensions` rejects opening/live workloads so it cannot
install fixtures into a shared provider/credential profile.

The extension scenarios run after first-ID reopening with a second conversation
already owned, before the existing real-native execution suite. They cover:

- The actual Mimir Settings button opens the existing Settings modal and shows the
  exact target; effective native HOME skill discovery and disabled skill policy.
- Native-installed disabled/headless-ineligible packages remain distinct from
  enabled/selected/live. Fixture packages reuse the real product component bytes,
  are installed/prelinked with native CLI, and must never activate in headless.
- Keyboard view/inventory refresh issues no reload POST. Exact first-session
  reload preserves second-session reload state and runtime frontend `mount_id`
  plus supervised process identity. Before the idle reload, task-owned disabled
  installed package metadata changes from 0.1.0 to 0.2.0; acknowledgment must
  automatically GET actual inventory and display 0.2.0 without manual refresh.
  This is read freshness evidence, not an activation change caused by reload.
- Both sessions have real native requests held at the external ProviderFixture;
  first-session reload is Deferred/Not applied yet until real provider completion
  and GET confirms the same operation Applied. The second held request remains
  Running with its original ID and later actually completes.
- A browser-only inventory GET connection fault exposes stale/error text, disables
  reload, preserves the previous inventory, and recovers through real GET.
- Delayed POST acknowledgment is forwarded unchanged from real `route.fetch()`
  only after Settings selects the second target. The detached reply must settle
  the original first target, leave second-target status untouched, and not retry.
- Lost POST response is injected **after** `route.fetch()` reaches the real native
  backend. Unconfirmed/disabled reload survive A→B→A and actual Settings tab/modal
  remounts while inventory reads are faulted. All first-target GETs retain the
  original UUID; real exact-ID reconciliation enables reload without another POST.
  No native result/status is fabricated; delayed-response `route.fulfill` forwards
  the actual APIResponse unchanged, whereas lost-response injection aborts it.
- Desktop 1440x1000 and narrow 390x844 screenshots, keyboard action focus, target
  changes/no-target explanation, document overflow check and Escape dismissal.
  Desktop closure restores Mimir Settings. Desktop→narrow resize and opening from
  the mobile sidebar sheet restore the surviving Toggle coding sidebar button,
  not the unmounted Settings opener. Captures still require pixel inspection.
- Known-ID diagnostics, inventory and reload endpoints reject unauthenticated
  requests alongside the existing coding endpoints.

`report.json` retains raw native inventories, operation UUIDs/statuses, request
identities, frontend/native/UI fingerprints, source revisions, transport fault
provenance, screenshots, errors and cleanup facts. Fixture credentials are not
written into evidence. Deterministic provider success is **not** real-model
acceptance; native reload failures need the separate native tests. Browser
transport fault injection is explicitly distinct from native failure testing.
