'use strict';
/* ATELIER core — deterministic, chunk-scheduled falling-sand/fluid engine.
   Typed arrays only (Uint8/Int16/Uint32), zero dependencies, server-authoritative. */

const W = 320, H = 192, N = W * H;
const CH = 32, CW = W / CH, CHH = H / CH, NCHUNKS = CW * CHH;
const AMBIENT = 20;

const MAT = { EMPTY:0, STONE:1, SAND:2, WATER:3, OIL:4, FIRE:5, STEAM:6, ACID:7, PLANT:8, WOOD:9, GAS:10 };
const MAT_NAMES = ['empty','stone','sand','water','oil','fire','steam','acid','plant','wood','gas'];

// density: static solids get 9 (never displaced); gases < oil < water < acid < sand
const DENSITY  = new Float32Array([0, 9, 2.0, 1.0, 0.8, 0.25, 0.4, 1.3, 9, 9, 0.2]);
const IS_STATIC= new Uint8Array([0,1,0,0,0,0,0,0,1,1,0]);
const IS_GAS   = new Uint8Array([1,0,0,0,0,1,1,0,0,0,1]);

const FLAMMABLE = { 4:0.30, 8:0.08, 9:0.02 };            // oil, plant, wood
const BURN_LIFE = { 4:55, 8:60, 9:150 };
const DISSOLVE  = { 2:0.05, 1:0.004, 8:0.30, 9:0.10 };   // sand, stone, plant, wood

// gravity quantized to 8 directions; deg 0 = straight down, clockwise
const GDIRS = [[0,1],[1,1],[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1]];

function rgb(r,g,b){ return ((0xFF000000 | (b&255)<<16 | (g&255)<<8 | (r&255)) >>> 0); }

class Engine {
  constructor(seed = 1){
    this.W=W; this.H=H; this.N=N;
    this.mat   = new Uint8Array(N);
    this.temp  = new Int16Array(N); this.temp.fill(AMBIENT);
    this.life  = new Uint8Array(N);
    this.color = new Uint32Array(N);
    this.noise = new Uint8Array(N);
    this.vx = new Int8Array(N); this.vy = new Int8Array(N);
    this.moved = new Uint8Array(N);

    let s = seed>>>0;
    for (let i=0;i<N;i++){ s=(s+0x6D2B79F5)|0; this.noise[i]=(s>>>24)&255; }

    this._s = (seed ^ 0x9e3779b9)>>>0;
    this.tickCount = 0;
    this.gravityIndex = 0; this.gravityDeg = 0;
    this.scanOrder = this.buildScan(0);

    this.active = new Uint8Array(NCHUNKS).fill(1);
    this.idle   = new Uint16Array(NCHUNKS);
    this.events = new Uint32Array(NCHUNKS);
    this.sleepThreshold = 6;

    this.history = []; this.historyCap = 150;
    this.lastStepUs = 0;
  }

  rand(){ let s=(this._s=(this._s+0x6D2B79F5)|0); let t=Math.imul(s^(s>>>15),1|s); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }

  chunkOf(i){ return (((i/W)|0)>>5)*CW + ((i%W)>>5); }

  buildScan(gi){
    const g=GDIRS[gi], idx=[];
    for (let i=0;i<N;i++){ const x=i%W, y=(i/W)|0; idx.push({i, p: x*g[0]+y*g[1]}); }
    idx.sort((a,b)=>b.p-a.p);
    return Uint32Array.from(idx, o=>o.i);
  }

  setGravity(deg){
    this.gravityDeg = ((deg%360)+360)%360;
    this.gravityIndex = Math.round(this.gravityDeg/45)%8;
    this.scanOrder = this.buildScan(this.gravityIndex);
    this.active.fill(1); this.idle.fill(0);
  }

