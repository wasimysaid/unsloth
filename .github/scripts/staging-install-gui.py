import ctypes as c
from ctypes import wintypes as w
import hashlib
from pathlib import Path
import os
import subprocess
import time
from PIL import ImageGrab

user = c.windll.user32
user.SetProcessDPIAware()
callback = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)

def windows(parent=None):
    found = []
    @callback
    def add(hwnd, _):
        found.append(hwnd)
        return True
    if parent:
        user.EnumChildWindows(parent, add, 0)
    else:
        user.EnumWindows(add, 0)
    return found

def title(hwnd):
    buf = c.create_unicode_buffer(2048)
    user.SendMessageTimeoutW(hwnd, 13, len(buf), c.byref(buf), 2, 500, None)
    return buf.value

def get_gui(pid):
    for hwnd in windows():
        owner = w.DWORD()
        user.GetWindowThreadProcessId(hwnd, c.byref(owner))
        if owner.value == pid and user.IsWindowVisible(hwnd) and "Unsloth" in title(hwnd):
            return hwnd

def screenshot(hwnd, name):
    time.sleep(0.4)
    snap = ImageGrab.grab(window=hwnd)
    assert snap.width >= 400 and len(snap.convert('L').getcolors()) > 16
    snap.save(Path("evidence") / f"{os.environ['RUNNER_ARCH']}-{name}.png")

launcher = Path("combined.exe").resolve()
print("Universal installer SHA256", hashlib.file_digest(open(launcher,"rb"),"sha256").hexdigest(), flush=True)
dest = Path(os.environ["RUNNER_TEMP"]) / "Unsloth installation test"
arch = os.environ["RUNNER_ARCH"].lower()
Path("evidence").mkdir(exist_ok=True)
proc = subprocess.Popen(f'"{launcher}" /D={dest}')
deadline = time.monotonic()+100
last = None
while time.monotonic() < deadline:
    if proc.poll() is not None:
        raise RuntimeError(f"Setup exited early: {proc.returncode}")
    if not last:
        result = subprocess.run(["powershell","-NoProfile","-Command",f"(Get-Process -Name setup-{arch} -ErrorAction SilentlyContinue).Id"],capture_output=True,text=True)
        if not result.stdout.strip():
            time.sleep(.3)
            continue
        hwnd = get_gui(int(result.stdout.strip()))
        if not hwnd:
            continue
    controls = [(h,title(h).replace('&','')) for h in windows(hwnd) if user.IsWindowVisible(h)]
    if not last:
        print("Welcome:",controls,flush=True)
        if not any(label.startswith("Next") for _,label in controls):
            time.sleep(.2)
            continue
        screenshot(hwnd,"welcome")
        last = "welcome"
    button = user.GetDlgItem(hwnd,1)
    label = title(button).replace('&','').strip()
    if user.IsWindowEnabled(button) and label in ('Finish','Close') and (dest/'unsloth-studio.exe').is_file():
        print("Finish:",controls,flush=True)
        for h,label in controls:
            if label.startswith(('Run ', 'Launch ')) and user.SendMessageW(h,0xf0,0,0) == 1:
                user.SendMessageW(h,0xf1,0,0)
        screenshot(hwnd,"installed")
        for _ in range(30):
            if proc.poll() is not None:
                break
            if user.IsWindowVisible(hwnd) and user.IsWindowEnabled(hwnd):
                user.PostMessageW(hwnd, 0x0111, 1, button)
            time.sleep(1)
        if proc.poll() is None:
            print("Open windows:", [(h,title(h)) for h in windows() if user.IsWindowVisible(h)], flush=True)
        if proc.wait(timeout=5): raise RuntimeError("Installer returned failure")
        break
    if label.startswith(('Next','Install','I Agree')) and user.IsWindowEnabled(button):
        print("Click",label,flush=True)
        user.PostMessageW(button,0xf5,0,0)
    time.sleep(.7)
else:
    raise RuntimeError(f"Installer failed to finish: {controls}")
