import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase } from '../src/storage/db.js';
import {
  consumeBrowserAccessLink,
  consumeIosHandoffToken,
  getOrCreateBrowserAccessLink,
  revokeActiveBrowserAccessLinks,
  rotateBrowserAccessLink,
  createIosHandoffToken,
} from '../src/storage/browserAuthRepo.js';

describe('browserAuthRepo', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `vpn-core-browser-auth-${Date.now()}-${Math.random()}.sqlite`);
    process.env.AUTH_JWT_SECRET = 'test-secret';
    process.env.BROWSER_ACCESS_SECRET = 'test-browser-access-secret';
    initDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  it('creates and reuses the active browser access link for the same user', () => {
    const first = getOrCreateBrowserAccessLink('tg_123');
    const second = getOrCreateBrowserAccessLink('tg_123');

    expect(first.token).toBe(second.token);
    expect(first.record.id).toBe(second.record.id);
    expect(consumeBrowserAccessLink(first.token).status).toBe('active');
  });

  it('rotates browser access links and revokes the previous one', () => {
    const first = getOrCreateBrowserAccessLink('tg_321');
    const rotated = rotateBrowserAccessLink('tg_321');

    expect(rotated.token).not.toBe(first.token);
    expect(consumeBrowserAccessLink(first.token).status).toBe('revoked');
    expect(consumeBrowserAccessLink(rotated.token).status).toBe('active');
  });

  it('revokes active browser access links', () => {
    const link = getOrCreateBrowserAccessLink('tg_777');

    expect(revokeActiveBrowserAccessLinks('tg_777')).toBeGreaterThan(0);
    expect(consumeBrowserAccessLink(link.token).status).toBe('revoked');
  });

  it('consumes iOS handoff tokens only once', () => {
    const handoff = createIosHandoffToken({
      tgId: 555,
      username: 'ios-user',
      firstName: 'iOS',
    });

    const firstConsume = consumeIosHandoffToken(handoff.token);
    const secondConsume = consumeIosHandoffToken(handoff.token);

    expect(firstConsume.status).toBe('active');
    expect(firstConsume.tgId).toBe(555);
    expect(secondConsume.status).toBe('consumed');
  });
});
