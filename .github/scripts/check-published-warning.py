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
            if "different processor" in label:
                print("dialog controls", labels, flush=True)
                time.sleep(0.3)
                from PIL import ImageGrab
                screenshot = ImageGrab.grab(window=hwnd)
                assert screenshot.convert("L").getextrema()[0] < 100
                screenshot.save(f"windows-{host}.png")
                user.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
                return label

host = os.environ["RUNNER_ARCH"]
proc = subprocess.Popen([Path(sys.argv[1]).resolve()])
try:
    for _ in range(160):
        if proc.poll() is not None:
            raise RuntimeError(f"Unexpected early exit: {proc.returncode}")
        msg = dialog(proc)
        if msg:
            assert "download Unsloth-Desktop-Windows.exe" in msg
            assert "https://unsloth.ai/download/windows" in msg
            assert proc.wait(timeout=20) == 1633
            break
        time.sleep(0.25)
    else:
        raise RuntimeError("Missing interactive warning")
finally:
    proc.kill()
    proc.wait()
