'use strict';
/* ATELIER client — renderer, brush, loupe, gravity dial, time control, snapshots. */

const W=320, H=192, CH=32, CW=10, CHH=6, HIST=150;
const $ = id => document.getElementById(id);

const simCv=$('sim'), simCtx=simCv.getContext('2d');
const fxCv=$('fx'), fxCtx=fxCv.getContext('2d');
const img=simCtx.createImageData(W,H);
const imgBuf=new Uint8Array(img.data.buffer);

let col=new Uint32Array(W*H), temp=new Int16Array(W*H);
let activeChunks=new Set(), tick=0, paused=false;
let view='material', brush=6, curMat=2, strokeErase=false;
let pointer={x:-1,y:-1,inside:false}, paintQueue=[], paintBusy=false;
let scrubbing=false;
const lastScrub={v:-1, at:0};

/* ---------- decode helpers ---------- */
function b64u8(s){ const bin=atob(s); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; }
const b64u32 = s => new Uint32Array(b64u8(s).buffer);
const b64i16 = s => new Int16Array(b64u8(s).buffer);

/* ---------- thermal LUT ---------- */
const STOPS=[[-50,5,7,12],[20,16,24,44],[80,40,20,80],[150,120,20,110],[300,220,60,20],[600,255,150,30],[900,255,240,190]];
const LUT=new Uint8Array(1051*3);
for(let t=-50;t<=1000;t++){
  let a=STOPS[0], b=STOPS[STOPS.length-1];
  for(let k=0;k<STOPS.length-1;k++) if(t>=STOPS[k][0]&&t<=STOPS[k+1][0]){ a=STOPS[k]; b=STOPS[k+1]; break; }
  const f=(t-a[0])/Math.max(1,b[0]-a[0]), o=(t+50)*3;
  LUT[o]=a[1]+(b[1]-a[1])*f; LUT[o+1]=a[2]+(b[2]-a[2])*f; LUT[o+2]=a[3]+(b[3]-a[3])*f;
}

/* ---------- live state: long-poll transport (proxy-safe) ---------- */
let lastSeq=0;
function applyFrame(d){
  if(scrubbing) return;
  tick=d.t; paused=!!d.paused; $('paused-badge').hidden=!paused;
  if(d.g!==undefined) syncDial(d.g);
  activeChunks=new Set(d.a);
  if(d.full){ col=b64u32(d.c); temp=b64i16(d.p); }
  else if(d.d){
    const arr=b64u32(d.d);
    for(let k=0;k<arr.length;k+=3){
      const i=arr[k]; col[i]=arr[k+1];
      const raw=arr[k+2]; temp[i]=(raw&0xFFFF)-500;
    }
  }
}
function updateStats(d){
  $('st-tick').textContent=d.tick;
  $('st-part').textContent=d.particles.toLocaleString('en-US');
  $('st-chunk').textContent=d.activeChunks+'/'+d.totalChunks;
  $('st-step').textContent=d.stepUs.toFixed(1)+' µs';
  $('st-mem').textContent=d.heapMB.toFixed(1)+' MB';
}
async function pollLoop(){
  for(;;){
    try{
      const d=await (await fetch('api/poll?since='+lastSeq)).json();
      lastSeq=d.seq; if(!d.same) applyFrame(d);
    }catch(e){ await new Promise(r=>setTimeout(r,400)); }
  }
}
pollLoop();
setInterval(async()=>{ try{ updateStats(await (await fetch('api/telemetry.json')).json()); }catch(e){} }, 500);

/* ---------- render loop ---------- */
function frame(){
  if(view==='thermal'){
    for(let i=0;i<W*H;i++){
      const o=Math.max(0,Math.min(1050,temp[i]+50))*3, p=i*4;
      imgBuf[p]=LUT[o]; imgBuf[p+1]=LUT[o+1]; imgBuf[p+2]=LUT[o+2]; imgBuf[p+3]=255;
    }
  } else {
    imgBuf.set(new Uint8Array(col.buffer));
  }
  simCtx.putImageData(img,0,0);
  drawOverlay(); drawReticle(); flushPaint();
  requestAnimationFrame(frame);
}

