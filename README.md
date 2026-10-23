# Sponge Township — flood simulator

**Live:** https://sponge-township.vercel.app · **Phone dashboard:** https://sponge-township.vercel.app/monitor

Built for the Sime Darby Property University Hackathon 2026 ("Township of Tomorrow", Planet · Climate Resilience).

Bandar Bukit Raja floods several times a year. *Sponge Township* proposes **water squares** — sunken basketball or
skate courts on idle land that store floodwater in a storm and drain slowly afterwards — supported by gutters,
rain gardens, permeable walkways and a level sensor that warns residents. This app is the proof:

1. **Pick an area** anywhere (search or drag/draw a box, 250 m – 2 km a side). It loads that area's elevation,
   satellite image, buildings, roads and open land and builds a 3D model.
2. **Design and simulate.** It finds open land that could become a water square, lets you place and edit
   features, and runs real 2-D flood physics for the same storm *without* and *with* your design, side by side.
3. **Monitor.** A phone-friendly dashboard whose gauge fills from the simulation in real time, plus a live mode on
   MET Malaysia's forecast and warnings for Klang, with in-app alerts (court closing, 80 % full, court open
   again, clog warning).

Default site: **Casira, Bandar Bukit Raja, Klang** (3.0985 °N, 101.4135 °E), storm: **4 Jun 2023 Kapar, 98.5 mm in ~3 h**.

---

## Run it locally

Needs Node.js 20.9+ (tested on Node 24).

```bash
cd sponge-township
npm install
npm run dev          # http://localhost:3000
```

```bash
npm test             # physics tests (water balance, still water stays still, a square lowers flooding)
npm run build        # production build
```

Deploy: `npx vercel deploy --prod` from `sponge-township/` (no environment variables needed).

`node scripts/bake.mjs` refreshes the offline copy of the Casira area in `public/baked/` (OpenStreetMap,
terrain and imagery tiles) that the app falls back to if those services are down on demo day.
`?cpu` on the URL forces the CPU solver (for comparison with WebGPU).

---

## How the simulation works (plain language)

The town is cut into a grid of square cells (about 145 × 145 cells; 3.4 m each for the 500 m default area).
Every fraction of a second the model works out, for each pair of neighbouring cells, how fast water flows between
them — pushed by the difference in water level, held back by friction with the ground (rough grass slows it more
than smooth asphalt) — then moves exactly that much water. Rain falls on every cell; soil soaks some in (less and
less as it gets wet); roadside drains take some away; the rest pools in low places and runs along the streets.
That is a **shallow-water model** — the same family of physics professional flood models use — not a rising flat
plane.

What each piece does:

