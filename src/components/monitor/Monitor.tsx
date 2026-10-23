"use client";
import { AlertTriangle, BellRing, CheckCircle2, CloudLightning, CloudRain, CloudSun, Haze, Link2, Play, QrCode, Radio, RotateCcw, Sun, Wrench } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fmtClock, fmtDuration, InkButton, Label, Mascot, Panel, PaperButton, Readout, Segmented, Stamp, Toggle } from "@/components/ui/primitives";
import { AlertEngine, type CourtAlert } from "@/lib/alerts";
import { MONITOR_CHANNEL, type MonitorMessage } from "@/lib/monitor-channel";
import { EASE } from "@/lib/motion";
import { SensorSim } from "@/lib/sensor";
import { KAPAR_2023 } from "@/lib/sim/storm";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { WeatherPayload } from "@/lib/weather";
import { Gauge } from "./Gauge";

type Mode = "linked" | "live" | "replay";

interface Feed {
  name: string;
  level: number;
  fill: number;
  depth: number;
  stored: number;
  capacity: number;
  rainMmH: number;
  inflow: number;
  outflow: number;
  projectedEmpty: number | null;
  emptyAt: number | null;
  t: number;
  tEnd: number;
  running: boolean;
  history: { t: number[]; level: number[]; rain: number[] };
  alerts: CourtAlert[];
  closed: boolean;
  clock: "sim" | "live";
  drainDown?: boolean;
}

const ICONS: Record<string, ReactNode> = {
  closing: <AlertTriangle className="size-4 text-warn" />,
  full80: <BellRing className="size-4 text-danger" />,
  open: <CheckCircle2 className="size-4 text-ok" />,
  clog: <Wrench className="size-4 text-danger" />,
  weather: <CloudLightning className="size-4 text-warn" />,
  info: <Radio className="size-4 text-water" />,
};

function useWeather(enabled: boolean) {
  const [w, setW] = useState<WeatherPayload | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch("/api/weather?location=Klang");
        const j = (await res.json()) as WeatherPayload;
        if (!stop) {
          setW(j);
          setErr(j.source === "unavailable");
        }
      } catch {
        if (!stop) setErr(true);
      }
    };
    load();
    const id = setInterval(load, 10 * 60 * 1000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [enabled]);
  return { w, err };
}

/** Linked feed from the simulator (this tab or another tab on this device). */
function useLinked(): Feed | null {
  const [feed, setFeed] = useState<Feed | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(MONITOR_CHANNEL);
    bc.onmessage = (ev: MessageEvent<{ msg: MonitorMessage; alerts: CourtAlert[]; closed: boolean }>) => {
      const { msg, alerts, closed } = ev.data;
      setFeed({ ...msg, alerts, closed, clock: "sim" });
    };
    return () => bc.close();
  }, []);
  return feed;
}

