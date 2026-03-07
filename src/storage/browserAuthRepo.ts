import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { getDatabase } from './db.js';

const LINK_TTL_MS = 1000 * 60 * 60 * 24;
const IOS_HANDOFF_TTL_MS = 1000 * 60 * 5;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export interface BrowserAccessLinkRecord {
  id: number;
  user_ref: string;
  token_hash: string;
  token_ciphertext: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  rotated_from_id: number | null;
}

interface BrowserAccessLinkWithToken {
  record: BrowserAccessLinkRecord;
  token: string;
}

interface IosHandoffTokenRecord {
  id: number;
  tg_id: number;
  username: string | null;
  first_name: string | null;
  token_hash: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getOpaqueSecret(): string {
  const secret = process.env.BROWSER_ACCESS_SECRET || process.env.AUTH_JWT_SECRET || '';
  if (!secret) {
    throw new Error('Missing BROWSER_ACCESS_SECRET or AUTH_JWT_SECRET');
  }
  return secret;
}

function getKey(): Buffer {
  return createHash('sha256').update(getOpaqueSecret()).digest();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function encryptToken(token: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(token, 'utf-8')), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}.${base64UrlEncode(authTag)}`;
}

function decryptToken(ciphertext: string): string | null {
  try {
    const [ivPart, cipherPart, authTagPart] = ciphertext.split('.');
    if (!ivPart || !cipherPart || !authTagPart) {
      return null;
    }

    const decipher = createDecipheriv(ALGORITHM, getKey(), base64UrlDecode(ivPart));
    decipher.setAuthTag(base64UrlDecode(authTagPart));
    return Buffer.concat([
      decipher.update(base64UrlDecode(cipherPart)),
      decipher.final(),
    ]).toString('utf-8');
  } catch {
    return null;
  }
}

function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

function generateIosHandoffToken(): string {
  return `${generateToken(12)}.${generateToken(18)}.${generateToken(12)}`;
}

function isRecordActive(record: { revoked_at?: string | null; expires_at: string; consumed_at?: string | null }): boolean {
  const now = Date.now();
  const expiresAt = new Date(record.expires_at).getTime();
  const isExpired = Number.isNaN(expiresAt) || expiresAt <= now;
  return !record.revoked_at && !record.consumed_at && !isExpired;
}

export function getActiveBrowserAccessLink(userRef: string): BrowserAccessLinkWithToken | null {
  const db = getDatabase();
  const record = db.prepare(`
    SELECT *
    FROM browser_access_links
    WHERE user_ref = ?
      AND revoked_at IS NULL
      AND expires_at > ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userRef, nowIso()) as BrowserAccessLinkRecord | undefined;

  if (!record) {
    return null;
  }

  const token = decryptToken(record.token_ciphertext);
  if (!token) {
    return null;
  }

  return { record, token };
}

export function createBrowserAccessLink(
  userRef: string,
  options: { rotatedFromId?: number | null; ttlMs?: number } = {}
): BrowserAccessLinkWithToken {
  const db = getDatabase();
  const token = generateToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + (options.ttlMs ?? LINK_TTL_MS)).toISOString();
  const tokenHash = hashToken(token);
  const tokenCiphertext = encryptToken(token);

  const result = db.prepare(`
    INSERT INTO browser_access_links (
      user_ref, token_hash, token_ciphertext, created_at, expires_at, rotated_from_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(userRef, tokenHash, tokenCiphertext, createdAt, expiresAt, options.rotatedFromId ?? null);

  const record = db.prepare(`
    SELECT *
    FROM browser_access_links
    WHERE id = ?
  `).get(result.lastInsertRowid) as BrowserAccessLinkRecord;

  return { record, token };
}

export function revokeActiveBrowserAccessLinks(userRef: string): number {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE browser_access_links
    SET revoked_at = ?
    WHERE user_ref = ?
      AND revoked_at IS NULL
      AND expires_at > ?
  `).run(nowIso(), userRef, nowIso());

  return result.changes;
}

export function rotateBrowserAccessLink(userRef: string): BrowserAccessLinkWithToken {
  const current = getActiveBrowserAccessLink(userRef);
  if (current) {
    const db = getDatabase();
    db.prepare(`
      UPDATE browser_access_links
      SET revoked_at = ?
      WHERE id = ?
    `).run(nowIso(), current.record.id);
    return createBrowserAccessLink(userRef, { rotatedFromId: current.record.id });
  }

  return createBrowserAccessLink(userRef);
}

export function getOrCreateBrowserAccessLink(userRef: string): BrowserAccessLinkWithToken {
  return getActiveBrowserAccessLink(userRef) ?? createBrowserAccessLink(userRef);
}

export function consumeBrowserAccessLink(token: string): { status: 'active' | 'revoked' | 'expired' | 'invalid'; userRef?: string; expiresAt?: string } {
  const db = getDatabase();
  const record = db.prepare(`
    SELECT *
    FROM browser_access_links
    WHERE token_hash = ?
    LIMIT 1
  `).get(hashToken(token)) as BrowserAccessLinkRecord | undefined;

  if (!record) {
    return { status: 'invalid' };
  }

  if (record.revoked_at) {
    return { status: 'revoked' };
  }

  if (new Date(record.expires_at).getTime() <= Date.now()) {
    return { status: 'expired' };
  }

  db.prepare(`
    UPDATE browser_access_links
    SET last_used_at = ?
    WHERE id = ?
  `).run(nowIso(), record.id);

  return {
    status: 'active',
    userRef: record.user_ref,
    expiresAt: record.expires_at,
  };
}

export function createIosHandoffToken(params: {
  tgId: number;
  username?: string;
  firstName?: string;
}): { token: string; expiresAt: string } {
  const db = getDatabase();
  const token = generateIosHandoffToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + IOS_HANDOFF_TTL_MS).toISOString();

  db.prepare(`
    INSERT INTO ios_handoff_tokens (
      tg_id, username, first_name, token_hash, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(params.tgId, params.username ?? null, params.firstName ?? null, hashToken(token), createdAt, expiresAt);

  return { token, expiresAt };
}

export function consumeIosHandoffToken(token: string): {
  status: 'active' | 'expired' | 'consumed' | 'invalid';
  tgId?: number;
  username?: string;
  firstName?: string;
} {
  const db = getDatabase();
  const record = db.prepare(`
    SELECT *
    FROM ios_handoff_tokens
    WHERE token_hash = ?
    LIMIT 1
  `).get(hashToken(token)) as IosHandoffTokenRecord | undefined;

  if (!record) {
    return { status: 'invalid' };
  }

  if (record.consumed_at) {
    return { status: 'consumed' };
  }

  if (!isRecordActive(record)) {
    return { status: 'expired' };
  }

  db.prepare(`
    UPDATE ios_handoff_tokens
    SET consumed_at = ?
    WHERE id = ?
  `).run(nowIso(), record.id);

  return {
    status: 'active',
    tgId: record.tg_id,
    username: record.username ?? undefined,
    firstName: record.first_name ?? undefined,
  };
}
