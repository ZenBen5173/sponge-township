"use client";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { ArrowRight, Crosshair, Loader2, MapPin, Search, SquareDashedMousePointer } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, Slider } from "@/components/ui/primitives";
import { getEngine } from "@/lib/engine";
import { gridFor } from "@/lib/data/scene";
import { type Area, areaBBox, CASIRA, fmtLatLon, mPerDegLat, mPerDegLon } from "@/lib/geo";
import { EASE } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

interface Hit {
  name: string;
  detail: string;
  lat: number;
  lon: number;
}

function boxFeature(a: Area) {
  const b = areaBBox(a);
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [[[b.w, b.s], [b.e, b.s], [b.e, b.n], [b.w, b.n], [b.w, b.s]]] },
  };
}

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    sat: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    },
    labels: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
    },
    roads: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
    },
  },
  layers: [
    { id: "sat", type: "raster", source: "sat", paint: { "raster-saturation": -0.1, "raster-contrast": 0.05 } },
    { id: "roads", type: "raster", source: "roads", paint: { "raster-opacity": 0.45 } },
    { id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.85 } },
  ],
};

export function AreaPicker() {
  const area = useApp((s) => s.area);
  const scene = useApp((s) => s.scene);
  const sceneStatus = useApp((s) => s.sceneStatus);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const areaRef = useRef(area);
  const [drawMode, setDrawMode] = useState(false);
  const drawRef = useRef(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [hl, setHl] = useState(0);
  const [hover, setHover] = useState(false);

  const setArea = useCallback((a: Area) => {
    areaRef.current = a;
    useApp.getState().setArea(a);
    const src = map.current?.getSource("box") as GeoJSONSource | undefined;
    src?.setData(boxFeature(a));
  }, []);

  useEffect(() => {
    drawRef.current = drawMode;
    if (map.current) {
      if (drawMode) map.current.dragPan.disable();
      else map.current.dragPan.enable();
      map.current.getCanvas().style.cursor = drawMode ? "crosshair" : "";
    }
  }, [drawMode]);

  useEffect(() => {
    if (!mapEl.current || map.current) return;
    // MapLibre 6 ships its worker as a separate ES module; serve our copy from /public.
    maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.js");
    const m = new maplibregl.Map({
      container: mapEl.current,
      style: STYLE,
      center: [areaRef.current.lon, areaRef.current.lat],
      zoom: 15.6,
      attributionControl: { compact: true },
      maxPitch: 0,
      dragRotate: false,
    });
    map.current = m;
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    m.on("load", () => {
      m.addSource("box", { type: "geojson", data: boxFeature(areaRef.current) });
      m.addLayer({ id: "box-fill", type: "fill", source: "box", paint: { "fill-color": "#5eead4", "fill-opacity": 0.12 } });
      m.addLayer({ id: "box-glow", type: "line", source: "box", paint: { "line-color": "#5eead4", "line-width": 10, "line-opacity": 0.18, "line-blur": 6 } });
      m.addLayer({ id: "box-line", type: "line", source: "box", paint: { "line-color": "#99f6e4", "line-width": 2, "line-dasharray": [2, 1.5] } });
    });

    // drag the box to move it; draw a new one in draw mode
    let drag: { kind: "move" | "draw"; start: maplibregl.LngLat; startArea: Area } | null = null;
    const inside = (ll: maplibregl.LngLat) => {
      const b = areaBBox(areaRef.current);
      return ll.lat > b.s && ll.lat < b.n && ll.lng > b.w && ll.lng < b.e;
    };
    m.on("mousedown", (e: maplibregl.MapMouseEvent) => {
      if (drawRef.current) {
        drag = { kind: "draw", start: e.lngLat, startArea: areaRef.current };
        e.preventDefault();
      } else if (inside(e.lngLat)) {
        drag = { kind: "move", start: e.lngLat, startArea: areaRef.current };
        m.dragPan.disable();
        e.preventDefault();
      }
    });
    m.on("mousemove", (e: maplibregl.MapMouseEvent) => {
      if (!drag) {
        if (!drawRef.current) m.getCanvas().style.cursor = inside(e.lngLat) ? "move" : "";
        return;
      }
      const a = drag.startArea;
      if (drag.kind === "move") {
        setArea({ ...a, lat: a.lat + (e.lngLat.lat - drag.start.lat), lon: a.lon + (e.lngLat.lng - drag.start.lng), label: undefined });
      } else {
        const lat = (e.lngLat.lat + drag.start.lat) / 2;
        const lon = (e.lngLat.lng + drag.start.lng) / 2;
        const w = Math.abs(e.lngLat.lng - drag.start.lng) * mPerDegLon(lat);
        const h = Math.abs(e.lngLat.lat - drag.start.lat) * mPerDegLat(lat);
        const size = Math.round(Math.min(2000, Math.max(250, Math.max(w, h))) / 10) * 10;
        setArea({ lat, lon, size, label: undefined });
      }
    });
    const end = () => {
      if (drag?.kind === "draw") setDrawMode(false);
      drag = null;
      if (!drawRef.current) m.dragPan.enable();
    };
    m.on("mouseup", end);
    m.on("mouseout", end);
    // touch: tap to move the box centre
    m.on("click", (e: maplibregl.MapMouseEvent) => {
      if ((e.originalEvent as PointerEvent).pointerType === "touch") setArea({ ...areaRef.current, lat: e.lngLat.lat, lon: e.lngLat.lng, label: undefined });
    });
    return () => {
      m.remove();
      map.current = null;
    };
  }, [setArea]);

  // search (Photon, OpenStreetMap-based, biased to Klang)
  useEffect(() => {
    if (q.trim().length < 3) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=3.1&lon=101.45&limit=6`, { signal: ctl.signal });
        const json = await res.json();
        setHits(
          (json.features ?? []).map((f: { properties: Record<string, string>; geometry: { coordinates: [number, number] } }) => ({
            name: f.properties.name ?? f.properties.street ?? "Unnamed place",
            detail: [f.properties.district ?? f.properties.city, f.properties.state, f.properties.country].filter(Boolean).join(", "),
            lon: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
          })),
        );
        setHl(0);
      } catch {
        /* aborted or offline */
      } finally {
        setSearching(false);
      }
    }, 280);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const go = (h: Hit) => {
    setArea({ ...areaRef.current, lat: h.lat, lon: h.lon, label: `${h.name}${h.detail ? `, ${h.detail}` : ""}` });
    map.current?.flyTo({ center: [h.lon, h.lat], zoom: 15.6, duration: 1400, essential: true });
    setHits([]);
    setQ(h.name);
  };

  const g = gridFor(area.size);
  const loading = sceneStatus === "loading";

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0">
        <div ref={mapEl} style={{ width: "100%", height: "100%" }} />
      </div>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(7,11,16,0.55))]" />

      <motion.div
        initial={{ opacity: 0, x: -24 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.6, ease: EASE.expressive }}
        className="absolute left-3 top-3 w-[min(380px,calc(100%-24px))] sm:left-5 sm:top-5"
      >
        <Panel className="p-4">
          <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-primary">Step 1 · Pick an area</div>
          <h2 className="font-display text-[26px] leading-[1.05] text-foreground">
            Where does the water <em className="text-primary">go?</em>
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Search a place or drag the box. We load the area&apos;s terrain, satellite view, buildings and roads, then let it rain.
          </p>

          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                if (e.target.value.trim().length < 3) setHits([]);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setHl((h) => Math.min(hits.length - 1, h + 1));
                else if (e.key === "ArrowUp") setHl((h) => Math.max(0, h - 1));
                else if (e.key === "Enter" && hits[hl]) go(hits[hl]);
                else if (e.key === "Escape") setHits([]);
              }}
              placeholder="Search an address or place…"
              className="h-10 w-full rounded-xl border border-border bg-black/40 pl-9 pr-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60 focus:bg-black/60"
            />
            {searching && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
            <AnimatePresence>
              {hits.length > 0 && (
                <motion.ul
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="glass absolute left-0 right-0 top-12 z-20 max-h-64 overflow-auto rounded-xl p-1 scroll-thin"
                >
                  {hits.map((h, k) => (
                    <motion.li key={`${h.lat}${h.lon}${k}`} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: k * 0.03 }}>
                      <button
                        onMouseEnter={() => setHl(k)}
                        onClick={() => go(h)}
                        className={cn("flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors", k === hl ? "bg-primary/12" : "")}
                      >
                        <MapPin className={cn("mt-0.5 size-3.5 shrink-0", k === hl ? "text-primary" : "text-muted-foreground")} />
                        <span className="min-w-0">
                          <span className="block truncate text-xs text-foreground">{h.name}</span>
                          <span className="block truncate text-[10px] text-muted-foreground">{h.detail}</span>
                        </span>
                      </button>
                    </motion.li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>

          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                setArea({ ...CASIRA });
                map.current?.flyTo({ center: [CASIRA.lon, CASIRA.lat], zoom: 15.6, duration: 1200 });
              }}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-black/30 px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              <Crosshair className="size-3.5" /> Casira (default)
            </button>
            <button
              onClick={() => setDrawMode((d) => !d)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] transition-colors",
                drawMode ? "border-primary/70 bg-primary/15 text-primary" : "border-border bg-black/30 text-muted-foreground hover:border-primary/50 hover:text-foreground",
              )}
            >
              <SquareDashedMousePointer className="size-3.5" /> {drawMode ? "Drag on the map…" : "Draw a box"}
            </button>
          </div>

          <div className="mt-4">
            <Slider
              label="Area size (side)"
              value={area.size}
              min={250}
              max={2000}
              step={10}
              onChange={(v) => setArea({ ...areaRef.current, size: v })}
              format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${v} m`)}
              hint={`${(area.size * area.size / 1e4).toFixed(1)} ha · simulated on a ${g.nx} × ${g.ny} grid of ${g.dx.toFixed(1)} m cells`}
            />
          </div>

          <div className="mt-3 flex items-center justify-between rounded-xl border border-border bg-black/25 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-xs text-foreground">{area.label ?? "Custom area"}</div>
              <div className="num text-[10px] text-muted-foreground">{fmtLatLon(area.lat, area.lon)}</div>
            </div>
          </div>

          <button
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            disabled={loading}
            onClick={() => getEngine().loadArea({ ...areaRef.current })}
            className="group relative mt-3 flex h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-primary font-medium text-primary-foreground shadow-[0_10px_40px_-10px_rgba(94,234,212,0.7)] transition-transform active:scale-[0.98] disabled:opacity-60"
          >
            <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}
            <span className="relative">{scene && sceneStatus === "ready" ? "Rebuild 3D scene" : "Build 3D scene"}</span>
            <motion.span animate={{ x: hover ? 4 : 0 }} className="relative">
              <ArrowRight className="size-4" />
            </motion.span>
          </button>
        </Panel>
      </motion.div>

      <div className="pointer-events-none absolute bottom-6 left-1/2 hidden -translate-x-1/2 rounded-full border border-border bg-black/50 px-3 py-1 text-[11px] text-muted-foreground backdrop-blur sm:block">
        Drag the box to move it · scroll to zoom
      </div>
    </div>
  );
}
