# Desktop icons

These Windows/Linux assets are copied byte-for-byte from the supplied `Design`
export. Do not run `tauri icon` over them or resize/re-encode them during builds.

- Root PNGs and `icon.ico`: `Design/TAURI`. The ICO already contains the Windows
  icon sizes; the installer and application both use it directly.
- `linux/*.png`: `Design/LINUX`. The Linux bundle lists every supplied raster
  size, with 512 px first for the native window icon.
- `legacy-tray/windows.ico`: preserved original Windows ICO for provenance.
  `legacy-tray/windows.png` and `legacy-tray/linux.png` preserve the old 32 px tray
  pixels. The Windows PNG is a byte-for-byte copy of the preserved Linux PNG;
  its decoded RGBA was verified identical to the old Windows ICO's first entry.
  Explicit PNG loading prevents upgraded codegen's largest-ICO selection from
  silently changing the Windows tray. All supplied tray exports are monochrome,
  so Windows/Linux retain their existing colored tray artwork.
- `icon.icns`, root `tray-icon*.png`, and `macos/*.png`: **preserved old assets**.
  The macOS config overrides the shared icon list so neither its Dock icon nor
  its tray artwork changes. The macOS appearance observer is unchanged.

## Windows runtime selection

Tauri 2.12.0/codegen 2.7.0 include upstream fixes
[#15274](https://github.com/tauri-apps/tauri/pull/15274) (load the default window
icon from executable resources at the system icon size) and
[#15241](https://github.com/tauri-apps/tauri/pull/15241) (select the largest ICO
entry for explicit image embedding). Older codegen embedded only the ICO's
first 32 px layer even though all six layers remained intact in the executable.
The supplied ICO stays unchanged: no directory reordering or regeneration.


PNG compression is lossless. Bundle/archive compression does not reduce image
quality, so it need not be disabled. The operating system may scale icons to
match its tray/window dimensions or display DPI; these assets do not prevent
that OS behavior. No new lossy compression or image-generation step is added.

`python tests/studio/test_desktop_icons.py` checks original SHA-256 hashes,
macOS preservation, bundle sizes, and platform-specific tray references.
