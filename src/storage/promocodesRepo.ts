import { getDatabase } from './db.js';

export interface PromocodeDef {
    code: string;
    type: 'DISCOUNT' | 'DAYS' | 'TRIAL';
    value: number;
    expires_at: number | null;
    usage_limit: number | null;
    usage_count: number;
}

export function getPromocode(code: string, botDbPath: string): PromocodeDef | null {
    const db = getDatabase();
    try {
        db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
        try {
            const row = db.prepare(`
        SELECT * FROM bot_db.promocodes WHERE code = ?
      `).get(code.toUpperCase().trim()) as PromocodeDef | undefined;
            return row || null;
        } finally {
            db.prepare('DETACH DATABASE bot_db').run();
        }
    } catch (error) {
        console.error('Error fetching promocode from bot database:', error);
        return null;
    }
}

export function usePromocode(userId: number, code: string, botDbPath: string): boolean {
    const db = getDatabase();
    try {
        db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
        try {
            db.transaction(() => {
                db.prepare('UPDATE bot_db.promocodes SET usage_count = usage_count + 1 WHERE code = ?').run(code);
                db.prepare('INSERT INTO bot_db.used_promocodes (user_id, code, used_at) VALUES (?, ?, ?)').run(userId, code, Date.now());
            })();
            return true;
        } finally {
            db.prepare('DETACH DATABASE bot_db').run();
        }
    } catch (error) {
        console.error('Error using promocode in bot database:', error);
        return false;
    }
}

export function hasUserUsedPromocode(userId: number, code: string, botDbPath: string): boolean {
    const db = getDatabase();
    try {
        db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
        try {
            const row = db.prepare('SELECT 1 FROM bot_db.used_promocodes WHERE user_id = ? AND code = ?').get(userId, code);
            return !!row;
        } finally {
            db.prepare('DETACH DATABASE bot_db').run();
        }
    } catch (error) {
        console.error('Error checking if user used promocode:', error);
        return false;
    }
}

export function setUserDiscount(userId: number, percent: number, expiresAt: number | null, botDbPath: string): boolean {
    const db = getDatabase();
    try {
        db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
        try {
            db.prepare('UPDATE bot_db.users SET discount_percent = ?, discount_expires_at = ? WHERE id = ?').run(percent, expiresAt, userId);
            return true;
        } finally {
            db.prepare('DETACH DATABASE bot_db').run();
        }
    } catch (error) {
        console.error('Error setting user discount in bot database:', error);
        return false;
    }
}
