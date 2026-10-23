# Demo script (about 80 seconds of clicks)

Record at 1920×1080 (or 1440×900) in Chrome or Edge, on https://sponge-township.vercel.app.
Before recording: open the page once so tiles are cached; close other GPU-heavy tabs.
Narration is in *italics*; clicks are in **bold**. Times are approximate — trim the waits in editing.

| Time | Click | Say / show |
| --- | --- | --- |
| 0:00 | Page opens on **Pick area**, Casira box already drawn on the satellite map | *"Bandar Bukit Raja floods three or more times a year. This is Casira. Any area works — search or draw a box."* (optionally click the search box to show the list of 20 Sime Darby townships, then pick **Bandar Bukit Raja · Casira**) |
| 0:06 | **Build 3D scene** | Loader traces a curve while terrain, imagery, roads and ~500 houses load (≈ 4 s). *"Real terrain, real streets — and houses read from the satellite image where the map has none."* |
| 0:12 | Drag to orbit once | Yellow outlines and ink tags = **open space found** (Site A, B…). |
| 0:16 | **Run storm** (Kapar 2023 preset, high tide on). Speed **Max** | Rain streaks, water spreading along the streets, houses turning red as water reaches the door. *"The 4 June 2023 Kapar storm — 98.5 mm in three hours."* (≈ 13 s on WebGPU) |
| 0:30 | Point at the Results panel, then the site cards | *"133 homes get water at the door. Each site now shows how many flooded homes are around it."* |
| 0:35 | **Suggest a layout at Site A** | A 40 × 30 m sunken court, four street gutters feeding it, a rain garden and a permeable walk appear where the water pooled. |
| 0:40 | Drag a court **corner** to resize, then drag the court a little | *"Every feature can be moved, resized or deleted."* (Ctrl+Z not needed — just drag back) |
| 0:45 | **Run again** | Both runs on the same storm, in lock-step. Switch the bottom bar to **Split** and drag the divider. *"Left: Casira today. Right: with the water square."* (≈ 30 s — cut to the end in editing) |
| 1:00 | Point at **Within 150 m of your design** | *"Near the square the deepest street drops from 36 to 23 centimetres, and fewer homes flood. The water balance closes to a millionth."* Click **Show worst moment**, then **Change** for the blue-is-better map. |
| 1:08 | Top tab **3 Monitor** | The gauge has filled from the simulation; alerts: *Court closing*, *80 % full*, then the drain-down fast-forwards to *Court open again*. Flip **Simulate a clogged outlet** during the drain-down → *Clog warning*. |
| 1:18 | Point at **Klang weather** and the QR card | *"Live MET Malaysia forecast and warnings for Klang. Residents scan this to get the same dashboard on their phone."* |
| 1:22 | **Export results** | The zip has the before/after slide and the numbers for the deck. |

Phone shot (optional, 5 s): scan the QR or open `/monitor` on a phone — it replays the 2023 storm with the same alerts.

If something is slow on the day: the Casira data is baked into the app, so it loads even if OpenStreetMap or the tile
servers are down. Without WebGPU (older browsers) runs take ~1 minute each — use speed **Max** and cut in editing.
