import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  browseHome,
  coverUrl,
  fetchLyrics,
  formatTime,
  loadCollection,
  loadGenre,
  loadGenreMeta,
  loadStatus,
  importPlaylist,
  parseLrc,
  postPresence,
  setBackend,
  prefetch,
  searchCatalog,
  streamUrl,
  trackKey,
} from "./api.js";
import { GENRES } from "./genres.js";
import {
  AlertIcon,
  BackIcon,
  BrowseIcon,
  ClockIcon,
  CloseIcon,
  GearIcon,
  CopyIcon,
  HeartIcon,
  HomeIcon,
  ImportIcon,
  LibraryIcon,
  MoreIcon,
  NextIcon,
  PauseIcon,
  MicIcon,
  PlayIcon,
  PlaylistIcon,
  PrevIcon,
  QueueIcon,
  RefreshIcon,
  RepeatIcon,
  SearchIcon,
  ShuffleIcon,
  TrashIcon,
  VolumeIcon,
} from "./icons.jsx";

const LS_LIKED = "mc-liked";
const LS_RECENT = "mc-recent";
const LS_VOL = "mc-vol";
const LS_THEME = "mc-theme";
const LS_PLAYLISTS = "mc-playlists";
const LS_PRESENCE = "mc-presence";
const LS_PRESENCE_KEY = "mc-presence-key";

/**
 * Opaque per-browser key. It is a capability: whoever holds it can read what this
 * browser is playing, so it is random and regenerable rather than derived from
 * anything identifying.
 */