function drawOverlay(){
  const dpr=devicePixelRatio||1;
  const r=simCv.getBoundingClientRect();
  const w=Math.round(r.width*dpr), h=Math.round(r.height*dpr);
  if(fxCv.width!==w||fxCv.height!==h){ fxCv.width=w; fxCv.height=h; }
  fxCtx.clearRect(0,0,w,h);
  if(view==='chunks'){
    const sx=w/W, sy=h/H;
    for(let cy=0;cy<CHH;cy++) for(let cx=0;cx<CW;cx++){
      const c=cy*CW+cx, on=activeChunks.has(c);
      fxCtx.strokeStyle=on?'rgba(255,68,0,0.30)':'rgba(40,42,46,0.5)';
      fxCtx.lineWidth=1;
      fxCtx.strokeRect(cx*32*sx+0.5, cy*32*sy+0.5, 32*sx-1, 32*sy-1);
      if(on){ fxCtx.fillStyle='rgba(255,68,0,0.75)'; fxCtx.font=`${9*dpr}px IBM Plex Mono`;
        fxCtx.fillText('A', cx*32*sx+4, cy*32*sy+12); }
    }
  }
}

function drawReticle(){
  if(!pointer.inside) return;
  const dpr=devicePixelRatio||1, r=simCv.getBoundingClientRect();
  const sx=r.width/W, cx=(pointer.x+0.5)*sx, cy=(pointer.y+0.5)*(r.height/H), rad=brush*sx;
  fxCtx.strokeStyle='rgba(232,232,226,0.9)'; fxCtx.lineWidth=1*dpr;
  fxCtx.beginPath(); fxCtx.arc(cx*dpr,cy*dpr,Math.max(rad*dpr,2),0,Math.PI*2); fxCtx.stroke();
  fxCtx.fillStyle='rgba(255,68,0,0.9)';
  fxCtx.fillRect(cx*dpr-1,cy*dpr-1,2,2);
}

/* ---------- pointer / painting ---------- */
function toWorld(e){
  const r=simCv.getBoundingClientRect();
  return { x:Math.floor((e.clientX-r.left)/r.width*W), y:Math.floor((e.clientY-r.top)/r.height*H) };
}
simCv.addEventListener('contextmenu',e=>e.preventDefault());
simCv.addEventListener('pointerdown',e=>{
  e.preventDefault(); simCv.setPointerCapture(e.pointerId);
  strokeErase = e.button===2;
  const p=toWorld(e); pointer.x=p.x; pointer.y=p.y; pointer.inside=true;
  paintQueue.push(p);
});
simCv.addEventListener('pointermove',e=>{
  const p=toWorld(e);
  pointer.inside = p.x>=0&&p.x<W&&p.y>=0&&p.y<H;
  pointer.x=p.x; pointer.y=p.y;
  if(e.buttons){ if(pointer.inside) paintQueue.push(p); }
  moveLoupe(e); scheduleInspect();
});
simCv.addEventListener('pointerup',()=>{ strokeErase=false; });
simCv.addEventListener('pointerleave',()=>{ pointer.inside=false; $('loupe').hidden=true; });
simCv.addEventListener('wheel',e=>{
  e.preventDefault();
  const step=brush>=16?2:1;
  brush=Math.max(1,Math.min(64,brush+(e.deltaY<0?step:-step)));
  $('brush').value=brush; $('brush-val').textContent=String(brush).padStart(2,'0');
},{passive:false});
$('brush').addEventListener('input',e=>{ brush=+e.target.value; $('brush-val').textContent=String(brush).padStart(2,'0'); });

function flushPaint(){
  if(!paintQueue.length||paintBusy) return;
  const pts=paintQueue.splice(0,paintQueue.length);
  paintBusy=true;
  fetch('api/paint',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({points:pts,r:brush,mat:curMat,erase:strokeErase})})
    .catch(()=>{}).finally(()=>{ paintBusy=false; });
}

/* ---------- loupe ---------- */
let inspectAt=0;
function scheduleInspect(){
  const now=performance.now();
  if(now-inspectAt<90) return; inspectAt=now;
  if(!pointer.inside){ $('loupe').hidden=true; return; }
  fetch(`api/inspect?x=${pointer.x}&y=${pointer.y}`).then(r=>r.json()).then(d=>{
    if(!d.ok){ $('loupe').hidden=true; return; }
    $('loupe').hidden=false;
    $('lp-mat').textContent=d.name;
    $('lp-temp').textContent=d.temp+' °C';
    $('lp-vel').textContent=`v (${d.vx}, ${d.vy}) px/t`;
    $('lp-chunk').textContent=`CHUNK ${String(d.chunk).padStart(3,'0')} · ${d.active?'ACTIVE':'SLEEPING'} · occ ${d.occupancy}`;
  }).catch(()=>{});
}
function moveLoupe(e){
  const stage=$('stage'), r=stage.getBoundingClientRect(), lp=$('loupe');
  let x=e.clientX-r.left+16, y=e.clientY-r.top+16;
  if(x+170>r.width) x-=190; if(y+90>r.height) y-=110;
  lp.style.left=x+'px'; lp.style.top=y+'px';
}

