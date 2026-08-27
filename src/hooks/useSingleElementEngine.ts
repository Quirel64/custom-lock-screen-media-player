import { useCallback, useEffect, useRef, useState } from "react";

/**
 * PLAN 1: Single-element freeze — no anchor handoff.
 * On pause we DON'T pause the element. We keep it playing at volume 0.001 and playbackRate 0.0001,
 * and repeatedly set currentTime = frozenPos so iOS thinks "something still playing" and keeps the session.
 * On play we restore volume/playbackRate and let time advance. Only ONE element ever exists.
 * Test if this keeps PWA session >30s without needing a second silent WAV.
 */

export interface Track {
  id: string;
  file: File;
  url: string;
  name: string;
  mediaType: "audio" | "video";
}

export type ElementMode = "dual" | "video-only" | "audio-only";
export type SessionOwner = "track" | "frozen" | "none";

interface EngineOptions {
  elementMode: ElementMode;
  log: (msg: string) => void;
}

function setAudioSessionType() {
  try {
    const nav = navigator as unknown as { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = "playback";
  } catch { /* ignore */ }
}
function hideOffscreen(el: HTMLElement) {
  Object.assign(el.style, { position: "fixed", left: "-2px", top: "-2px", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" } as CSSStyleDeclaration);
}
function publish(pos: number, dur: number, rate: number) {
  if (!("mediaSession" in navigator)) return;
  if (!Number.isFinite(dur) || dur <= 0) return;
  try { navigator.mediaSession.setPositionState({ duration: dur, playbackRate: rate, position: Math.min(Math.max(0, pos), dur) }); } catch { /* ignore */ }
}

export function useSingleElementEngine({ elementMode, log }: EngineOptions) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [sessionOwner, setSessionOwner] = useState<SessionOwner>("none");

  const mediaRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);

  const rafPinRef = useRef(0);
  const rafVideoRef = useRef(0);
  const frozenPosRef = useRef(0);
  const frozenDurRef = useRef(0);
  const isFrozenRef = useRef(false);
  const lastVolumeRef = useRef(1);

  const logRef = useRef(log);
  logRef.current = log;
  const elementModeRef = useRef(elementMode);
  elementModeRef.current = elementMode;

  const currentTrack = tracks[currentIndex] ?? null;

  const stopPin = () => { if (rafPinRef.current) { cancelAnimationFrame(rafPinRef.current); rafPinRef.current = 0; } };
  const stopVideo = () => { if (rafVideoRef.current) { cancelAnimationFrame(rafVideoRef.current); rafVideoRef.current = 0; } };

  const pinFrozen = useCallback(() => {
    const el = mediaRef.current;
    if (!el || !isFrozenRef.current) return;
    const target = frozenPosRef.current;
    if (Math.abs(el.currentTime - target) > 0.03) {
      try { el.currentTime = target; } catch { /* ignore */ }
    }
    if (Number.isFinite(frozenDurRef.current) && frozenDurRef.current > 0) {
      try { navigator.mediaSession.setPositionState({ duration: frozenDurRef.current, playbackRate: 1, position: Math.min(target, frozenDurRef.current) }); } catch { /* ignore */ }
    }
  }, []);

  const startVideoSync = useCallback(() => {
    stopVideo();
    const tick = () => {
      const a = mediaRef.current, v = videoRef.current;
      if (a && v && !isFrozenRef.current && !a.paused) {
        if (Math.abs(v.currentTime - a.currentTime) > 0.12) { try { v.currentTime = a.currentTime; } catch {} }
      }
      if (mediaRef.current && !isFrozenRef.current && !mediaRef.current.paused) rafVideoRef.current = requestAnimationFrame(tick);
    };
    rafVideoRef.current = requestAnimationFrame(tick);
  }, []);

  const attachVideo = useCallback((url: string) => {
    const container = videoContainerRef.current;
    let v = videoRef.current;
    if (!v) {
      v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.setAttribute("webkit-playsinline","true"); v.setAttribute("playsinline","true");
      v.preload = "auto"; v.controls = false;
      Object.assign(v.style, { width:"100%", height:"100%", objectFit:"contain", borderRadius:"12px", touchAction:"manipulation", background:"#000" });
      videoRef.current = v;
    }
    if (container && v.parentNode !== container) { container.innerHTML = ""; container.appendChild(v); }
    if (v.src !== url) { v.src = url; v.load(); }
  }, []);
  const detachVideo = useCallback(() => { if (videoRef.current) { const v=videoRef.current; v.pause(); v.removeAttribute("src"); v.load(); if(v.parentNode) v.parentNode.removeChild(v); videoRef.current=null; } }, []);

  const getDiagnostics = useCallback(() => {
    const el = mediaRef.current;
    return { owner: isFrozenRef.current ? "frozen" as SessionOwner : (el && !el.paused ? "track" : "none"), trackPaused: el ? el.paused : null, anchorPaused: null, trackTime: el ? el.currentTime : null, anchorTime: null, frozenPosition: frozenPosRef.current };
  }, []);

  // --- transport ---
  const play = useCallback(async () => {
    const el = mediaRef.current;
    if (!el || !el.src) { logRef.current("play aborted: no src"); return; }
    // Unfreeze: restore audible volume and let time advance
    if (isFrozenRef.current) {
      logRef.current(`unfreeze -> play from ${frozenPosRef.current.toFixed(1)}s`);
      try { el.currentTime = frozenPosRef.current; } catch {}
      try { el.volume = lastVolumeRef.current; } catch {}
      try { el.playbackRate = 1; } catch {}
      isFrozenRef.current = false;
      stopPin();
      setSessionOwner("track");
    } else {
      // Normal play after track change already at 0
      logRef.current(`play @ ${el.currentTime.toFixed(1)}s`);
      setSessionOwner("track");
    }
    setAudioSessionType();
    try { await el.play(); } catch (e) { logRef.current(`play failed: ${String(e)}`); await new Promise(r=>setTimeout(r,120)); try{ setAudioSessionType(); await el.play(); } catch(e2){ logRef.current(`retry failed: ${String(e2)}`); return; } }
    if (videoRef.current?.src) { try{ videoRef.current.currentTime = el.currentTime; videoRef.current.play().catch(()=>{});}catch{}; startVideoSync(); }
    setIsPlaying(true);
    if ("mediaSession" in navigator) { navigator.mediaSession.playbackState="playing"; publish(el.currentTime, el.duration, 1); }
    logRef.current(`play ok @ ${el.currentTime.toFixed(1)}s vol=${el.volume}`);
  }, [startVideoSync]);

  const pause = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    // Save once — your idea: setCurrentTime constantly to pause time, but only save once
    frozenPosRef.current = el.currentTime;
    frozenDurRef.current = Number.isFinite(el.duration) && el.duration>0 ? el.duration : 2;
    lastVolumeRef.current = el.volume;
    logRef.current(`freeze @ ${frozenPosRef.current.toFixed(1)}s / ${frozenDurRef.current.toFixed(1)}s — keep playing at 0.001 vol`);

    // Don't pause! Keep element playing but inaudible and frozen
    try { el.volume = 0.001; } catch {}
    try { el.playbackRate = 0.0001; } catch { try{ el.playbackRate=0.0625; }catch{} }
    isFrozenRef.current = true;
    setIsPlaying(false);
    setSessionOwner("frozen");
    if ("mediaSession" in navigator) { navigator.mediaSession.playbackState="paused"; publish(frozenPosRef.current, frozenDurRef.current, 0); }

    // Pin loop: rAF when foregrounded, timeupdate when locked (rAF stops on lock screen)
    stopPin();
    const pin = () => {
      const a = mediaRef.current;
      if (!a || !isFrozenRef.current || a.paused) return;
      pinFrozen();
      rafPinRef.current = requestAnimationFrame(pin);
    };
    rafPinRef.current = requestAnimationFrame(pin);

    videoRef.current?.pause();
    stopVideo();
    // Ensure element stays playing (it already is if was playing)
    if (el.paused) {
      setAudioSessionType();
      el.play().catch(e=>logRef.current(`freeze play failed: ${String(e)}`));
    }
  }, [pinFrozen]);

  const togglePlay = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (isFrozenRef.current) { void play(); return; }
    if (el.paused) void play(); else pause();
  }, [play, pause]);

  const remotePauseOrResume = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    logRef.current(`remote pause/resume: frozen=${isFrozenRef.current} paused=${el.paused}`);
    if (isFrozenRef.current) { void play(); return; }
    pause();
  }, [play, pause]);

  const seek = useCallback((t: number) => {
    const el = mediaRef.current; if(!el) return;
    const max = Number.isFinite(el.duration)? el.duration : t;
    const clamped = Math.max(0, Math.min(t, max));
    if (isFrozenRef.current) {
      frozenPosRef.current = clamped;
      try{ el.currentTime = clamped; }catch{}
      if (videoRef.current) try{ videoRef.current.currentTime=clamped; }catch{}
      setCurrentTime(clamped);
      if (Number.isFinite(frozenDurRef.current) && frozenDurRef.current>0) {
        try{ navigator.mediaSession.setPositionState({ duration: frozenDurRef.current, playbackRate:1, position:clamped }); }catch{}
      }
    } else {
      el.currentTime = clamped;
      if (videoRef.current) try{ videoRef.current.currentTime=clamped; }catch{}
      setCurrentTime(clamped);
      publish(clamped, el.duration, 1);
    }
  }, []);
  const seekRelative = useCallback((d:number)=>{ const el=mediaRef.current; if(!el) return; const base = isFrozenRef.current ? frozenPosRef.current : el.currentTime; seek(base+d); },[seek]);

  const loadTrack = useCallback(async (idx:number, autoplay:boolean)=>{
    const list = tracks; const track = list[idx];
    const el = mediaRef.current;
    if (!track || !el) { if(el){ el.pause(); el.removeAttribute("src"); el.load(); } detachVideo(); stopPin(); isFrozenRef.current=false; setIsPlaying(false); setCurrentTime(0); setDuration(0); setSessionOwner("none"); return; }
    stopVideo(); stopPin(); isFrozenRef.current=false;
    // Reset frozen so next pause saves fresh — your "if track name different reset"
    frozenPosRef.current = 0;
    el.volume = 1; try{ el.playbackRate=1; }catch{}
    setCurrentTime(0); setDuration(0);
    el.src = track.url; el.load();
    const mode = elementModeRef.current;
    if (mode==="dual" || (mode==="video-only" && track.mediaType==="video")) attachVideo(track.url);
    else if (mode==="video-only") attachVideo(track.url);
    else detachVideo();
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist:"Lock Screen Test Player", album: track.mediaType==="video"?"Video track":"Audio track" });
    setAudioSessionType();
    logRef.current(`loadTrack [${idx+1}/${list.length}] ${track.name} autoplay=${autoplay}`);
    await new Promise<void>(res=>{
      if(Number.isFinite(el.duration) && el.duration>0){ res(); return; }
      const done=()=>{ el.removeEventListener("loadedmetadata",done); res(); };
      el.addEventListener("loadedmetadata",done); setTimeout(()=>{ el.removeEventListener("loadedmetadata",done); res();},2000);
    });
    if(Number.isFinite(el.duration) && el.duration>0){ setDuration(el.duration); frozenDurRef.current=el.duration; publish(el.currentTime, el.duration, 1); }
    if(autoplay) await play();
  },[tracks, attachVideo, detachVideo, play]);

  const addFiles = useCallback((fl: FileList|File[])=>{
    const arr=Array.from(fl); if(arr.length===0) return;
    const nt: Track[] = arr.map((f,i)=>({ id:`${Date.now()}-${i}-${f.name}`, file:f, url:URL.createObjectURL(f), name:f.name.replace(/\.[^.]+$/,"")||f.name, mediaType: f.type.startsWith("video/")||/\.(mp4|mov|webm|m4v)$/i.test(f.name) ? "video":"audio" }));
    setTracks(prev=>{ const n=[...prev,...nt]; logRef.current(`Added ${nt.length} track(s). Now ${n.length}`); return n; });
  },[]);
  const removeTrack = useCallback((i:number)=>{ setTracks(prev=>{ const r=prev[i]; if(r) URL.revokeObjectURL(r.url); const n=prev.filter((_,j)=>j!==i); logRef.current(`Removed #${i+1}. Now ${n.length}`); return n; }); setCurrentIndex(prev=>{ if(i<prev) return prev-1; if(i===prev) return Math.max(0, Math.min(prev, Math.max(0, tracks.length-2))); return prev; }); },[tracks.length]);
  const clearPlaylist = useCallback(()=>{ setTracks(prev=>{ prev.forEach(t=>URL.revokeObjectURL(t.url)); return []; }); setCurrentIndex(0); const el=mediaRef.current; if(el){ el.pause(); el.removeAttribute("src"); el.load(); } detachVideo(); stopPin(); isFrozenRef.current=false; setIsPlaying(false); setCurrentTime(0); setDuration(0); setSessionOwner("none"); logRef.current("Playlist cleared"); },[detachVideo]);
  const goToTrack = useCallback((i:number)=>{ const list=tracks; if(list.length===0) return; const c=((i%list.length)+list.length)%list.length; logRef.current(`goToTrack(${c}) -> ${list[c]?.name}`); setCurrentIndex(c); },[tracks]);
  const nextTrack = useCallback(()=>{ if(tracks.length===0){ logRef.current("next: empty"); return; } if(tracks.length===1){ seek(0); void play(); return; } goToTrack(currentIndex+1); },[tracks.length, currentIndex, goToTrack, seek, play]);
  const prevTrack = useCallback(()=>{ if(tracks.length===0) return; const el=mediaRef.current; const pos=isFrozenRef.current? frozenPosRef.current : el?.currentTime??0; if(pos>3){ seek(0); return; } if(tracks.length===1){ seek(0); return; } goToTrack(currentIndex-1); },[tracks.length, goToTrack, seek]);

  // mount
  useEffect(()=>{
    const audio=document.createElement("audio"); audio.preload="auto"; audio.controls=false; audio.setAttribute("playsinline","true"); audio.setAttribute("webkit-playsinline","true"); audio.setAttribute("x-webkit-airplay","allow"); hideOffscreen(audio); document.body.appendChild(audio); mediaRef.current=audio;
    const onTime=()=>{ if(mediaRef.current!==audio) return; if(isFrozenRef.current){ pinFrozen(); return; } setCurrentTime(audio.currentTime); publish(audio.currentTime, audio.duration, 1); };
    const onMeta=()=>{ if(mediaRef.current!==audio) return; if(Number.isFinite(audio.duration)&&audio.duration>0){ setDuration(audio.duration); frozenDurRef.current=audio.duration; publish(audio.currentTime, audio.duration, isFrozenRef.current?0:1); } };
    const onPlay=()=>{ if(mediaRef.current!==audio) return; if(isFrozenRef.current) return; setIsPlaying(true); setSessionOwner("track"); if("mediaSession" in navigator){ navigator.mediaSession.playbackState="playing"; publish(audio.currentTime, audio.duration, 1); } if(videoRef.current?.src){ try{ videoRef.current.currentTime=audio.currentTime; videoRef.current.play().catch(()=>{});}catch{}; startVideoSync(); } logRef.current("track play event"); };
    const onPause=()=>{ if(mediaRef.current!==audio) return; if(isFrozenRef.current) return; if(document.visibilityState==="visible"||audio.ended){ setIsPlaying(false); if("mediaSession" in navigator){ navigator.mediaSession.playbackState="paused"; publish(audio.currentTime, audio.duration, 0); } stopVideo(); logRef.current("track pause event"); } else logRef.current("pause ignored (background)"); };
    const onEnded=()=>{ if(mediaRef.current!==audio) return; if(isFrozenRef.current) return; logRef.current("track ended"); window.dispatchEvent(new CustomEvent("playback-ended")); };
    const onError=()=>{ if(mediaRef.current!==audio) return; logRef.current("track error"); setIsPlaying(false); };
    audio.addEventListener("timeupdate",onTime); audio.addEventListener("loadedmetadata",onMeta); audio.addEventListener("durationchange",onMeta); audio.addEventListener("play",onPlay); audio.addEventListener("pause",onPause); audio.addEventListener("ended",onEnded); audio.addEventListener("error",onError);
    // timeupdate is background-safe pin for frozen state (rAF stops on lock screen)
    const onAnchorTime=()=>{ if(isFrozenRef.current) pinFrozen(); };
    audio.addEventListener("timeupdate", onAnchorTime);
    setAudioSessionType();
    return ()=>{ audio.removeEventListener("timeupdate",onTime); audio.removeEventListener("loadedmetadata",onMeta); audio.removeEventListener("durationchange",onMeta); audio.removeEventListener("play",onPlay); audio.removeEventListener("pause",onPause); audio.removeEventListener("ended",onEnded); audio.removeEventListener("error",onError); audio.removeEventListener("timeupdate",onAnchorTime); stopVideo(); stopPin(); audio.pause(); audio.removeAttribute("src"); audio.load(); audio.remove(); mediaRef.current=null; };
  },[pinFrozen, startVideoSync]);

  useEffect(()=>{ if(tracks.length===0){ const el=mediaRef.current; if(el){ el.pause(); el.removeAttribute("src"); el.load(); } detachVideo(); stopPin(); isFrozenRef.current=false; setIsPlaying(false); setCurrentTime(0); setDuration(0); setSessionOwner("none"); return; } const idx=Math.min(currentIndex, tracks.length-1); if(idx!==currentIndex){ setCurrentIndex(idx); return; } void loadTrack(idx, isPlaying); },[currentIndex, tracks, elementMode]); // eslint-disable-line
  useEffect(()=>{ const onEnded=()=>{ if(tracks.length===0) return; if(currentIndex < tracks.length-1){ setCurrentIndex(currentIndex+1); } else { setIsPlaying(false); if("mediaSession" in navigator) navigator.mediaSession.playbackState="paused"; // stay frozen at end to keep session
      const el=mediaRef.current; if(el){ frozenPosRef.current = el.currentTime; frozenDurRef.current = el.duration; isFrozenRef.current=true; setSessionOwner("frozen"); try{ el.volume=0.001; el.playbackRate=0.0001; }catch{}; stopPin(); const pin=()=>{ if(!isFrozenRef.current || !mediaRef.current || mediaRef.current.paused) return; pinFrozen(); rafPinRef.current=requestAnimationFrame(pin); }; rafPinRef.current=requestAnimationFrame(pin); logRef.current("end -> frozen keep-alive"); } } }; window.addEventListener("playback-ended",onEnded); return()=>window.removeEventListener("playback-ended",onEnded); },[tracks.length, currentIndex, pinFrozen]);
  useEffect(()=>{ const onVis=()=>{ logRef.current(`visibility -> ${document.visibilityState}`); if(document.visibilityState==="visible"){ const el=mediaRef.current; if(el && isFrozenRef.current && el.paused){ logRef.current("foreground frozen but paused — resume pin"); setAudioSessionType(); el.play().catch(()=>{}); } else if(el && !isFrozenRef.current && isPlaying && el.paused && !el.ended){ logRef.current("foreground should be playing — resume"); void play(); } } else { videoRef.current?.pause(); stopVideo(); } }; document.addEventListener("visibilitychange",onVis); return()=>document.removeEventListener("visibilitychange",onVis); },[isPlaying, play]);

  const armSession = async()=>{ const el=mediaRef.current; if(!el) return false; if(!el.paused){ logRef.current("arm skipped: already playing"); return true; } try{ setAudioSessionType(); await el.play(); await new Promise(r=>setTimeout(r,90)); el.pause(); logRef.current("arm done"); return true; }catch(e){ logRef.current(`arm failed: ${String(e)}`); return false; } };
  const recoverSession = async()=>{ logRef.current("recover: rebuild"); stopVideo(); stopPin(); isFrozenRef.current=false; setIsPlaying(false); setSessionOwner("none"); if(tracks[currentIndex]) await loadTrack(currentIndex,false); };

  return { tracks, currentIndex, currentTrack, isPlaying, currentTime, duration, sessionOwner, videoContainerRef, mediaRef, getDiagnostics, addFiles, removeTrack, clearPlaylist, armSession, recoverSession, play, pause, remotePauseOrResume, togglePlay, seek, seekRelative, nextTrack, prevTrack, goToTrack };
}
