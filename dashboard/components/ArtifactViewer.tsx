'use client';
/**
 * planning_update.md P3 (§6.4): one retained artifact body, loaded on demand through `/api/artifact`. The client never holds
 * the body until the operator asks for it; the viewer labels it as redacted best effort, shows exactly which chunk and hash it
 * received, and never renders the body as HTML.
 */
import { useState } from 'react';
import type { DashboardArtifactRef } from '../lib/model';
import { AUTH_REOPEN_MESSAGE, authFetch } from '../lib/auth';
import { clamp, plural } from '../lib/format';

export interface ArtifactCapture { id: string; bytes: number; sha256: string; partial: boolean }

interface ArtifactPage {
  text: string;
  bytes: number;
  totalBytes: number;
  sha256: string;
  truncated: boolean;
  offset: number;
  nextOffset: number | null;
}

const integer = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;

/** The route answers one JSON page; a plain-text response is accepted too so the UI states what it got, not what it wanted. */
function readPage(raw: string, requestedOffset: number, fallback: ArtifactCapture): ArtifactPage {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch { body = null; }
  const text = body !== null && typeof body.text === 'string' ? body.text : body === null ? raw : '';
  const bytes = body === null ? text.length : integer(body.bytes) ?? integer(body.returnedBytes) ?? text.length;
  const totalBytes = body === null ? Math.max(bytes, fallback.bytes) : integer(body.totalBytes) ?? fallback.bytes;
  const sha256 = body !== null && typeof body.sha256 === 'string' ? body.sha256 : fallback.sha256;
  const next = body === null ? null : integer(body.nextOffset);
  return {
    text,
    bytes,
    totalBytes,
    sha256,
    truncated: body !== null && body.truncated === true,
    offset: body !== null ? integer(body.offset) ?? requestedOffset : requestedOffset,
    nextOffset: next !== null && next > requestedOffset ? next : null,
  };
}

export function ArtifactViewer({ runId, capture, artifact }: { runId: string; capture: ArtifactCapture; artifact?: DashboardArtifactRef }) {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<ArtifactPage[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const load = async (offset: number): Promise<void> => {
    setStatus('loading');
    setError(null);
    try {
      const query = `run=${encodeURIComponent(runId)}&id=${encodeURIComponent(capture.id)}&offset=${encodeURIComponent(String(offset))}`;
      const response = await authFetch(`/api/artifact?${query}`, { headers: { accept: 'application/json' } });
      if (response.status === 401) {
        setStatus('error');
        setError(AUTH_REOPEN_MESSAGE);
        return;
      }
      if (response.status === 404) {
        setStatus('error');
        setError('404: this artifact is not served for this run. It may be uncited by the served finding, or the snapshot copy was left out by its artifact bound.');
        return;
      }
      if (!response.ok) {
        setStatus('error');
        setError(`${response.status} ${response.statusText}`.trim());
        return;
      }
      const page = readPage(await response.text(), offset, capture);
      setPages(previous => offset === 0 ? [page] : [...previous, page]);
      setStatus('ready');
    } catch (failure) {
      setStatus('error');
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const last = pages.at(-1) ?? null;
  const text = pages.map(page => page.text).join('');
  return (
    <div className="artifact">
      <div className="artifact-head">
        <button
          type="button"
          className="button button-quiet"
          aria-expanded={open}
          aria-label={`${open ? 'hide' : 'show'} retained artifact ${capture.id}`}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && status === 'idle') void load(0);
          }}
        >
          {open ? 'hide retained artifact' : 'show retained artifact'}
        </button>
        <span className="artifact-meta mono">{capture.id}</span>
        <span className="artifact-meta">{plural(capture.bytes, 'byte')} in the receipt</span>
        <span className="artifact-meta mono" title={capture.sha256}>sha256 {clamp(capture.sha256, 20)}</span>
        {capture.partial ? <span className="artifact-warn">partial capture</span> : null}
        {artifact ? <span className="artifact-meta">snapshot copy {plural(artifact.bytes, 'byte')}{artifact.truncated ? ' (truncated)' : ''}</span> : null}
      </div>
      {open ? (
        <div className="artifact-body" role="region" aria-label={`artifact ${capture.id}`}>
          <p className="do-not-publish">redacted best effort — do not publish; retained artifact bodies can still contain target data</p>
          {status === 'error' ? <p className="artifact-error" role="alert">{error ?? 'could not load the artifact'}</p> : null}
          {status === 'loading' && pages.length === 0 ? <p className="loading" role="status">reading the retained artifact…</p> : null}
          {last ? (
            <>
              <dl className="artifact-facts">
                <div><dt>offset</dt><dd className="mono">{last.offset}</dd></div>
                <div><dt>bytes</dt><dd className="mono">{plural(last.bytes, 'byte')} returned of {plural(last.totalBytes, 'byte')} in {plural(pages.length, 'chunk')}</dd></div>
                <div><dt>sha256</dt><dd className="mono wrap">{last.sha256}</dd></div>
                <div><dt>truncated</dt><dd>{last.truncated ? 'yes; the retained body is shorter than the captured one' : 'no'}</dd></div>
                <div><dt>next</dt><dd className="mono">{last.nextOffset === null ? 'end of the retained body' : `offset ${last.nextOffset}`}</dd></div>
              </dl>
              <pre className="detail-body evidence-pre">{text || '(no text in this chunk)'}</pre>
            </>
          ) : null}
          <div className="artifact-actions">
            {last !== null && last.nextOffset !== null ? (
              <button type="button" className="button" disabled={status === 'loading'} onClick={() => void load(last.nextOffset!)}>
                {status === 'loading' ? 'reading…' : 'next chunk'}
              </button>
            ) : null}
            {status === 'error' ? <button type="button" className="button" onClick={() => void load(last?.nextOffset ?? 0)}>try again</button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
