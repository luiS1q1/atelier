'use strict';
/* ATELIER server — zero-dependency Node HTTP: static frontend, SSE world stream,
   SSE telemetry, paint/gravity/time control, binary snapshots. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Engine, MAT, MAT_NAMES, W, H, N, NCHUNKS, CW, CHH } = require('./engine');
const blueprints = require('./blueprints');

const PORT = process.env.PORT ? parseInt(process.env.port || process.env.PORT, 10) : 8787;
const PUBLIC = path.join(__dirname, '..', 'public');
const DATA = path.join(__dirname, '..', 'data', 'snapshots');

const BASE = (process.env.BASE_PATH || '').replace(/\/$/, '');
const engine = new Engine((Math.random()*1e9)|0);
let paused = false, speed = 1, acc = 0;

fs.mkdirSync(DATA, { recursive: true });
const INDEX_FILE = path.join(DATA, 'index.json');
function readIndex(){ try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return []; } }
function writeIndex(ix){ fs.writeFileSync(INDEX_FILE, JSON.stringify(ix, null, 2)); }

function saveSnapshot(name, eng){
  const id = crypto.randomBytes(6).toString('hex');
  const raw = eng.pack();
  fs.writeFileSync(path.join(DATA, id + '.bin'), zlib.deflateSync(raw, { level: 8 }));
  const ix = readIndex();
  ix.push({ id, name, ts: Date.now(), size: raw.length, tick: eng.tickCount });
  writeIndex(ix);
  return { id, name };
}
function loadSnapshot(id){
  const file = path.join(DATA, id + '.bin');
  const raw = zlib.inflateSync(fs.readFileSync(file));
  const e = Engine.unpack(raw);
  engine.mat.set(e.mat); engine.temp.set(e.temp); engine.life.set(e.life); engine.noise.set(e.noise);
  engine._s = e._s; engine.tickCount = e.tickCount;
  engine.setGravity(e.gravityDeg); engine.recolorAll(); engine.wakeAll();
  engine.history.length = 0;
}

// seed the three blueprints once
if (readIndex().filter(s => s.name.startsWith('Blueprint')).length < 3){
  const bp = [['Blueprint · Volcano', blueprints.volcano()], ['Blueprint · Hydro-Dam Failure', blueprints.hydroDam()], ['Blueprint · Chemical Reaction Cascade', blueprints.cascade()]];
  for (const [name, e] of bp) saveSnapshot(name, e);
}

// a freshly booted cell should not greet you with a black void: load the volcano
{
  const c0 = engine.counts(); let p0 = 0; for (let m=1;m<11;m++) p0 += c0[m];
  if (p0 === 0){
    const vol = readIndex().find(s => s.name === 'Blueprint · Volcano');
    if (vol){ try { loadSnapshot(vol.id); lastSentMat.set(engine.mat); lastSentTemp.set(engine.temp); } catch {} }
  }
}

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };

function b64(u32){ return Buffer.from(u32.buffer, u32.byteOffset, u32.byteLength).toString('base64'); }
function unb64(s){ return new Uint32Array(new Uint8Array(Buffer.from(s, 'base64')).buffer); }

let lastSentMat = engine.mat.slice(), lastSentTemp = engine.temp.slice();

function buildDiff(){
  const changed = [];
  for (let i=0;i<N;i++){
    if (engine.mat[i] !== lastSentMat[i] || engine.temp[i] !== lastSentTemp[i]) changed.push(i);
  }
  let payload;
  if (changed.length > N*0.35){
    payload = { full: true, c: b64(engine.color), p: b64(engine.temp) };
    lastSentMat.set(engine.mat); lastSentTemp.set(engine.temp);
  } else if (changed.length){
    const arr = new Uint32Array(changed.length*3);
    let k=0;
    for (const i of changed){ arr[k++]=i; arr[k++]=engine.color[i]; arr[k++]=((engine.mat[i]<<16)|((engine.temp[i]+500)&0xFFFF))>>>0; }
    payload = { d: b64(arr) };
    for (const i of changed){ lastSentMat[i]=engine.mat[i]; lastSentTemp[i]=engine.temp[i]; }
  }
  return payload;
}

const streamClients = new Set();
const teleClients = new Set();

function sseInit(res){
  res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive' });
  res.write(':ok\n\n');
}

function tickWorld(){
  if (paused) return;
  acc += speed;
  let steps = 0;
  while (acc >= 1 && steps < 8){ engine.step(1); acc -= 1; steps++; }
}

setInterval(() => {
  tickWorld();
  if (streamClients.size){
    const d = buildDiff();
    if (d){
      const active = [];
      for (let c=0;c<NCHUNKS;c++) if (engine.active[c]) active.push(c);
      const msg = `data: ${JSON.stringify({ t: engine.tickCount, g: engine.gravityDeg, a: active, ...d })}\n\n`;
      for (const res of streamClients){ try { res.write(msg); } catch { streamClients.delete(res); } }
    }
  }
}, 16);

setInterval(() => {
  if (!teleClients.size) return;
  const counts = engine.counts();
  let particles = 0; for (let m=1;m<11;m++) particles += counts[m];
  let activeN = 0; for (let c=0;c<NCHUNKS;c++) if (engine.active[c]) activeN++;
  const mem = process.memoryUsage();
  const msg = `data: ${JSON.stringify({
    tick: engine.tickCount, particles, activeChunks: activeN, totalChunks: NCHUNKS,
    stepUs: Math.round(engine.lastStepUs*10)/10, paused,
    heapMB: Math.round(mem.heapUsed/1048576*10)/10,
    rssMB: Math.round(mem.rss/1048576*10)/10,
    counts: Array.from(counts.slice(1,11)),
  })}\n\n`;
  for (const res of teleClients){ try { res.write(msg); } catch { teleClients.delete(res); } }
}, 500);

function json(res, code, obj){ res.writeHead(code, { 'Content-Type':'application/json' }); res.end(JSON.stringify(obj)); }
function body(req){ return new Promise((resolve) => { let b=''; req.on('data', c => b+=c); req.on('end', () => { try { resolve(JSON.parse(b||'{}')); } catch { resolve({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  if (BASE){
    if (p === BASE){ res.writeHead(301, { Location: BASE + '/' }); return res.end(); }
    if (p.startsWith(BASE + '/')) p = p.slice(BASE.length) || '/';
  }

  if (p === '/api/stream'){ streamClients.add(res); sseInit(res); req.on('close', () => streamClients.delete(res)); return; }
  if (p === '/api/telemetry'){ teleClients.add(res); sseInit(res); req.on('close', () => teleClients.delete(res)); return; }

  if (p === '/api/state'){
    return json(res, 200, { w: W, h: H, tick: engine.tickCount, gravityDeg: engine.gravityDeg, paused, speed,
      c: b64(engine.color), p: b64(engine.temp) });
  }
  if (p === '/api/paint' && req.method === 'POST'){
    const b = await body(req);
    const m = b.erase ? MAT.EMPTY : (MAT_NAMES[b.mat] !== undefined ? b.mat : MAT.EMPTY);
    for (const pt of (b.points||[])) engine.paint(pt.x|0, pt.y|0, b.r|0, m, !!b.erase);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/gravity' && req.method === 'POST'){
    const b = await body(req); engine.setGravity(Number(b.deg)||0);
    lastSentMat.fill(255); // force full resend so thermal/latents stay consistent
    return json(res, 200, { ok: true, deg: engine.gravityDeg });
  }
  if (p === '/api/time' && req.method === 'POST'){
    const b = await body(req);
    if (b.action === 'pause') paused = true;
    else if (b.action === 'resume'){ paused = false; }
    else if (b.action === 'step'){ engine.step(1); }
    else if (b.action === 'speed'){ speed = Math.max(0.1, Math.min(4, Number(b.value)||1)); }
    return json(res, 200, { ok: true, paused, speed });
  }
  if (p === '/api/frames'){
    const back = Math.max(0, parseInt(u.searchParams.get('offset')||'0', 10));
    const f = engine.seek(back);
    if (!f) return json(res, 200, { ok: false });
    lastSentMat.set(engine.mat); lastSentTemp.set(engine.temp);
    return json(res, 200, { ok: true, t: f.t, c: b64(engine.color), p: b64(engine.temp) });
  }
  if (p === '/api/inspect'){
    const x = parseInt(u.searchParams.get('x')||'-1',10), y = parseInt(u.searchParams.get('y')||'-1',10);
    if (x<0||x>=W||y<0||y>=H) return json(res, 200, { ok: false });
    const i = y*W+x, c = engine.chunkOf(i);
    const cx = (c % CW)*32, cy = ((c/CW)|0)*32;
    let occ=0; for (let dy=0;dy<32;dy++) for (let dx=0;dx<32;dx++) if (engine.mat[(cy+dy)*W + cx+dx]) occ++;
    return json(res, 200, { ok: true, mat: engine.mat[i], name: MAT_NAMES[engine.mat[i]], temp: engine.temp[i],
      vx: engine.vx[i], vy: engine.vy[i], chunk: c, active: !!engine.active[c], occupancy: occ });
  }
  if (p === '/api/snapshots' && req.method === 'POST'){
    const b = await body(req);
    const name = String(b.name||'').slice(0, 60) || ('Snapshot ' + new Date().toISOString().slice(0,16));
    return json(res, 200, saveSnapshot(name, engine));
  }
  if (p === '/api/snapshots' && req.method === 'GET'){
    return json(res, 200, readIndex().sort((a,b)=>b.ts-a.ts));
  }
  let m = p.match(/^\/api\/snapshots\/([0-9a-f]+)\/load$/);
  if (m && req.method === 'POST'){ try { loadSnapshot(m[1]); return json(res, 200, { ok: true }); } catch (e){ return json(res, 500, { ok:false, error:String(e) }); } }
  m = p.match(/^\/api\/snapshots\/([0-9a-f]+)$/);
  if (m && req.method === 'GET'){
    try { const raw = zlib.inflateSync(fs.readFileSync(path.join(DATA, m[1]+'.bin')));
      res.writeHead(200, { 'Content-Type':'application/octet-stream', 'Content-Length': raw.length }); return res.end(raw);
    } catch { return json(res, 404, { ok:false }); }
  }
  if (p === '/api/materials'){ return json(res, 200, MAT_NAMES.map((n,i)=>({ id:i, name:n }))); }

  // static
  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const fp = path.join(PUBLIC, file);
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const data = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    return res.end(data);
  } catch { res.writeHead(404); return res.end('not found'); }
});

server.listen(PORT, () => console.log(`ATELIER listening on http://localhost:${PORT}`));
