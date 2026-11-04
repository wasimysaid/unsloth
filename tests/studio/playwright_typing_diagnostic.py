"""One-off release comparison: real saved chats, production frontend, no inference."""
import json
import os
import platform
import secrets
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('PW_ART_DIR', ROOT / 'logs/typing-diagnostic')).resolve()
OUT.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:8899')
API_BASE = ''
PASSWORD = os.environ.get('DIAGNOSTIC_PASSWORD') or secrets.token_urlsafe(24)
SIZES = [int(x) for x in os.environ.get('TYPING_SIZES', '1,200,500').split(',')]
RATES = [int(x) for x in os.environ.get('TYPING_RATES', '1,4').split(',')]
TYPED = 'The quick brown fox types a new question.'


def seed(page):
    for turns in SIZES:
        ident = f'typing-repro-{turns}'
        now = int(time.time()*1000)
        thread = dict(id=ident, title=f'Typing reproduction {turns} turns', modelType='base', modelId='', createdAt=now, updatedAt=now)
        messages = []
        for i in range(turns):
            user, assistant = f'{ident}-u{i}', f'{ident}-a{i}'
            messages.append(dict(id=user, threadId=ident, parentId=f'{ident}-a{i-1}' if i else None, role='user', content=[dict(type='text', text=f'Turn {i+1}: Explain this implementation, tradeoffs, and test cases.')], createdAt=now+i*2000))
            answer = f'## Analysis {i+1}\n\n' + ('This is a representative response with **formatted text**, a useful explanation, and details about the implementation. The interface should remain responsive while reading and writing messages.\n\n')*8 + '\n```python\ndef example(value):\n    return [item * 2 for item in range(value)]\n```\n\n| Case | Result |\n| --- | --- |\n| Small | Works |\n| Large | Check performance |\n'
            messages.append(dict(id=assistant, threadId=ident, parentId=user, role='assistant', content=[dict(type='text', text=answer)], metadata={}, createdAt=now+i*2000+1000))
        page.evaluate('''async ({thread,messages,apiBase})=>{
          const headers={'Content-Type':'application/json',Authorization:`Bearer ${localStorage.getItem('unsloth_auth_token')}`};
          for(const [url,method,body] of [['/api/chat/threads','POST',thread],[`/api/chat/threads/${thread.id}/messages`,'PUT',{messages}]]) {
            const r=await fetch(apiBase+url,{method,headers,body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());
          }
        }''', dict(thread=thread,messages=messages,apiBase=API_BASE))


def set_motion_ui(page, value):
    print('Setting motion '+value,flush=True)
    page.get_by_role('button',name='Settings',exact=True).click()
    page.get_by_role('button',name='Appearance',exact=True).click()
    label=page.get_by_text('Reduce motion',exact=True)
    row=page.locator('[data-settings-label="Reduce motion"]')
    row.get_by_role('button',name=value.capitalize(),exact=True).click()
    assert row.get_by_role('button',name=value.capitalize(),exact=True).get_attribute('aria-pressed')=='true'
    assert page.evaluate("document.documentElement.classList.contains('force-reduced-motion')") == (value=='on')
    page.screenshot(path=str(OUT/f'{CURRENT_VERSION}-motion-{value}.png'))
    page.keyboard.press('Escape')
    page.wait_for_timeout(1500)


