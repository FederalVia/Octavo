import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

const pad = (n: number) => String(n).padStart(2, '0');

function pickMime(): { mime: string; ext: string } {
  const options: [string, string][] = [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/webm', 'webm'],
    ['audio/mp4', 'm4a'], // Safari / iPhone
    ['audio/ogg;codecs=opus', 'ogg'],
  ];
  for (const [mime, ext] of options) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(mime)) return { mime, ext };
  return { mime: '', ext: 'webm' };
}

/** Why recording can't start here, or null if it can. */
export function recordingUnavailable(): string | null {
  if (!window.isSecureContext) return 'Recording needs a secure connection. Open Octavo on this computer, in the desktop app, or through an https:// address (e.g. Tailscale or access from anywhere).';
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return 'This browser can’t record audio.';
  return null;
}

/**
 * A small floating recorder. Records from the microphone, saves the file to the vault's attachments
 * and hands back the embed (`![[Recording … .webm]]`) to insert where it belongs.
 */
export function AudioRecorder({ onSaved, onClose }: { onSaved: (embed: string, path: string) => void | Promise<void>; onClose: () => void }) {
  const [state, setState] = useState<'starting' | 'recording' | 'paused' | 'saving' | 'error'>('starting');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const started = useRef(0);
  const pausedTotal = useRef(0);
  const pausedAt = useRef(0);
  const cancelled = useRef(false);
  const fmt = useRef(pickMime());
  const startDate = useRef(new Date());

  useEffect(() => {
    let raf = 0;
    let ctx: AudioContext | null = null;
    const why = recordingUnavailable();
    if (why) {
      setError(why);
      setState('error');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => {
        if (cancelled.current) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = s;
        const r = new MediaRecorder(s, fmt.current.mime ? { mimeType: fmt.current.mime } : undefined);
        r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
        r.onstop = () => void finish();
        r.start(1000);
        rec.current = r;
        started.current = Date.now();
        startDate.current = new Date();
        setState('recording');
        // A simple input level meter, so it's obvious the mic is picking something up.
        try {
          ctx = new AudioContext();
          const src = ctx.createMediaStreamSource(s);
          const an = ctx.createAnalyser();
          an.fftSize = 512;
          src.connect(an);
          const data = new Uint8Array(an.fftSize);
          const tick = () => {
            an.getByteTimeDomainData(data);
            let peak = 0;
            for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
            setLevel(Math.min(1, peak / 64));
            raf = requestAnimationFrame(tick);
          };
          tick();
        } catch {
          /* meter is optional */
        }
      })
      .catch((err: Error) => {
        setError(err.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser or system settings and try again.' : `Couldn’t start recording: ${err.message}`);
        setState('error');
      });
    const timer = setInterval(() => {
      if (started.current && !pausedAt.current) setElapsed(Date.now() - started.current - pausedTotal.current);
    }, 250);
    return () => {
      clearInterval(timer);
      cancelAnimationFrame(raf);
      void ctx?.close();
      cancelled.current = true;
      if (rec.current && rec.current.state !== 'inactive') rec.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = async () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    if (cancelled.current) return;
    setState('saving');
    const blob = new Blob(chunks.current, { type: fmt.current.mime.split(';')[0] || 'audio/webm' });
    const d = startDate.current;
    const name = `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${fmt.current.ext}`;
    try {
      const r = await api.upload(new File([blob], name, { type: blob.type }));
      const file = r.path.split('/').pop() ?? name;
      await onSaved(`![[${file}]]`, r.path);
      onClose();
    } catch (err) {
      setError(`Couldn’t save the recording: ${(err as Error).message}`);
      setState('error');
    }
  };

  const stop = () => rec.current?.state !== 'inactive' && rec.current?.stop();
  const togglePause = () => {
    const r = rec.current;
    if (!r) return;
    if (r.state === 'recording') {
      r.pause();
      pausedAt.current = Date.now();
      setState('paused');
    } else if (r.state === 'paused') {
      r.resume();
      pausedTotal.current += Date.now() - pausedAt.current;
      pausedAt.current = 0;
      setState('recording');
    }
  };
  const cancel = () => {
    cancelled.current = true;
    if (rec.current && rec.current.state !== 'inactive') rec.current.stop();
    stream.current?.getTracks().forEach((t) => t.stop());
    onClose();
  };

  const secs = Math.floor(elapsed / 1000);
  return (
    <div className="recorder" role="dialog" aria-label="Audio recorder">
      {state === 'error' ? (
        <>
          <span className="recorder-error">{error}</span>
          <button onClick={onClose}>Close</button>
        </>
      ) : (
        <>
          <span className={`recorder-dot${state === 'recording' ? ' live' : ''}`} style={{ transform: `scale(${1 + level * 0.8})` }} aria-hidden="true" />
          <span className="recorder-time" aria-live="off">
            {state === 'starting' ? 'Starting…' : state === 'saving' ? 'Saving…' : `${Math.floor(secs / 60)}:${pad(secs % 60)}${state === 'paused' ? ' · paused' : ''}`}
          </span>
          <button onClick={togglePause} disabled={state !== 'recording' && state !== 'paused'} aria-label={state === 'paused' ? 'Resume' : 'Pause'}>
            {state === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button className="primary" onClick={stop} disabled={state !== 'recording' && state !== 'paused'}>
            Stop &amp; save
          </button>
          <button onClick={cancel} aria-label="Discard recording" title="Discard">
            ✕
          </button>
        </>
      )}
    </div>
  );
}