function makePresenceKey() {
  const bytes = new Uint8Array(18);
  (window.crypto || {}).getRandomValues?.(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(36).padStart(2, "0");
  return s.slice(0, 32) || Math.random().toString(36).slice(2).padEnd(16, "x");
}

function readPresenceKey() {
  let k = localStorage.getItem(LS_PRESENCE_KEY);
  if (!k || !/^[A-Za-z0-9_-]{12,64}$/.test(k)) {
    k = makePresenceKey();
    localStorage.setItem(LS_PRESENCE_KEY, k);
  }
  return k;
}

export const APP_NAME = "Lahsunn Player";
export const APP_AUTHOR = "Rajeev";
/** Swap this one line to use a different brand image from client/public. */
const BRAND_LOGO = "/logo.svg";

const THEMES = ["purple", "light"];
/** Older builds stored "monochrome"/"white"; map them onto the new purple theme. */
function readTheme() {
  const raw = localStorage.getItem(LS_THEME);
  if (raw === "white" || raw === "light") return "light";
  if (THEMES.includes(raw)) return raw;
  return "purple";
}

function loadJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function Art({ src, alt, className, onClick }) {
  const url = src ? coverUrl(src) : "";
  if (!url) return <div className={className} onClick={onClick} />;
  return <img className={className} src={url} alt={alt || ""} onClick={onClick} draggable={false} />;
}

function NavButton({ id, current, onClick, children, label }) {
  return (
    <button className={`nav-btn ${current === id ? "active" : ""}`} onClick={() => onClick(id)} title={label} aria-label={label}>
      {children}
    </button>
  );
}

function SeekBar({ value, max, onChange, wide }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="seek" style={wide ? { width: "100%", maxWidth: "none" } : undefined}>
      <span>{formatTime(value)}</span>
      <div className="seek-wrap">
        <div className="seek-track">
          <div className="seek-fill" style={{ width: `${pct}%` }} />
        </div>
        <input
          type="range"
          min={0}
          max={max || 0}
          step={0.1}
          value={Math.min(value, max || 0)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <span>{formatTime(max)}</span>
    </div>
  );
}

export default function App() {
  const audioRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(0);
  const canvasRef = useRef(null);
  const lyricsRef = useRef(null);
  const searchRef = useRef(null);

  const [view, setView] = useState("home");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [searchTab, setSearchTab] = useState("tracks");
  const [browse, setBrowse] = useState(null);
  const [collection, setCollection] = useState(null);
  const [collectionLoading, setCollectionLoading] = useState(false);

  const [queue, setQueue] = useState([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState("off");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem(LS_VOL) ?? 0.85));
  const [muted, setMuted] = useState(false);
  const [liked, setLiked] = useState(() => loadJson(LS_LIKED, []));
  const [recent, setRecent] = useState(() => loadJson(LS_RECENT, []));
  const [playlists, setPlaylists] = useState(() => loadJson(LS_PLAYLISTS, []));
  const [openList, setOpenList] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const [presenceOn, setPresenceOn] = useState(() => localStorage.getItem(LS_PRESENCE) === "1");
  const [presenceKey, setPresenceKey] = useState(readPresenceKey);
  const [panel, setPanel] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [lyrics, setLyrics] = useState(null);
  const [lyricsStatus, setLyricsStatus] = useState("idle");
  const [ctxMenu, setCtxMenu] = useState(null);
  const [theme, setTheme] = useState(readTheme);
  const [status, setStatus] = useState(null);
  const [notice, setNotice] = useState(null);
  const [noticeHidden, setNoticeHidden] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [genres, setGenres] = useState([]);
  const [genresLoading, setGenresLoading] = useState(false);
  const [genrePage, setGenrePage] = useState(null);
  const [genreLoading, setGenreLoading] = useState(false);
  const streamRetry = useRef(0);
  const failStreak = useRef(0);
  const statusRef = useRef(null);
  const genreProbe = useRef(0);

  const current = index >= 0 ? queue[index] : null;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(LS_THEME, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(LS_LIKED, JSON.stringify(liked.slice(0, 400)));
  }, [liked]);
  useEffect(() => {
    localStorage.setItem(LS_RECENT, JSON.stringify(recent.slice(0, 80)));
  }, [recent]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_PLAYLISTS, JSON.stringify(playlists.slice(0, 100)));
    } catch {
      // A few large imports can exceed the ~5MB quota; keep the app usable.
      setImportMsg({
        err: true,
        text: "Out of browser storage — delete an imported playlist to save more.",
      });
    }
  }, [playlists]);
  useEffect(() => {
    localStorage.setItem(LS_VOL, String(volume));
    if (audioRef.current) audioRef.current.volume = muted ? 0 : volume;
  }, [volume, muted]);

  const refreshStatus = useCallback((force = false) => {
    return loadStatus(force)
      .then((s) => {
        setStatus(s);
        statusRef.current = s;
        return s;
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    browseHome()
      .then((b) => {
        setBrowse(b);
        if (b?.warning) setNotice({ kind: "err", text: b.warning });
      })
      .catch(() =>
        setBrowse({
          songs: [],
          albums: [],
          artists: [],
          picks: [],
          warning: "Could not reach the player's own API.",
        })
      );
    refreshStatus();
  }, [refreshStatus]);

  // A blank page should always explain itself.
  useEffect(() => {
    if (!status) return;
    const canPlay = status.audio?.ytdlp || status.audio?.mode === "plugin";
    const canSearch = status.node?.ok || status.backend?.effective === "ytdlp";

    // Playback is the thing that actually matters; report it first.
    if (!canPlay) {
      setNotice({
        kind: "err",
        text: status.audio?.ytdlpError
          ? `Nothing can play yet — ${status.audio.ytdlpError}`
          : "Nothing can play yet — the server is still setting up yt-dlp.",
        hints: [
          "The server tries to download yt-dlp by itself; hit retry in a few seconds.",
          "If it keeps failing, redeploy on Render using the Docker runtime — this repo's Dockerfile installs yt-dlp and ffmpeg.",
        ],
      });
      return;
    }
    if (!canSearch) {
      setNotice({
        kind: "err",
        text: status.node?.error || "Lavalink is not reachable.",
        hints: status.hints || [],
      });
      return;
    }
    // Everything needed is working. Mention the fallback without alarming.
    if (!status.node?.ok && status.backend?.effective === "ytdlp") {
      setNotice({
        kind: "warn",
        text: "Lavalink is offline, so music is coming straight from yt-dlp instead.",
        hints: ["Search and playback work. Album and artist pages need Lavalink."],
      });
      return;
    }
    setNotice(null);
  }, [status]);

  /* --- Discord presence ------------------------------------------------ *
   * Push what is playing to the server so the companion script (which runs on
   * the same machine as Discord) can relay it. Cosmetic only.
   * -------------------------------------------------------------------- */

  useEffect(() => {
    localStorage.setItem(LS_PRESENCE, presenceOn ? "1" : "0");
  }, [presenceOn]);

  // Keep the latest values in a ref so the heartbeat does not resubscribe
  // every second as the position changes.
  const presenceRef = useRef({});
  presenceRef.current = { current, playing, currentTime, duration };

  useEffect(() => {
    if (!presenceOn) return undefined;

    const send = () => {
      const { current: t, playing: p, currentTime: pos, duration: dur } = presenceRef.current;
      if (!t) return;
      postPresence({
        key: presenceKey,
        playing: !!p,
        title: t.title,
        author: t.author,
        album: t.album || "",
        artwork: t.artwork || null,
        url: t.uri || null,
        duration: Math.round(dur || (t.duration || 0) / 1000),
        position: Math.round(pos || 0),
      });
    };

    send();
    // The server treats a mailbox older than ~45s as dead, so refresh well inside that.
    const id = setInterval(send, 15000);
    return () => clearInterval(id);
  }, [presenceOn, presenceKey, current && trackKey(current), playing]);

  const regeneratePresenceKey = useCallback(() => {
    const k = makePresenceKey();
    localStorage.setItem(LS_PRESENCE_KEY, k);
    setPresenceKey(k);
  }, []);

  const dismissNotice = useCallback(() => setNoticeHidden(true), []);
  const retryNotice = useCallback(() => {
    setNoticeHidden(false);
    refreshStatus(true).then((s) => {
      if (s?.node?.ok) {
        setNotice(null);
        browseHome()
          .then(setBrowse)
          .catch(() => {});
      }
    });
  }, [refreshStatus]);

  useEffect(() => {
    // On these views the search box acts as a local filter, not a catalog search.
    if (view === "browse" || view === "genre" || view === "playlists" || view === "playlist") {
      return undefined;
    }
    const t = setTimeout(() => {
      const q = query.trim();
      if (!q) {
        setResults(null);
        setSearching(false);
        return;
      }
      setSearching(true);
      searchCatalog(q)
        .then((r) => {
          setResults(r);
          setView("search");
          // The server answers 200 with a `warning` when a source misbehaves, so
          // "no results" can say why instead of looking like an empty catalogue.
          if (r?.warning) setNotice({ kind: "err", text: r.warning, hints: r.errors || [] });
        })
        .catch(() =>
          setResults({
            tracks: [],
            albums: [],
            artists: [],
            playlists: [],
            warning: "Search request failed.",
          })
        )
        .finally(() => setSearching(false));
    }, 280);
    return () => clearTimeout(t);
  }, [query, view]);

  const isLiked = useCallback((t) => liked.some((x) => trackKey(x) === trackKey(t)), [liked]);

  const toggleLike = useCallback((t) => {
    if (!t) return;
    setLiked((prev) => {
      const k = trackKey(t);
      if (prev.some((x) => trackKey(x) === k)) return prev.filter((x) => trackKey(x) !== k);
      return [t, ...prev];
    });
  }, []);

  const pushRecent = useCallback((t) => {
    setRecent((prev) => [t, ...prev.filter((x) => trackKey(x) !== trackKey(t))].slice(0, 80));
  }, []);

  const playAt = useCallback(
    (list, i) => {
      setQueue(list);
      setIndex(i);
      setPlaying(true);
      const t = list[i];
      if (t) {
        pushRecent(t);
        prefetch(list[i + 1]);
      }
    },
    [pushRecent]
  );

  const playTrack = useCallback(
    (track, list) => {
      const src = list && list.length ? list : [track];
      const i = Math.max(0, src.findIndex((x) => trackKey(x) === trackKey(track)));
      playAt(src, i);
    },
    [playAt]
  );

  const addToQueue = (track) => {
    setQueue((q) => (q.length ? [...q, track] : [track]));
    if (index < 0) {
      setIndex(0);
      setPlaying(true);
    }
  };
  const playNext = (track) => {
    setQueue((q) => {
      if (!q.length) {
        setIndex(0);
        setPlaying(true);
        return [track];
      }
      const next = [...q];
      next.splice(index + 1, 0, track);
      return next;
    });
  };

  const skip = useCallback(
    (dir) => {
      if (!queue.length) return;
      if (dir < 0 && currentTime > 3) {
        if (audioRef.current) audioRef.current.currentTime = 0;
        return;
      }
      setIndex((i) => {
        if (shuffle && queue.length > 1) {
          let n = i;
          while (n === i) n = Math.floor(Math.random() * queue.length);
          return n;
        }
        const n = i + dir;
        if (n < 0) return repeat === "all" ? queue.length - 1 : 0;
        if (n >= queue.length) return repeat === "all" ? 0 : i;
        return n;
      });
      setPlaying(true);
    },
    [queue, shuffle, repeat, currentTime]
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    const url = streamUrl(current);
    if (audio.src !== new URL(url, window.location.href).href) {
      audio.src = url;
      setBuffering(true);
      streamRetry.current = 0; // retries are per track, not per session
    }
    audio.volume = muted ? 0 : volume;
    const p = audio.play();
    if (p) p.catch(() => setPlaying(false));
    setLyrics(null);
    setLyricsStatus("loading");
    fetchLyrics(current)
      .then((l) => {
        setLyrics(l);
        setLyricsStatus(l ? "ok" : "empty");
      })
      .catch(() => setLyricsStatus("empty"));
    prefetch(queue[index + 1]);
    if ("mediaSession" in navigator) {
      const art = current.artwork ? coverUrl(current.artwork) : null;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: current.author,
        album: current.album || APP_NAME,
        // Offer several sizes so lock screens and Android notifications pick well.
        artwork: art
          ? ["96x96", "192x192", "256x256", "384x384", "512x512"].map((sizes) => ({
              src: art,
              sizes,
              type: "image/jpeg",
            }))
          : [{ src: BRAND_LOGO, sizes: "512x512", type: "image/svg+xml" }],
      });
    }
  }, [current && trackKey(current)]);

  /* --- background playback -------------------------------------------- *
   * Audio keeps running while the tab is hidden; these handlers are what
   * make the OS lock screen / notification controls work.
   * ------------------------------------------------------------------- */

  useEffect(() => {
    if (!("mediaSession" in navigator)) return undefined;
    const audio = audioRef.current;
    const set = (action, fn) => {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        // Not every browser supports every action.
      }
    };
    set("play", () => {
      setPlaying(true);
      audio?.play().catch(() => {});
    });
    set("pause", () => {
      setPlaying(false);
      audio?.pause();
    });
    set("previoustrack", () => skip(-1));
    set("nexttrack", () => skip(1));
    set("stop", () => {
      setPlaying(false);
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    });
    set("seekbackward", (d) => {
      if (audio) audio.currentTime = Math.max(0, audio.currentTime - (d?.seekOffset || 10));
    });
    set("seekforward", (d) => {
      if (audio) audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (d?.seekOffset || 10));
    });
    set("seekto", (d) => {
      if (!audio || d?.seekTime == null) return;
      if (d.fastSeek && audio.fastSeek) audio.fastSeek(d.seekTime);
      else audio.currentTime = d.seekTime;
      setCurrentTime(d.seekTime);
    });
    return () => {
      for (const a of ["play", "pause", "previoustrack", "nexttrack", "stop", "seekbackward", "seekforward", "seekto"]) {
        set(a, null);
      }
    };
  }, [skip]);

  // Keep the OS scrubber in sync.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!current || !Number.isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(Math.max(currentTime, 0), duration),
        playbackRate: audioRef.current?.playbackRate || 1,
      });
    } catch {
      // Ignore transient position/duration mismatches while a track loads.
    }
  }, [current, duration, Math.floor(currentTime), playing]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = current ? (playing ? "playing" : "paused") : "none";
  }, [playing, current]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.play().catch(() => {});
    else audio.pause();
  }, [playing]);

  const onEnded = () => {
    if (repeat === "one") {
      const a = audioRef.current;
      if (a) {
        a.currentTime = 0;
        a.play().catch(() => setPlaying(false));
      }
      return;
    }
    if (index < queue.length - 1 || repeat === "all") skip(1);
    else setPlaying(false);
  };

  /**
   * A track that will not load must not kill the session.
   *
   * Previously the retry counter was global and never reset, so after three
   * failures anywhere the handler returned silently forever: playback appeared
   * to just stop with no message and no way to recover without a reload.
   * Retries are now per track, and once they are spent we say so and move on.
   */
  const onStreamError = useCallback(() => {
    setBuffering(false);
    const audio = audioRef.current;
    if (!audio || !current) return;

    if (streamRetry.current < 2) {
      streamRetry.current += 1;
      audio.src = `${streamUrl(current)}&retry=${streamRetry.current}&t=${Date.now()}`;
      audio.load();
      audio.play().catch(() => {});
      return;
    }

    const failed = current;
    failStreak.current += 1;

    // If several tracks in a row fail, the server is broken, not the track.
    // Skipping onward would silently churn the entire queue, which looks like
    // the player "looping and doing nothing".
    if (failStreak.current >= 3) {
      setPlaying(false);
      setNotice({
        kind: "err",
        text: `${failStreak.current} tracks in a row failed to play, so playback stopped.`,
        hints: [
          statusRef.current?.audio?.ytdlp === false
            ? "yt-dlp is not available on the server — that is the cause. Open Settings to see the details."
            : "Open Settings to check the server status, or run npm run doctor.",
          "On Render, deploying with the Docker runtime installs yt-dlp and ffmpeg for you.",
        ],
      });
      refreshStatus(true);
      return;
    }

    const more = index < queue.length - 1;
    setNotice({
      kind: "err",
      text: `Could not play “${failed.title}”${failed.author ? ` by ${failed.author}` : ""}.`,
      hints: more ? ["Skipped to the next track."] : ["Open Settings to check the server status."],
    });
    if (more) skip(1);
    else setPlaying(false);
  }, [current, index, queue.length, skip, refreshStatus]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Escape") {
        setPanel(null);
        setFullscreen(false);
        setCtxMenu(null);
        return;
      }
      if (!typing && (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k"))) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing) return;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight" && e.shiftKey) skip(1);
      else if (e.key === "ArrowLeft" && e.shiftKey) skip(-1);
      else if (e.key === "ArrowRight") {
        if (audioRef.current) audioRef.current.currentTime += 10;
      } else if (e.key === "ArrowLeft") {
        if (audioRef.current) audioRef.current.currentTime -= 10;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setVolume((v) => Math.min(1, v + 0.05));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setVolume((v) => Math.max(0, v - 0.05));
      } else if (e.key.toLowerCase() === "m") setMuted((m) => !m);
      else if (e.key.toLowerCase() === "s") setShuffle((s) => !s);
      else if (e.key.toLowerCase() === "r")
        setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off"));
      else if (e.key.toLowerCase() === "q") setPanel((p) => (p === "queue" ? null : "queue"));
      else if (e.key.toLowerCase() === "l") setPanel((p) => (p === "lyrics" ? null : "lyrics"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skip]);

  const openCollection = async (item) => {
    if (!item?.url) return;
    setCollectionLoading(true);
    setView("collection");
    setCollection({ info: item, tracks: [] });
    try {
      const data = await loadCollection(item.url);
      setCollection(data);
    } catch {
      /* keep header */
    } finally {
      setCollectionLoading(false);
    }
  };

  const lrc = useMemo(() => parseLrc(lyrics?.syncedLyrics || ""), [lyrics]);
  const lyricIndex = useMemo(() => {
    if (!lrc.length) return -1;
    let i = 0;
    for (let n = 0; n < lrc.length; n++) if (lrc[n].t <= currentTime + 0.15) i = n;
    return i;
  }, [lrc, currentTime]);

  useEffect(() => {
    if (panel !== "lyrics") return;
    let raf = 0;
    const align = () => {
      const track = lyricsRef.current;
      if (!track) return;
      const active = track.querySelector("[data-active='1']");
      const view = track.parentElement;
      if (!active || !view) return;
      const y = active.offsetTop - view.clientHeight * 0.2;
      track.style.transform = `translate3d(0, ${-y}px, 0)`;
    };
    raf = requestAnimationFrame(() => {
      align();
      raf = requestAnimationFrame(align);
    });
    return () => cancelAnimationFrame(raf);
  }, [lyricIndex, panel, lrc.length, lyricsStatus]);

  /**
   * Once createMediaElementSource() runs, ALL audio is routed through the
   * AudioContext for the lifetime of the page — and it cannot be undone. If that
   * context is ever suspended (backgrounding a tab, or the autoplay policy) the
   * element keeps "playing" but outputs silence. So whenever the context exists
   * and we intend to play, force it back to running.
   */
  useEffect(() => {
    const resume = () => {
      const ctx = analyserRef.current?.ctx;
      if (ctx && ctx.state === "suspended" && playing) ctx.resume().catch(() => {});
    };
    resume();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [playing]);

  useEffect(() => {
    if (!fullscreen || !audioRef.current) return;
    try {
      if (!analyserRef.current) {
        const ctx = new AudioContext();
        const src = ctx.createMediaElementSource(audioRef.current);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        analyser.connect(ctx.destination);
        analyserRef.current = { ctx, analyser };
      }
      analyserRef.current.ctx.resume();
      const analyser = analyserRef.current.analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        rafRef.current = requestAnimationFrame(draw);
        const c = canvasRef.current;
        if (!c) return;
        const g = c.getContext("2d");
        const w = (c.width = c.clientWidth * devicePixelRatio);
        const h = (c.height = c.clientHeight * devicePixelRatio);
        analyser.getByteFrequencyData(data);
        g.clearRect(0, 0, w, h);
        const bars = 48;
        const step = Math.floor(data.length / bars);
        const bw = w / bars;
        g.fillStyle =
          getComputedStyle(document.documentElement).getPropertyValue("--accent-3").trim() || "#d8b4fe";
        for (let i = 0; i < bars; i++) {
          const v = data[i * step] / 255;
          const bh = v * h;
          g.globalAlpha = 0.35 + v * 0.65;
          g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
        }
      };
      draw();
      return () => cancelAnimationFrame(rafRef.current);
    } catch {
      /* visualizer optional */
    }
  }, [fullscreen]);

  const goHome = () => {
    setView("home");
    setPanel(null);
  };

  const openBrowse = () => {
    setView("browse");
    setGenrePage(null);
    setQuery("");
    setGenres([]);
    setGenresLoading(true);
    const token = ++genreProbe.current;
    // named `pending`, not `queue` — `queue` is the playback queue state
    const pending = [...GENRES];
    const workers = Array.from({ length: 6 }, async () => {
      while (pending.length) {
        if (genreProbe.current !== token) return;
        const g = pending.shift();
        try {
          const d = await loadGenreMeta(g.id);
          if (genreProbe.current !== token) return;
          if (d?.ok && d.genre && (d.genre.trackCount || 0) > 0) {
            setGenres((prev) => (prev.some((x) => x.id === d.genre.id) ? prev : [...prev, d.genre]));
          }
        } catch {
          /* skip */
        }
      }
    });
    Promise.all(workers).then(() => {
      if (genreProbe.current === token) setGenresLoading(false);
    });
  };

  const runImport = useCallback(async (value) => {
    const text = String(value || "").trim();
    if (!text || importing) return;
    setImporting(true);
    setImportMsg(null);
    try {
      const r = await importPlaylist(text);
      if (!r?.ok) {
        setImportMsg({ err: true, text: r?.error || "Import failed.", hints: r?.hints || [] });
        return;
      }
      if (!r.tracks?.length) {
        setImportMsg({ err: true, text: "That playlist came back empty." });
        return;
      }
      const list = {
        id: `pl${Date.now().toString(36)}`,
        name: r.name || "Imported playlist",
        author: r.author || "",
        artwork: r.artwork || null,
        via: r.via,
        url: r.url || null,
        addedAt: Date.now(),
        tracks: r.tracks,
      };
      // Re-importing the same link replaces the old copy instead of duplicating.
      setPlaylists((prev) => [list, ...prev.filter((p) => !(p.url && list.url && p.url === list.url))]);
      setImportMsg({
        text: `Imported ${r.tracks.length} track${r.tracks.length === 1 ? "" : "s"} via ${r.via}${
          r.truncated ? " (list was truncated)" : ""
        }.`,
      });
      setOpenList(list);
      setView("playlist");
    } catch {
      setImportMsg({ err: true, text: "Could not reach the import API." });
    } finally {
      setImporting(false);
    }
  }, [importing]);

  const deletePlaylist = useCallback(
    (id) => {
      setPlaylists((prev) => prev.filter((p) => p.id !== id));
      setOpenList((cur) => (cur?.id === id ? null : cur));
      setView((v) => (v === "playlist" ? "playlists" : v));
    },
    []
  );

  const openPlaylist = (pl) => {
    setOpenList(pl);
    setView("playlist");
  };

  const openGenre = (g) => {
    setView("genre");
    setGenrePage({ info: g, tracks: [] });
    setGenreLoading(true);
    loadGenre(g.id)
      .then((d) => setGenrePage({ info: d.genre || g, tracks: d.tracks || [] }))
      .catch(() => setGenrePage({ info: g, tracks: [] }))
      .finally(() => setGenreLoading(false));
  };

  return (
    <div className={`app ${panel === "lyrics" ? "lyrics-open" : ""}`} onClick={() => ctxMenu && setCtxMenu(null)}>
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        preload="auto"
        playsInline
        onTimeUpdate={() => {
          const a = audioRef.current;
          setCurrentTime(a.currentTime);
          setDuration(a.duration || (current?.duration || 0) / 1000);
        }}
        onLoadedMetadata={() => setDuration(audioRef.current.duration || 0)}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => {
          setBuffering(false);
          setPlaying(true);
          failStreak.current = 0; // audio is flowing again
        }}
        onEnded={onEnded}
        onError={onStreamError}
      />

      <aside className="sidebar">
        <div className="brand" title={`${APP_NAME} — by ${APP_AUTHOR}`}>
          <img src={BRAND_LOGO} alt={APP_NAME} />
        </div>
        <NavButton id="home" current={view} onClick={goHome} label="Home">
          <HomeIcon />
        </NavButton>
        <NavButton id="search" current={view} onClick={setView} label="Search">
          <SearchIcon />
        </NavButton>
        <NavButton id="library" current={view} onClick={setView} label="Library">
          <LibraryIcon />
        </NavButton>
        <NavButton id="playlists" current={view} onClick={setView} label="Playlists">
          <PlaylistIcon />
        </NavButton>
        <NavButton id="recent" current={view} onClick={setView} label="Recently played">
          <ClockIcon />
        </NavButton>
        <div className="spacer" />
        <NavButton id="settings" current={view} onClick={setView} label="Settings">
          <GearIcon />
        </NavButton>
      </aside>

      <main className="main">
        <div className="topbar">
          {(view === "collection" || view === "genre" || view === "playlist") && (
            <button
              className="icon-btn"
              onClick={() => setView(view === "genre" ? "browse" : view === "playlist" ? "playlists" : "home")}
              aria-label="Back"
            >
              <BackIcon />
            </button>
          )}
          <div className="search-wrap">
            <SearchIcon size={18} className="search-ico" />
            <input
              ref={searchRef}
              placeholder="Search songs, albums, artists…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => {
                if (view === "browse" || view === "genre" || view === "playlists" || view === "playlist") return;
                if (query.trim()) setView("search");
              }}
            />
            <button
              className={`browse-toggle ${view === "browse" || view === "genre" ? "on" : ""}`}
              onClick={openBrowse}
              title="Browse all"
              aria-label="Browse all"
            >
              <BrowseIcon size={18} />
            </button>
          </div>
        </div>
        <div className="content">
          {notice && !noticeHidden && (
            <Notice notice={notice} onRetry={retryNotice} onClose={dismissNotice} />
          )}
          {view === "home" && (
            <Home
              browse={browse}
              recent={recent}
              onPlayTrack={playTrack}
              onOpen={openCollection}
              onContext={setCtxMenu}
            />
          )}
          {view === "search" && (
            <SearchPage
              query={query}
              searching={searching}
              results={results}
              tab={searchTab}
              setTab={setSearchTab}
              onPlayTrack={playTrack}
              onOpen={openCollection}
              onContext={setCtxMenu}
            />
          )}
          {view === "library" && (
            <>
              <h1 className="page-title">Library</h1>
              <p className="page-sub">Liked tracks saved on this device.</p>
              {liked.length ? (
                <TrackList
                  tracks={liked}
                  current={current}
                  playing={playing}
                  onPlay={playTrack}
                  onLike={toggleLike}
                  isLiked={isLiked}
                  onContext={setCtxMenu}
                />
              ) : (
                <div className="empty">Like songs while you listen — they’ll land here.</div>
              )}
            </>
          )}
          {view === "recent" && (
            <>
              <h1 className="page-title">Recently played</h1>
              {recent.length ? (
                <TrackList
                  tracks={recent}
                  current={current}
                  playing={playing}
                  onPlay={playTrack}
                  onLike={toggleLike}
                  isLiked={isLiked}
                  onContext={setCtxMenu}
                />
              ) : (
                <div className="empty">Nothing yet. Search for a song to get started.</div>
              )}
            </>
          )}
          {view === "playlists" && (
            <PlaylistsPage
              playlists={playlists}
              importing={importing}
              message={importMsg}
              status={status}
              onImport={runImport}
              onOpen={openPlaylist}
              onDelete={deletePlaylist}
              onDismiss={() => setImportMsg(null)}
            />
          )}
          {view === "playlist" && openList && (
            <PlaylistPage
              list={openList}
              current={current}
              playing={playing}
              filter={query}
              onPlay={playTrack}
              onLike={toggleLike}
              isLiked={isLiked}
              onContext={setCtxMenu}
              onDelete={deletePlaylist}
              onBack={() => setView("playlists")}
            />
          )}
          {view === "collection" && collection && (
            <CollectionPage
              data={collection}
              loading={collectionLoading}
              current={current}
              playing={playing}
              onPlay={playTrack}
              onLike={toggleLike}
              isLiked={isLiked}
              onContext={setCtxMenu}
            />
          )}
          {view === "browse" && (
            <BrowsePage genres={genres} filter={query} loading={genresLoading} onOpen={openGenre} />
          )}
          {view === "genre" && genrePage && (
            <GenrePage
              data={genrePage}
              loading={genreLoading}
              filter={query}
              current={current}
              playing={playing}
              onPlay={playTrack}
              onLike={toggleLike}
              isLiked={isLiked}
              onContext={setCtxMenu}
            />
          )}
          {view === "settings" && (
            <Settings
              theme={theme}
              setTheme={setTheme}
              status={status}
              onRefresh={() => refreshStatus(true)}
              presenceOn={presenceOn}
              setPresenceOn={setPresenceOn}
              presenceKey={presenceKey}
              onRegenerateKey={regeneratePresenceKey}
            />
          )}
        </div>
      </main>

      <footer className="player">
        <div className="now">
          {current?.artwork ? (
            <Art src={current.artwork} alt="" onClick={() => setFullscreen(true)} />
          ) : (
            <div className="ph" onClick={() => current && setFullscreen(true)}>
              <LibraryIcon size={18} />
            </div>
          )}
          <div className="txt">
            <div className="t">{current?.title || "Nothing playing"}</div>
            <div className="a">
              {buffering && current ? "Loading…" : current?.author || "Search to start listening"}
            </div>
          </div>
          {current && (
            <button className={`icon-btn ${isLiked(current) ? "on" : ""}`} onClick={() => toggleLike(current)}>
              <HeartIcon filled={isLiked(current)} size={18} />
            </button>
          )}
        </div>
        <div className="controls">
          <div className="ctrl-row">
            <button className={`icon-btn ${shuffle ? "on" : ""}`} onClick={() => setShuffle((s) => !s)} title="Shuffle">
              <ShuffleIcon size={18} />
            </button>
            <button className="icon-btn" onClick={() => skip(-1)} title="Previous">
              <PrevIcon size={20} />
            </button>
            <button
              className={`play-main ${buffering ? "loading" : ""}`}
              onClick={() => current && setPlaying((p) => !p)}
              title={buffering ? "Loading…" : "Play/Pause"}
              aria-busy={buffering ? "true" : "false"}
            >
              {buffering ? (
                <span className="spinner" />
              ) : playing ? (
                <PauseIcon size={18} />
              ) : (
                <PlayIcon size={18} />
              )}
            </button>
            <button className="icon-btn" onClick={() => skip(1)} title="Next">
              <NextIcon size={20} />
            </button>
            <button
              className={`icon-btn ${repeat !== "off" ? "on" : ""}`}
              onClick={() => setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off"))}
              title="Repeat"
            >
              <RepeatIcon size={18} one={repeat === "one"} />
            </button>
          </div>
          <SeekBar
            value={currentTime}
            max={duration || 0}
            onChange={(v) => {
              if (audioRef.current) audioRef.current.currentTime = v;
              setCurrentTime(v);
            }}
          />
        </div>
        <div className="extras">
          <button className={`icon-btn ${panel === "lyrics" ? "on" : ""}`} onClick={() => setPanel(panel === "lyrics" ? null : "lyrics")} title="Lyrics">
            <MicIcon size={18} />
          </button>
          <button className={`icon-btn ${panel === "queue" ? "on" : ""}`} onClick={() => setPanel(panel === "queue" ? null : "queue")} title="Queue">
            <QueueIcon size={18} />
          </button>
          <div className="vol">
            <button className="icon-btn" onClick={() => setMuted((m) => !m)}>
              <VolumeIcon size={18} level={muted ? 0 : volume} />
            </button>
            <div className="vol-wrap">
              <div className="vol-track">
                <div className="vol-fill" style={{ width: `${(muted ? 0 : volume) * 100}%` }} />
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  setMuted(false);
                  setVolume(Number(e.target.value));
                }}
              />
            </div>
          </div>
        </div>
      </footer>

      <nav className="mobile-nav">
        <NavButton id="home" current={view} onClick={goHome} label="Home"><HomeIcon size={20} /></NavButton>
        <NavButton id="search" current={view} onClick={setView} label="Search"><SearchIcon size={20} /></NavButton>
        <NavButton id="library" current={view} onClick={setView} label="Library"><LibraryIcon size={20} /></NavButton>
        <NavButton id="playlists" current={view} onClick={setView} label="Playlists"><PlaylistIcon size={20} /></NavButton>
        <NavButton id="recent" current={view} onClick={setView} label="Recent"><ClockIcon size={20} /></NavButton>
        <NavButton id="settings" current={view} onClick={setView} label="Settings"><GearIcon size={20} /></NavButton>
      </nav>

      {panel === "lyrics" && (
        <aside className="lyrics-stage" aria-label="Lyrics">
          <div
            className="lyrics-bg"
            style={{ backgroundImage: current?.artwork ? `url(${coverUrl(current.artwork)})` : "none" }}
          />
          <div className="lyrics-veil" />
          <button className="icon-btn lyrics-close" onClick={() => setPanel(null)} aria-label="Close lyrics">
            <CloseIcon />
          </button>
          <div className="lyrics-viewport">
            {!current && <div className="empty">Play a song to see lyrics.</div>}
            {current && lyricsStatus === "loading" && <div className="empty">Fetching lyrics…</div>}
            {current && lyricsStatus === "empty" && <div className="empty">No lyrics found for this track.</div>}
            {lyrics?.instrumental && <div className="empty">Instrumental</div>}
            {lrc.length > 0 && (
              <div className="lyrics-track" ref={lyricsRef}>
                {lrc.map((line, i) => {
                  const dist = i - lyricIndex;
                  const kind = dist === 0 ? "on" : dist < 0 ? "past" : `next n${Math.min(dist, 6)}`;
                  return (
                    <button
                      type="button"
                      key={i}
                      data-active={dist === 0 ? "1" : "0"}
                      className={`lyric-line ${kind}`}
                      onClick={() => {
                        if (audioRef.current) audioRef.current.currentTime = line.t;
                      }}
                    >
                      {line.text || "♪"}
                    </button>
                  );
                })}
              </div>
            )}
            {!lrc.length && lyrics?.plainLyrics && (
              <div className="lyrics-track lyrics-plain">{lyrics.plainLyrics}</div>
            )}
          </div>
        </aside>
      )}

      {panel === "queue" && (
        <aside className="drawer">
          <header>
            <h3>Queue</h3>
            <button className="icon-btn" onClick={() => setPanel(null)}><CloseIcon /></button>
          </header>
          <div className="body">
            {queue.length ? (
              <TrackList
                tracks={queue}
                current={current}
                playing={playing}
                onPlay={(t, list) => playTrack(t, list)}
                onLike={toggleLike}
                isLiked={isLiked}
                onContext={setCtxMenu}
                dense
              />
            ) : (
              <div className="empty">Queue is empty.</div>
            )}
          </div>
        </aside>
      )}

      {fullscreen && current && (
        <div className="fs" onClick={() => setFullscreen(false)}>
          <div className="bg" style={{ backgroundImage: current.artwork ? `url(${coverUrl(current.artwork)})` : "none" }} />
          <div className="inner" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" style={{ alignSelf: "flex-end" }} onClick={() => setFullscreen(false)}>
              <CloseIcon />
            </button>
            <div className="art"><Art src={current.artwork} alt="" /></div>
            <h2>{current.title}</h2>
            <p>{current.author}</p>
            <canvas ref={canvasRef} />
            <div className="ctrl-row">
              <button className="icon-btn" onClick={() => skip(-1)}><PrevIcon /></button>
              <button className="play-main" onClick={() => setPlaying((p) => !p)}>
                {playing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button className="icon-btn" onClick={() => skip(1)}><NextIcon /></button>
            </div>
            <div className="seek" style={{ width: "100%" }}>
              <span>{formatTime(currentTime)}</span>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={Math.min(currentTime, duration || 0)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (audioRef.current) audioRef.current.currentTime = v;
                  setCurrentTime(v);
                }}
              />
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        </div>
      )}

      {ctxMenu && (
        <div className="ctx" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { playTrack(ctxMenu.track, ctxMenu.list); setCtxMenu(null); }}>Play</button>
          <button onClick={() => { playNext(ctxMenu.track); setCtxMenu(null); }}>Play next</button>
          <button onClick={() => { addToQueue(ctxMenu.track); setCtxMenu(null); }}>Add to queue</button>
          <button onClick={() => { toggleLike(ctxMenu.track); setCtxMenu(null); }}>
            {isLiked(ctxMenu.track) ? "Unlike" : "Like"}
          </button>
          {ctxMenu.track.albumUrl && (
            <button onClick={() => { openCollection({ url: ctxMenu.track.albumUrl, name: ctxMenu.track.album, type: "album" }); setCtxMenu(null); }}>
              Go to album
            </button>
          )}
          {ctxMenu.track.artistUrl && (
            <button onClick={() => { openCollection({ url: ctxMenu.track.artistUrl, name: ctxMenu.track.author, type: "artist" }); setCtxMenu(null); }}>
              Go to artist
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Explains why the catalogue is empty rather than showing a blank page. */
function Notice({ notice, onRetry, onClose }) {
  const hints = (notice.hints || []).filter(Boolean).slice(0, 4);
  return (
    <div className={`banner ${notice.kind === "err" ? "err" : ""}`} role="status">
      <span className="b-ico">
        <AlertIcon size={18} />
      </span>
      <div className="b-body">
        <div className="b-title">{notice.kind === "err" ? "Something needs attention" : "Heads up"}</div>
        <div className="b-text">{notice.text}</div>
        {hints.length > 0 && (
          <ul>
            {hints.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        )}
      </div>
      <button className="icon-btn b-close" onClick={onRetry} title="Retry" aria-label="Retry">
        <RefreshIcon size={16} />
      </button>
      <button className="icon-btn b-close" onClick={onClose} title="Dismiss" aria-label="Dismiss">
        <CloseIcon size={16} />
      </button>
    </div>
  );
}

const IMPORT_EXAMPLES = [
  "https://open.spotify.com/playlist/…",
  "https://www.youtube.com/playlist?list=…",
  "lastfm:username",
];

function PlaylistsPage({
  playlists,
  importing,
  message,
  status,
  onImport,
  onOpen,
  onDelete,
  onDismiss,
}) {
  const [value, setValue] = useState("");
  const imp = status?.importers;

  const submit = (e) => {
    e.preventDefault();
    onImport(value);
  };

  return (
    <>
      <h1 className="page-title">Playlists</h1>
      <p className="page-sub">
        Import from Spotify, YouTube, Apple Music, Deezer or Last.fm. Playlists are saved on this device.
      </p>

      <form className="import-box" onSubmit={submit}>
        <div className="import-row">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste a playlist link, or lastfm:username"
            aria-label="Playlist link or Last.fm username"
            spellCheck={false}
            autoComplete="off"
          />
          <button className="btn" type="submit" disabled={importing || !value.trim()}>
            {importing ? <span className="spinner" /> : <ImportIcon size={17} />}
            <span>{importing ? "Importing…" : "Import"}</span>
          </button>
        </div>
        <div className="import-hint">
          {IMPORT_EXAMPLES.map((ex) => (
            <code key={ex}>{ex}</code>
          ))}
        </div>
        {imp && (
          <div className="import-caps">
            <Cap on={imp.youtube} label="YouTube" />
            <Cap on={imp.spotifyViaLavalink || imp.spotifyApi} label="Spotify" />
            <Cap on={imp.deezer} label="Deezer" />
            <Cap on={imp.appleMusic} label="Apple Music" />
            <Cap on={imp.lastfm} label="Last.fm" />
          </div>
        )}
      </form>

      {message && (
        <div className={`banner ${message.err ? "err" : ""}`} role="status">
          <span className="b-ico">
            <AlertIcon size={18} />
          </span>
          <div className="b-body">
            <div className="b-text">{message.text}</div>
            {!!message.hints?.length && (
              <ul>
                {message.hints.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            )}
          </div>
          <button className="icon-btn b-close" onClick={onDismiss} aria-label="Dismiss">
            <CloseIcon size={16} />
          </button>
        </div>
      )}

      {playlists.length ? (
        <div className="h-scroll" style={{ flexWrap: "wrap", overflowX: "visible" }}>
          {playlists.map((pl) => (
            <div className="card pl-card" key={pl.id}>
              <div className="art" onClick={() => onOpen(pl)}>
                {pl.artwork ? <Art src={pl.artwork} alt="" /> : <div className="pl-fallback"><PlaylistIcon size={34} /></div>}
                <button
                  className="pl-del"
                  title="Delete playlist"
                  aria-label="Delete playlist"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(pl.id);
                  }}
                >
                  <TrashIcon size={15} />
                </button>
              </div>
              <div className="meta" onClick={() => onOpen(pl)}>
                <div className="t">{pl.name}</div>
                <div className="a">
                  {pl.tracks.length} track{pl.tracks.length === 1 ? "" : "s"} · {pl.via}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">No playlists yet. Paste a link above to import one.</div>
      )}
    </>
  );
}

function Cap({ on, label }) {
  return (
    <span className={`cap ${on ? "on" : ""}`} title={on ? `${label} import available` : `${label} not configured`}>
      {label}
    </span>
  );
}

function PlaylistPage({
  list,
  current,
  playing,
  filter,
  onPlay,
  onLike,
  isLiked,
  onContext,
  onDelete,
  onBack,
}) {
  const q = String(filter || "").trim().toLowerCase();
  const tracks = (list.tracks || []).filter((t) =>
    q ? `${t.title} ${t.author} ${t.album || ""}`.toLowerCase().includes(q) : true
  );
  return (
    <>
      <div className="hero">
        <div className="cover">
          {list.artwork ? <Art src={list.artwork} alt="" /> : <div className="pl-fallback"><PlaylistIcon size={54} /></div>}
        </div>
        <div>
          <div className="kicker">Imported via {list.via}</div>
          <h1>{list.name}</h1>
          <p>
            {list.author ? `${list.author} · ` : ""}
            {list.tracks.length} track{list.tracks.length === 1 ? "" : "s"}
            {q ? ` · ${tracks.length} matching` : ""}
          </p>
          <div className="row-actions">
            <button className="btn" disabled={!tracks.length} onClick={() => tracks[0] && onPlay(tracks[0], tracks)}>
              Play
            </button>
            <button
              className="btn ghost"
              disabled={!tracks.length}
              onClick={() => tracks[0] && onPlay(tracks[0], shuffleCopy(tracks))}
            >
              Shuffle play
            </button>
            {list.url && (
              <a className="btn ghost" href={list.url} target="_blank" rel="noreferrer">
                Source
              </a>
            )}
            <button
              className="btn ghost"
              onClick={() => {
                onDelete(list.id);
                onBack();
              }}
            >
              <TrashIcon size={16} />
              <span>Delete</span>
            </button>
          </div>
        </div>
      </div>
      {tracks.length ? (
        <TrackList
          tracks={tracks}
          current={current}
          playing={playing}
          onPlay={onPlay}
          onLike={onLike}
          isLiked={isLiked}
          onContext={onContext}
        />
      ) : (
        <div className="empty">{q ? "Nothing in this playlist matches that filter." : "This playlist is empty."}</div>
      )}
    </>
  );
}

function BrowsePage({ genres, filter, loading, onOpen }) {
  const q = String(filter || "").trim().toLowerCase();
  const shown = genres.filter((g) => {
    if ((g.trackCount || 0) <= 0) return false;
    if (!q) return true;
    return g.name.toLowerCase().includes(q) || String(g.query || "").toLowerCase().includes(q);
  });
  return (
    <>
      <h1 className="page-title">Browse all</h1>
      <p className="page-sub">
        {loading ? "Finding genres with songs…" : q ? `${shown.length} matching genre${shown.length === 1 ? "" : "s"}` : "Only genres with available songs are listed."}
      </p>
      {loading && !genres.length && (
        <div className="genre-grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="genre-tile skel" style={{ background: "var(--secondary)" }} />
          ))}
        </div>
      )}
      {!loading && !shown.length && <div className="empty">No genres available for that filter.</div>}
      <div className="genre-grid">
        {shown.map((g) => (
          <button key={g.id} className="genre-tile" style={{ background: g.color }} onClick={() => onOpen(g)}>
            <div className="g-name">{g.name}</div>
            <div className="g-art">
              {g.artwork ? <Art src={g.artwork} alt="" /> : <div style={{ width: "100%", height: "100%", background: "#ffffff22" }} />}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function GenrePage({ data, loading, filter, current, playing, onPlay, onLike, isLiked, onContext }) {
  const info = data.info || {};
  const q = String(filter || "").trim().toLowerCase();
  const tracks = (data.tracks || []).filter((t) => {
    if (!q) return true;
    return `${t.title} ${t.author} ${t.album || ""}`.toLowerCase().includes(q);
  });
  return (
    <>
      <div className="genre-hero">
        <div className="swatch" style={{ background: info.color || "#333" }} />
        <div>
          <div className="kicker">Genre</div>
          <h1 className="page-title" style={{ margin: "4px 0 8px" }}>{info.name}</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            {loading ? "Loading songs…" : `${tracks.length} song${tracks.length === 1 ? "" : "s"}`}
          </p>
          <div className="row-actions" style={{ marginTop: 14 }}>
            <button className="btn" disabled={!tracks.length} onClick={() => tracks[0] && onPlay(tracks[0], tracks)}>
              Play
            </button>
            <button className="btn ghost" disabled={!tracks.length} onClick={() => tracks[0] && onPlay(tracks[0], shuffleCopy(tracks))}>
              Shuffle play
            </button>
          </div>
        </div>
      </div>
      {!!tracks.length && (
        <TrackList tracks={tracks} current={current} playing={playing} onPlay={onPlay} onLike={onLike} isLiked={isLiked} onContext={onContext} />
      )}
      {!loading && !tracks.length && <div className="empty">{q ? "No songs in this genre match that filter." : "No songs found for this genre."}</div>}
    </>
  );
}

function Home({ browse, recent, onPlayTrack, onOpen, onContext }) {
  if (!browse) {
    return (
      <>
        <div className="skel" style={{ height: 36, width: 280, margin: "12px 0 24px" }} />
        <div className="h-scroll">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card"><div className="skel" style={{ width: 168, height: 168 }} /></div>
          ))}
        </div>
      </>
    );
  }
  return (
    <>
      <h1 className="page-title">Welcome to {APP_NAME}</h1>
      <p className="page-sub">
        {recent.length ? "Pick up where you left off, or find something new." : "You haven’t listened to anything yet. Search for your favorite songs to get started!"}
      </p>
      {recent.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Jump Back In</h2></div>
          <div className="h-scroll">
            {recent.slice(0, 12).map((t) => (
              <MediaCard key={trackKey(t)} title={t.title} subtitle={t.author} art={t.artwork} onClick={() => onPlayTrack(t, recent)} onPlay={() => onPlayTrack(t, recent)} />
            ))}
          </div>
        </section>
      )}
      {browse.songs?.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Recommended Songs</h2></div>
          <TrackList tracks={browse.songs} onPlay={onPlayTrack} onContext={onContext} compact />
        </section>
      )}
      {browse.picks?.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Editor’s Picks</h2></div>
          <div className="h-scroll">
            {browse.picks.map((a) => (
              <MediaCard key={a.url} title={a.name} subtitle={a.author} art={a.artwork} onClick={() => onOpen(a)} onPlay={() => a.tracks?.[0] && onPlayTrack(a.tracks[0], a.tracks)} />
            ))}
          </div>
        </section>
      )}
      {browse.albums?.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Recommended Albums</h2></div>
          <div className="h-scroll">
            {browse.albums.map((a) => (
              <MediaCard key={a.url} title={a.name} subtitle={a.author} art={a.artwork} onClick={() => onOpen(a)} />
            ))}
          </div>
        </section>
      )}
      {browse.artists?.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Recommended Artists</h2></div>
          <div className="h-scroll">
            {browse.artists.map((a) => (
              <MediaCard key={a.url} title={a.author || a.name} subtitle="Artist" art={a.artwork} artist onClick={() => onOpen(a)} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function SearchPage({ query, searching, results, tab, setTab, onPlayTrack, onOpen, onContext }) {
  if (!query.trim()) return <div className="empty">Search for songs, albums, and artists.</div>;
  if (searching && !results) return <div className="empty">Searching…</div>;
  const r = results || { tracks: [], albums: [], artists: [], playlists: [] };
  const tabs = [
    ["tracks", `Tracks (${r.tracks.length})`],
    ["albums", `Albums (${r.albums.length})`],
    ["artists", `Artists (${r.artists.length})`],
    ["playlists", `Playlists (${r.playlists.length})`],
  ];
  return (
    <>
      <h1 className="page-title">Search Results</h1>
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === "tracks" &&
        (r.tracks.length ? (
          <TrackList tracks={r.tracks} onPlay={onPlayTrack} onContext={onContext} />
        ) : (
          <div className="empty">{r.warning || "No tracks."}</div>
        ))}
      {tab === "albums" && (
        <div className="h-scroll" style={{ flexWrap: "wrap" }}>
          {r.albums.map((a) => (
            <MediaCard key={a.url} title={a.name} subtitle={a.author} art={a.artwork} onClick={() => onOpen(a)} />
          ))}
          {!r.albums.length && <div className="empty">No albums.</div>}
        </div>
      )}
      {tab === "artists" && (
        <div className="h-scroll" style={{ flexWrap: "wrap" }}>
          {r.artists.map((a) => (
            <MediaCard key={a.url} title={a.author || a.name} subtitle="Artist" art={a.artwork} artist onClick={() => onOpen(a)} />
          ))}
          {!r.artists.length && <div className="empty">No artists.</div>}
        </div>
      )}
      {tab === "playlists" && (
        <div className="h-scroll" style={{ flexWrap: "wrap" }}>
          {r.playlists.map((a) => (
            <MediaCard key={a.url} title={a.name || "Playlist"} subtitle={a.author} art={a.artwork} onClick={() => onOpen(a)} />
          ))}
          {!r.playlists.length && <div className="empty">No playlists.</div>}
        </div>
      )}
    </>
  );
}

function CollectionPage({ data, loading, current, playing, onPlay, onLike, isLiked, onContext }) {
  const info = data.info || {};
  const tracks = data.tracks || [];
  return (
    <>
      <div className="hero">
        <div className={`cover ${info.type === "artist" ? "circle" : ""}`}>
          <Art src={info.artwork} alt="" />
        </div>
        <div>
          <div className="kicker">{info.type || "Collection"}</div>
          <h1>{info.name}</h1>
          <p>
            {info.author}
            {info.totalTracks ? ` · ${info.totalTracks} tracks` : tracks.length ? ` · ${tracks.length} tracks` : ""}
          </p>
          <div className="row-actions">
            <button className="btn" disabled={!tracks.length} onClick={() => tracks[0] && onPlay(tracks[0], tracks)}>
              Play
            </button>
            <button className="btn ghost" disabled={!tracks.length} onClick={() => tracks[0] && onPlay(tracks[0], shuffleCopy(tracks))}>
              Shuffle play
            </button>
          </div>
        </div>
      </div>
      {loading && <div className="empty">Loading tracks…</div>}
      {!!tracks.length && (
        <TrackList tracks={tracks} current={current} playing={playing} onPlay={onPlay} onLike={onLike} isLiked={isLiked} onContext={onContext} />
      )}
    </>
  );
}

function shuffleCopy(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const LS_ADMIN = "mc-admin-token";
const BACKEND_LABELS = {
  auto: "Auto",
  lavalink: "Lavalink only",
  ytdlp: "Direct (yt-dlp)",
};

/**
 * Owner-only source switch. The server rejects changes unless ADMIN_TOKEN is
 * configured, so this is informational for everyone else.
 */
function BackendRow({ status, onChanged }) {
  const b = status?.backend;
  const [token, setToken] = useState(() => localStorage.getItem(LS_ADMIN) || "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const apply = async (mode) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await setBackend(token, mode);
      if (r?.ok) {
        localStorage.setItem(LS_ADMIN, token);
        setMsg({ text: `Now using ${BACKEND_LABELS[r.backend] || r.backend} (serving from ${r.effective}).` });
        onChanged?.();
      } else {
        setMsg({ err: true, text: r?.error || "Could not switch." });
      }
    } catch {
      setMsg({ err: true, text: "Request failed." });
    } finally {
      setBusy(false);
    }
  };

  const effectiveNote =
    b?.effective === "ytdlp"
      ? "Serving from yt-dlp directly — Lavalink is not being used."
      : "Serving from Lavalink.";

  return (
    <div className="row presence-row">
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              marginRight: 8,
              verticalAlign: "middle",
              background: b?.effective ? "#4ade80" : "var(--danger)",
            }}
          />
          Music source
        </div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13, marginTop: 4, lineHeight: 1.55 }}>
          {b ? (
            <>
              Mode <strong style={{ color: "var(--accent-3)" }}>{BACKEND_LABELS[b.mode] || b.mode}</strong> · {effectiveNote}
              <br />
              <b>Auto</b> uses Lavalink and falls back to yt-dlp when the node is offline, so the
              player keeps working either way.
              {b.maxTrackMinutes ? (
                <>
                  <br />
                  Results longer than {b.maxTrackMinutes} minutes are hidden, to keep hour-long mixes out.
                </>
              ) : null}
            </>
          ) : (
            "Loading…"
          )}
        </div>

        {b?.canSwitch ? (
          <div className="presence-setup">
            <div className="presence-field">
              <span className="presence-label">Admin</span>
              <input
                className="admin-input"
                type="password"
                value={token}
                placeholder="ADMIN_TOKEN"
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="tabs" style={{ margin: 0 }}>
              {(b.options || []).map((o) => (
                <button
                  key={o}
                  className={`tab ${b.mode === o ? "on" : ""}`}
                  disabled={busy || !token}
                  onClick={() => apply(o)}
                >
                  {BACKEND_LABELS[o] || o}
                </button>
              ))}
            </div>
            {msg && (
              <div className="presence-note" style={msg.err ? { color: "var(--danger)" } : undefined}>
                {msg.text}
              </div>
            )}
          </div>
        ) : (
          <div className="presence-note" style={{ marginTop: 8 }}>
            Set <code>ADMIN_TOKEN</code> on the server to switch the source from here.
          </div>
        )}
      </div>
    </div>
  );
}

function DiscordPresenceRow({ on, setOn, presenceKey, onRegenerate }) {
  const [copied, setCopied] = useState("");
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-app";
  const command = `node tools/discord-presence.mjs --url ${origin} --key ${presenceKey} --client-id <YOUR_APP_ID>`;

  const copy = (text, what) => {
    const done = () => {
      setCopied(what);
      setTimeout(() => setCopied(""), 1600);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => {});
    else done();
  };

  return (
    <div className="row presence-row">
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>Discord presence</div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13, marginTop: 4, lineHeight: 1.55 }}>
          Shows what you are listening to on your Discord profile.
          <br />
          Discord only accepts Rich Presence from a program on your own computer, so a
          browser cannot do it alone. Enable this, then run the small companion
          script from this repo on the PC where Discord is open.
        </div>

        {on && (
          <div className="presence-setup">
            <div className="presence-field">
              <span className="presence-label">Your key</span>
              <code>{presenceKey}</code>
              <button className="icon-btn" title="Copy key" onClick={() => copy(presenceKey, "key")}>
                <CopyIcon size={15} />
              </button>
              <button className="icon-btn" title="Generate a new key" onClick={onRegenerate}>
                <RefreshIcon size={15} />
              </button>
            </div>
            <div className="presence-field">
              <span className="presence-label">Command</span>
              <code className="presence-cmd">{command}</code>
              <button className="icon-btn" title="Copy command" onClick={() => copy(command, "cmd")}>
                <CopyIcon size={15} />
              </button>
            </div>
            <div className="presence-note">
              Create an application at{" "}
              <a
                className="credit-link"
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noreferrer"
              >
                discord.com/developers/applications
              </a>{" "}
              and use its Application ID. The application name is what Discord displays.
              {copied && <strong> · {copied === "key" ? "Key" : "Command"} copied</strong>}
            </div>
          </div>
        )}
      </div>
      <div className="pill">
        <button className={on ? "on" : ""} onClick={() => setOn(true)}>On</button>
        <button className={!on ? "on" : ""} onClick={() => setOn(false)}>Off</button>
      </div>
    </div>
  );
}

