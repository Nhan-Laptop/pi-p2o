'use client';
/**
 * planning_update.md P2/P3: the client's only data path. Pages fetch the snapshot tree relative to the served origin
 * (`/index.json`, `/runs/<runId>.json`) — never an absolute URL, never a filesystem read, never a write. P3 adds the bearer
 * token, the 5 s poll (`?refresh=` 0–300, 0 disables) and the plain 401 state every page must be able to show.
 */
import { useCallback, useEffect, useState } from 'react';
import { AUTH_REOPEN_MESSAGE, authFetch, captureAuthTokenFromLocation } from './auth';
import { queryValue, refreshSeconds } from './format';

export type JsonStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface JsonState<T> {
  status: JsonStatus;
  data: T | null;
  error: string | null;
  /** True only for a 401; the page's message is already `AUTH_REOPEN_MESSAGE`. */
  unauthorized: boolean;
  refreshSeconds: number;
  reload: () => void;
}

export class UnauthorizedError extends Error {
  constructor() {
    super(AUTH_REOPEN_MESSAGE);
    this.name = 'UnauthorizedError';
  }
}

/** One JSON read through the shared authenticated fetch; a 401 is its own error so callers can label it. */
export async function fetchJson<T>(path: string): Promise<T> {
  const response = await authFetch(path, { headers: { accept: 'application/json' } });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  return (await response.json()) as T;
}

interface JsonInternal<T> { status: JsonStatus; data: T | null; error: string | null; unauthorized: boolean }

export function useJson<T>(path: string | null): JsonState<T> {
  // The poll rate is external to render output, so reading it in the initializer cannot create a hydration mismatch.
  const [rate] = useState(() => typeof window === 'undefined' ? 5 : refreshSeconds(window.location.search));
  const [state, setState] = useState<JsonInternal<T>>({ status: path ? 'loading' : 'idle', data: null, error: null, unauthorized: false });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) { setState({ status: 'idle', data: null, error: null, unauthorized: false }); return; }
    let cancelled = false;
    let inFlight = false;
    let blocked = false;
    setState(previous => ({ status: 'loading', data: previous.data, error: null, unauthorized: false }));
    const load = async (initial: boolean): Promise<void> => {
      if (inFlight || blocked) return;
      inFlight = true;
      if (initial) setState(previous => ({ status: 'loading', data: previous.data, error: null, unauthorized: false }));
      try {
        const data = await fetchJson<T>(path);
        if (!cancelled) setState({ status: 'ready', data, error: null, unauthorized: false });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) {
          blocked = true;
          setState(previous => ({ status: 'error', data: previous.data, error: AUTH_REOPEN_MESSAGE, unauthorized: true }));
        } else {
          setState(previous => ({ status: 'error', data: previous.data, error: error instanceof Error ? error.message : String(error), unauthorized: false }));
        }
      } finally {
        inFlight = false;
      }
    };
    void load(true);
    const timer = rate > 0
      ? setInterval(() => {
        // A hidden tab does not need to poll; the manual reload still works when it becomes visible again.
        if (typeof document !== 'undefined' && document.hidden) return;
        void load(false);
      }, rate * 1000)
      : null;
    return () => { cancelled = true; if (timer !== null) clearInterval(timer); };
  }, [path, nonce, rate]);

  const reload = useCallback(() => setNonce(value => value + 1), []);
  return { ...state, refreshSeconds: rate, reload };
}

/** `window.location.search` is only read after mount, so the static export prerenders without a browser object. */
export function useQueryValue(name: string): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => { setValue(queryValue(window.location.search, name)); }, [name]);
  return value;
}

/** Capture the launch token after mount; returning it makes the header re-render its links with the fragment preserved. */
export function useAuthToken(): string | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => { setToken(captureAuthTokenFromLocation()); }, []);
  return token;
}