/* ---------- materials ---------- */
const MATS=[
  {id:1,name:'STONE',c:'#6a6e74'},{id:2,name:'SAND',c:'#d4a442'},{id:3,name:'WATER',c:'#1a64ca'},
  {id:4,name:'OIL',c:'#4c321a'},{id:5,name:'FIRE',c:'#ff5a1f'},{id:6,name:'STEAM',c:'#ccd2da'},
  {id:7,name:'ACID',c:'#f0b800'},{id:8,name:'PLANT',c:'#2f9142'},{id:9,name:'WOOD',c:'#6b4a2b'},
  {id:10,name:'GAS',c:'#6a7076'},{id:-1,name:'ERASE',c:'transparent'},
];
for(const m of MATS){
  const row=document.createElement('div'); row.className='mat'+(m.id===curMat?' sel':''); row.dataset.id=m.id;
  row.innerHTML=`<span class="sw" style="background:${m.c}"></span><span class="mn">${m.name}</span>`;
  row.onclick=()=>{
    document.querySelectorAll('#materials .mat').forEach(el=>el.classList.remove('sel'));
    row.classList.add('sel');
    if(m.id===-1){ strokeErase=true; } else { strokeErase=false; curMat=m.id; }
  };
  $('materials').appendChild(row);
}
$('legend').innerHTML=
  '<b><span class="c-fire">FIRE</span></b> ignites oil · plant · wood<br>'+
  '<b><span class="c-water">WATER</span></b> quenches fire → steam<br>'+
  '<b><span class="c-acid">ACID</span></b> dissolves sand · stone · organics<br>'+
  '<b>PLANT</b> spreads on water contact';

$('btn-clear').onclick=()=>fetch('api/paint',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({points:[{x:W/2,y:H/2}],r:200,mat:0,erase:true})});

/* ---------- view mode ---------- */
document.querySelectorAll('#viewmode button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('#viewmode button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); view=b.dataset.view;
});

/* ---------- gravity dial ---------- */
const ticksG=$('dial-ticks'), labelsG=$('dial-labels');
for(let d=0;d<360;d+=15){
  const major=d%45===0, rad=(d-90)*Math.PI/180;
  const x1=100+Math.cos(rad)*84, y1=100+Math.sin(rad)*84, x2=100+Math.cos(rad)*(major?76:80), y2=100+Math.sin(rad)*(major?76:80);
  const l=document.createElementNS('http://www.w3.org/2000/svg','line');
  l.setAttribute('x1',x1); l.setAttribute('y1',y1); l.setAttribute('x2',x2); l.setAttribute('y2',y2);
  l.setAttribute('stroke',major?'#8a8d91':'#282a2e'); l.setAttribute('stroke-width',major?1.5:1);
  ticksG.appendChild(l);
  if(major){
    const t=document.createElementNS('http://www.w3.org/2000/svg','text');
    const lab={0:'D',90:'R',180:'U',270:'L'}[d];
    t.setAttribute('x',100+Math.cos(rad)*64); t.setAttribute('y',100+Math.sin(rad)*64+3);
    t.setAttribute('text-anchor','middle'); t.setAttribute('fill','#5a5d61');
    t.setAttribute('font-size','9'); t.textContent=lab;
    labelsG.appendChild(t);
  }
}
let dialDragging=false;
function needleSync(deg){
  const theta=(180-deg%360+360)%360;
  $('dial-needle').setAttribute('transform',`rotate(${theta} 100 100)`);
  $('g-deg').textContent=String(Math.round(deg)%360).padStart(3,'0')+'°';
}
function syncDial(deg){ if(!dialDragging) needleSync(deg); }
function dialFromEvent(e){
  const r=$('dial').getBoundingClientRect();
  const dx=e.clientX-(r.left+r.width/2), dy=e.clientY-(r.top+r.height/2);
  return (Math.atan2(dx,dy)*180/Math.PI+360)%360;
}
$('dial').addEventListener('pointerdown',e=>{ dialDragging=true; $('dial').setPointerCapture(e.pointerId); const d=dialFromEvent(e); needleSync(d); sendGravity(d); });
$('dial').addEventListener('pointermove',e=>{ if(!dialDragging) return; const d=dialFromEvent(e); needleSync(d); sendGravity(d); });
$('dial').addEventListener('pointerup',()=>{ dialDragging=false; });
let gravAt=0;
function sendGravity(deg){ const now=performance.now(); if(now-gravAt<50) return; gravAt=now;
  fetch('api/gravity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deg})}).catch(()=>{}); }

/* ---------- time control ---------- */
function setTime(action,value){
  return fetch('api/time',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,value})}).then(r=>r.json());
}
$('btn-pause').onclick=async()=>{ const r=await setTime(paused?'resume':'pause'); paused=r.paused; $('ic-pause').hidden=paused; $('ic-play').hidden=!paused; $('paused-badge').hidden=!paused; };
$('btn-step').onclick=()=>{ setTime('step'); };
document.querySelectorAll('#speedseg button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('#speedseg button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); setTime('speed',+b.dataset.speed);
});
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT') return;
  if(e.code==='Space'){ e.preventDefault(); $('btn-pause').click(); }
  else if(e.key==='s'||e.key==='S'){ setTime('step'); }
  else if(e.key==='1'){ document.querySelector('#viewmode [data-view=material]').click(); }
  else if(e.key==='2'){ document.querySelector('#viewmode [data-view=thermal]').click(); }
  else if(e.key==='3'){ document.querySelector('#viewmode [data-view=chunks]').click(); }
});

