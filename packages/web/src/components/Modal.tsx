import { useEffect, useRef, useState, type ReactNode } from 'react';

export type DialogRequest =
  | {
      kind: 'prompt';
      title: string;
      message?: string;
      initial?: string;
      placeholder?: string;
      confirmLabel?: string;
      /** Mask the input (passwords). */
      password?: boolean;
      resolve: (v: string | null) => void;
    }
  | { kind: 'confirm'; title: string; message?: string; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void };

export function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

/** Replacement for window.prompt/confirm (prompt() is not available in Electron). */
export function Dialog({ req, onDone }: { req: DialogRequest; onDone: () => void }) {
  const [value, setValue] = useState(req.kind === 'prompt' ? req.initial ?? '' : '');
  const input = useRef<HTMLInputElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (req.kind === 'prompt') {
      input.current?.focus();
      if (req.password) return;
      const v = req.initial ?? '';
      // Select the name but not the folder prefix / extension.
      const start = v.lastIndexOf('/') + 1;
      const end = v.toLowerCase().endsWith('.md') ? v.length - 3 : v.length;
      input.current?.setSelectionRange(start, end);
    } else {
      confirmBtn.current?.focus();
    }
  }, [req]);

  const cancel = () => {
    if (req.kind === 'prompt') req.resolve(null);
    else req.resolve(false);
    onDone();
  };
  const ok = () => {
    if (req.kind === 'prompt') {
      if (!value.trim()) return;
      req.resolve(value.trim());
    } else req.resolve(true);
    onDone();
  };

  return (
    <Overlay onClose={cancel}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            cancel();
          }
        }}
      >
        <h3>{req.title}</h3>
        {req.message && <p className="muted">{req.message}</p>}
        {req.kind === 'prompt' && (
          <input
            ref={input}
            className="input"
            type={req.password ? 'password' : 'text'}
            autoComplete={req.password ? 'new-password' : undefined}
            value={value}
            placeholder={req.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
          <button
            ref={confirmBtn}
            type="submit"
            className={`btn ${req.kind === 'confirm' && req.danger ? 'danger' : 'primary'}`}
          >
            {req.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
