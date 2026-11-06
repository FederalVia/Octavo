import { useEffect, useState } from 'react';
import { Overlay } from './Modal';

export interface UpdateState {
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported';
  current: string;
  version?: string;
  progress?: number;
  error?: string;
}

/** Desktop-only actions exposed by the Electron app (packages/desktop/src/preload.cjs). */
export interface DesktopBridge {
  getState(): Promise<DesktopState | null>;
  checkNetwork(): Promise<DesktopState>;
  toggleRemote(): Promise<DesktopState>;
  togglePhone(): Promise<DesktopState>;
  showQr(): Promise<DesktopState>;
  getUpdate(): Promise<UpdateState | null>;
  checkForUpdates(): Promise<UpdateState | null>;
  installUpdate(): Promise<UpdateState | null>;
  onUpdate(callback: (s: UpdateState) => void): () => void;
}

/** Subscribe to the desktop app's update status (null in a browser). */
export function useDesktopUpdate(): UpdateState | null {
  const desktop = window.octavoDesktop;
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!desktop?.getUpdate) return;
    desktop.getUpdate().then(setState).catch(() => {});
    return desktop.onUpdate(setState);
  }, [desktop]);
  return state;
}

function UpdatesSection() {
  const desktop = window.octavoDesktop;
  const state = useDesktopUpdate();
  if (!desktop?.getUpdate || !state) return null;
  const text: Record<UpdateState['status'], string> = {
    idle: 'Checks automatically when Octavo starts and every 6 hours.',
    checking: 'Checking for a new version…',
    'up-to-date': 'You have the latest version.',
    available: `Version ${state.version} is available.`,
    downloading: `Downloading version ${state.version}… ${state.progress ?? 0}%`,
    ready: `Version ${state.version} is downloaded and ready.`,
    error: state.error ?? 'Couldn’t check for updates.',
    unsupported: state.error ?? 'Updates are only available in the installed app.',
  };
  return (
    <section>
      <h4>Updates</h4>
      <div className="setting-row">
        <div>
          <b>Octavo {state.current}</b>
          <span className="muted small">{text[state.status]}</span>
        </div>
        {state.status === 'ready' ? (
          <button className="btn primary" onClick={() => desktop.installUpdate()}>
            Restart to update
          </button>
        ) : state.status === 'available' ? (
          <button className="btn primary" onClick={() => desktop.installUpdate()}>
            Download
          </button>
        ) : (
          <button className="btn" disabled={state.status === 'checking' || state.status === 'downloading' || state.status === 'unsupported'} onClick={() => desktop.checkForUpdates()}>
            Check now
          </button>
        )}
      </div>
    </section>
  );
}
interface DesktopState {
  phone: boolean;
  remote: boolean;
  remoteStatus: { state: string; step: string; url?: string; advice?: string } | null;
}
declare global {
  interface Window {
    octavoDesktop?: DesktopBridge;
  }
}

