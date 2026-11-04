"""Attach to the released Windows Tauri app, not a browser stand-in."""
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
import playwright_typing_diagnostic as harness

harness.CURRENT_VERSION = 'v0.1.914-beta-native'
harness.SIZES = [1, 500]
harness.RATES = [1, 4]
results = []
with sync_playwright() as pw:
    for gpu in ['auto', 'off']:
        config = Path(os.environ['APPDATA']) / 'ai.unsloth.studio'
        config.mkdir(parents=True, exist_ok=True)
        (config / 'gpu-rendering-v1').write_text(gpu, encoding='utf-8')
        env = dict(os.environ, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222', UNSLOTH_DISABLE_UPDATE_CHECK='1')
        app = subprocess.Popen([os.environ['APP_EXE']], env=env)
        browser = None
        try:
            for _ in range(180):
                if app.poll() is not None:
                    raise RuntimeError(f'Desktop exited: {app.returncode}')
                try:
                    with urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=1) as response:
                        version = json.load(response)
                    break
                except Exception:
                    time.sleep(1)
            else:
                raise RuntimeError('WebView2 debugging endpoint did not start')
            browser = pw.chromium.connect_over_cdp('http://127.0.0.1:9222')
            context = browser.contexts[0]
            for _ in range(180):
                pages = [p for p in context.pages if 'tauri.localhost' in p.url or p.url.startswith('tauri:')]
                if pages:
                    page = pages[0]
                    break
                time.sleep(1)
            else:
                raise RuntimeError('No Tauri main window found')
            page.set_default_timeout(60000)
            page.set_viewport_size(dict(width=1440, height=900))
            page.locator('textarea[aria-label="Message input"]').wait_for(timeout=180000)
            assert page.evaluate("'__TAURI_INTERNALS__' in window"), 'Not the native Tauri app'
            # Learn the actual server chosen by Tauri from its completed local API requests.
            api_url = page.evaluate("performance.getEntriesByType('resource').map(x=>x.name).find(x=>/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/api\\//.test(x))")
            if not api_url:
                raise RuntimeError('No managed backend URL observed')
            u = urlsplit(api_url)
            harness.API_BASE = f'{u.scheme}://{u.netloc}'
            u = urlsplit(page.url)
            harness.BASE = f'{u.scheme}://{u.netloc}'
            harness.seed(page)
            cdp = context.new_cdp_session(page)
            cdp.send('Performance.enable')
            info = dict(gpuSetting=gpu,webview2=version.get('Browser'),native=True)
            for motion in ['off', 'on']:
                harness.set_motion_ui(page, motion)
                for rate in harness.RATES:
                    for turns in harness.SIZES:
                        row = harness.measure(page, cdp, turns, rate, motion, False)
                        row.update(info)
                        results.append(row)
                        print(json.dumps(row), flush=True)
                        (harness.OUT/'native-results.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
                page.screenshot(path=str(harness.OUT/f'native-gpu-{gpu}-motion-{motion}.png'))
        except Exception:
            if browser and 'page' in locals():
                try:
                    page.screenshot(path=str(harness.OUT/f'native-failure-{gpu}.png'))
                    (harness.OUT/f'native-failure-{gpu}.txt').write_text(page.locator('body').inner_text(),encoding='utf-8')
                except Exception:
                    pass
            raise
        finally:
            if browser:
                browser.close()
            subprocess.run(['taskkill', '/PID', str(app.pid), '/T', '/F'], capture_output=True)
            time.sleep(3)
