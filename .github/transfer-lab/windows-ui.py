import json, subprocess, time, urllib.request
from pywinauto import Desktop
def running(version):
    args=subprocess.check_output(['powershell','-NoProfile','-Command','Get-CimInstance Win32_Process -Filter "Name=\'msedgewebview2.exe\'" | Select-Object -Expand CommandLine'],text=True,errors='replace')
    return '--webview-exe-version='+version in args and '--webview-exe-name=unsloth-studio.exe' in args
def verify(version,count):
    for _ in range(count):
        if running(version):
            print('Verified running version',version,flush=True);return
        time.sleep(3)
    raise RuntimeError('Version was not observed: '+version)
def select(names,seconds,optional=False):
    end=time.monotonic()+seconds
    previous=''
    while time.monotonic()<end:
        wins=[w for w in Desktop(backend='uia').windows() if 'unsloth' in w.window_text().lower()]
        cs=[c for w in wins for c in w.descendants() if c.is_visible()]
        labels=[(c.element_info.control_type,c.window_text().strip()) for c in cs]
        snap=str([(t,n[:120]) for t,n in labels if n][-60:])
        if snap!=previous: print(snap,flush=True); previous=snap
        for name in names:
            for c,(t,n) in zip(cs,labels):
                if n.casefold()==name.casefold() and t in ('CheckBox','Button','Hyperlink','TabItem','MenuItem') and c.is_enabled():
                    if t=='CheckBox': c.toggle()
                    else:
                        try: c.invoke()
                        except Exception: c.click_input()
                    print('Selected',n,flush=True);time.sleep(2);return n
        time.sleep(4)
    if not optional: raise RuntimeError('Could not select '+str(names))
verify('0.1.9100-beta',25)
select(['Chat only (GGUF): smaller install, no training'],25,True)
select(['Get Started'],110)
button=select(['Settings','Unsloth account menu'],900)
if button!='Settings': select(['Settings'],45)
url='https://github.com/wasimysaid/desktop-updater-transfer-lab/releases/latest/download/latest.json'
for i in range(120):
    try:
        with urllib.request.urlopen(url,timeout=15) as resp: current=json.load(resp)['version']
        if current=='0.1.9101-beta': break
    except OSError: pass
    time.sleep(15)
else: raise RuntimeError('B not published')
select(['Check for updates','Check again'],45,True)
select(['Update now','Install update','Update Unsloth','Update','Update app'],100)
verify('0.1.9101-beta',160)
