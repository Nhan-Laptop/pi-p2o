import { randomBytes } from 'node:crypto';
import type { WorkPurpose } from './duties.js';
import { isWorkPurpose } from './duties.js';
import { sha256Hex } from './validate.js';
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * A worker ticket is the only thing that lets a delegated Pi process speak to the owner's sandbox.
 * It is owner-private (0600 in a 0700 directory), valid only while its owner keeps it registered, bound to the exact
 * extension bytes and image, and the owner additionally checks the token against its in-memory
 * registry — so a ticket found after a restart grants nothing.
 */
export const TICKET_VERSION = 2;
export const TICKET_LIMIT_BYTES = 8192;
export const WORKER_ID_PATTERN = /^p2o-[a-z]{3,10}-[0-9a-f]{6}$/;

export interface TicketTarget { kind: 'directory' | 'url' | 'hybrid'; label: string; origin?: string }

export interface Ticket {
  version: 2;
  runId: string;
  workerId: string;
  paneId: string;
  parentWorkerId: string | null;
  depth: number;
  role: string;
  /** What this worker is for. Absent on tickets minted before purposes existed; the prompt falls back to the role. */
  purpose?: WorkPurpose;
  target: TicketTarget;
  image: string;
  socket: string;
  records: string;
  reports: string;
  lifetime: 'until-stopped';
  executorMode?: 'shared' | 'isolated';
  commandBudget: number;
  extension: { path: string; sha256: string };
  token: string;
  taskId?: string;
  requestedRuntime?: { model?: string; thinking?: string };
}

export function ticketPath(control: string, workerId: string): string { return join(control, `ticket-${workerId}.json`); }

export function mintToken(): string { return randomBytes(16).toString('hex'); }

export function workerName(role: string, id = randomBytes(3).toString('hex')): string {
  return `p2o-${role.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10)}-${id}`;
}

export async function mintTicket(control: string, ticket: Ticket): Promise<string> {
  const path = ticketPath(control, ticket.workerId);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(ticket), { mode: 0o600, flag: 'w' });
  await rename(temporary, path);
  const info = await lstat(path);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`Refusing to publish a ticket with mode ${(info.mode & 0o777).toString(8)}`);
  return path;
}

export async function removeTicket(path: string): Promise<void> { await rm(path, { force: true }); }

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if ((info.mode & 0o777) !== 0o700) throw new Error('Control directory must be owner-private (0700)');
}

export function extensionDigest(source: string): string { return sha256Hex(source); }

function bad(detail: string): never { throw new Error(`TICKET_REJECTED: ${detail}`); }

export interface TicketExpectations { image: string; extensionPath: string; extensionSha: string; now?: number }

/**
 * Strict validation before a worker touches anything. Every failure is fail-closed; the caller
 * disables the worker tool set and reports the reason instead of degrading to host execution.
 */
export async function readTicket(path: string, expected: TicketExpectations): Promise<Ticket> {
  if (!isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) bad('ticket path must be a plain absolute path');
  const info = await lstat(path).catch(() => bad(`no ticket at ${path}`));
  if (!info.isFile()) bad('ticket is not a regular file');
  const directory = dirname(path);
  const parent = await stat(directory).catch(() => bad('ticket directory is missing'));
  if ((parent.mode & 0o777) !== 0o700) bad('ticket directory must be owner-private (0700)');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if ((opened.mode & 0o777) !== 0o600) bad('ticket must be owner-private (0600)');
    if (opened.size === 0 || opened.size > TICKET_LIMIT_BYTES) bad(`ticket must be 1..${TICKET_LIMIT_BYTES} bytes`);
  } finally { await handle.close(); }

  let ticket: Ticket;
  try { ticket = JSON.parse(await readFile(path, 'utf8')) as Ticket; }
  catch { return bad('ticket is not valid JSON'); }
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) bad('ticket is not an object');
  if (ticket.version !== TICKET_VERSION) bad(`unsupported ticket version ${String(ticket.version)}`);
  if (!WORKER_ID_PATTERN.test(String(ticket.workerId))) bad('workerId is not a p2o worker name');
  if (!isAbsolute(String(ticket.socket)) || dirname(ticket.socket) !== directory) bad('socket must live in the ticket directory');
  if (dirname(String(ticket.records)) !== directory || dirname(String(ticket.reports)) !== directory) bad('records and reports must live in the ticket directory');
  if (!Number.isInteger(ticket.depth) || ticket.depth < 1 || ticket.depth > 4) bad('invalid delegation depth');
  if (ticket.lifetime !== 'until-stopped' || 'expiresAt' in ticket || 'deadline' in ticket) bad('invalid ticket lifetime');
  if (ticket.executorMode !== undefined && !['shared','isolated'].includes(ticket.executorMode)) bad('invalid executor profile');
  if (ticket.image !== expected.image) bad('ticket image does not match this extension');
  if (ticket.extension?.path !== expected.extensionPath || ticket.extension.sha256 !== expected.extensionSha) bad('ticket extension identity does not match the running code');
  if (!/^[a-f0-9]{32}$/.test(String(ticket.token))) bad('invalid ticket token');
  if (ticket.taskId !== undefined && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(ticket.taskId)) bad('invalid task ID');
  if (ticket.purpose !== undefined && !isWorkPurpose(ticket.purpose)) bad('invalid work purpose');
  if (ticket.requestedRuntime !== undefined && (!ticket.requestedRuntime || Object.entries(ticket.requestedRuntime).some(([k,v]) => !['model','thinking'].includes(k) || typeof v !== 'string' || v.length > 200 || /[\x00-\x1f\x7f]/.test(v)))) bad('invalid runtime profile');
  if (typeof ticket.target?.label !== 'string' || !ticket.target.label || ticket.target.label.length > 512 || /[\x00-\x1f\x7f]/.test(ticket.target.label)) bad('invalid target label');
  if (!['directory', 'url', 'hybrid'].includes(ticket.target.kind)) bad('invalid target kind');
  if (ticket.target.kind !== 'directory' && (typeof ticket.target.origin !== 'string' || !/^https?:\/\//.test(ticket.target.origin))) bad('url and hybrid tickets need an http(s) origin');
  if (!Number.isInteger(ticket.commandBudget) || ticket.commandBudget < 1 || ticket.commandBudget > 5000) bad('invalid command budget');
  const socket = await lstat(ticket.socket).catch(() => undefined);
  if (!socket?.isSocket()) bad('owner sandbox socket is not available');
  return ticket;
}
