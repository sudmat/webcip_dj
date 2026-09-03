import { useCallback, useEffect, useRef, useState } from 'react';
import { browse, uploadAnyFile, type BrowseEntry } from '../api/client';

// The desktop's file dialog, for the web.
//
// A browser's own picker hands back file CONTENT. That is right for a scan sitting on your
// laptop, and useless for the things that are already on the server — a 400 MB CT, or a pipeline
// run whose folder holds gigabytes of tool output. So this browses the SERVER and returns a path,
// with an upload button for the other case; both end at "a path on this server", so everything
// downstream is one code path.

export type PickKind = 'image' | 'cdb' | 'any';

export function FilePicker({
  title,
  kind,
  /** Pick a directory rather than a file (a pipeline run, a DICOM series). */
  folders = false,
  /** Extensions the upload button accepts; omit to hide it (a folder cannot be uploaded). */
  accept,
  onPick,
  onClose,
}: {
  title: string;
  kind: PickKind;
  folders?: boolean;
  accept?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState('');
  const [parent, setParent] = useState('');
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const go = useCallback(
    async (to: string) => {
      setError('');
      try {
        const r = await browse(to, kind);
        setPath(r.path);
        setParent(r.parent);
        setEntries(r.entries);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [kind],
  );

  // Opens on the server's configured data roots rather than '/', so the first screen is the
  // handful of places this server actually keeps data.
  useEffect(() => void go(''), [go]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const choose = (p: string) => {
    onPick(p);
    onClose();
  };

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <div style={panel}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>{title}</div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <button onClick={() => void go('')} title="Back to the server's data folders">
            ⌂
          </button>
          <button onClick={() => void go(parent)} disabled={!path || !parent}>
            ↑
          </button>
          {/* Typing a path stays possible — faster than clicking down a deep tree. */}
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void go(path)}
            placeholder="(the server's data folders)"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button onClick={() => void go(path)}>Go</button>
        </div>

        <div style={list}>
          {entries.length === 0 && (
            <div style={{ color: 'var(--muted)', padding: 8 }}>
              {error ? '' : 'Nothing here that this button can open.'}
            </div>
          )}
          {entries.map((e) => (
            <div
              key={e.path}
              onDoubleClick={() => (e.dir ? void go(e.path) : choose(e.path))}
              style={row}
            >
              <span style={{ width: 18 }}>{e.dir ? '📁' : '📄'}</span>
              <span
                onClick={() => e.dir && void go(e.path)}
                style={{ flex: 1, cursor: e.dir ? 'pointer' : 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={e.path}
              >
                {e.name}
                {e.kind && <span style={{ color: 'var(--ok)', marginLeft: 6 }}>[{e.kind}]</span>}
              </span>
              {/* A directory is selectable only when a directory is what we are after. */}
              {(!e.dir || folders) && (
                <button onClick={() => choose(e.path)} style={{ padding: '1px 8px' }}>
                  Select
                </button>
              )}
            </div>
          ))}
        </div>

        {error && <div style={{ color: 'var(--err)', marginTop: 6 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          {accept && (
            <>
              <button onClick={() => fileRef.current?.click()} disabled={busy}>
                {busy ? 'Uploading…' : 'Upload from this computer…'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={accept}
                style={{ display: 'none' }}
                onChange={async (ev) => {
                  const f = ev.target.files?.[0];
                  ev.target.value = '';
                  if (!f) return;
                  setBusy(true);
                  setError('');
                  try {
                    choose((await uploadAnyFile(f)).path);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </>
          )}
          <div style={{ flex: 1 }} />
          {folders && path && (
            <button onClick={() => choose(path)}>Select this folder</button>
          )}
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const panel: React.CSSProperties = {
  width: 640,
  maxWidth: '92vw',
  padding: 14,
  background: 'var(--panel)',
  border: '1px solid var(--panel-border)',
  borderRadius: 6,
};
const list: React.CSSProperties = {
  height: '46vh',
  overflowY: 'auto',
  border: '1px solid var(--panel-border)',
  background: 'var(--sunken)',
};
const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  borderBottom: '1px solid var(--panel-border)',
};
