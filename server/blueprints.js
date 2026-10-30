'use strict';
/* Procedural blueprints, painted into a fresh Engine. */
const { Engine, MAT, W, H } = (typeof require === 'function' ? require('./engine') : globalThis.ATELIER);
const { STONE, SAND, WATER, OIL, FIRE, ACID, PLANT, WOOD } = MAT;

function rect(e, x0, y0, x1, y1, m){
  for (let y=Math.max(0,y0); y<=Math.min(H-1,y1); y++)
    for (let x=Math.max(0,x0); x<=Math.min(W-1,x1); x++) e.paint(x, y, 1, m, false);
}
function disc(e, cx, cy, r, m){ e.paint(cx, cy, r, m, false); }

/* Volcano: stone cone, hollow chimney, oil magma lake, live fire seed falling in. */
function volcano(){
  const e=new Engine(101);
  const base=H-6, cx=160;
  rect(e, 0, base, W-1, H-1, STONE);
  for (let y=base; y>base-110; y--){
    const half=Math.round((base-y)*0.9);
    rect(e, cx-half, y, cx+half, y, STONE);
  }
  rect(e, cx-40, base-100, cx+40, base-8, 0);          // carve chamber + chimney
  rect(e, cx-36, base-16, cx+36, base-8, OIL);         // magma lake (oil)
  rect(e, cx-2, base-26, cx+2, base-18, FIRE);         // fire seed drops onto the lake
  for (let k=0;k<10;k++) disc(e, 40+((e.rand()*240)|0), base-6-((e.rand()*70)|0), 2+((e.rand()*3)|0), SAND);
  return e;
}

/* Hydro-Dam Failure: raised reservoir held by a stone dam with a sand plug. */
function hydroDam(){
  const e=new Engine(202);
  const floorY=H-4;
  rect(e, 0, floorY, W-1, H-1, STONE);                 // canyon floor
  rect(e, 0, 0, 5, H-1, STONE);                        // left cliff
  rect(e, W-6, 0, W-1, H-1, STONE);                    // right cliff
  rect(e, 6, H-96, 120, floorY-1, STONE);              // reservoir massif
  rect(e, 30, H-94, 120, H-72, WATER);                 // the lake
  rect(e, 121, H-96, 127, floorY-1, STONE);            // dam wall
  rect(e, 124, H-88, 126, H-78, SAND);                 // sand plug — acid eats through
  rect(e, 128, H-6, W-7, H-5, SAND);                   // downstream riverbed
  for (let k=0;k<14;k++) disc(e, 150+((e.rand()*140)|0), H-8, 2+((e.rand()*2)|0), PLANT);
  for (let k=0;k<5;k++) rect(e, 170+((e.rand()*90)|0), H-12, 184+((e.rand()*90)|0), H-10, WOOD);
  return e;
}

/* Chemical Reaction Cascade: three trays — burning oil film, acid pool, sand bed. */
function cascade(){
  const e=new Engine(303);
  const floorY=H-4;
  rect(e, 0, floorY, W-1, H-1, STONE);
  // tray 1: water pool + oil film + moss, ignited
  rect(e, 30, 92, 130, 96, STONE);
  rect(e, 30, 50, 34, 91, STONE); rect(e, 126, 50, 130, 91, STONE);
  rect(e, 36, 60, 124, 91, WATER);
  rect(e, 60, 56, 100, 59, OIL);
  rect(e, 44, 78, 68, 91, PLANT);
  disc(e, 70, 58, 2, FIRE);
  // tray 2: acid pool
  rect(e, 190, 88, 290, 92, STONE);
  rect(e, 186, 40, 190, 87, STONE); rect(e, 290, 40, 294, 87, STONE);
  rect(e, 194, 60, 284, 87, ACID);
  // tray 3: sand bed with wood pylons, acid drip above
  rect(e, 150, 132, 154, floorY-1, STONE); rect(e, 246, 132, 250, floorY-1, STONE);
  rect(e, 154, 136, 246, 150, SAND);
  for (let k=0;k<6;k++) rect(e, 60+((e.rand()*160)|0), H-12, 82+((e.rand()*160)|0), H-10, WOOD);
  rect(e, 237, 96, 240, 100, ACID);                    // acid drip onto the sand below
  return e;
}

module.exports = { volcano, hydroDam, cascade };