/* ---------- timeline scrub ---------- */
$('timeline').max=HIST-1;
$('timeline').addEventListener('input',e=>{
  const v=+e.target.value;
  if(v===0){ scrubbing=false; $('tl-label').textContent='LIVE'; return; }
  scrubbing=true; paused=true; $('paused-badge').hidden=false; $('ic-pause').hidden=true; $('ic-play').hidden=false;
  const now=performance.now();
  if(now-lastScrub.at<120) return; lastScrub.at=now; lastScrub.v=v;
  $('tl-label').textContent='T−'+v;
  fetch('api/frames?offset='+v).then(r=>r.json()).then(d=>{
    if(d.ok){ col=b64u32(d.c); temp=b64i16(d.p); }
  }).catch(()=>{});
});

/* ---------- snapshots ---------- */
async function refreshSnaps(){
  const list=await fetch('api/snapshots').then(r=>r.json());
  const bps=list.filter(s=>s.name.startsWith('Blueprint')), snaps=list.filter(s=>!s.name.startsWith('Blueprint'));
  const fmt=ts=>new Date(ts).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
  const row=s=>`<div class="snap-item"><span class="sn">${s.name}</span><span class="st mono">${fmt(s.ts)}</span>`+
    `<button data-load="${s.id}">LOAD</button></div>`;
  $('blueprints').innerHTML=bps.map(row).join('')||'<div class="snap-item"><span class="sn">—</span></div>';
  $('snapshots').innerHTML=snaps.map(row).join('')||'<div class="snap-item"><span class="sn">no snapshots yet</span></div>';
  document.querySelectorAll('[data-load]').forEach(b=>b.onclick=async()=>{
    await fetch(`api/snapshots/${b.dataset.load}/load`,{method:'POST'});
    const st=await fetch('api/state').then(r=>r.json());
    col=b64u32(st.c); temp=b64i16(st.p); tick=st.tick; scrubbing=false; $('timeline').value=0; $('tl-label').textContent='LIVE';
  });
}
$('btn-save').onclick=async()=>{
  await fetch('api/snapshots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('snap-name').value})});
  $('snap-name').value=''; refreshSnaps();
};

/* ---------- boot ---------- */
fetch('api/state').then(r=>r.json()).then(st=>{
  col=b64u32(st.c); temp=b64i16(st.p); tick=st.tick; paused=st.paused; needleSync(st.gravityDeg);
  $('ic-pause').hidden=paused; $('ic-play').hidden=!paused; $('paused-badge').hidden=!paused;
  requestAnimationFrame(frame); refreshSnaps();
});
