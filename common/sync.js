/* Guarda notas, palabras y respuestas en el servidor (Cloudflare) para que se vean
   igual en todos los dispositivos. Si el servidor no responde, todo sigue
   funcionando con la memoria del navegador (localStorage) y se envía más tarde. */
function makeStore(student){
  const P = student + ":", API = "/" + student + "/api";
  const lsGet = k => { try{ return localStorage.getItem(P+k); }catch(e){ return null; } };
  const lsSet = (k,v) => { try{ localStorage.setItem(P+k, v); }catch(e){} };
  const meta = k => "__" + k;
  const dirty = {}, inflight = {}, known = {}, listeners = [];
  let online = false, cursor = 0, flushT = null, pollT = null, busy = false, polling = false, fails = 0;

  try{ JSON.parse(lsGet(meta("dirty")) || "[]").forEach(k=>{ const v = lsGet(k); if(v!==null) dirty[k] = v; }); }catch(e){}
  const saveDirty = () => lsSet(meta("dirty"), JSON.stringify([...new Set([...Object.keys(dirty), ...Object.keys(inflight)])]));
  const emit = keys => { if(keys.length) listeners.forEach(fn=>{ try{ fn(keys); }catch(e){ console.error(e); } }); };
  const status = s => { document.documentElement.dataset.sync = s; };

  const merge = (k, local, remote) => {
    if(!local || local===remote) return remote;
    if(!remote) return local;
    if(k==="notas") return remote.includes(local) ? remote : local.includes(remote) ? local : remote.replace(/\s+$/,"") + "\n\n" + local;
    if(/:words$/.test(k)){
      try{
        const a = JSON.parse(remote), b = JSON.parse(local), id = w => w.id || String(w.term||"").trim().toLowerCase();
        const seen = new Set(a.map(id));
        return JSON.stringify([...a, ...b.filter(w=>!seen.has(id(w)))]);
      }catch(e){ return remote; }
    }
    return remote;
  };

  async function get(since){
    const r = await fetch(API + "?since=" + since, { credentials:"same-origin", redirect:"manual", cache:"no-store" });
    if(!r.ok) throw new Error("sync " + r.status);
    return r.json();
  }

  async function flush(keepalive){
    clearTimeout(flushT); flushT = null;
    if(!online || busy || !Object.keys(dirty).length) return;
    busy = true;
    const batch = Object.assign({}, dirty);
    Object.keys(batch).forEach(k=>{ inflight[k] = batch[k]; delete dirty[k]; });
    try{
      const r = await fetch(API, { method:"POST", credentials:"same-origin", redirect:"manual", keepalive: !!keepalive,
        headers:{ "content-type":"application/json" }, body: JSON.stringify({ set: batch }) });
      if(!r.ok) throw new Error("sync " + r.status);
      const { ts } = await r.json();
      Object.keys(batch).forEach(k=>{ known[k] = ts; delete inflight[k]; });
      fails = 0; status("on");
    }catch(e){
      Object.keys(batch).forEach(k=>{ if(!(k in dirty)) dirty[k] = batch[k]; delete inflight[k]; });
      fails++; status("off");
    }
    busy = false; saveDirty();
    if(Object.keys(dirty).length) flushT = setTimeout(flush, fails ? Math.min(30000, 2000*fails) : 300);
  }
  const schedule = () => { saveDirty(); if(!flushT) flushT = setTimeout(flush, 700); };

  async function start(){
    try{
      const data = await get(0), first = !lsGet(meta("synced")), changed = [], remote = {};
      data.items.forEach(it=>{
        remote[it.k] = it.v; known[it.k] = it.ts;
        if(it.k in dirty) return;
        const local = lsGet(it.k), v = first ? merge(it.k, local, it.v) : it.v;
        if(v !== it.v) dirty[it.k] = v;
        if(v !== local){ lsSet(it.k, v); changed.push(it.k); }
      });
      if(first){
        try{
          for(let i=0; i<localStorage.length; i++){
            const full = localStorage.key(i);
            if(!full || !full.startsWith(P) || full.startsWith(P+"__")) continue;
            const k = full.slice(P.length), v = localStorage.getItem(full);
            if(!(k in remote) && v) dirty[k] = v;
          }
        }catch(e){}
        lsSet(meta("synced"), "1");
      }
      cursor = data.now - 10000; online = true; fails = 0; status("on");
      emit(changed); flush(); poll();
    }catch(e){
      status("off");
      setTimeout(start, 60000);
    }
  }

  async function poll(){
    if(polling) return;
    clearTimeout(pollT); polling = true;
    if(document.visibilityState === "visible"){
      try{
        const data = await get(cursor), changed = [];
        data.items.forEach(it=>{
          if((known[it.k]||0) >= it.ts) return;
          known[it.k] = it.ts;
          if(it.k in dirty || it.k in inflight) return;
          if(lsGet(it.k) !== it.v){ lsSet(it.k, it.v); changed.push(it.k); }
        });
        cursor = Math.max(cursor, data.now - 10000); fails = 0; status("on");
        emit(changed);
      }catch(e){ fails++; status("off"); }
    }
    polling = false;
    pollT = setTimeout(poll, fails ? Math.min(60000, 5000*fails) : 4000);
  }

  document.addEventListener("visibilitychange", ()=>{
    if(!online) return;
    if(document.visibilityState === "visible") poll(); else flush(true);
  });
  window.addEventListener("pagehide", ()=>{ if(online) flush(true); });
  start();

  return {
    get: lsGet,
    set(k, v){ v = String(v); if(lsGet(k) === v && !(k in dirty)) return; lsSet(k, v); dirty[k] = v; schedule(); },
    onRemote(fn){ listeners.push(fn); }
  };
}