/** Replay of the Kapar storm on the stand-in sensor, at 10 simulated minutes per second. */
function useReplay(active: boolean, clog: boolean): [Feed | null, () => void] {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [nonce, setNonce] = useState(0);
  const clogRef = useRef(clog);
  useEffect(() => {
    clogRef.current = clog;
  }, [clog]);
  useEffect(() => {
    if (!active) return;
    const s = new SensorSim();
    const storm = { ...KAPAR_2023 };
    s.start(storm);
    const eng = new AlertEngine("sim");
    let alerts: CourtAlert[] = [];
    const hist = { t: [] as number[], level: [] as number[], rain: [] as number[] };
    const tEnd = (storm.durationMin + 480) * 60;
    let raf = 0;
    let last = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const wall = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (s.t >= tEnd) return;
      s.clog = clogRef.current ? 0.85 : 0;
      const simDt = wall * 600;
      const n = Math.max(1, Math.ceil(simDt / 5));
      for (let k = 0; k < n; k++) s.step(simDt / n);
      const fresh = eng.update({
        at: s.t,
        level: s.level,
        fill: s.fill,
        rainMmH: s.rainMmH,
        heavyExpected: false,
        outflow: s.outflow,
        expectedOutflow: s.expectedOutflow,
        secondsPerUnit: 1,
      });
      if (fresh.length) alerts = [...fresh, ...alerts];
      if (!hist.t.length || s.t - hist.t[hist.t.length - 1] > 60) {
        hist.t.push(s.t);
        hist.level.push(s.level);
        hist.rain.push(s.rainMmH);
      }
      setFeed({
        name: "Water square (replay)",
        level: s.level,
        fill: s.fill,
        depth: s.depth,
        stored: s.V,
        capacity: s.Vmax,
        rainMmH: s.rainMmH,
        inflow: s.inflow,
        outflow: s.outflow,
        projectedEmpty: s.projectedEmpty(),
        emptyAt: s.emptyAt,
        t: s.t,
        tEnd,
        running: s.t < tEnd,
        history: { t: [...hist.t], level: [...hist.level], rain: [...hist.rain] },
        alerts,
        closed: eng.closed,
        clock: "sim",
      });
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [active, nonce]);
  return [feed, () => setNonce((n) => n + 1)];
}

/** Live: the real MET Malaysia forecast and warnings for Klang drive the closing rule; the level sensor is simulated (dry court, small noise). */
function useLive(active: boolean, weather: WeatherPayload | null): Feed | null {
  const [feed, setFeed] = useState<Feed | null>(null);
  const eng = useMemo(() => new AlertEngine("live"), []);
  const alertsRef = useRef<CourtAlert[]>([]);
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      const now = Date.now();
      const level = Math.max(0, 0.002 + Math.sin(now / 9000) * 0.0015);
      const fresh = eng.update({
        at: now,
        level,
        fill: level,
        rainMmH: 0,
        heavyExpected: !!weather?.heavyExpected,
        outflow: 0,
        expectedOutflow: 0,
        secondsPerUnit: 0.001,
      });
      if (fresh.length) {
        alertsRef.current = [
          ...fresh.map((a) => (a.kind === "closing" && weather?.heavyReason ? { ...a, body: `${weather.heavyReason}. Court closing as a precaution — the square will collect storm water.` } : a)),
          ...alertsRef.current,
        ];
      }
      setFeed({
        name: "Water square · sensor (simulated)",
        level,
        fill: level,
        depth: 1,
        stored: level * 1200,
        capacity: 1200,
        rainMmH: 0,
        inflow: 0,
        outflow: 0,
        projectedEmpty: 0,
        emptyAt: null,
        t: now,
        tEnd: now,
        running: true,
        history: { t: [], level: [], rain: [] },
        alerts: alertsRef.current,
        closed: eng.closed,
        clock: "live",
      });
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [active, weather, eng]);
  return feed;
}

