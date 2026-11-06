import { Overlay } from './Modal';

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
          <p className="muted small settings-note">
            Desktop app: <b>File → Use on Your Phone</b>. From a terminal: <code>npm start -- --phone</code>. Either one shows a QR code to scan with your phone on the same Wi-Fi.
          </p>
        </section>
      </div>
    </Overlay>
  );
}