function PhoneSection() {
  const desktop = window.octavoDesktop;
  const [state, setState] = useState<DesktopState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    const load = () => desktop.getState().then(setState).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [desktop]);

  if (!desktop) {
    return (
      <p className="muted small settings-note">
        In the Octavo desktop app, these controls appear here. From a terminal: <code>npm start -- --remote</code> (from anywhere) or{' '}
        <code>npm start -- --phone</code> (home Wi-Fi). Both show a QR code to scan with your phone.
      </p>
    );
  }
  const run = async (fn: () => Promise<DesktopState>) => {
    setBusy(true);
    try {
      setState(await fn());
    } finally {
      setBusy(false);
    }
  };
  const rs = state?.remoteStatus;
  const remoteLabel = !state?.remote
    ? 'Off'
    : rs?.state === 'ready'
      ? 'On: works from anywhere'
      : rs?.state === 'error'
        ? 'Problem: see details'
        : rs?.step ?? 'Starting…';
  return (
    <>
      <div className="setting-row">
        <div>
          <b>1. Check your network</b>
          <span className="muted small">Can your router and internet provider accept direct connections? Takes about 10 seconds.</span>
        </div>
        <button className="btn" disabled={busy} onClick={() => run(desktop.checkNetwork)}>
          Check
        </button>
      </div>
      <div className="setting-row">
        <div>
          <b>2. Access from Anywhere</b>
          <span className="muted small">Your phone connects directly to this PC over any Wi-Fi or mobile data. Status: {remoteLabel}</span>
        </div>
        <button className={`btn${state?.remote ? '' : ' primary'}`} disabled={busy} onClick={() => run(desktop.toggleRemote)}>
          {state?.remote ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      <div className="setting-row">
        <div>
          <b>Home Wi-Fi only</b>
          <span className="muted small">Simpler: works while your phone is on the same Wi-Fi as this PC. Status: {state?.phone ? 'On' : 'Off'}</span>
        </div>
        <button className="btn" disabled={busy} onClick={() => run(desktop.togglePhone)}>
          {state?.phone ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      {(state?.phone || state?.remote) && (
        <div className="setting-row">
          <div>
            <b>QR code</b>
            <span className="muted small">Scan it with your phone’s camera to open Octavo there.</span>
          </div>
          <button className="btn" disabled={busy} onClick={() => run(desktop.showQr)}>
            Show QR code
          </button>
        </div>
      )}
    </>
  );
}

export interface VaultSettings {
  /** Show the lock (encryption) feature. Off by default; existing locked notes still open either way. */
  locking: boolean;
}

export const DEFAULT_SETTINGS: VaultSettings = { locking: false };

interface Props {
  settings: VaultSettings;
  onChange: (s: VaultSettings) => void;
  vimMode: boolean;
  setVimMode: (v: boolean) => void;
  lineNumbers: boolean;
  setLineNumbers: (v: boolean) => void;
  viewMode: 'atlas' | 'network';
  setViewMode: (v: 'atlas' | 'network') => void;
  onClose: () => void;
}

function Toggle({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="setting-row">
      <div>
        <b>{label}</b>
        <span className="muted small">{help}</span>
      </div>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function SettingsDialog(p: Props) {
  const secure = window.isSecureContext;
  return (
    <Overlay onClose={p.onClose}>
      <div className="dialog settings-dialog" onKeyDown={(e) => e.key === 'Escape' && p.onClose()}>
        <header className="settings-head">
          <h3>Settings</h3>
          <button className="icon-btn" onClick={p.onClose} title="Close">
            ✕
          </button>
        </header>

        <section>
          <h4>Privacy</h4>
          <Toggle
            label="Lock notes with a password"
            help="Adds a 🔐 button to encrypt individual notes. Notes are never encrypted unless you lock them. Applies to this vault on every device."
            checked={p.settings.locking}
            onChange={(v) => p.onChange({ ...p.settings, locking: v })}
          />
          {p.settings.locking && !secure && (
            <p className="muted small settings-note">
              This page isn’t on HTTPS, so encryption runs in JavaScript: it’s slower to unlock, but just as secure.
            </p>
          )}
        </section>

        <section>
          <h4>Editor</h4>
          <Toggle label="Vim keybindings" help="Modal editing in the note editor." checked={p.vimMode} onChange={p.setVimMode} />
          <Toggle label="Line numbers" help="Show line numbers while editing." checked={p.lineNumbers} onChange={p.setLineNumbers} />
        </section>

        <section>
          <h4>Brain view</h4>
          <div className="setting-row">
            <div>
              <b>Default view</b>
              <span className="muted small">3D anatomical atlas, or a flat network graph.</span>
            </div>
            <select className="input select" value={p.viewMode} onChange={(e) => p.setViewMode(e.target.value as 'atlas' | 'network')}>
              <option value="atlas">Atlas</option>
              <option value="network">Network</option>
            </select>
          </div>
        </section>

        <section>
          <h4>Use on your phone</h4>
          <PhoneSection />
        </section>

        <UpdatesSection />
      </div>
    </Overlay>
  );
}
