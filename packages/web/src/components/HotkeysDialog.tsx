import { useMemo, useState } from 'react';
import { Overlay } from './Modal';
import { comboFromEvent, formatCombo, isUsableCombo, type Hotkeys } from '../hotkeys';

interface Command {
  id: string;
  label: string;
  hint?: string;
}

/** Assign your own keyboard shortcut to any command. Saved in the vault (.octavo/hotkeys.json). */
export function HotkeysDialog({ commands, hotkeys, onChange, onClose }: { commands: Command[]; hotkeys: Hotkeys; onChange: (h: Hotkeys) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [warning, setWarning] = useState('');
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const seen = new Set<string>();
    return commands.filter((c) => !seen.has(c.id) && seen.add(c.id) && (!q || c.label.toLowerCase().includes(q)));
  }, [commands, query]);
  const owner = (combo: string) => Object.entries(hotkeys).find(([, v]) => v === combo)?.[0];

  return (
    <Overlay onClose={onClose}>
      <div
        className="dialog hotkeys-dialog"
        onKeyDown={(e) => {
          if (!recording) {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') return setRecording(null);
          if (e.key === 'Backspace' || e.key === 'Delete') {
            const next = { ...hotkeys };
            delete next[recording];
            onChange(next);
            setRecording(null);
            return;
          }
          const combo = comboFromEvent(e);
          if (!combo) return;
          if (!isUsableCombo(combo)) return setWarning('Use a modifier key (Ctrl, Alt, Shift) or a function key, so typing never triggers it.');
          const next = { ...hotkeys };
          const prev = owner(combo);
          if (prev && prev !== recording) delete next[prev];
          next[recording] = combo;
          onChange(next);
          setWarning(prev && prev !== recording ? `${formatCombo(combo)} was moved from “${commands.find((c) => c.id === prev)?.label ?? prev}”.` : '');
          setRecording(null);
        }}
      >
        <header className="settings-head">
          <h3>Hotkeys</h3>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </header>
        <input className="input" placeholder="Filter commands…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        <p className="muted small settings-note">
          Click a shortcut, then press the keys. Backspace removes it, Esc cancels. Saved with this brain, so it applies on every device.
        </p>
        {warning && <p className="small hotkey-warning">{warning}</p>}
        <div className="hotkey-list">
          {list.map((c) => {
            const custom = hotkeys[c.id];
            return (
              <div key={c.id} className="setting-row hotkey-row">
                <span>{c.label}</span>
                <button className={`hotkey-btn${recording === c.id ? ' recording' : ''}${custom ? ' custom' : ''}`} onClick={() => setRecording(recording === c.id ? null : c.id)}>
                  {recording === c.id ? 'Press keys…' : custom ? formatCombo(custom) : c.hint ?? 'Add'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </Overlay>
  );
}
