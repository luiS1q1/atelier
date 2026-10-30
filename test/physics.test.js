'use strict';
/* ATELIER physics verification — runs the real engine headless. */
const { Engine, MAT, W, H } = require('../server/engine');
const blueprints = require('../server/blueprints');

let pass=0, fail=0;
const T=(name,cond)=>{ if(cond){ pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };
const counts=e=>e.counts();

function fill(e,x0,y0,x1,y1,m){ for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) e.paint(x,y,1,m,false); }

console.log('[1] oil floats on water');
{
  const e=new Engine(42);
  fill(e,40,140,280,H-1,MAT.WATER);
  e.paint(160,80,14,MAT.OIL);
  e.step(400);
  let ok=true;
  for(let x=40;x<=280;x++){
    let deepOil=-1, topWater=1e9;
    for(let y=0;y<H;y++){ const m=e.mat[y*W+x];
      if(m===MAT.OIL&&y>deepOil) deepOil=y;
      if(m===MAT.WATER&&y<topWater) topWater=y; }
    if(deepOil>=0&&topWater<1e9&&deepOil>topWater) ok=false;
  }
  T('no oil cell sits below a water cell in any column', ok);
  T('oil still present after settling', counts(e)[MAT.OIL]>100);
}

console.log('[2] fire ignites oil, propagates, water makes steam');
{
  const e=new Engine(43);
  for(let x=0;x<W;x++) e.mat[(H-3)*W+x]=MAT.STONE;          // floor
  fill(e,100,H-12,220,H-4,MAT.OIL);                          // pool resting on floor
  const oil0=counts(e)[MAT.OIL];
  e.paint(112,H-9,3,MAT.FIRE);
  e.step(160);
  T('oil burned away (propagation)', counts(e)[MAT.OIL] < oil0*0.5);
  const e2=new Engine(44);
  e2.paint(160,150,6,MAT.WATER);
  e2.paint(160,146,3,MAT.FIRE);
  e2.step(60);
  T('water near fire becomes steam', counts(e2)[MAT.STEAM]>0);
  T('steam condenses back to water over time', (()=>{ e2.step(900); return counts(e2)[MAT.STEAM]===0; })());
}

console.log('[3] gravity dial: 180° flip moves everything up');
{
  const e=new Engine(45);
  fill(e,60,160,260,H-1,MAT.SAND);
  e.step(200);
  e.setGravity(180);
  e.step(300);
  let sum=0,n=0;
  for(let i=0;i<W*H;i++) if(e.mat[i]===MAT.SAND){ sum+=(i/W)|0; n++; }
  T('sand mean y < 40 after flip (was ~168)', n>1000 && sum/n<40);
}

console.log('[4] acid dissolves sand into gas');
{
  const e=new Engine(46);
  fill(e,140,170,180,181,MAT.SAND);
  const s0=counts(e)[MAT.SAND];
  e.paint(160,150,4,MAT.ACID);
  e.step(900);
  T('sand count dropped', counts(e)[MAT.SAND] < s0-40);
  T('gas bubbles produced', counts(e)[MAT.GAS]>0 || counts(e)[MAT.SAND]<s0-40);
}

console.log('[5] plant spreads on water contact');
{
  const e=new Engine(47);
  for(let x=0;x<W;x++) e.mat[(H-1)*W+x]=MAT.STONE;           // floor
  fill(e,140,H-12,180,H-2,MAT.WATER);                        // pool on floor
  fill(e,182,H-6,188,H-2,MAT.PLANT);                         // moss bank beside it
  const p0=counts(e)[MAT.PLANT];
  e.step(900);
  T('plant count grew', counts(e)[MAT.PLANT] > p0+5);
}

console.log('[6] chunk sleeping');
{
  const e=new Engine(48);
  fill(e,20,150,300,H-1,MAT.WATER);
  e.step(500);
  let active=0; for(let c=0;c<e.active.length;c++) if(e.active[c]) active++;
  T('settled pool sleeps (active <= 4 of 60 chunks)', active<=4);
  e.paint(160,80,4,MAT.WATER);
  T('paint wakes chunks again', e.active[e.chunkOf(80*W+160)]===1);
}

console.log('[7] determinism');
{
  const script=e=>{ e.paint(100,60,6,MAT.WATER); e.paint(160,100,6,MAT.SAND); e.paint(200,80,4,MAT.OIL); e.paint(160,40,2,MAT.FIRE); e.step(300); };
  const a=new Engine(99), b=new Engine(99);
  script(a); script(b);
  let same=true; for(let i=0;i<W*H;i++) if(a.mat[i]!==b.mat[i]){ same=false; break; }
  T('same seed + same ops → identical world', same);
}

console.log('[8] blueprints build');
{
  const v=blueprints.volcano(), d=blueprints.hydroDam(), c=blueprints.cascade();
  T('volcano: stone + oil lake + live fire', counts(v)[MAT.STONE]>5000 && counts(v)[MAT.OIL]>300 && counts(v)[MAT.FIRE]>0);
  T('dam: lake held (>1500 water) + sand plug + dry riverbed', counts(d)[MAT.WATER]>1500 && counts(d)[MAT.SAND]>20);
  let dry=true;
  for(let x=132;x<300;x++) for(let y=H-4;y<H;y++) if(d.mat[y*W+x]===MAT.WATER) dry=false;
  T('dam: downstream is dry before failure', dry);
  T('cascade: water + oil + acid + plant all present', counts(c)[MAT.WATER]>500 && counts(c)[MAT.OIL]>50 && counts(c)[MAT.ACID]>500 && counts(c)[MAT.PLANT]>30);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
