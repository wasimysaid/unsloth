const invoke = (name) => `window.__TAURI__.core.invoke(${JSON.stringify(name)})`;
const cmd = process.argv[2];
const targets = await fetch("http://localhost:19424/json/list").then(r=>r.json());
const page = targets.find(t=>t.type==="page" && /tauri\.localhost/.test(t.url));
if(!page) throw Error("No desktop webview: "+JSON.stringify(targets.map(t=>[t.type,t.url])));
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
const response = new Promise((resolve,reject)=>{
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1)resolve(m);};
 ws.onclose=()=>reject(Error("Webview closed"));
});
ws.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression:invoke(cmd),awaitPromise:true,returnByValue:true}}));
try {
 const m=await response;
 if(m.error||m.result?.exceptionDetails) throw Error(JSON.stringify(m));
 console.log(JSON.stringify(m.result.result.value??null));
} finally {ws.close();}
