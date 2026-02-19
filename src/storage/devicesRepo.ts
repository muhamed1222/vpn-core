import { getDatabase } from './db.js';

export interface Device {
    id: number;
    user_id: number;
    vpn_key_id: string; // user_ref
    device_id: string; // Unique identifier (hash of UA+IP or similar)
    device_name: string;
    platform: string;
    ip: string;
    country: string | null;
    last_seen: string;
    is_revoked: boolean;
    created_at: string;
}

export function initDevicesTable(): void {
    const db = getDatabase();

    // Drop old table if exists (migration for new schema)
    // Check if table has 'device_connections' and NOT 'devices' schema?
    // Or just check if 'is_revoked' column exists. If not, drop.
    const tableInfo = db.prepare("PRAGMA table_info(devices)").all() as any[];
    const hasRevoked = tableInfo.some(c => c.name === 'is_revoked');

    // If table exists but schema is old/different (we were using 'device_connections' before),
    // let's just make sure we use the new table name 'devices'.
    // OLD table was 'device_connections'. We will ignore it/drop it.

    db.exec(`DROP TABLE IF EXISTS device_connections`); // Remove old table

    db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      vpn_key_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      ip TEXT NOT NULL,
      country TEXT,
      last_seen TEXT NOT NULL,
      is_revoked INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(vpn_key_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_devices_key ON devices(vpn_key_id);
  `);
}

/**
 * Register or update a device.
 * Returns the device object.
 */
export function trackDevice(params: {
    userRef: string;
    userAgent: string;
    ip: string;
    country?: string;
}): Device {
    const db = getDatabase();
    const now = new Date().toISOString();

    // Parse UserRef -> UserId (tg_123 -> 123)
    const userIdMatch = params.userRef.match(/^tg_(\d+)/);
    const userId = userIdMatch ? parseInt(userIdMatch[1]) : 0;

    // Generate Device ID: simple hash of UserAgent (to group same app instances)
    // PROBLEM: If we use UA as DeviceID, then 2 phones with same app version = 1 device.
    // We MUST use IP to differentiate connections for "Anti-Sharing".
    // BUT user asked for "Limit 5 devices". If I change IP, should I consume a slot?
    // Let's us UA + IP as unique ID for a "Session".
    const deviceId = `${params.userAgent}|${params.ip}`; // Simple composite key

    const { deviceType, appName } = parseUserAgent(params.userAgent);
    const deviceName = `${appName} on ${deviceType}`;

    // Upsert
    db.prepare(`
    INSERT INTO devices (
      user_id, vpn_key_id, device_id, device_name, platform, ip, country, last_seen, created_at, is_revoked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(vpn_key_id, device_id) DO UPDATE SET
      last_seen = ?,
      ip = ?,
      country = COALESCE(?, country)
  `).run(
        userId,
        params.userRef,
        deviceId,
        deviceName,
        deviceType,
        params.ip,
        params.country || null,
        now,
        now,
        // Do update args
        now,
        params.ip,
        params.country || null
    );

    return db.prepare('SELECT * FROM devices WHERE vpn_key_id = ? AND device_id = ?').get(params.userRef, deviceId) as Device;
}

export function getDevices(userRef: string): Device[] {
    const db = getDatabase();
    const results = db.prepare(`
    SELECT * FROM devices 
    WHERE vpn_key_id = ? 
    ORDER BY is_revoked ASC, last_seen DESC
  `).all(userRef);

    return results.map((d: any) => ({
        ...d,
        is_revoked: !!d.is_revoked
    }));
}

export function getActiveDeviceCount(userRef: string): number {
    const db = getDatabase();
    // Active = not revoked AND seen in last 30 days?
    // Or just not revoked? Standard usage: "Connected Devices".
    // Let's say "Active" means not revoked.
    // But due to IP changes, a user might have 100 entries.
    // We should count distinct User-Agents? No, that defeats limit.
    // Count distinct IPs?
    // Let's count ALL non-revoked sessions seen in last 24h?
    // If we count all history, limit 5 will be hit in a few days of dynamic IP.
    // STRATEGY: 
    // 1. Ignore devices not seen for > 24 hours (cleanup/exclude from limit).
    // 2. Count remaining.

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const count = db.prepare(`
    SELECT COUNT(*) as count FROM devices 
    WHERE vpn_key_id = ? 
      AND is_revoked = 0 
      AND last_seen > ?
  `).get(userRef, oneDayAgo) as { count: number };

    return count.count;
}

export function revokeDevice(id: number, userRef: string): void {
    const db = getDatabase();
    db.prepare('UPDATE devices SET is_revoked = 1 WHERE id = ? AND vpn_key_id = ?').run(id, userRef);
}

export function isDeviceRevoked(userRef: string, deviceId: string): boolean {
    const db = getDatabase();
    const dev = db.prepare('SELECT is_revoked FROM devices WHERE vpn_key_id = ? AND device_id = ?').get(userRef, deviceId) as { is_revoked: number };
    return dev ? !!dev.is_revoked : false;
}

export function getDeviceById(id: number): Device | undefined {
    const db = getDatabase();
    const dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as any;
    if (!dev) return undefined;
    return { ...dev, is_revoked: !!dev.is_revoked };
}


// --- Helper ---
function parseUserAgent(ua: string): { deviceType: string; appName: string } {
    const uaLower = ua.toLowerCase();

    // V2RayTun
    if (uaLower.includes('v2raytun')) {
        let type = 'Standard';
        if (uaLower.includes('ios') || uaLower.includes('iphone')) type = 'iPhone';
        else if (uaLower.includes('mac') || uaLower.includes('macos')) type = 'Mac';
        else if (uaLower.includes('android')) type = 'Android';
        else if (uaLower.includes('win')) type = 'Windows';
        return { deviceType: type, appName: 'V2RayTun' };
    }

    // Happ (iOS app)
    if (uaLower.includes('happ')) {
        const version = ua.match(/Happ\/([\d.]+)/i)?.[1] || '';
        return { deviceType: 'iPhone', appName: version ? `Happ ${version}` : 'Happ' };
    }

    // Streisand
    if (uaLower.includes('streisand')) {
        let type = 'Standard';
        if (uaLower.includes('ios') || uaLower.includes('iphone')) type = 'iPhone';
        if (uaLower.includes('mac')) type = 'Mac';
        if (uaLower.includes('android')) type = 'Android';
        return { deviceType: type, appName: 'Streisand' };
    }

    // V2Box
    if (uaLower.includes('v2box')) return { deviceType: 'iPhone', appName: 'V2Box' };
    // FoXray
    if (uaLower.includes('foxray')) return { deviceType: 'iPhone', appName: 'FoXray' };
    // Nekoray / Nekobox
    if (uaLower.includes('nekoray') || uaLower.includes('nekobox')) return { deviceType: 'Windows', appName: 'Nekoray' };
    // v2rayNG
    if (uaLower.includes('v2rayng')) return { deviceType: 'Android', appName: 'v2rayNG' };
    // Clash
    if (uaLower.includes('clash')) return { deviceType: 'Standard', appName: 'Clash' };
    // Hiddify
    if (uaLower.includes('hiddify')) return { deviceType: 'Standard', appName: 'Hiddify' };

    // Generic
    if (uaLower.includes('iphone') || uaLower.includes('ios')) return { deviceType: 'iPhone', appName: ua.split('/')[0] || 'Unknown' };
    if (uaLower.includes('mac') || uaLower.includes('darwin')) return { deviceType: 'Mac', appName: ua.split('/')[0] || 'Unknown' };
    if (uaLower.includes('android')) return { deviceType: 'Android', appName: ua.split('/')[0] || 'Unknown' };
    if (uaLower.includes('win')) return { deviceType: 'Windows', appName: 'Unknown' };

    return { deviceType: 'Unknown', appName: ua.substring(0, 20) };
}
