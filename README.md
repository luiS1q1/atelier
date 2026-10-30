# ATELIER — Reactive Particle & Fluid Dynamics Laboratory

Interactive physics sandbox: paint thermodynamic and chemical granular reactions
in real time. Industrial-laboratory instrument aesthetic (matte anodized
aluminum, hairline gridlines, tabular mono telemetry).

## Run

```bash
npm run dev        # → http://localhost:8787
```

Zero dependencies, zero build step. Node 18+ is the only requirement.

## Verification checklist

| Check | How |
|---|---|
| Single command start | `npm run dev` |
| Oil floats on water | Blueprint "Hydro-Dam Failure" shows a stratified lake; or paint water, then oil |
| Fire propagation + steam | Paint oil, drop fire, watch it spread; wet fire → steam |
| Gravity dial 180° | Everything falls to the ceiling instantly |
| 20k+ particles, no stutter | Engine step measures ~0.9 ms per tick on one core; client renders a 320×192 typed-array blit |

`npm test` runs 16 headless physics assertions (density separation, ignition,
steam cycle, gravity flip, acid dissolution, plant growth, chunk sleeping,
determinism, blueprint builds).

## Architecture

**Server-authoritative engine** (`server/engine.js`, deterministic, seeded PRNG):

- World: 320×192 cells in `Uint8Array` (material), `Int16Array` (temperature),
  `Uint8Array` (life/budget), `Uint32Array` (packed ABGR color).
- **Chunk scheduling:** 32×32 chunks (10×6 grid, 60 chunks). Every tick counts
  events (moves, reactions); a chunk with no events sleeps after 6 quiet ticks
  and costs nothing until disturbed by a neighbor event, a paint stroke or the
  periodic 60-tick wake scan (lets slow probabilistic reactions fire).
- **Gravity:** quantized to 8 directions, scan order rebuilt by projection
  sort, so the dial rotates the world in 360° while traversal stays bottom-up.
- Materials: sand (granular, 45° angle of repose), water (level-seeking
  dispersion), oil (floats on water by density), fire (lifespan, ignition,
  boiling), steam (rises, condenses < 80 °C), acid (dissolves sand/stone/
  organics into gas), stone, plant (spreads on water contact), wood, gas.
- Heat: per-cell temperature with relaxation toward ambient; water cools hot
  neighbors, oil auto-ignites at 240 °C, wood at 300 °C, water boils at 100 °C.

**Server** (`server/index.js`, plain `node:http`): static frontend, SSE world
diff stream (binary-packed changed cells, full-frame fallback >35 % changed),
SSE telemetry (active chunks, particle count, step latency in µs, heap),
paint/gravity/time/inspect endpoints, scrubbing into a 150-tick history ring.

**Snapshots:** `POST /api/snapshots` (name) saves the full world as
deflate-compressed binary (header + typed-array buffers);
`GET /api/snapshots` lists, `GET /api/snapshots/:id` downloads the raw binary,
`POST /api/snapshots/:id/load` restores. Three blueprints (Volcano, Hydro-Dam
Failure, Chemical Reaction Cascade) are generated and seeded on first boot.

**Client** (`public/`): framework-free canvas renderer (320×192 `ImageData`
blit, pixelated upscale), circular brush reticle 1–64 px, hover inspection
loupe (material, °C, velocity, chunk id + sleeping/active), SVG gravity dial,
time controller (pause / single step / 0.25×–2× / timeline scrub), thermal and
chunk-overlay render modes.

No third-party libraries; fonts are Space Grotesk + IBM Plex Mono (Google
Fonts). Deliberately dependency-free so the 60 FPS guarantee holds.
