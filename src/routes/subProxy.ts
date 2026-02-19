import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import { trackDevice, getActiveDeviceCount, isDeviceRevoked, getDevices } from '../storage/devicesRepo.js';
import { sendNewDeviceNotification } from '../services/notifications.js';

// Cache for debounce/rate-limiting: key -> { timestamp, allowed, reason }
interface CacheEntry {
    timestamp: number;
    allowed: boolean;
    reason?: string;
}
const deviceTrackingCache = new Map<string, CacheEntry>();
const TRACKING_COOLDOWN_MS = 60 * 1000; // 1 minute cache for decision

// GeoIP Cache (IP -> Country)
const geoIpCache = new Map<string, string>();

// Shared Agents
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

// Axios Instances
const marzbanClient = axios.create({
    timeout: 10000,
    httpAgent,
    httpsAgent,
    validateStatus: () => true, // Handle 4xx/5xx manually
    maxRedirects: 0,
});

async function getCountry(ip: string): Promise<string | null> {
    if (geoIpCache.has(ip)) return geoIpCache.get(ip)!;
    if (ip === '127.0.0.1' || ip.startsWith('192.168.') || ip === '::1') return 'Localhost';

    try {
        // Use ip-api.com (free, rate-limited 45/min). Cache helps avoid limits.
        const res = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country`, {
            timeout: 2000,
            httpAgent,
            httpsAgent
        });
        if (res.data && res.data.status === 'success') {
            const country = res.data.country;
            if (geoIpCache.size > 1000) geoIpCache.clear(); // Simple LRU-ish
            geoIpCache.set(ip, country);
            return country;
        }
    } catch { }
    return null;
}

export async function subscriptionProxyRoutes(fastify: FastifyInstance) {
    const MARZBAN_URL = process.env.MARZBAN_API_URL || 'http://127.0.0.1:8000';

    // Cleanup cache periodically
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of deviceTrackingCache.entries()) {
            if (now - entry.timestamp > TRACKING_COOLDOWN_MS * 60) {
                deviceTrackingCache.delete(key);
            }
        }
    }, 3600 * 1000);

    const handleProxy = async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply, isInfo = false) => {
        const { token } = request.params;
        const userAgent = (request.headers['user-agent'] as string) || 'unknown';
        const ipAddress = (request.headers['x-real-ip'] as string)
            || (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
            || request.ip;

        const cacheKey = `${token}:${userAgent}:${ipAddress}`;
        const cached = deviceTrackingCache.get(cacheKey);
        const now = Date.now();

        // 1. Check Cache
        if (cached && (now - cached.timestamp < TRACKING_COOLDOWN_MS)) {
            if (!cached.allowed) {
                return reply.status(403).send(cached.reason || 'Forbidden');
            }
            // If allowed, proceed to proxy
        } else {
            // 2. Perform Logic (DB check)
            const userRef = extractUserRefFromToken(token);

            if (userRef) {
                const deviceId = `${userAgent}|${ipAddress}`; // Composite ID matching Repo logic

                // Check Revoked
                if (isDeviceRevoked(userRef, deviceId)) {
                    deviceTrackingCache.set(cacheKey, { timestamp: now, allowed: false, reason: 'Device Revoked' });
                    return reply.status(403).send('Device Revoked');
                }

                // Check Limits
                const existingDevices = getDevices(userRef);
                const isKnown = existingDevices.some(d => d.device_id === deviceId);

                // Only enforce limit on NEW devices
                if (!isKnown) {
                    const activeCount = getActiveDeviceCount(userRef);
                    if (activeCount >= 5) { // Limit 5
                        deviceTrackingCache.set(cacheKey, { timestamp: now, allowed: false, reason: 'Device Limit Exceeded (Max 5)' });
                        return reply.status(403).send('Device Limit Exceeded (Max 5)');
                    }
                }

                // If Allowed -> Track & Notify (Async)
                setImmediate(async () => {
                    try {
                        const country = await getCountry(ipAddress);
                        const device = trackDevice({
                            userRef,
                            userAgent,
                            ip: ipAddress,
                            country: country || undefined
                        });

                        // Notify if new (created within last 30s)
                        const createdTime = new Date(device.created_at).getTime();
                        if (Date.now() - createdTime < 30000) {
                            const userId = parseInt(userRef.replace('tg_', ''));
                            if (userId && !isNaN(userId)) {
                                sendNewDeviceNotification(userId, device.device_name, device.ip, device.country || 'Unknown', device.platform);
                            }
                        }
                    } catch (e) {
                        fastify.log.error({ err: e }, '[SubProxy] Async tracking failed');
                    }
                });

                // Cache verdict as allowed
                deviceTrackingCache.set(cacheKey, { timestamp: now, allowed: true });
            } else {
                // Failed to extract userRef (invalid token format?)
                fastify.log.warn({ token: token.substring(0, 20) + '...' }, '[SubProxy] Failed to extract valid userRef from token');
            }
        }

        // 3. Proxy to Marzban
        try {
            const targetUrl = `${MARZBAN_URL}/sub/${token}${isInfo ? '/info' : ''}`;

            const response = await marzbanClient.get(targetUrl, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': request.headers['accept'] || '*/*',
                    'Host': request.headers['host'] || 'vpn.outlivion.space', // Forward Host header
                    'X-Real-IP': ipAddress,
                    'X-Forwarded-For': request.headers['x-forwarded-for'] || ipAddress
                },
                responseType: 'stream'
            });

            // Forward headers
            const headersToForward = [
                'content-type', 'subscription-userinfo', 'profile-update-interval',
                'profile-title', 'content-disposition', 'profile-web-page-url',
                'cache-control', 'date', 'etag'
            ];

            for (const header of headersToForward) {
                const value = response.headers[header];
                if (value) reply.header(header, value);
            }

            return reply.status(response.status).send(response.data);

        } catch (err: any) {
            // Don't log normal disconnects
            if (err.code !== 'ECONNRESET') {
                fastify.log.error({ err: err.message, token: token.substring(0, 10) + '...' }, '[SubProxy] Proxy Request Failed');
            }
            return reply.status(502).send('Bad Gateway');
        }
    };

    fastify.get<{ Params: { token: string } }>('/sub/:token', (req, rep) => handleProxy(req, rep, false));
    fastify.get<{ Params: { token: string } }>('/sub/:token/info', (req, rep) => handleProxy(req, rep, true));
}

/**
 * Extracts username from Marzban token.
 * Supports:
 * 1. Standard JWT (Header.Payload.Sig) -> extracts 'sub' field
 * 2. Legacy/Simple Base64 -> specific pattern matching
 */
function extractUserRefFromToken(token: string): string | null {
    if (!token) return null;
    try {
        // 1. Try JWT (Header.Payload.Sig)
        const parts = token.split('.');
        if (parts.length === 3) {
            try {
                // Javascript's atob/Buffer needs proper padding, but usually works
                const payload = parts[1];
                // Fix base64url characters just in case
                const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
                const json = Buffer.from(base64, 'base64').toString('utf-8');
                const data = JSON.parse(json);
                if (data.sub && typeof data.sub === 'string' && data.sub.startsWith('tg_')) {
                    return data.sub;
                }
            } catch (e) {
                // Not a valid JWT payload
            }
        }

        // 2. Try Legacy decoding (Base64 of string)
        // Some older systems used base64(username) or base64(username,timestamp)
        const chunk = token.substring(0, 100).replace(/-/g, '+').replace(/_/g, '/');
        const buffer = Buffer.from(chunk, 'base64');
        const decoded = buffer.toString('utf-8');

        // Look for our specific username pattern: tg_123456...
        // Matches "tg_123456" at start, or "tg_123456,1700000000"
        const match = decoded.match(/(tg_\d+)/);
        if (match && match[1]) {
            return match[1];
        }

        return null;
    } catch {
        return null;
    }
}