function Settings({
  theme,
  setTheme,
  status,
  onRefresh,
  presenceOn,
  setPresenceOn,
  presenceKey,
  onRegenerateKey,
}) {
  const node = status?.node;
  const audio = status?.audio;
  const dot = (ok) => ({
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    marginRight: 8,
    verticalAlign: "middle",
    background: ok ? "#4ade80" : "var(--danger)",
  });
  return (
    <>
      <h1 className="page-title">Settings</h1>
      <div className="settings">
        <div className="row">
          <div>
            <div style={{ fontWeight: 600 }}>Theme</div>
            <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>Choose your preferred color scheme</div>
          </div>
          <div className="pill">
            <button className={theme === "purple" ? "on" : ""} onClick={() => setTheme("purple")}>Purple</button>
            <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")}>Light</button>
          </div>
        </div>
        <div className="row">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>
              <span style={dot(!!node?.ok)} />
              Lavalink
            </div>
            <div style={{ color: "var(--muted-foreground)", fontSize: 13, marginTop: 4, overflowWrap: "anywhere" }}>
              {node?.ok ? (
                <>
                  Connected to <code>{node.base}</code>
                  {node.version ? ` (v${node.version})` : ""}
                  <br />
                  Sources: {node.sources?.join(", ") || "none"}
                  <br />
                  Search: {node.searches?.join(", ") || "none"}
                  {node.plugins?.length ? (
                    <>
                      <br />
                      Plugins: {node.plugins.join(", ")}
                    </>
                  ) : null}
                </>
              ) : (
                node?.error || "Not connected."
              )}
            </div>
          </div>
          <button className="btn ghost" onClick={onRefresh}>Re-check</button>
        </div>
        <div className="row">
          <div>
            <div style={{ fontWeight: 600 }}>
              <span style={dot(!!(audio?.ytdlp || audio?.pluginRoute))} />
              Streaming
            </div>
            <div style={{ color: "var(--muted-foreground)", fontSize: 13, marginTop: 4 }}>
              Tracks are resolved and proxied server-side, so Lavalink credentials never reach the browser.
              <br />
              yt-dlp: {audio?.ytdlp ? "available" : "missing"} · ffmpeg: {audio?.ffmpeg ? "available" : "missing"} · mode: {audio?.mode || "auto"}
            </div>
          </div>
        </div>
        <BackendRow status={status} onChanged={onRefresh} />
        <DiscordPresenceRow
          on={presenceOn}
          setOn={setPresenceOn}
          presenceKey={presenceKey}
          onRegenerate={onRegenerateKey}
        />
        <div className="row">
          <div>
            <div style={{ fontWeight: 600 }}>Lyrics</div>
            <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>Live synced lyrics provided by LRCLIB.</div>
          </div>
        </div>
        <div className="row">
          <div>
            <div style={{ fontWeight: 600 }}>Shortcuts</div>
            <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
              Space play/pause · ←/→ seek · Shift+←/→ skip · S shuffle · R repeat · L lyrics · Q queue · / search
            </div>
          </div>
        </div>
        <div className="row">
          <div>
            <div style={{ fontWeight: 600 }}>Credits</div>
            <div style={{ color: "var(--muted-foreground)", fontSize: 13, marginTop: 4, lineHeight: 1.55 }}>
              {APP_NAME} is designed and built by{" "}
              <span className="credit-link">{APP_AUTHOR}</span>. Lyrics by LRCLIB.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function MediaCard({ title, subtitle, art, artist, onClick, onPlay }) {
  return (
    <div className={`card ${artist ? "artist" : ""}`} onClick={onClick}>
      <div className="art">
        <Art src={art} alt="" />
        {onPlay && (
          <button
            className="play"
            onClick={(e) => {
              e.stopPropagation();
              onPlay();
            }}
          >
            <PlayIcon size={18} />
          </button>
        )}
      </div>
      <div className="meta">
        <div className="t">{title}</div>
        <div className="a">{subtitle}</div>
      </div>
    </div>
  );
}

function TrackList({ tracks, current, playing, onPlay, onLike, isLiked, onContext, compact }) {
  const show = compact ? tracks.slice(0, 8) : tracks;
  return (
    <div>
      {show.map((t, i) => {
        const active = current && trackKey(current) === trackKey(t);
        return (
          <div
            key={trackKey(t) + i}
            className={`track-row ${active ? "active" : ""}`}
            onDoubleClick={() => onPlay(t, tracks)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContext?.({ x: e.clientX, y: e.clientY, track: t, list: tracks });
            }}
          >
            <div className="idx">{active && playing ? "♪" : i + 1}</div>
            <div className="art" onClick={() => onPlay(t, tracks)} style={{ cursor: "pointer" }}>
              <Art src={t.artwork} alt="" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="title">{t.title}</div>
              <div className="sub">{t.author}</div>
            </div>
            <div className="album">{t.album || ""}</div>
            <div className="dur">{formatTime(t.duration || 0, true)}</div>
            <button
              className={`icon-btn ${isLiked?.(t) ? "on" : ""}`}
              onClick={() => onLike?.(t)}
            >
              <HeartIcon filled={!!isLiked?.(t)} size={16} />
            </button>
            <button
              className="icon-btn more"
              onClick={(e) => {
                e.stopPropagation();
                onContext?.({ x: e.clientX, y: e.clientY, track: t, list: tracks });
              }}
            >
              <MoreIcon size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
