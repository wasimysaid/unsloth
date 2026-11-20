import ctypes
import os
from pathlib import Path
import subprocess
import sys
import time
from ctypes import wintypes

user = ctypes.windll.user32
callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

def dialog(process):
    windows = []
    @callback
    def visit(hwnd, _):
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == process.pid:
            windows.append(hwnd)
        return True
    user.EnumWindows(visit, 0)
    for hwnd in windows:
        labels = []
        @callback
        def child(control, _):
            buf = ctypes.create_unicode_buffer(2048)
            user.SendMessageW(control, 13, len(buf), ctypes.byref(buf))
            labels.append((control, buf.value))
            return True
        user.EnumChildWindows(hwnd, child, 0)
        for control, label in labels:
            if "version of Unsloth" in label:
                print("dialog controls", labels, flush=True)
                time.sleep(0.3)
                from PIL import ImageGrab
                screenshot = ImageGrab.grab(window=hwnd)
                assert screenshot.convert("L").getextrema()[0] < 100
                screenshot.save(f"windows-{host}.png")
                user.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
                return label

source = Path("studio/src-tauri/windows/installer.nsi").read_text()
startup = source[source.index("Function .onInit"):source.index('  ${GetOptions} $CMDLINE "/NS"')]
compiler = Path(os.environ["LOCALAPPDATA"]) / "tauri/NSIS/makensis.exe"
host = sys.argv[1]
for target in ["x64", "arm64"]:
    exe = Path(f"probe-{target}.exe").resolve()
    script = Path("probe.nsi")
    script.write_text(f"""Unicode true
RequestExecutionLevel user
Name "Unsloth"
OutFile "{exe}"
!include FileFunc.nsh
!include x64.nsh
!define ARCH "{target}"
Var PassiveMode
{startup}
  SetErrorLevel 42
  Quit
FunctionEnd
Section
SectionEnd
""")
    subprocess.run([compiler, "/V2", script], check=True)
    for args in [["/S"], ["/P"], []]:
        proc = subprocess.Popen([exe, *args])
        try:
            if target != host and not args:
                expected = 'Choose "Windows (ARM64)"' if host == "arm64" else 'Choose "Download for Windows"' 
                for _ in range(100):
                    msg = dialog(proc)
                    if msg:
                        print(msg, flush=True)
                        assert f"You downloaded the {target.replace('arm64', 'ARM64')} version of Unsloth, but your machine is {host.replace('arm64', 'ARM64')}." in msg
                        assert expected in msg and "https://unsloth.ai/download/windows" in msg
                        break
                    time.sleep(0.1)
                else:
                    proc.kill()
                    raise RuntimeError("Missing guidance")
            try:
                result = proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                raise
            print(host, target, args, result, flush=True)
            assert result == (42 if host == target else 1633)
        finally:
            proc.kill()
            proc.wait()