  wakeArea(x,y,r){
    const c0x=Math.max(0,((x-r)>>5)-1), c1x=Math.min(CW-1,((x+r)>>5)+1);
    const c0y=Math.max(0,((y-r)>>5)-1), c1y=Math.min(CHH-1,((y+r)>>5)+1);
    for (let cy=c0y;cy<=c1y;cy++) for (let cx=c0x;cx<=c1x;cx++){ const c=cy*CW+cx; this.active[c]=1; this.idle[c]=0; }
  }
  wakeAll(){ this.active.fill(1); this.idle.fill(0); }

  touch(j){ this.events[this.chunkOf(j)]++; }

  paint(px,py,r,matTo,erase){
    r|=0; if(r<1)r=1;
    const x0=Math.max(0,px-r), x1=Math.min(W-1,px+r), y0=Math.max(0,py-r), y1=Math.min(H-1,py+r);
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++){
      const dx=x-px, dy=y-py; if (dx*dx+dy*dy > r*r) continue;
      const i=y*W+x;
      if (erase){ this.mat[i]=MAT.EMPTY; this.color[i]=0; this.life[i]=0; this.temp[i]=AMBIENT; }
      else {
        this.mat[i]=matTo; this.temp[i]=AMBIENT; this.vx[i]=0; this.vy[i]=0;
        if (matTo===MAT.FIRE){ this.temp[i]=520; this.life[i]=55+((this.rand()*40)|0); }
        else if (matTo===MAT.STEAM){ this.temp[i]=110; this.life[i]=120+((this.rand()*120)|0); }
        else if (matTo===MAT.GAS){ this.life[i]=70+((this.rand()*80)|0); }
        else if (matTo===MAT.PLANT){ this.life[i]=40; }
        else { this.life[i]=0; }
        this.color[i]=this.colorFor(i);
      }
      this.touch(i);
    }
    this.wakeArea(px,py,r);
  }

  colorFor(i){
    const m=this.mat[i], n=this.noise[i], d=(n%9)-4;
    switch(m){
      case MAT.STONE: { const v=100+d*3; return rgb(v+10, v+8, v+4); }
      case MAT.SAND:  return rgb(212+d*4, 164+d*3, 66+d*3);
      case MAT.WATER: return rgb(26+d*3, 100+d*3, 202+d*4);
      case MAT.OIL:   return rgb(76+d*3, 50+d*2, 26+d*2);
      case MAT.FIRE:  { const l=Math.min(1, this.life[i]/70); return rgb(255, (60+165*l)|0, 24); }
      case MAT.STEAM: return rgb(200+d*5, 208+d*5, 218+d*5);
      case MAT.ACID:  return rgb(222+d*6, 186+d*5, 8);
      case MAT.PLANT: return rgb(44+d*6, 138+d*14, 58);
      case MAT.WOOD:  return rgb(106+d*3, 74+d*3, 42+d*2);
      case MAT.GAS:   return rgb(104+d*4, 110+d*4, 116+d*4);
      default: return 0;
    }
  }
  recolorAll(){ for (let i=0;i<N;i++) this.color[i]=this.colorFor(i); }

  nb(i,dx,dy){
    const x=(i%W)+dx, y=((i/W)|0)+dy;
    if (x<0||x>=W||y<0||y>=H) return -1;
    return y*W+x;
  }

  canSwapInto(m, t){
    if (t===MAT.EMPTY) return true;
    if (IS_STATIC[t]) return false;
    return DENSITY[m] > DENSITY[t];
  }

  doSwap(i,j,dx,dy){
    const m=this.mat[i]; this.mat[i]=this.mat[j]; this.mat[j]=m;
    let t=this.temp[i]; this.temp[i]=this.temp[j]; this.temp[j]=t;
    t=this.life[i]; this.life[i]=this.life[j]; this.life[j]=t;
    let c=this.color[i]; this.color[i]=this.color[j]; this.color[j]=c;
    t=this.vx[i]; this.vx[i]=this.vx[j]; this.vx[j]=t;
    t=this.vy[i]; this.vy[i]=this.vy[j]; this.vy[j]=t;
    this.vx[j]=Math.max(-3,Math.min(3,dx)); this.vy[j]=Math.max(-3,Math.min(3,dy));
    this.moved[i]=1; this.moved[j]=1;
    this.events[this.chunkOf(i)]++; this.events[this.chunkOf(j)]++;
  }

  step(sub){ for (let k=0;k<(sub||1);k++) this.tickStep(); }

  tickStep(){
    const t0=process.hrtime.bigint();
    this.events.fill(0); this.moved.fill(0);
    // wake scan: every 60 ticks all chunks get one processing pass, so slow
    // probabilistic reactions (plant growth, acid sitting on a target) can fire
    // and mark fresh events; otherwise settled chunks sleep for real.
    if (this.tickCount % 60 === 0) this.active.fill(1);
    this.movePass();
    this.reactionPass();
    for (let c=0;c<NCHUNKS;c++){
      if (this.events[c]>0){ this.active[c]=1; this.idle[c]=0; }
      else { if (++this.idle[c]>this.sleepThreshold) this.active[c]=0; }
    }
    this.tickCount++;
    this.lastStepUs = Number(process.hrtime.bigint()-t0)/1000;
    this.history.push({ t:this.tickCount, s:this._s, m:this.mat.slice(), p:this.temp.slice() });
    if (this.history.length>this.historyCap) this.history.shift();
  }

  movePass(){
    const order=this.scanOrder, mat=this.mat, g=GDIRS[this.gravityIndex];
    const pa=[g[1],-g[0]], pb=[-g[1],g[0]];
    for (let k=0;k<N;k++){
      const i=order[k];
      if (!this.active[this.chunkOf(i)]) continue;
      const m=mat[i];
      if (m===MAT.EMPTY || IS_STATIC[m] || this.moved[i]) continue;
      if (m===MAT.SAND) this.moveGranular(i,m,g,pa,pb);
      else if (m===MAT.WATER||m===MAT.OIL||m===MAT.ACID) this.moveLiquid(i,m,g,pa,pb, m===MAT.WATER?5:3);
      else if (m===MAT.STEAM||m===MAT.GAS) this.moveGas(i,m,g,pa,pb);
      else if (m===MAT.FIRE) this.moveFire(i,g);
    }
  }

  moveGranular(i,m,g,pa,pb){
    let j=this.nb(i,g[0],g[1]);
    if (j>=0 && this.canSwapInto(m,this.mat[j])) return this.doSwap(i,j,g[0],g[1]);
    const first=this.rand()<0.5, dirs=first?[pa,pb]:[pb,pa];
    for (const d of dirs){
      j=this.nb(i,g[0]+d[0],g[1]+d[1]);
      if (j>=0 && this.canSwapInto(m,this.mat[j])) return this.doSwap(i,j,g[0]+d[0],g[1]+d[1]);
    }
  }

  moveLiquid(i,m,g,pa,pb,disp){
    let j=this.nb(i,g[0],g[1]);
    if (j>=0 && this.canSwapInto(m,this.mat[j])) return this.doSwap(i,j,g[0],g[1]);
    const first=this.rand()<0.5, dirs=first?[pa,pb]:[pb,pa];
    for (const d of dirs){
      j=this.nb(i,g[0]+d[0],g[1]+d[1]);
      if (j>=0 && this.canSwapInto(m,this.mat[j])) return this.doSwap(i,j,g[0]+d[0],g[1]+d[1]);
    }
    // lateral level-seeking: step sideways only toward a column that has a free cell "below"
    for (const d of dirs){
      let cur=i;
      for (let s=0;s<disp;s++){
        const side=this.nb(cur,d[0],d[1]);
        if (side<0) break;
        const tm=this.mat[side];
        if (!(tm===MAT.EMPTY || (IS_GAS[tm] && DENSITY[m]>DENSITY[tm]))) break;
        const below=this.nb(side,g[0],g[1]);
        if (below>=0 && this.canSwapInto(m,this.mat[below])) return this.doSwap(i,side,d[0],d[1]);
        cur=side;
      }
    }
  }
  moveGas(i,m,g,pa,pb){
    const ux=-g[0], uy=-g[1];
    let j=this.nb(i,ux,uy);
    if (j>=0){ const t=this.mat[j];
      if (t!==m && !IS_STATIC[t] && (t===MAT.EMPTY || (!IS_GAS[t] && DENSITY[m]<DENSITY[t]))){
        return this.doSwap(i,j,ux,uy);
      }
    }
    const first=this.rand()<0.5, dirs=first?[pa,pb]:[pb,pa];
    for (const d of dirs){
      j=this.nb(i,ux+d[0],uy+d[1]);
      if (j>=0){ const t=this.mat[j];
        if (t!==m && !IS_STATIC[t] && (t===MAT.EMPTY || (!IS_GAS[t] && DENSITY[m]<DENSITY[t]))){
          return this.doSwap(i,j,ux+d[0],uy+d[1]);
        }
      }
    }
    if (this.rand()<0.5){ const d=first?pa:pb; j=this.nb(i,d[0],d[1]);
      if (j>=0 && this.mat[j]===MAT.EMPTY) this.doSwap(i,j,d[0],d[1]);
    }
  }

  moveFire(i,g){
    if (this.rand()<0.35){
      const ux=-g[0], uy=-g[1];
      const j=this.nb(i,ux,uy);
      if (j>=0){ const t=this.mat[j];
        if (!IS_STATIC[t] && !IS_GAS[t] && DENSITY[MAT.FIRE]<DENSITY[t]) this.doSwap(i,j,ux,uy);
      }
    }
  }

  reactionPass(){
    const mat=this.mat, temp=this.temp, life=this.life;
    for (let i=0;i<N;i++){
      if (!this.active[this.chunkOf(i)]) continue;
      const m=mat[i];
      if (m===MAT.EMPTY) continue;
      const x=i%W, y=(i/W)|0;
      const n4=[];
      if (y>0) n4.push(i-W);
      if (y<H-1) n4.push(i+W);
      if (x>0) n4.push(i-1);
      if (x<W-1) n4.push(i+1);

      if (m===MAT.FIRE){
        life[i]--;
        if (temp[i]<500) temp[i]=500+(this.noise[i]&63);
        let doused=false;
        for (const j of n4){
          const t=mat[j];
          if (t===MAT.WATER){
            if (this.rand()<0.6){ mat[j]=MAT.STEAM; life[j]=120+((this.rand()*120)|0); temp[j]=115; this.color[j]=this.colorFor(j); this.touch(j); }
            doused=true;
          } else if (FLAMMABLE[t]!==undefined && this.rand()<FLAMMABLE[t]){
            mat[j]=MAT.FIRE; life[j]=BURN_LIFE[t]; temp[j]=520; this.color[j]=this.colorFor(j); this.touch(j);
          } else if (t!==MAT.EMPTY){
            temp[j]=Math.min(999, temp[j]+60); this.touch(j);
          }
        }
        if (doused && this.rand()<0.9 || life[i]<=0){
          if (this.rand()<0.4){ mat[i]=MAT.GAS; life[i]=70+((this.rand()*80)|0); }
          else { mat[i]=MAT.EMPTY; life[i]=0; }
          this.color[i]=this.colorFor(i); this.touch(i);
        }
      }
      else if (m===MAT.STEAM){
        life[i]--;
        if (life[i]<=0 || temp[i]<80){ mat[i]=MAT.WATER; this.color[i]=this.colorFor(i); this.touch(i); }
      }
      else if (m===MAT.WATER){
        let heated=false;
        for (const j of n4){
          if (mat[j]!==MAT.WATER && mat[j]!==MAT.EMPTY && temp[j]>120){ temp[j]=Math.max(AMBIENT, temp[j]-30); temp[i]=Math.min(99, temp[i]+8); heated=true; this.touch(j); }
        }
        if (temp[i]>=100){ mat[i]=MAT.STEAM; life[i]=120+((this.rand()*120)|0); this.color[i]=this.colorFor(i); this.touch(i); }
      }
      else if (m===MAT.OIL){
        if (temp[i]>=240){ mat[i]=MAT.FIRE; life[i]=BURN_LIFE[4]; this.color[i]=this.colorFor(i); this.touch(i); }
      }
      else if (m===MAT.WOOD){
        if (temp[i]>=300){ mat[i]=MAT.FIRE; life[i]=BURN_LIFE[9]; this.color[i]=this.colorFor(i); this.touch(i); }
      }
      else if (m===MAT.ACID){
        for (const j of n4){
          const t=mat[j], ch=DISSOLVE[t];
          if (ch && this.rand()<ch){
            mat[j]=MAT.GAS; life[j]=70+((this.rand()*80)|0); temp[j]=AMBIENT; this.color[j]=this.colorFor(j); this.touch(j);
            if (this.rand()<0.30){ mat[i]=MAT.GAS; life[i]=70; this.color[i]=this.colorFor(i); }
            break;
          }
        }
      }
      else if (m===MAT.PLANT){
        if (life[i]>0 && this.rand()<0.08){
          let water=-1, empties=[];
          for (const j of n4){ if (mat[j]===MAT.WATER) water=j; else if (mat[j]===MAT.EMPTY) empties.push(j); }
          if (water>=0 && empties.length){
            const k=empties[(this.rand()*empties.length)|0];
            mat[k]=MAT.PLANT; life[k]=Math.max(3, life[i]-2); this.color[k]=this.colorFor(k); this.touch(k);
            if (this.rand()<0.5){ mat[water]=MAT.EMPTY; this.touch(water); }
            life[i]--;
          }
        }
      }
      else if (m===MAT.GAS){
        life[i]--;
        if (life[i]<=0){ mat[i]=MAT.EMPTY; this.color[i]=0; this.touch(i); }
      }

      // thermal relaxation toward ambient
      if (mat[i]!==MAT.EMPTY){
        const t=temp[i];
        temp[i]=t+(((AMBIENT-t)*3)>>8);
      }
    }
  }

  counts(){
    const c=new Uint32Array(16);
    for (let i=0;i<N;i++) c[this.mat[i]]++;
    return c;
  }

  pack(){
    const head=new Uint32Array([W,H,this.tickCount,this.gravityDeg|0,this._s>>>0]);
    const out=new Uint8Array(20+N+N*2+N+N);
    out.set(new Uint8Array(head.buffer),0);
    out.set(this.mat,20);
    out.set(new Uint8Array(this.temp.buffer,this.temp.byteOffset,this.temp.byteLength),20+N);
    out.set(this.life,20+N*3);
    out.set(this.noise,20+N*4);
    return out;
  }
  static unpack(buf){
    const raw=buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer,buf.byteOffset,buf.byteLength);
    const u8=new Uint8Array(raw.byteLength); u8.set(raw);
    const head=new Uint32Array(u8.buffer,0,5);
    const e=new Engine(head[4]||1);
    e.tickCount=head[2]|0; e.setGravity(head[3]|0);
    e.mat.set(new Uint8Array(u8.buffer,20,N));
    e.temp.set(new Int16Array(u8.buffer,20+N,N));
    e.life.set(new Uint8Array(u8.buffer,20+N*3,N));
    e.noise.set(new Uint8Array(u8.buffer,20+N*4,N));
    e.recolorAll(); e.wakeAll();
    return e;
  }

  seek(framesBack){
    const idx=this.history.length-1-framesBack;
    if (idx<0 || !this.history[idx]) return null;
    const f=this.history[idx];
    this.mat.set(f.m); this.temp.set(f.p);
    this.tickCount=f.t; this._s=f.s;
    this.recolorAll(); this.wakeAll();
    return { t:f.t };
  }
}

module.exports = { Engine, MAT, MAT_NAMES, W, H, CH, NCHUNKS, AMBIENT };
globalThis.ATELIER = module.exports; // browser (worker shim) access without require
