# SPDX-License-Identifier: AGPL-3.0-only
"""Native icon integrity and platform isolation (no local Design folder required)."""

import hashlib
import json
import struct
import re
import unittest
from pathlib import Path

TAURI = Path(__file__).resolve().parents[2] / "studio/src-tauri"


class DesktopIconTests(unittest.TestCase):
    def config(self, platform=None):
        config = json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
        if platform:
            override = json.loads((TAURI / f"tauri.{platform}.conf.json").read_text(encoding="utf-8"))
            def merge(base, patch):
                for key, value in patch.items():
                    if isinstance(value, dict) and isinstance(base.get(key), dict):
                        merge(base[key], value)
                    else:
                        base[key] = value

            merge(config, override)
        return config

    def test_tauri_stack_contains_windows_icon_fixes(self):
        # tauri-apps/tauri #15241 and #15274 first ship together in this stack.
        # Release runners may expose Python 3.9, which predates stdlib tomllib.
        packages = re.findall(r'\[\[package\]\]\s+name = "([^"]+)"\s+version = "([^"]+)"',
                              (TAURI / "Cargo.lock").read_text(encoding="utf-8"))
        versions = {name: tuple(map(int, version.split("."))) for name, version in packages if name in {
            "tauri", "tauri-codegen", "tauri-build", "tauri-macros", "tauri-runtime-wry",
        }}
        for name, minimum in {
            "tauri": (2, 12, 0), "tauri-codegen": (2, 7, 0),
            "tauri-build": (2, 7, 0), "tauri-macros": (2, 7, 0),
            "tauri-runtime-wry": (2, 12, 0),
        }.items():
            with self.subTest(package=name):
                self.assertGreaterEqual(versions[name], minimum)
        studio = TAURI.parent
        cli = json.loads((studio / "package.json").read_text(encoding="utf-8"))["devDependencies"]["@tauri-apps/cli"]
        cli_lock = json.loads((studio / "package-lock.json").read_text(encoding="utf-8"))
        self.assertEqual(cli, "2.12.0")
        self.assertEqual(cli_lock["packages"]["node_modules/@tauri-apps/cli"]["version"], cli)
        workflow = (studio.parent / ".github/workflows/release-desktop.yml").read_text(encoding="utf-8")
        self.assertIn(f'if [ "$out" != "tauri-cli {cli}" ]; then', workflow)
        # COM Interface/HSTRING must come from the same windows-core as WebView2.
        manifest = (TAURI / "Cargo.toml").read_text(encoding="utf-8")
        self.assertIn('webview2-com = "0.39.1"', manifest)
        self.assertIn('windows-core = "0.62.2"', manifest)


    def test_supplied_assets_are_unmodified(self):
        # SHA-256 of the designer's originals, not regenerated/resized images.
        expected = {
            "32x32.png": "908b71cd54669a88ad6559c9325aa28e7517fea14f71b07a42bd597318758952",
            "128x128.png": "9274f7e007422b1de4066167c960f548a9bf0651ed7b421cb4a918bfcc26c503",
            "128x128@2x.png": "e3eed82d6c2f0802c588e0e419a32fb1d558aa8bb508caa5fc8e8151c532e6b1",
            "icon.png": "9cc5a39c109d588fa9d1f57562cf8f49926f611fe490d9863787be3a0011a61b",
            "icon.ico": "2cb4995d79005aeb1a62eb66e20e8d27817772a865fb363343375a40ad08fbfe",
            "linux/16x16.png": "b61159c19a7ec8c5cc0f5d51ba72f968569ad1778f0988a8723829f843ddf5ce",
            "linux/22x22.png": "93097997606ccc085aa0081046a868bb046e20ade901f8f4e538ad191d2ab72a",
            "linux/24x24.png": "785dbb08ab468db67dc9958f2edf8550553857bc388a2091a2b40a31397029ea",
            "linux/32x32.png": "908b71cd54669a88ad6559c9325aa28e7517fea14f71b07a42bd597318758952",
            "linux/48x48.png": "439ee16198b9e28741787e348604a97b21a3edf39f333c51888fae4bec3af7c9",
            "linux/64x64.png": "4319bb0f45b1a5e73aa72b7922478ce9d8221bf92e4cfa593844c3578677d68c",
            "linux/96x96.png": "bb2ef84b4aa6ff574102c39d1e580d529fc26b731fffa6541356ac67e031b83d",
            "linux/128x128.png": "9274f7e007422b1de4066167c960f548a9bf0651ed7b421cb4a918bfcc26c503",
            "linux/256x256.png": "e3eed82d6c2f0802c588e0e419a32fb1d558aa8bb508caa5fc8e8151c532e6b1",
            "linux/512x512.png": "ab9caf2566f3bb98c38cb69595566a4ae50b59639ed258be5b9e68b337bd1f92",
        }
        for name, digest in expected.items():
            with self.subTest(name=name):
                self.assertEqual(hashlib.sha256((TAURI / "icons" / name).read_bytes()).hexdigest(), digest)

    def test_macos_and_existing_color_tray_icons_remain_unchanged(self):
        preserved = {
            "legacy-tray/windows.ico": "70d9f70d9891d5745147486c8908abe79480f78996153e91cee2385903506b64",
            "legacy-tray/windows.png": "791d080e9e7d2f3bf2164bdbeea7ba416b7f9e6c4c06e892ade72b06563fd0fc",
            "legacy-tray/linux.png": "791d080e9e7d2f3bf2164bdbeea7ba416b7f9e6c4c06e892ade72b06563fd0fc",
            "macos/32x32.png": "791d080e9e7d2f3bf2164bdbeea7ba416b7f9e6c4c06e892ade72b06563fd0fc",
            "macos/128x128.png": "216dcc4b8b6113bbf93b9483d039188965c01b398020d184dd89fd75cb1b1eed",
            "icon.icns": "6d4887812a19e536981f4c1e58b4248d73889b2f176284d3b533e6fefa1de919",
            "tray-icon.png": "674c28314aa7420468f4cdbb3ef11f7221ae73df876cb72b25ca434c09e1b96a",
            "tray-icon@2x.png": "7fd387bb458e46b97e177071f3d200790637caab21a2b0ed8f10ab8877b2844e",
            "tray-icon-dark.png": "e285c66288dd7b5000312ed06ff76b2c994d9e54587d213cc273664d21806e34",
            "tray-icon-light.png": "e8af3f3d4bf319d95177805c7dfacd605d4b1ecbc65a3a83b6c042436a1b0b93",
        }
        for name, digest in preserved.items():
            with self.subTest(name=name):
                self.assertEqual(hashlib.sha256((TAURI / "icons" / name).read_bytes()).hexdigest(), digest)
        self.assertEqual(self.config("macos")["bundle"]["icon"], [
            "icons/macos/32x32.png", "icons/macos/128x128.png", "icons/icon.icns",
        ])

    def test_bundle_uses_full_resolution_and_all_linux_sizes(self):
        for platform, size in [("windows", 1024), ("linux", 512)]:
            icons = self.config(platform)["bundle"]["icon"]
            for name in icons:
                self.assertTrue((TAURI / name).is_file(), name)
            first_png = next(name for name in icons if name.endswith(".png"))
            data = (TAURI / first_png).read_bytes()
            self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack(">II", data[16:24]), (size, size))
        linux_icons = set(self.config("linux")["bundle"]["icon"])
        self.assertEqual(linux_icons, {f"icons/linux/{size}x{size}.png" for size in [16, 22, 24, 32, 48, 64, 96, 128, 256, 512]})
        self.assertEqual(self.config("windows")["bundle"]["windows"]["nsis"]["installerIcon"], "./icons/icon.ico")

    def test_trays_use_platform_specific_originals(self):
        source = (TAURI / "src/main.rs").read_text(encoding="utf-8")
        for platform, image in [
            ("macos", "tray-icon@2x.png"),
            ("windows", "legacy-tray/windows.png"),
            ("linux", "legacy-tray/linux.png"),
        ]:
            self.assertIn(f'#[cfg(target_os = "{platform}")]\n    let tray_icon = tauri::include_image!("./icons/{image}");', source)
        self.assertNotIn("let tray_icon = app.default_window_icon()", source)


if __name__ == "__main__":
    unittest.main()