export function Monitor({ embedded = false }: { embedded?: boolean }) {
  const linked = useLinked();
  const [mode, setMode] = useState<Mode>("linked");
  const [clog, setClog] = useState(false);
  const { w: weather, err: weatherErr } = useWeather(true);
  const [replay, restartReplay] = useReplay(mode === "replay", clog);
  const live = useLive(mode === "live", weather);
  const feed = mode === "linked" ? linked : mode === "replay" ? replay : live;
  const storeClog = useApp((s) => s.params.clog);
  const setParams = useApp((s) => s.setParams);

  // default to Replay on a device that has no simulation feed (e.g. a judge's phone)
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current) return;
    const t = setTimeout(() => {
      decided.current = true;
      if (!linked && !embedded) setMode("replay");
    }, 1200);
    return () => clearTimeout(t);
  }, [linked, embedded]);

  const status = !feed ? "idle" : feed.fill >= 0.8 ? "full" : feed.closed ? "closed" : "open";
  const statusUI = ({
    idle: { label: "Waiting", stamp: "No feed", sub: "No sensor feed yet", bg: "bg-muted", tone: "ink", mood: "sleepy", note: "zzz… no storm yet" },
    open: { label: "Court open", stamp: "Open", sub: "Dry and safe to play", bg: "bg-mint", tone: "ok", mood: "happy", note: "go play!" },
    closed: { label: "Court closed", stamp: "Closed", sub: "Storm water expected or entering", bg: "bg-sun-soft", tone: "warn", mood: "worried", note: "soaking it up…" },
    full: { label: "Court closed · filling", stamp: "80% full", sub: "Above 80% — keep clear of the edges", bg: "bg-tomato-soft", tone: "tomato", mood: "soaked", note: "keep clear of the edges" },
  } as const)[status];

  return (
    <div className={cn("mx-auto w-full max-w-6xl", embedded ? "h-full overflow-y-auto p-3 sm:p-5 scroll-thin" : "p-4 sm:p-6")}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold leading-none tracking-tight sm:text-4xl">
            Is the court{" "}
            <span className="relative inline-block">
              dry?
              <svg viewBox="0 0 100 12" preserveAspectRatio="none" className="absolute -bottom-1.5 left-0 h-2.5 w-full" aria-hidden>
                <path d="M2 8 Q 25 2 50 7 T 98 5" fill="none" stroke="var(--primary)" strokeWidth="3.5" strokeLinecap="round" />
              </svg>
            </span>
          </h1>
        </div>
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          className="w-full sm:w-[360px]"
          options={[
            { value: "linked", label: <><Link2 className="size-3.5" /> Simulation</> },
            { value: "live", label: <><Radio className="size-3.5" /> Live Klang</> },
            { value: "replay", label: <><Play className="size-3.5" /> Replay 2023</> },
          ]}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr_1fr]">
        {/* status + gauge */}
        <Panel className="p-4">
          <motion.div
            key={status}
            initial={{ scale: 0.97, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.35, ease: EASE.expressive }}
            className={cn("relative mb-4 flex items-center gap-3 rounded-2xl border-[1.5px] border-foreground px-3 py-3 shadow-[3px_3px_0_0_var(--foreground)]", statusUI.bg)}
          >
            <Mascot mood={statusUI.mood} size={58} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-display text-xl font-bold leading-tight">{statusUI.label}</div>
              <div className="text-[11px] text-foreground/70">{statusUI.sub}</div>
              <div className="mt-0.5 font-hand text-[18px] leading-none text-foreground/80">{statusUI.note}</div>
            </div>
            <Stamp key={statusUI.stamp} tone={statusUI.tone} className="absolute -top-2.5 right-3 bg-card/80 !text-[12px]">
              {statusUI.stamp}
            </Stamp>
          </motion.div>
          {feed ? (
            <>
              <Gauge fill={feed.fill} level={feed.level} depth={feed.depth} className="h-64" />
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Readout label="Rain now" value={feed.rainMmH} unit="mm/h" decimals={0} tone="water" />
                <Readout label="Stored" value={feed.stored} unit={`/ ${Math.round(feed.capacity)} m³`} decimals={0} />
                <Readout label="Flowing in" value={feed.inflow * 1000} unit="L/s" decimals={0} />
                <Readout label="Draining out" value={feed.outflow * 1000} unit="L/s" decimals={0} />
              </div>
              <div className="mt-3 rounded-xl border border-dashed border-foreground/25 bg-background px-3 py-2 text-[11px] text-muted-foreground">
                {feed.clock === "sim" ? (
                  <>
                    <span className="num text-foreground">{fmtClock(feed.t)}</span> after the storm began ·{" "}
                    {feed.emptyAt != null
                      ? `emptied ${fmtDuration(feed.emptyAt - KAPAR_2023.durationMin * 60)} after the rain`
                      : feed.level > 0.01
                        ? feed.projectedEmpty == null
                          ? "outlet blocked"
                          : `empties in ~${fmtDuration(feed.projectedEmpty)} once inflow stops`
                        : "dry"}
                  </>
                ) : (
                  <>Sensor reads dry.</>
                )}
              </div>
            </>
          ) : (
            <EmptyLinked onReplay={() => setMode("replay")} embedded={embedded} />
          )}
        </Panel>

        {/* alerts */}
        <Panel className="flex flex-col p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 font-display text-base font-semibold">
              <BellRing className="size-4 text-primary" /> Alerts
            </div>
          </div>
          <div className="min-h-[220px] flex-1 space-y-2 overflow-y-auto pr-1 scroll-thin lg:max-h-[420px]">
            <AnimatePresence initial={false}>
              {(feed?.alerts ?? []).map((a) => (
                <motion.div
                  key={a.id}
                  layout
                  initial={{ opacity: 0, y: -12, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.35, ease: EASE.expressive }}
                  className="lift flex overflow-hidden rounded-xl border border-border bg-card"
                >
                  <div
                    className={cn(
                      "grid w-11 shrink-0 place-items-center border-r-[1.5px] border-dashed border-foreground/25",
                      a.level === "danger" ? "bg-tomato-soft" : a.level === "warn" ? "bg-sun-soft" : a.level === "ok" ? "bg-mint" : "bg-water-soft",
                    )}
                  >
                    {ICONS[a.kind] ?? ICONS.info}
                  </div>
                  <div className="min-w-0 flex-1 p-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-foreground">{a.title}</span>
                      <span className="num shrink-0 text-[10px] text-muted-foreground">{a.clock === "sim" ? `T+${fmtClock(a.at)}` : new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{a.body}</p>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            {!feed?.alerts.length && <div className="grid h-40 place-items-center text-center text-[11px] text-muted-foreground">No alerts.</div>}
          </div>
          <div className="mt-3 space-y-2 border-t border-border pt-3">
            <Toggle
              checked={mode === "linked" ? storeClog > 0 : clog}
              onChange={(v) => (mode === "linked" && embedded ? setParams({ clog: v ? 0.85 : 0 }) : setClog(v))}
              label="Clogged outlet"
              hint="85% of the outlet pipe blocked."
            />
            {mode === "replay" && (
              <PaperButton onClick={restartReplay} className="group">
                <RotateCcw className="size-3 transition-transform duration-300 group-hover:-rotate-180" /> Restart replay
              </PaperButton>
            )}
          </div>
        </Panel>

        {/* weather + history */}
        <div className="flex flex-col gap-4">
          <WeatherCard w={weather} err={weatherErr} />
          {feed && feed.history.t.length > 1 && <HistoryCard feed={feed} />}
          {!embedded ? null : <QRCard />}
        </div>
      </div>
      {!embedded && (
        <p className="mt-6 text-center text-[10px] text-muted-foreground">
          Weather: MET Malaysia via data.gov.my (CC BY 4.0)
        </p>
      )}
    </div>
  );
}

function EmptyLinked({ onReplay, embedded }: { onReplay: () => void; embedded: boolean }) {
  const setPhase = useApp((s) => s.set);
  return (
    <div className="grid h-64 place-items-center text-center">
      <div className="max-w-xs">
        <Mascot mood="sleepy" size={64} className="mx-auto mb-2" />
        <div className="font-display text-base font-semibold text-foreground">No storm running</div>
        <div className="mt-3 flex justify-center gap-2">
          {embedded && (
            <InkButton onClick={() => setPhase({ phase: "design" })} className="px-3 py-1.5 text-xs">
              Go to simulator
            </InkButton>
          )}
          <PaperButton onClick={onReplay} className="px-3 py-1.5">
            <Play className="size-3" /> Replay the 2023 storm
          </PaperButton>
        </div>
      </div>
    </div>
  );
}

function wxIcon(risk: number, en: string) {
  if (/thunder/i.test(en)) return <CloudLightning className="size-4 text-warn" />;
  if (risk >= 1) return <CloudRain className="size-4 text-water" />;
  if (/haz/i.test(en)) return <Haze className="size-4 text-muted-foreground" />;
  if (/cloud/i.test(en)) return <CloudSun className="size-4 text-muted-foreground" />;
  return <Sun className="size-4 text-warn" />;
}

function WeatherCard({ w, err }: { w: WeatherPayload | null; err: boolean }) {
  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between">
        <div className="font-display text-base font-semibold">Klang weather</div>
        <Label className="!text-[9px]">MET Malaysia</Label>
      </div>
      {!w && !err && <div className="mt-3 h-24 animate-pulse rounded-xl bg-muted" />}
      {err && !w?.days.length && <div className="mt-3 text-[11px] text-muted-foreground">Forecast unavailable.</div>}
      {w && w.days.length > 0 && (
        <>
          <div className={cn("mt-2 rounded-xl border px-3 py-2 text-[11px] font-medium", w.heavyExpected ? "border-[#ecd98a] bg-sun-soft text-foreground" : "border-ok/25 bg-mint/70 text-ok")}>
            {w.heavyExpected ? `Heavy rain risk — ${w.heavyReason}` : "No heavy rain expected for the rest of today."}
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1.5 sm:grid-cols-7 lg:grid-cols-4 xl:grid-cols-7">
            {w.days.map((d, k) => (
              <motion.div
                key={`${d.date}-${k}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: k * 0.04 }}
                title={`Morning: ${d.morning.en}\nAfternoon: ${d.afternoon.en}\nNight: ${d.night.en}\n(${d.summary.bm})`}
                className={cn("lift flex flex-col items-center gap-1 rounded-lg border px-1 py-1.5", k === 0 ? "border-foreground bg-sun-soft" : "border-border bg-card")}
              >
                <span className="font-mono text-[9px] uppercase text-muted-foreground">{k === 0 ? "Today" : new Date(`${d.date}T00:00:00+08:00`).toLocaleDateString("en-MY", { weekday: "short" })}</span>
                {wxIcon(d.summary.risk, d.summary.en)}
                <span className="num text-[10px] text-foreground">{d.max}°</span>
              </motion.div>
            ))}
          </div>
          <div className="mt-2 text-[10px] leading-snug text-muted-foreground">
            Today: {w.days[0].summary.en} ({w.days[0].when.toLowerCase()}). <span className="opacity-70">“{w.days[0].summary.bm}”</span>
          </div>
          {w.warnings.length > 0 && (
            <div className="mt-2 space-y-1">
              {w.warnings.slice(0, 2).map((x, k) => (
                <div key={`${x.issued}-${x.title}-${k}`} className={cn("rounded-lg border px-2 py-1 text-[10px]", x.relevant ? "border-primary/40 bg-tomato-soft text-tomato-ink" : "border-border text-muted-foreground")}>
                  {x.title}
                  {x.relevant ? " · affects Klang" : ""}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function HistoryCard({ feed }: { feed: Feed }) {
  const W = 300;
  const H = 90;
  const tEnd = Math.max(feed.tEnd, ...feed.history.t);
  const X = (t: number) => (t / tEnd) * W;
  const maxR = Math.max(40, ...feed.history.rain);
  const lv = feed.history.t.map((t, k) => `${X(t).toFixed(1)},${(H - (Math.min(1.05, (feed.history.level[k] ?? 0) / feed.depth) * (H - 10))).toFixed(1)}`).join(" ");
  return (
    <Panel className="p-4">
      <div className="mb-1 flex items-center justify-between gap-2 font-display text-base font-semibold">
        Level over the storm
        <Label className="shrink-0 !text-[9px] !tracking-[0.1em]">line: level · bars: rain</Label>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" preserveAspectRatio="none">
        {feed.history.t.map((t, k) => (
          <rect key={k} x={X(t)} y={0} width={Math.max(1, W / feed.history.t.length)} height={(feed.history.rain[k] / maxR) * 28} fill="#3d6cf5" opacity={0.22} />
        ))}
        <line x1={0} x2={W} y1={H - 0.8 * (H - 10)} y2={H - 0.8 * (H - 10)} stroke="#ff5a36" strokeDasharray="3 3" strokeOpacity={0.8} vectorEffect="non-scaling-stroke" />
        <polyline points={lv} fill="none" stroke="#1f3fb0" strokeWidth={2.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <line x1={X(feed.t)} x2={X(feed.t)} y1={0} y2={H} stroke="#161514" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
      </svg>
    </Panel>
  );
}

function QRCard() {
  const [src, setSrc] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = `${window.location.origin}/monitor`;
    QRCode.toDataURL(u, { margin: 1, width: 240, color: { dark: "#161514", light: "#ffffff" } }).then((d) => {
      setSrc(d);
      setUrl(u);
    });
  }, []);
  return (
    <Panel className="flex items-center gap-4 p-4">
      {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL QR code, nothing to optimise */}
      {src ? <img src={src} alt="QR code to the phone dashboard" className="size-24 rounded-lg border-[1.5px] border-foreground bg-white p-1 shadow-[3px_3px_0_0_var(--foreground)]" /> : <div className="size-24 rounded-lg bg-muted" />}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 font-display text-base font-semibold">
          <QrCode className="size-4 text-primary" /> On your phone

        </div>
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{url}</div>
      </div>
    </Panel>
  );
}