def measure(page, cdp, turns, rate, motion, nav):
    cdp.send('Emulation.setCPUThrottlingRate',dict(rate=1))
    page.evaluate('''nav=>{const k='unsloth_chat_preferences';const p=JSON.parse(localStorage.getItem(k)||'{"state":{},"version":1}');p.state.showTurnNavigation=nav;localStorage.setItem(k,JSON.stringify(p));}''',nav)
    page.goto(f'{BASE}/chat?thread=typing-repro-{turns}')
    box=page.locator('textarea[aria-label="Message input"]')
    box.wait_for(timeout=120000)
    page.get_by_text(f'Turn {turns}: Explain this implementation, tradeoffs, and test cases.',exact=True).wait_for(timeout=120000)
    # Wait for progressive mounting to settle before starting the timer.
    previous=None;stable=0
    for _ in range(60):
        count=page.locator('*').count()
        stable=stable+1 if count==previous else 0
        previous=count
        if stable>=4:break
        page.wait_for_timeout(500)
    assert stable>=4, 'DOM did not settle'
    assert page.evaluate("document.documentElement.classList.contains('force-reduced-motion')") == (motion=='on')
    box.fill('');box.focus();page.wait_for_timeout(250)
    cdp.send('Emulation.setCPUThrottlingRate',dict(rate=rate))
    page.evaluate('''()=>{
      window.__typing={keys:[],long:[]}; const s=window.__typing;
      document.querySelector('textarea[aria-label="Message input"]').addEventListener('keydown',()=>{const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>s.keys.push(performance.now()-t)));});
      s.obs=new PerformanceObserver(l=>s.long.push(...l.getEntries().map(e=>e.duration)));s.obs.observe({type:'longtask'});
    }''')
    before={m['name']:m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
    start=time.perf_counter()
    box.press_sequentially(TYPED,delay=30)
    elapsed=(time.perf_counter()-start)*1000
    page.wait_for_timeout(300)
    assert box.input_value()==TYPED
    result=page.evaluate('''()=>{const s=window.__typing;s.obs.disconnect();const q=(a,p)=>{const b=[...a].sort((a,b)=>a-b);return b[Math.min(b.length-1,Math.floor(p*b.length))]||0;};return {keys:s.keys.length,paintMedian:q(s.keys,.5),paintP95:q(s.keys,.95),paintMax:q(s.keys,1),longTasks:s.long.length,longTaskMax:q(s.long,1),domNodes:document.querySelectorAll('*').length,motionClass:document.documentElement.classList.contains('force-reduced-motion')};}''')
    after={m['name']:m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
    result.update(version=CURRENT_VERSION,turns=turns,rate=rate,motion=motion,nav=nav,elapsed=elapsed,domSettled=True,metrics={k:after[k]-before[k] for k in ['LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration']})
    cdp.send('Emulation.setCPUThrottlingRate',dict(rate=1))
    return result


def wait_server(proc):
    for _ in range(120):
        if proc.poll() is not None:raise RuntimeError('Studio server exited; see server log')
        try:
            with urllib.request.urlopen(BASE+'/api/liveness',timeout=2) as r:
                if r.status==200:return
        except Exception:time.sleep(1)
    raise RuntimeError('Studio did not start')


def main():
    global CURRENT_VERSION
    results=[]
    versions=os.environ.get('TYPING_VERSIONS','v0.1.913-beta,v0.1.914-beta').split(',')
    with sync_playwright() as pw:
        options=dict(headless=True)
        if os.environ.get('PW_EXECUTABLE'):options['executable_path']=os.environ['PW_EXECUTABLE']
        elif os.name=='nt':options['channel']='msedge'
        for CURRENT_VERSION in versions:
            proc=None
            log=None
            try:
                if not os.environ.get('BASE_URL'):
                    env=dict(os.environ,UNSLOTH_STUDIO_HOME=str(OUT/'studio-home'),UNSLOTH_STUDIO_PASSWORD=PASSWORD,UNSLOTH_DISABLE_UPDATE_CHECK='1')
                    log=open(OUT/f'{CURRENT_VERSION}-server.log','w',encoding='utf-8')
                    dist=ROOT/'temp'/'typing-versions'/CURRENT_VERSION/'studio'/'frontend'/'dist'
                    proc=subprocess.Popen([os.environ['STUDIO_PYTHON'],str(ROOT/'studio/backend/run.py'),'--port','8899','--frontend',str(dist)],env=env,stdout=log,stderr=subprocess.STDOUT)
                    wait_server(proc)
                browser=pw.chromium.launch(**options)
                context=browser.new_context(viewport=dict(width=1440,height=900))
                page=context.new_page();page.set_default_timeout(30000)
                errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                page.goto(BASE)
                page.get_by_role('textbox',name='Password',exact=True).fill(PASSWORD)
                page.get_by_role('button',name='Login',exact=True).click()
                page.locator('textarea[aria-label="Message input"]').wait_for()
                seed(page)
                cdp=context.new_cdp_session(page);cdp.send('Performance.enable')
                for motion in ['off','on']:
                    set_motion_ui(page,motion)
                    for rate in RATES:
                        for turns in SIZES:
                            result=measure(page,cdp,turns,rate,motion,False)
                            results.append(result);print(json.dumps(result),flush=True)
                            (OUT/'results.json').write_text(json.dumps(dict(platform=platform.platform(),browser=browser.version,results=results,pageErrors=errors),indent=2),encoding='utf-8')
                    result=measure(page,cdp,max(SIZES),max(RATES),motion,True)
                    results.append(result);print(json.dumps(result),flush=True)
                    (OUT/'results.json').write_text(json.dumps(dict(platform=platform.platform(),browser=browser.version,results=results,pageErrors=errors),indent=2),encoding='utf-8')
                page.screenshot(path=str(OUT/f'{CURRENT_VERSION}-long-chat.png'))
                browser.close()
            finally:
                if proc:
                    proc.terminate()
                    try:proc.wait(timeout=15)
                    except subprocess.TimeoutExpired:proc.kill();proc.wait()
                if log:log.close()

if __name__ == "__main__":
    main()
