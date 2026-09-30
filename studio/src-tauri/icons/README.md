# Desktop icons

These Windows/Linux assets are copied byte-for-byte from the supplied `Design`
export. Do not run `tauri icon` over them or resize/re-encode them during builds.

- Root PNGs and `icon.ico`: `Design/TAURI`. The ICO already contains the Windows
  icon sizes; the installer and application both use it directly.
- `linux/*.png`: `Design/LINUX`. The Linux bundle lists every supplied raster
  size, with 512 px first for the native window icon.
- `legacy-tray/windows.ico` and `legacy-tray/linux.png`: preserved original
  Windows ICO and 32 px Linux window PNG, which previously supplied the trays.
  All supplied tray exports are monochrome, so Windows/Linux retain their
  existing colored tray artwork, independent of the updated application icons.
  Tauri decodes these original files into RGBA without application-side resizing.
- `icon.icns`, root `tray-icon*.png`, and `macos/*.png`: **preserved old assets**.
  The macOS config overrides the shared icon list so neither its Dock icon nor
  its tray artwork changes. The macOS appearance observer is unchanged.

PNG compression is lossless. Bundle/archive compression does not reduce image
quality, so it need not be disabled. The operating system may scale icons to
match its tray/window dimensions or display DPI; these assets do not prevent
that OS behavior. No new lossy compression or image-generation step is added.

`python tests/studio/test_desktop_icons.py` checks original SHA-256 hashes,
macOS preservation, bundle sizes, and platform-specific tray references.