| Piece | How it is modelled |
| --- | --- |
| Water flow | 2-D *local-inertial* shallow-water equations (Bates et al. 2010, the LISFLOOD-FP scheme) with de Almeida et al. (2012) smoothing, arranged as in the MIT-licensed [Deluge](https://github.com/rkottomt/deluge-flood-sim) solver: well-balanced face depths (still water stays still), semi-implicit Manning friction, a positivity-preserving flux limiter (depths never go negative, no water is created). |
| Buildings | Solid blocks water must go round. Roof rain goes down the downpipes to the nearest street. |
| Ground | Manning roughness by land use: asphalt 0.016, yards 0.035, grass 0.04, paving 0.018. |
| Soil | Horton-type infiltration that declines as the ground wets (grass 40 → 5 mm/h; compacted yards 20 → 2 mm/h; Klang's clayey alluvium). |
| Existing drains | Every street cell has a roadside inlet into one drain network of limited capacity (default 30 mm/h over the area). |
| High tide | Outfalls to the Klang estuary back up: the network carries 35 % of normal during the storm and an hour after, recovering over 2 h. |
| **Water square** | A storage node (the way TUFLOW/InfoWorks treat ponds): street water pours in over its rim by the broad-crested weir equation (Q = 1.7·L·H^1.5, submerged weirs reduced by Villemonte's formula); rain on the court goes in directly; an outlet pipe at the floor empties it by the orifice equation (Q = 0.6·A·√(2gh)) into whatever drain capacity is left — so it holds water while the drains are full and empties as they recover. Gutters stop feeding it when it is full. Default 40 × 30 m, 1 m deep (1,200 m³), Ø 200 mm outlet. |
| Gutters / drains | Grated channels that catch street water along their length (default 6 L/s per metre). One that ends within 12 m of a square pours into it; otherwise it adds capacity to the drain network. |
| Inlets | One-point version of the above (default 80 L/s; feeds a square within 25 m). |
| Permeable walkway | Open-jointed paving: soaks up to 300 mm/h into a 300 mm stone bed (35 % voids ≈ 105 mm of water), which seeps into the clay at 2 mm/h. |
| Rain garden | A 25 cm planted dip over 600 mm of soil and 300 mm of gravel (≈ 300 mm of water), soaking 100 mm/h, seeping out at 3 mm/h. |
| Edges | Water can flow out of the area's edges at normal depth (it cannot flow in). |

**Timestep.** Explicit flood models must move water less than one cell per step, so deep water forces tiny steps.
The step follows the fastest wave up to 3 m/s; the rare faster faces (deep, still ponds) take their momentum step in
proportion (the "local Courant guard" of Deluge §3.2), which keeps them stable without holding the whole town back.
Checked on Casira: same flooded buildings and street area to 0.2 % with 44 % fewer steps.

**Speed.** The step runs on the GPU (WebGPU compute shaders, four passes per step) where available and on the CPU
otherwise, in two Web Workers so the "without" and "with" runs advance in lock-step on the same storm.

| Casira 500 m, Kapar storm + 2 h drain-down | WebGPU (Intel Iris Xe laptop GPU) | CPU (same laptop) |
| --- | --- | --- |
| one run (town as it is) | **13 s** | 68 s |
| without + with design together | **31 s** | ~2–3 min |
| peak street depth / flooded homes / street area > 15 cm | 0.4545 m / 133 / 8,823 m² | 0.4545 m / 133 / 8,823 m² |

### Water balance — how it was checked

Every external change is booked: rain in, soaked in, drained, flowed out of the area, and what is stored on the
ground and in the features. The app shows the balance live (Results → *Water balance*) and in the export.

- **Unit test, full storm with every feature type** (`tests/sim.test.ts`): rain in = 98.5 mm × area to 1e-3 m³;
  `rain = surface + features + infiltrated + drained + left area` with relative error **< 1e-9** at every 15-minute
  check; no negative depth anywhere.
- **Still water stays still:** a lake on bumpy ground keeps its level to < 1e-6 m over 10 minutes.
- **Casira, CPU solver:** error **1e-14** (Float64). **WebGPU solver:** error **~3e-6 to 1e-5** (Float32 state; each
  change is summed per cell and added up in Float64).
- **CPU vs GPU agree** on Casira to 4 significant figures (table above), so the two implementations check each other.
- Storm totals are integrated exactly (the 98.5 mm arrives in full whatever the timestep).

Example (Casira, with the suggested design): rain 24,625 m³ = on the ground 1,081 + in features 688 + soaked in
6,239 + drained 11,239 + flowed out of the area 5,377 m³.

---

## Terrain: getting street-level detail out of 30 m data

Free elevation (AWS Terrain Tiles, SRTM-based) is ~30 m per pixel and is a *surface* model — it sees roofs and
trees, so open fields between houses look like pits, and Klang is very flat. The app:

1. **Strips roofs and trees** with a morphological opening (erode then dilate over ~40 m), smooths the 30 m steps
   (Gaussian, σ 18 m), and **fills artefact pits** by priority-flood (Barnes et al. 2014), keeping real sags up to 25 cm.
2. **Burns in the town from map data:** streets are the low channels; house plots sit on platforms 25 cm above
   the road crown (as Malaysian housing does); grass +5 cm; open monsoon drains −1.2 m; ponds have a bed.
3. Adds a 3 cm micro-relief for kerbs, driveways and potholes, so water pools in irregular patches.
4. **Reads unmapped houses from the satellite image.** OpenStreetMap has only ~50 of the ~500 houses in the Casira
   box, so roofs are detected inside street blocks (terracotta or grey, ridged texture, set back from the road),
   snapped to the street grid and cut into ~7 m terrace units.

**Finding open space** combines OpenStreetMap land use (parks, grass, construction land) with green pixels in the
imagery, removes thin strips, and ranks each site by: does a 40 × 30 m court fit, how much ground drains to it
(D8 flow accumulation), how low it sits, and how many homes are near. After one run of the storm, each site also
shows the flooded homes within 150 m and the court is moved to where water actually pooled.

---

## Readouts

- **Peak street depth** — the deepest water on any street cell at any time.
- **Buildings with water at the door** — water deeper than **15 cm** (a doorstep; adjustable) in a cell touching
  the building, at the worst moment.
- **Street area under > 15 cm** — at the worst moment.
- **Within 150 m of your design** — the same three measures for the streets and buildings near your features,
  where the local effect shows.
- **Per feature** — stored now / peak / capacity; gutters and inlets show water caught.
- **Time to empty** — when the court's level drops below 1 cm after the rain; if the run ends first, the projection
  from the orifice equation.

Example result (Casira, Kapar storm, high tide, suggested layout after one "as-is" run): within 150 m, deepest
street **0.36 → 0.23 m (−35 %)**, homes with water at the door **92 → 83**; whole area **133 → 121 homes (−9 %)**;
the court fills to 92 % (1,080 m³) and empties ~7 h after the rain. One 1,200 m³ court cannot drain a 98.5 mm storm
over 25 ha (24,600 m³ of rain); it takes the edge off the worst-hit streets around it. The app makes that trade-off
visible — add squares on more sites to see how much storage the township needs.

**Export results** downloads a zip: a 1920×1080 before/after slide with the headline numbers, the two worst-moment
images, a split view, `summary.md`, `timeseries.csv` and `results.json`.

---

## Monitor and alerts

- **Simulation** mode: the gauge fills from the running simulation (same tab, or another tab on this device via
  `BroadcastChannel`). After the 2-D run the court's emptying is fast-forwarded with the outlet alone, so the cycle
  ends with "Court open again".
- **Live Klang** mode: the real MET Malaysia 7-day forecast and warnings for Klang (`api.data.gov.my`, cached 15
  min). The level sensor is **simulated** (no hardware in this prototype).
- **Replay 2023** mode (default on phones): the Kapar storm replayed on a lumped level-pool model of the court.

Alert rules (`src/lib/alerts.ts`, shared by all modes):

| Alert | Fires when |
| --- | --- |
| Court closing | rain ≥ 10 mm/h, or > 2 cm of water in the court, or heavy rain / thunderstorms forecast or warned for Klang |
| 80 % full | stored volume ≥ 80 % of capacity |
| Court open again | below 1 cm, no rain and no heavy-rain forecast for 15 minutes |
| Clog warning | after the rain, the outlet carries < 50 % of what a clear pipe would at that level for 10 minutes (toggle *Simulate a clogged outlet* to test) |

Alerts are in-app only (no SMS / WhatsApp / Telegram), as the brief asked.

---

## Browsers tested

- **Chrome / Chromium (desktop, Windows 11, Intel Iris Xe)** — full flow, WebGPU solver. Also the CPU fallback (`?cpu`).
- **Phone layout** — `/monitor` at 390 × 844 (Chromium mobile emulation).
- Edge uses the same engine as Chrome. Firefox and Safari without WebGPU use the CPU solver automatically (slower,
  same results). The 3D view needs WebGL2.

---

## Data sources and licences

| Data / code | Source | Licence / terms |
| --- | --- | --- |
| Elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (terrarium, from SRTM and others) | Open data; attribution to the sources (see AWS registry) |
| Satellite imagery | Esri World Imagery (Esri, Maxar, Earthstar Geographics) | Esri terms of use; attribution shown in the app. Fine for a prototype; production use needs an Esri or open imagery licence |
| Buildings, roads, land use | © OpenStreetMap contributors, via Overpass API | ODbL 1.0 |
| Buildings/roads fallback | [OpenFreeMap](https://openfreemap.org) vector tiles (OpenMapTiles schema, OSM data), used when Overpass is busy | OSM data ODbL; © OpenMapTiles |
| Place search | [Photon](https://photon.komoot.io) (komoot), OSM data | ODbL data; free public API |
| Weather and warnings | MET Malaysia via [data.gov.my](https://developer.data.gov.my/realtime-api/weather) | Open data (data.gov.my terms, CC BY 4.0) |
| Numerical method | [Deluge](https://github.com/rkottomt/deluge-flood-sim) (scheme layout and safeguards; code rewritten here) | MIT |
| 3D / map | three.js, MapLibre GL JS | MIT, BSD-3-Clause |
| UI | Next.js, React, Tailwind CSS, Motion, NumberFlow, lucide; Generate Button and Math Curve Loader from the author's component library (MIT-licensed sources) | MIT |

Other prior work looked at: [WebFlood](https://github.com/aeplay/WebFlood) (MIT, semi-Lagrangian, WebGL),
[webgpu-shallow-water](https://github.com/lisyarus/webgpu-shallow-water) (MIT, virtual pipes),
[Hydro3DJS](https://github.com/uihilab/Hydro3DJS). We chose the local-inertial scheme because it is the standard
for urban flood inundation, conserves water exactly and is well validated on flat floodplains like Klang.

References: Bates, Horritt & Fewtrell (2010) *J. Hydrology* 387; de Almeida et al. (2012) *Water Resour. Res.* 48;
Barnes, Lehman & Mulla (2014) *Computers & Geosciences* 62; Schubert & Sanders (2012) *Adv. Water Resour.* 41;
Chow (1959) *Open-Channel Hydraulics*; DID Malaysia MSMA 2nd ed. (2012).

---

## Assumptions and limitations

- **Indicative, not a design calculation.** Not calibrated against observed flood depths for 4 Jun 2023.
- **Storm shape** is assumed (front-loaded thunderstorm, peak 71 mm/h); the 98.5 mm / 3 h total is from the brief.
- **High tide** is a model choice (35 % of drain capacity), not a recorded tide level for that day.
- **Drain network** is one shared capacity (30 mm/h over the area), not a pipe-by-pipe network; mapped open
  monsoon drains are 1.2 m deep channels one cell wide.
- **Terrain** is reconstructed from 30 m data plus map-derived street detail; real levels can differ by tens of cm.
  A 1 m LiDAR survey or SDP's as-built levels would replace step 1–3 above directly.
- **Houses from imagery** are approximate footprints; OSM coverage varies by area. Imagery may be older or newer than OSM.
- **Building flooding** is judged at the building edge, not inside; floor levels are not known.
- Soil infiltration rates are typical values for Klang's clayey alluvium, not measured.
- The court's water surface is level (a storage node); flow inside it is not simulated.
- After the 2-D run ends, the court's emptying is projected or fast-forwarded with the outlet alone.
- The level sensor and alerts are simulated; no SMS/messaging.
- Open-space ownership is not known — sites must be checked with SDP.
- Very large areas (2 km) use coarser cells (~14 m), so narrow streets are less resolved.

---

## Project structure

```
src/app/                 Next.js routes: / (simulator), /monitor (phone dashboard), /api/osm, /api/weather
src/lib/sim/model.ts     the flood model (CPU, Float64) — set-up, step, ledger, readouts
src/lib/sim/gpu.ts       the same step as WebGPU compute shaders
src/lib/sim/worker.ts    Web Worker running one scenario; controller.ts keeps two in lock-step
src/lib/data/            terrain/imagery tiles, OpenStreetMap, roof detection, scene + open-space builder
src/lib/render/          three.js scene: terrain, buildings, water shader, courts, rain
src/lib/alerts.ts        court alert rules; sensor.ts the stand-in level sensor
src/components/          picker, designer panels, timeline, monitor dashboard
tests/sim.test.ts        physics tests
scripts/bake.mjs         offline copy of the Casira data
```

See [DEMO.md](DEMO.md) for the 60–90 second demo script.
