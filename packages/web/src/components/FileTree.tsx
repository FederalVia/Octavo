import { useMemo, useState } from 'react';
import type { NoteSummary } from '../api';

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  notes: NoteSummary[];
}

interface Props {
  notes: NoteSummary[];
  currentPath: string | null;
  onOpen: (path: string) => void;
  onNewNote: (folder: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onMove: (path: string, folder: string) => void;
}

function buildTree(notes: NoteSummary[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), notes: [] };
  for (const n of notes) {
    let f = root;
    if (n.folder) {
      let acc = '';
      for (const part of n.folder.split('/')) {
        acc = acc ? `${acc}/${part}` : part;
        if (!f.folders.has(part)) f.folders.set(part, { name: part, path: acc, folders: new Map(), notes: [] });
        f = f.folders.get(part)!;
      }
    }
    f.notes.push(n);
  }
  return root;
}

const COLLAPSE_KEY = 'ultron.collapsed';

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

export function FileTree(props: Props) {
  const tree = useMemo(() => buildTree(props.notes), [props.notes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isFolder: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const toggle = (p: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const dropProps = (folder: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-ultron-note')) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget((d) => (d === folder ? null : d)),
    onDrop: (e: React.DragEvent) => {
      const p = e.dataTransfer.getData('application/x-ultron-note');
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      if (p) props.onMove(p, folder);
    },
  });

  const renderFolder = (f: Folder, depth: number) => {
    const folders = [...f.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    const notes = [...f.notes].sort((a, b) => a.name.localeCompare(b.name));
    return (
      <>
        {folders.map((sub) => {
          const isCollapsed = collapsed.has(sub.path);
          return (
            <div key={`d:${sub.path}`} {...dropProps(sub.path)} className={dropTarget === sub.path ? 'drop-target' : ''}>
              <div
                className="tree-item folder"
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => toggle(sub.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, path: sub.path, isFolder: true });
                }}
              >
                <span className={`chevron${isCollapsed ? '' : ' open'}`}>›</span>
                <span className="tree-name">{sub.name}</span>
              </div>
              {!isCollapsed && renderFolder(sub, depth + 1)}
            </div>
          );
        })}
        {notes.map((n) => (
          <div
            key={n.path}
            className={`tree-item note${n.path === props.currentPath ? ' active' : ''}`}
            style={{ paddingLeft: 22 + depth * 14 }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-ultron-note', n.path);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => props.onOpen(n.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, path: n.path, isFolder: false });
            }}
            title={n.path}
          >
            <span className="tree-name">{n.name}</span>
          </div>
        ))}
      </>
    );
  };

  return (
    <div className={`tree${dropTarget === '' ? ' drop-target' : ''}`} {...dropProps('')} onClick={() => setMenu(null)}>
      {props.notes.length === 0 && <div className="empty muted">No notes yet</div>}
      {renderFolder(tree, 0)}
      {menu && (
        <>
          <div className="menu-backdrop" onMouseDown={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))} />
          <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.isFolder ? (
              <button onClick={() => (props.onNewNote(menu.path), setMenu(null))}>New note here</button>
            ) : (
              <>
                <button onClick={() => (props.onOpen(menu.path), setMenu(null))}>Open</button>
                <button onClick={() => (props.onRename(menu.path), setMenu(null))}>Rename / move…</button>
                <button className="danger" onClick={() => (props.onDelete(menu.path), setMenu(null))}>
                  Delete
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
