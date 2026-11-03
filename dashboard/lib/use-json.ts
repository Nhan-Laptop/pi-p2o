'use client';
/**
 * planning_update.md P2: the client's only data path. Static pages fetch the snapshot tree relative to the served origin
 * (`/index.json`, `/runs/<runId>.json`) — never an absolute URL, never a filesystem read, never a write.
 */
import { useCallback, useEffect, useState } from 'react';
import { queryValue } from './format';

export type JsonStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface JsonState<T> {
  status: JsonStatus;
  data: T | null;
  error: string | null;
  reload: () => void;
}

export function useJson<T>(path: string | null): JsonState<T> {
  const [state, setState] = useState<{ status: JsonStatus; data: T | null; error: string | null }>({ status: path ? 'loading' : 'idle', data: null, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (path === null) { setState({ status: 'idle', data: null, error: null }); return; }
    let cancelled = false;
    setState(previous => ({ status: 'loading', data: previous.data, error: null }));
    void (async () => {
      try {
        const response = await fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
        const data = (await response.json()) as T;
        if (!cancelled) setState({ status: 'ready', data, error: null });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', data: null, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; };
  }, [path, nonce]);
  const reload = useCallback(() => setNonce(value => value + 1), []);
  return { ...state, reload };
}

/** `window.location.search` is only read after mount, so the static export prerenders without a browser object. */
export function useQueryValue(name: string): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => { setValue(queryValue(window.location.search, name)); }, [name]);
  return value;
}
