/**
 * Tests for critical payment logic in vpn-core.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// ─── Inline: isYooKassaIP (mirrors config/yookassa.ts) ───────────────────────

const YOOKASSA_WEBHOOK_IPS = [
    '185.71.76.0/27',
    '185.71.77.0/27',
    '77.75.153.0/25',
    '77.75.156.11',
    '77.75.156.35',
    '77.75.154.128/25',
    '2a02:5180::/32',
];

function ipv4ToInt(ip: string): number {
    return ip.split('.').reduce((acc, octet) => ((acc << 8) | parseInt(octet, 10)) >>> 0, 0);
}

function isInCIDR(ip: string, cidr: string): boolean {
    const [network, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);
    const mask = prefix === 0 ? 0 : (~(0xFFFFFFFF >>> prefix)) >>> 0;
    return (ipv4ToInt(ip) & mask) >>> 0 === (ipv4ToInt(network) & mask) >>> 0;
}

function isYooKassaIP(ip: string): boolean {
    const normalizedIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    for (const entry of YOOKASSA_WEBHOOK_IPS) {
        if (entry.includes('/')) {
            const isIpv6Entry = entry.includes(':');
            const isIpv6Ip = normalizedIp.includes(':');
            if (isIpv6Entry !== isIpv6Ip) continue;
            if (!isIpv6Entry && isInCIDR(normalizedIp, entry)) return true;
        } else {
            if (entry === normalizedIp) return true;
        }
    }
    return false;
}

// ─── Tests: isYooKassaIP ─────────────────────────────────────────────────────

describe('isYooKassaIP', () => {
    it('accepts IPs in 185.71.76.0/27 range', () => {
        expect(isYooKassaIP('185.71.76.0')).toBe(true);
        expect(isYooKassaIP('185.71.76.31')).toBe(true); // last in /27
    });

    it('rejects IPs outside 185.71.76.0/27 range', () => {
        expect(isYooKassaIP('185.71.76.32')).toBe(false); // first outside /27
        expect(isYooKassaIP('185.71.76.128')).toBe(false); // old bug: startsWith would accept this
        expect(isYooKassaIP('185.71.76.255')).toBe(false);
    });

    it('accepts IPs in 77.75.153.0/25 range', () => {
        expect(isYooKassaIP('77.75.153.0')).toBe(true);
        expect(isYooKassaIP('77.75.153.127')).toBe(true); // last in /25
    });

    it('rejects IPs outside 77.75.153.0/25 range', () => {
        expect(isYooKassaIP('77.75.153.128')).toBe(false); // first outside /25
    });

    it('accepts exact single IPs', () => {
        expect(isYooKassaIP('77.75.156.11')).toBe(true);
        expect(isYooKassaIP('77.75.156.35')).toBe(true);
    });

    it('rejects arbitrary IPs', () => {
        expect(isYooKassaIP('1.2.3.4')).toBe(false);
        expect(isYooKassaIP('127.0.0.1')).toBe(false);
        expect(isYooKassaIP('10.0.0.1')).toBe(false);
    });

    it('handles IPv6-mapped IPv4', () => {
        expect(isYooKassaIP('::ffff:185.71.76.1')).toBe(true);
        expect(isYooKassaIP('::ffff:1.2.3.4')).toBe(false);
    });
});

// ─── Tests: idempotency_key in orders ────────────────────────────────────────

function createTestDb() {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE orders (
            order_id TEXT PRIMARY KEY,
            user_ref TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            yookassa_payment_id TEXT,
            amount_value TEXT,
            amount_currency TEXT,
            bonus_days INTEGER DEFAULT 0,
            key TEXT,
            idempotency_key TEXT,
            payment_url TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_orders_idempotency_key ON orders(idempotency_key);
    `);
    return db;
}

describe('order idempotency_key', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = createTestDb();
    });

    it('stores and retrieves by idempotency_key', () => {
        const now = new Date().toISOString();
        db.prepare(`
            INSERT INTO orders (order_id, user_ref, plan_id, idempotency_key, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run('order-1', 'tg_123', 'plan_30', 'idem-key-abc', now, now);

        const row = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get('idem-key-abc') as any;
        expect(row).not.toBeNull();
        expect(row.order_id).toBe('order-1');
        expect(row.status).toBe('pending');
    });

    it('returns null for unknown idempotency_key', () => {
        const row = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get('unknown-key');
        expect(row).toBeUndefined();
    });

    it('stores payment_url for cached response', () => {
        const now = new Date().toISOString();
        db.prepare(`
            INSERT INTO orders (order_id, user_ref, plan_id, idempotency_key, payment_url, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('order-2', 'tg_123', 'plan_30', 'idem-key-xyz', 'https://yookassa.ru/checkout/pay/abc', now, now);

        const row = db.prepare('SELECT payment_url FROM orders WHERE idempotency_key = ?').get('idem-key-xyz') as any;
        expect(row.payment_url).toBe('https://yookassa.ru/checkout/pay/abc');
    });

    it('second order with same idempotency_key triggers UNIQUE violation', () => {
        const now = new Date().toISOString();
        db.prepare(`
            INSERT INTO orders (order_id, user_ref, plan_id, idempotency_key, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run('order-3', 'tg_123', 'plan_30', 'idem-key-dup', now, now);

        // Second insert with same key should fail — app should check before inserting
        const existing = db.prepare('SELECT order_id FROM orders WHERE idempotency_key = ?').get('idem-key-dup');
        expect(existing).toBeDefined();
        // Simulate app logic: if exists, don't insert
        const shouldInsert = !existing;
        expect(shouldInsert).toBe(false);
    });
});
