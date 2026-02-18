import { getDatabase } from './db.js';

/**
 * Таблица device_connections хранит все уникальные устройства,
 * которые когда-либо обращались к subscription URL пользователя.
 * 
 * Ключ уникальности: user_ref + user_agent (одно устройство = один UA)
 */

export function initDevicesTable(): void {
    const db = getDatabase();
    db.exec(`
    CREATE TABLE IF NOT EXISTS device_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_ref TEXT NOT NULL,
      user_agent TEXT NOT NULL,
      ip_address TEXT,
      device_type TEXT NOT NULL DEFAULT 'unknown',
      app_name TEXT NOT NULL DEFAULT 'unknown',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 1,
      UNIQUE(user_ref, user_agent)
    );
    CREATE INDEX IF NOT EXISTS idx_device_user_ref ON device_connections(user_ref);
  `);
}

export interface DeviceConnection {
    id: number;
    user_ref: string;
    user_agent: string;
    ip_address: string | null;
    device_type: string;
    app_name: string;
    first_seen: string;
    last_seen: string;
    request_count: number;
}

/**
 * Парсит user-agent VPN-клиента для определения типа устройства и приложения
 */
function parseUserAgent(ua: string): { deviceType: string; appName: string } {
    const uaLower = ua.toLowerCase();

    // V2RayTun
    if (uaLower.includes('v2raytun/ios') || uaLower.includes('v2raytun/iphone')) {
        return { deviceType: 'iPhone', appName: 'V2RayTun' };
    }
    if (uaLower.includes('v2raytun/mac') || uaLower.includes('v2raytun/macos')) {
        return { deviceType: 'Mac', appName: 'V2RayTun' };
    }
    if (uaLower.includes('v2raytun/android')) {
        return { deviceType: 'Android', appName: 'V2RayTun' };
    }
    if (uaLower.includes('v2raytun/windows') || uaLower.includes('v2raytun/win')) {
        return { deviceType: 'Windows', appName: 'V2RayTun' };
    }
    if (uaLower.includes('v2raytun')) {
        return { deviceType: 'Standard', appName: 'V2RayTun' };
    }

    // Happ (iOS app)
    if (uaLower.includes('happ')) {
        const version = ua.match(/Happ\/([\d.]+)/i)?.[1] || '';
        return { deviceType: 'iPhone', appName: version ? `Happ ${version}` : 'Happ' };
    }

    // Streisand
    if (uaLower.includes('streisand')) {
        if (uaLower.includes('ios') || uaLower.includes('iphone')) return { deviceType: 'iPhone', appName: 'Streisand' };
        if (uaLower.includes('mac')) return { deviceType: 'Mac', appName: 'Streisand' };
        if (uaLower.includes('android')) return { deviceType: 'Android', appName: 'Streisand' };
        return { deviceType: 'Standard', appName: 'Streisand' };
    }

    // V2Box
    if (uaLower.includes('v2box')) {
        return { deviceType: 'iPhone', appName: 'V2Box' };
    }

    // FoXray
    if (uaLower.includes('foxray')) {
        return { deviceType: 'iPhone', appName: 'FoXray' };
    }

    // Nekoray / Nekobox
    if (uaLower.includes('nekoray') || uaLower.includes('nekobox')) {
        return { deviceType: 'Windows', appName: 'Nekoray' };
    }

    // v2rayNG (Android)
    if (uaLower.includes('v2rayng')) {
        return { deviceType: 'Android', appName: 'v2rayNG' };
    }

    // Clash / ClashX
    if (uaLower.includes('clashx')) {
        return { deviceType: 'Mac', appName: 'ClashX' };
    }
    if (uaLower.includes('clash')) {
        return { deviceType: 'Standard', appName: 'Clash' };
    }

    // Generic detection by OS keywords
    if (uaLower.includes('iphone') || uaLower.includes('ios')) return { deviceType: 'iPhone', appName: ua.split('/')[0] || 'Unknown' };
    if (uaLower.includes('mac') || uaLower.includes('darwin')) return { deviceType: 'Mac', appName: ua.split('/')[0] || 'Unknown' };
    if (uaLower.includes('android')) return { deviceType: 'Android', appName: ua.split('/')[0] || 'Unknown' };
    if (uaLower.includes('windows') || uaLower.includes('win')) return { deviceType: 'Windows', appName: ua.split('/')[0] || 'Unknown' };
    if (uaLower.includes('linux')) return { deviceType: 'Linux', appName: ua.split('/')[0] || 'Unknown' };

    return { deviceType: 'Standard', appName: ua.split('/')[0] || 'Unknown' };
}

/**
 * Записывает или обновляет подключение устройства.
 * UPSERT: если устройство с таким user_ref + user_agent уже существует — обновляет last_seen и IP
 */
export function trackDevice(params: {
    userRef: string;
    userAgent: string;
    ipAddress?: string;
}): void {
    const db = getDatabase();
    const now = new Date().toISOString();
    const { deviceType, appName } = parseUserAgent(params.userAgent);

    db.prepare(`
    INSERT INTO device_connections (user_ref, user_agent, ip_address, device_type, app_name, first_seen, last_seen, request_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(user_ref, user_agent)
    DO UPDATE SET
      last_seen = ?,
      ip_address = COALESCE(?, ip_address),
      request_count = request_count + 1
  `).run(
        params.userRef,
        params.userAgent,
        params.ipAddress || null,
        deviceType,
        appName,
        now,
        now,
        // ON CONFLICT updates:
        now,
        params.ipAddress || null,
    );
}

/**
 * Получить все устройства пользователя, отсортированные по последней активности
 */
export function getDevicesByUser(userRef: string): DeviceConnection[] {
    const db = getDatabase();
    return db.prepare(`
    SELECT * FROM device_connections
    WHERE user_ref = ?
    ORDER BY last_seen DESC
  `).all(userRef) as DeviceConnection[];
}

/**
 * Удалить конкретное устройство
 */
export function removeDevice(id: number): void {
    const db = getDatabase();
    db.prepare('DELETE FROM device_connections WHERE id = ?').run(id);
}

/**
 * Удалить все устройства пользователя
 */
export function removeAllDevices(userRef: string): void {
    const db = getDatabase();
    db.prepare('DELETE FROM device_connections WHERE user_ref = ?').run(userRef);
}
