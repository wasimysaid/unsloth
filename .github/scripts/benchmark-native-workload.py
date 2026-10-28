"""Drive real Tauri IPC in an isolated home; collect native support diagnostics."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import signal
import statistics
import subprocess
import sys
import time

repo = pathlib.Path(os.environ.get("BENCH_REPO", str(pathlib.Path(__file__).resolve().parents[2])))
sys.path.insert(0, str(repo / "tests/studio"))
import appimage_model_download_webdriver as fixture

parser = argparse.ArgumentParser()
parser.add_argument("--binary", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--phase", choices=["train", "eval"], default="eval")
parser.add_argument("--reps", type=int, default=8)
args = parser.parse_args()
binary = pathlib.Path(args.binary).resolve()
out = pathlib.Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
fixture.ART_DIR = out
home = out / "home"
runtime = out / "runtime"
for folder in [home, runtime, home/".config", home/".cache", home/".local/share", home/".local/state"]:
    folder.mkdir(parents=True, exist_ok=True)
runtime.chmod(0o700)
fixture._write_backend_fixture(home, out/"backend-requests.jsonl")
env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home/".config"),
           XDG_DATA_HOME=str(home/".local/share"), XDG_CACHE_HOME=str(home/".cache"),
           XDG_STATE_HOME=str(home/".local/state"), XDG_RUNTIME_DIR=str(runtime),
           WEBKIT_DISABLE_DMABUF_RENDERER="1", LIBGL_ALWAYS_SOFTWARE="1",
           GALLIUM_DRIVER="llvmpipe", NO_AT_BRIDGE="1")
port, native_port = fixture._free_port(), fixture._free_port()
base = f"http://127.0.0.1:{port}"
log = (out/"driver.log").open("w")
driver = subprocess.Popen([os.environ.get("BENCH_TAURI_DRIVER", shutil.which("tauri-driver") or "/round2/bin/tauri-driver"), "--port", str(port),
                           "--native-port", str(native_port), "--native-driver", "/usr/bin/WebKitWebDriver"],
                          env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
session = None
app_pid = None
try:
    for _ in range(100):
        try:
            fixture._request(base,"GET","/status",timeout=1)
            break
        except Exception:
            if driver.poll() is not None:
                raise RuntimeError("WebDriver stopped")
            time.sleep(.1)
    start = time.monotonic()
    created = fixture._request(base,"POST","/session",{"capabilities":{"alwaysMatch":{
        "browserName":"wry","tauri:options":{"application":str(binary)}}}},timeout=60)
    session = created["value"]["sessionId"]
    fixture._request(base,"POST",f"/session/{session}/timeouts",{"script":180000})
    fixture._wait_for(base,session,"return !!document.querySelector('button[aria-label=Settings]')", "desktop authentication",timeout=60)
    ready_ms = (time.monotonic()-start)*1000
    for entry in pathlib.Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                if (entry/"exe").resolve() == binary:
                    app_pid = int(entry.name)
                    break
            except OSError:
                pass
    def cpu_ticks():
        if not app_pid:
            return None
        # Fields after the final ')' begin at process-state field 3.
        tail = pathlib.Path(f"/proc/{app_pid}/stat").read_text().rsplit(")",1)[1].split()
        return int(tail[11])+int(tail[12])
    before = cpu_ticks()
    reps = args.reps
    script = r"""
    const done=arguments[arguments.length-1];
    (async()=>{
      const results=[];
      const secret='sk-benchonlyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      for(const count of COUNTS) {
        const lines=Array.from({length:count},(_,i)=> {
          const n=i+SEED;
          if(n%4===0)return `INFO file=/home/bench/cache/model-${n}.bin progress=${n%100} message=ready `+'healthy '.repeat(12);
          if(n%4===1)return `WARNING Authorization: Bearer ${secret} proxy=https://user:pass@proxy.invalid/${n}`;
          if(n%4===2)return `api_key=${secret} url=https://bench.invalid/path?token=${secret} `+'message=portable-runtime-🌍-Δ '.repeat(6);
          return `line=${n} token=${secret} error=connection-timeout path=C:\\Users\\bench\\.unsloth\\studio\\cache `+'retry '.repeat(15);
        });
        const snapshot={status:'ready',flow:'benchmark',lastUiLogLines:lines};
        const timings=[];
        for(let i=0;i<REPETITIONS+2;i++) {
          const t=performance.now();
          const report=await window.__TAURI__.core.invoke('collect_support_diagnostics',{snapshot});
          const ms=performance.now()-t;
          if(typeof report!=='string'||!report.includes('Unsloth Support Diagnostics')||
             report.includes(secret)||!report.includes('<redacted'))throw new Error('diagnostic correctness failed');
          if(i>=2)timings.push(ms);
        }
        results.push({lines:count,timings_ms:timings});
      }
      return {results};
    })().then(done).catch(error=>done({error:String(error)}));
    """.replace("REPETITIONS",str(reps)).replace("COUNTS", "[20,100,400,1000]" if args.phase == "train" else "[60,900]").replace("SEED", "1337" if args.phase == "train" else "923")
    result = fixture._request(base,"POST",f"/session/{session}/execute/async",{"script":script,"args":[]},timeout=200)["value"]
    if result.get("error"):
        raise RuntimeError(result["error"])
    after = cpu_ticks()
    result.update(ready_ms=ready_ms,app_pid=app_pid,phase=args.phase,
                  binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                  native_cpu_ms=(after-before)*1000/os.sysconf("SC_CLK_TCK") if before is not None else None)
    for item in result["results"]:
        item["median_ms"] = statistics.median(item["timings_ms"])
    (out/"result.json").write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
finally:
    # SIGTERM uses the app's graceful quit path and allows LLVM to flush profiles.
    if app_pid:
        try: os.kill(app_pid, signal.SIGTERM)
        except ProcessLookupError: pass
        deadline=time.monotonic()+10
        while pathlib.Path(f"/proc/{app_pid}").exists() and time.monotonic()<deadline:time.sleep(.1)
    if session:
        try: fixture._request(base,"DELETE",f"/session/{session}",timeout=5)
        except Exception: pass
    if driver.poll() is None:
        os.killpg(driver.pid,signal.SIGTERM)
        try: driver.wait(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(driver.pid,signal.SIGKILL)
            driver.wait()
    log.close()
