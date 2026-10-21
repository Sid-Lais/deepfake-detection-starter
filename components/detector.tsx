"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle, Check, ChevronDown, Copy, FileAudio, Loader2, Mic, MicOff, Pause, Play,
  RotateCcw, Square, UploadCloud, VolumeX, Waves,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DotWave, Waveform } from "@/components/waveform";
import { extFromMime, formatBytes, formatDuration, readWaveform, recorderMime } from "@/lib/audio";
import { LIKELY_REAL_MIN, LIKELY_SYNTHETIC_MAX, type Interpretation } from "@/lib/interpret";
import { ALLOWED_EXTENSIONS, MAX_UPLOAD_BYTES, extensionOf, type VelmaFrame } from "@/lib/velma";
import { cn } from "@/lib/utils";

interface Sample { title: string; file: string; label: string; source: string; licence: string }
interface Result { filename: string | null; durationMs: number; frames: VelmaFrame[]; summary: Interpretation }
interface Picked { file: File; peaks: number[]; duration: number; origin: "upload" | "mic" | "sample" }
type Phase = "choose" | "analysing" | "result";

const MAX_RECORD_SEC = 30;
const COLLAPSED_WINDOWS = 4;

const TONE = {
  real: { title: "Likely real", text: "text-real", bar: "bg-real" },
  synthetic: { title: "Likely synthetic", text: "text-synthetic", bar: "bg-synthetic" },
  unsure: { title: "Unsure", text: "text-unsure", bar: "bg-unsure" },
} as const;

const STATUS_LINES = ["Uploading the clip", "Velma is listening", "Scoring each four second window"];

const clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function Detector() {
  const [phase, setPhase] = useState<Phase>("choose");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [statusIdx, setStatusIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [decoding, setDecoding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [finishedAt, setFinishedAt] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/samples/manifest.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => Array.isArray(d) && setSamples(d.filter((s) => s?.file && s?.title)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (phase !== "analysing") return;
    const t = setInterval(() => setStatusIdx((i) => Math.min(i + 1, STATUS_LINES.length - 1)), 2200);
    return () => clearInterval(t);
  }, [phase]);

  const stopPlayback = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
    setProgress(0);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  useEffect(() => () => {
    stopPlayback();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (timerRef.current) clearInterval(timerRef.current);
  }, [stopPlayback]);

  const accept = useCallback(async (file: File, origin: Picked["origin"]) => {
    setError(null);
    setResult(null);
    stopPlayback();
    const ext = extensionOf(file.name);
    if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
      setPicked(null);
      setError(`.${ext || "unknown"} files are not supported. Use ${ALLOWED_EXTENSIONS.join(", ")}.`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setPicked(null);
      setError(`That file is ${formatBytes(file.size)}. The demo accepts up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }
    if (file.size === 0) { setPicked(null); setError("That file is empty."); return; }
    setDecoding(true);
    try {
      const { peaks, duration } = await readWaveform(file);
      setPicked({ file, peaks, duration, origin });
    } catch {
      setPicked(null);
      setError("Your browser could not read that audio. It may be corrupt or not really audio.");
    } finally {
      setDecoding(false);
    }
  }, [stopPlayback]);

  const togglePlay = () => {
    if (!picked) return;
    if (!audioRef.current) {
      urlRef.current = URL.createObjectURL(picked.file);
      const a = new Audio(urlRef.current);
      a.ontimeupdate = () => setProgress(a.duration ? a.currentTime / a.duration : 0);
      a.onended = () => { setPlaying(false); setProgress(0); };
      audioRef.current = a;
    }
    const a = audioRef.current;
    if (a.paused) { a.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); }
    else { a.pause(); setPlaying(false); }
  };

  const startRecording = async () => {
    setMicError(null);
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMicError("This browser cannot record audio. Upload a file instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = recorderMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || mime || "audio/webm";
        const file = new File([new Blob(chunks, { type })], `recording.${extFromMime(type)}`, { type });
        void accept(file, "mic");
      };
      recRef.current = rec;
      stopPlayback();
      setPicked(null);
      setResult(null);
      rec.start();
      setRecording(true);
      setRecSec(0);
      timerRef.current = setInterval(() => {
        setRecSec((s) => {
          if (s + 1 >= MAX_RECORD_SEC) stopRecording();
          return s + 1;
        });
      }, 1000);
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      setMicError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access was denied. Allow it in your browser's site settings, then try again, or upload a file."
          : name === "NotFoundError"
            ? "No microphone was found on this device."
            : "Could not start the microphone.",
      );
    }
  };

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    setRecording(false);
  }

  const pickSample = async (s: Sample) => {
    setError(null);
    try {
      const res = await fetch(`/samples/${s.file}`);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      await accept(new File([blob], s.file, { type: blob.type }), "sample");
    } catch {
      setError(`Could not load the sample "${s.title}".`);
    }
  };

  const analyse = async () => {
    if (!picked) return;
    stopPlayback();
    setError(null);
    setStatusIdx(0);
    setPhase("analysing");
    try {
      const body = new FormData();
      body.append("file", picked.file, picked.file.name);
      const res = await fetch("/api/detect", { method: "POST", body });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status}).`);
      setResult(json as Result);
      setFinishedAt(clock());
      setShowAll(false);
      setPhase("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("choose");
    }
  };

  const reset = () => {
    stopPlayback();
    setPicked(null);
    setResult(null);
    setError(null);
    setMicError(null);
    setPhase("choose");
  };

  const summary = result?.summary;
  const tone = summary && summary.label !== "no-speech" ? TONE[summary.label] : null;
  const pct = summary?.naturalShare != null ? summary.naturalShare * 100 : 0;
  const speech = result?.frames.filter((f) => f.verdict !== "no-content") ?? [];
  const syntheticPct = summary?.naturalShare != null ? 100 - pct : 0;
  const confPct = (summary?.meanConfidence ?? 0) * 100;

  const copyResult = async () => {
    if (!summary || !result) return;
    const text = summary.label === "no-speech"
      ? `Velma found no speech in ${picked?.file.name ?? "this clip"}.`
      : `${TONE[summary.label].title}: Velma judged ${pct.toFixed(0)}% of the speech in ${picked?.file.name ?? "this clip"} as natural (${(summary.speechMs / 1000).toFixed(1)}s of speech, ${result.frames.length} windows). Demo only. Scores are estimates and are not proof.`;
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch {}
  };

  const windows = result?.frames ?? [];
  const visibleWindows = showAll ? windows : windows.slice(0, COLLAPSED_WINDOWS);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="space-y-3 pb-6">
        <AnimatePresence mode="popLayout" initial={false}>
          {/* source card */}
          {phase !== "result" && (
            <MsgCard key="source" label="Source" meta={picked ? (picked.origin === "mic" ? "Recorded" : picked.origin === "sample" ? "Sample" : "Uploaded") : "Step 1 of 3"}>
              {!picked && !recording && !decoding && (
                <>
                  <p className="text-[15px] font-medium text-foreground">Add a voice clip to analyse</p>
                  <p className="mt-1 text-sm text-muted-foreground">Clips of 4 to 60 seconds work best.</p>
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) void accept(f, "upload"); }}
                    onClick={() => inputRef.current?.click()}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
                    className={cn("mt-4 flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-7 text-center transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                      dragging ? "border-foreground/50 bg-muted" : "border-border hover:border-foreground/30 hover:bg-muted/50")}
                  >
                    <UploadCloud className="size-5 text-muted-foreground" aria-hidden />
                    <p className="text-sm font-medium">Drop an audio file, or <span className="underline underline-offset-4">browse</span></p>
                    <p className="text-xs text-muted-foreground">wav, mp3, m4a, ogg, webm and more, up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB</p>
                    <input ref={inputRef} type="file" className="sr-only" aria-label="Choose an audio file"
                      accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",") + ",audio/*"}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void accept(f, "upload"); e.target.value = ""; }} />
                  </div>
                </>
              )}

              {recording && (
                <div aria-live="polite">
                  <p className="flex items-center gap-2 text-[15px] font-medium">
                    <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-record opacity-60" /><span className="relative inline-flex size-2 rounded-full bg-record" /></span>
                    Recording
                  </p>
                  <p className="mt-1 text-sm tabular-nums text-muted-foreground">{formatDuration(recSec)} of {formatDuration(MAX_RECORD_SEC)}</p>
                  <div className="mt-4 h-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-record transition-[width] duration-1000 ease-linear" style={{ width: `${(recSec / MAX_RECORD_SEC) * 100}%` }} />
                  </div>
                </div>
              )}

              {decoding && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading audio</p>
              )}

              {picked && (
                <div>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={togglePlay} disabled={phase === "analysing"}
                      aria-label={playing ? "Pause preview" : "Play preview"}
                      className="grid size-9 shrink-0 place-items-center rounded-full border bg-card transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
                      {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-[15px] font-medium"><FileAudio className="size-4 shrink-0 text-muted-foreground" />{picked.file.name}</p>
                      <p className="text-xs tabular-nums text-muted-foreground">{formatDuration(picked.duration)} · {formatBytes(picked.file.size)}</p>
                    </div>
                    {phase === "choose" && (
                      <button type="button" onClick={reset} className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Clear</button>
                    )}
                  </div>
                  <Waveform peaks={picked.peaks} progress={progress} animate={phase === "analysing"} className="mt-4" />
                  {phase === "analysing" && (
                    <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
                      <Loader2 className="size-3.5 animate-spin" /> {STATUS_LINES[statusIdx]}…
                    </p>
                  )}
                </div>
              )}

              {samples.length > 0 && !recording && !picked && !decoding && (
                <div className="mt-5 border-t pt-4">
                  <p className="mb-2 text-xs text-muted-foreground">Or try a sample</p>
                  <div className="flex flex-wrap gap-2">
                    {samples.map((s) => (
                      <button key={s.file} type="button" onClick={() => pickSample(s)} title={`${s.source} (${s.licence})`}
                        className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                        <Waves className="size-3.5 text-muted-foreground" /> {s.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </MsgCard>
          )}

          {(error || micError) && phase === "choose" && (
            <motion.p key="err" layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              role="alert" className={cn("flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm",
                error ? "border-synthetic/30 bg-synthetic-soft text-synthetic" : "border-unsure/30 bg-unsure-soft text-unsure")}>
              {error ? <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : <MicOff className="mt-0.5 size-4 shrink-0" />}
              <span>{error ?? micError}</span>
            </motion.p>
          )}

          {/* result cards */}
          {phase === "result" && result && summary && (
            <>
              <MsgCard key="verdict" label="Verdict" meta={finishedAt}>
                {tone ? (
                  <>
                    <p className={cn("text-xl font-semibold tracking-tight", tone.text)}>{tone.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {pct.toFixed(0)}% of {(summary.speechMs / 1000).toFixed(1)} seconds of detected speech was judged natural.
                    </p>
                    <div className="mt-5 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
                      <Metric label="Natural" value={pct} bar="bg-real" />
                      <Metric label="Synthetic" value={syntheticPct} bar="bg-synthetic" />
                      <Metric label="Avg confidence" value={confPct} bar="bg-foreground/60" />
                    </div>
                  </>
                ) : (
                  <div className="flex items-start gap-3">
                    <VolumeX className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-[15px] font-medium">No speech detected</p>
                      <p className="mt-1 text-sm text-muted-foreground">Velma marked every window as no content, so there is nothing to score. Try a clip with a voice in it.</p>
                    </div>
                  </div>
                )}
              </MsgCard>

              {windows.length > 0 && tone && (
                <MsgCard key="timeline" label="Timeline" meta={`${windows.length} windows`}>
                  <Timeline frames={windows} />
                </MsgCard>
              )}

              {visibleWindows.map((f, i) => (
                <WindowCard key={`w-${i}`} frame={f} index={i} />
              ))}

              {windows.length > COLLAPSED_WINDOWS && (
                <motion.button key="more" layout type="button" onClick={() => setShowAll((v) => !v)}
                  className="mx-auto flex items-center gap-1.5 rounded-full border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                  {showAll ? "Show fewer windows" : `Show all ${windows.length} windows`}
                  <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} />
                </motion.button>
              )}

              <motion.div key="how" layout>
                <Collapsible className="rounded-2xl border bg-card">
                  <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 rounded-2xl px-4 py-3 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
                    How to read this score
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 px-4 pb-4 text-sm leading-relaxed text-muted-foreground">
                    <p>Velma scores every four second window of audio and gives each one a verdict (synthetic, non-synthetic, or no content) plus a confidence in that verdict. Confidence is how sure Velma is of its verdict. It is not the chance that the audio is fake.</p>
                    <p>Natural is the share of detected speech, weighted by time, that Velma judged non-synthetic. Windows with no speech are left out.</p>
                    <p>Modulate does not publish a clip-level cut-off. The labels here use demo defaults from this repo: {Math.round(LIKELY_REAL_MIN * 100)}% or more reads as likely real, {Math.round(LIKELY_SYNTHETIC_MAX * 100)}% or less as likely synthetic, and anything between as unsure. Modulate advises setting your own threshold against your own labelled recordings.</p>
                  </CollapsibleContent>
                </Collapsible>
              </motion.div>
            </>
          )}
        </AnimatePresence>
        <span className="sr-only" aria-live="polite">{speech.length ? `${speech.length} speech windows scored` : ""}</span>
      </div>

      {/* control pill: sticks to the viewport bottom while scrolling, then rests above the footer */}
      <div className="pointer-events-none sticky bottom-0 z-20 flex justify-center bg-gradient-to-t from-background via-background/90 to-transparent px-4 pb-4 pt-8">
        <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-full border bg-card/95 p-2 pl-2 shadow-lg shadow-black/5 backdrop-blur">
          <button type="button" onClick={recording ? stopRecording : startRecording}
            disabled={phase !== "choose" || decoding}
            aria-label={recording ? "Stop recording" : "Record from microphone"}
            className={cn("grid size-10 shrink-0 place-items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40",
              recording ? "bg-record/10 text-record" : "bg-muted text-foreground hover:bg-border")}>
            {recording ? <Square className="size-4 fill-current" /> : <Mic className="size-4" />}
          </button>

          <div className="min-w-0 flex-1">
            <DotWave active={recording || phase === "analysing"} />
          </div>

          {phase === "result" ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" onClick={copyResult} aria-label="Copy result"
                className="grid size-10 place-items-center rounded-full border bg-card text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </button>
              <button type="button" onClick={reset}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring">
                <RotateCcw className="size-4" /> New clip
              </button>
            </div>
          ) : recording ? (
            <button type="button" onClick={stopRecording}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-record px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring">
              <Square className="size-3.5 fill-current" /> Stop
            </button>
          ) : (
            <button type="button" onClick={analyse} disabled={!picked || decoding || phase === "analysing"}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40">
              {phase === "analysing" ? <><Loader2 className="size-4 animate-spin" /> Analysing</> : "Analyse clip"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MsgCard({ label, meta, children }: { label: string; meta?: string; children: React.ReactNode }) {
  return (
    <motion.section layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-2xl border bg-card px-5 py-4 shadow-[0_1px_2px_rgb(0_0_0/0.03)]">
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        {meta && <span className="tabular-nums">{meta}</span>}
      </div>
      {children}
    </motion.section>
  );
}

function Metric({ label, value, bar }: { label: string; value: number; bar: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{(value / 100).toFixed(2)}</span>
      </div>
      <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-muted">
        <motion.div className={cn("h-full rounded-full", bar)} initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(100, value))}%` }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} />
      </div>
    </div>
  );
}

const VERDICT = {
  "non-synthetic": { name: "Natural", bar: "bg-real" },
  synthetic: { name: "Synthetic", bar: "bg-synthetic" },
  "no-content": { name: "No speech", bar: "bg-border" },
} as const;

function WindowCard({ frame, index }: { frame: VelmaFrame; index: number }) {
  const v = VERDICT[frame.verdict];
  const range = `${formatDuration(frame.start_time_ms / 1000)} – ${formatDuration(frame.end_time_ms / 1000)}`;
  return (
    <MsgCard label={`Window ${index + 1}`} meta={range}>
      <p className="text-[15px] font-medium">{v.name}</p>
      {frame.verdict !== "no-content" && (
        <div className="mt-3">
          <Metric label="Confidence" value={frame.confidence * 100} bar={v.bar} />
        </div>
      )}
    </MsgCard>
  );
}

function Timeline({ frames }: { frames: VelmaFrame[] }) {
  const total = frames[frames.length - 1].end_time_ms || 1;
  const color = (v: VelmaFrame["verdict"]) =>
    v === "synthetic" ? "bg-synthetic" : v === "non-synthetic" ? "bg-real" : "bg-border";
  return (
    <figure>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img"
        aria-label={`Verdict per window: ${frames.map((f) => f.verdict).join(", ")}`}>
        {frames.map((f, i) => (
          <div key={i} className={cn("h-full border-r border-card last:border-0", color(f.verdict))}
            style={{ width: `${((f.end_time_ms - f.start_time_ms) / total) * 100}%`, opacity: f.verdict === "no-content" ? 0.6 : 0.35 + 0.65 * f.confidence }} />
        ))}
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><i className="size-1.5 rounded-full bg-real" />Natural</span>
        <span className="flex items-center gap-1.5"><i className="size-1.5 rounded-full bg-synthetic" />Synthetic</span>
        <span className="flex items-center gap-1.5"><i className="size-1.5 rounded-full bg-border" />No speech</span>
        <span className="ml-auto">Brighter is more confident</span>
      </figcaption>
    </figure>
  );
}
