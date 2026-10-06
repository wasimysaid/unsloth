# Fork desktop releases with pinned source backends

This is an opt-in mode on `wasimysaid/unsloth`'s dedicated
`release/desktop-source-backend` branch. It does **not** change the upstream
release flow, and it is not `install.sh --local` / `install.ps1 --local` (those
require a development checkout and Windows checks for `pyproject.toml`).
The branch records upstream zoo commit `286e49527fb50cf32e6a0632373239a87c0cb565`
(observed upstream HEAD at this branch refresh); the workflow requires an
explicit full SHA value and records the actual selected SHA in each release bundle.

For a future authorized release, create the desktop release tag on the fork as
usual, then **explicitly** dispatch `.github/workflows/release-desktop.yml`
against the branch, not the tag or main. For example, after separately
verifying the tag and the immutable zoo commit:

```sh
gh workflow run release-desktop.yml --repo wasimysaid/unsloth \
  --ref release/desktop-source-backend \
  -f studio_version=v0.1.52-beta -f source_backend=true \
  -f zoo_sha=286e49527fb50cf32e6a0632373239a87c0cb565 \
  -f draft=true
```
If the source tag's `unsloth` package version differs from its
`MIN_DESKTOP_BACKEND_VERSION`, also supply `-f pypi_version=<tag-package-version>`;
in source mode this input is an expected **wheel version**, not a PyPI download.
A mismatched wheel version fails the build before signing.

**Do not run this command just to prepare the branch.** The normal release
procedure controls draft/publishing, signing approvals and tag creation. In
source mode the workflow checks out the branch for installer/Tauri code, checks
out the named release tag separately for the unsloth wheel and checks out the
exact zoo SHA for its wheel. It records the two source SHAs and wheel SHA-256s
in the bundled `source-backend/manifest.json`. Each build matrix leg builds its
own pure-Python wheels and verifies the bundle before signing; the consumer
verifies both checksums before installing either core package. No live git
checkout or mutable `main` is resolved on the consumer. Wheels are package
source builds, not editable installs. Dependencies other than the two core
packages continue to follow the usual platform installer.

A production app whose bundle has this manifest selects the pinned wheel pair
for both first install/repair and in-app `studio update`, including no-torch
updates. A missing/invalid source bundle fails rather than falling back to
PyPI. The source bundle lives in the app's Tauri resources and therefore follows
app updates; keep later app updates on this fork's source-backed channel. The
normal release (source_backend=false, the default) continues to use the tagged
code and normal PyPI backend semantics; manually using `--local` still uses the
checkout and the existing zoo git route. Do not dispatch this workflow or
publish a release as part of branch preparation.
