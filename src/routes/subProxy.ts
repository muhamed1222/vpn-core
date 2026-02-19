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
        const res = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country`, {
            timeout: 2000,
            httpAgent,
            httpsAgent
        });
        if (res.data && res.data.status === 'success') {
            const country = res.data.country;
            if (geoIpCache.size > 1000) geoIpCache.clear();
            geoIpCache.set(ip, country);
            return country;
        }
    } catch { }
    return null;
}

export async function subscriptionProxyRoutes(fastify: FastifyInstance) {
    const MARZBAN_URL = process.env.MARZBAN_API_URL || 'http://127.0.0.1:8000';

    // Cleanup cache
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
        } else {
            // 2. Perform Logic (DB check)
            const userRef = extractUserRefFromToken(token);

            if (userRef) {
                const deviceId = `${userAgent}|${ipAddress}`;

                if (isDeviceRevoked(userRef, deviceId)) {
                    deviceTrackingCache.set(cacheKey, { timestamp: now, allowed: false, reason: 'Device Revoked' });
                    return reply.status(403).send('Device Revoked');
                }

                const existingDevices = getDevices(userRef);
                const isKnown = existingDevices.some(d => d.device_id === deviceId);

                if (!isKnown) {
                    const activeCount = getActiveDeviceCount(userRef);
                    if (activeCount >= 5) {
                        deviceTrackingCache.set(cacheKey, { timestamp: now, allowed: false, reason: 'Device Limit Exceeded (Max 5)' });
                        return reply.status(403).send('Device Limit Exceeded (Max 5)');
                    }
                }

                // Async Track
                setImmediate(async () => {
                    try {
                        const country = await getCountry(ipAddress);
                        const device = trackDevice({
                            userRef,
                            userAgent,
                            ip: ipAddress,
                            country: country || undefined
                        });

                        if (Date.now() - new Date(device.created_at).getTime() < 30000) {
                            const userId = parseInt(userRef.replace('tg_', ''));
                            if (userId && !isNaN(userId)) {
                                sendNewDeviceNotification(userId, device.device_name, device.ip, device.country || 'Unknown', device.platform);
                            }
                        }
                    } catch (e) {
                        fastify.log.error({ err: e }, '[SubProxy] Async tracking failed');
                    }
                });

                deviceTrackingCache.set(cacheKey, { timestamp: now, allowed: true });
            } else {
                fastify.log.debug({ token: token.substring(0, 10) }, '[SubProxy] Failed to extract userRef');
            }
        }

        // 3. Proxy to Marzban
        try {
            // Forward correct URL with query params
            const queryString = new URLSearchParams(request.query as any).toString();
            const targetUrl = `${MARZBAN_URL}/sub/${token}${isInfo ? '/info' : ''}${queryString ? '?' + queryString : ''}`;

            const response = await marzbanClient.get(targetUrl, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': request.headers['accept'] || '*/*',
                    'Host': request.headers['host'] || 'vpn.outlivion.space',
                    'X-Real-IP': ipAddress,
                    'X-Forwarded-For': request.headers['x-forwarded-for'] || ipAddress,
                    'X-Forwarded-Proto': 'https', // Validate branding/secure links
                },
                responseType: 'stream'
            });

            // Forward All Valid Headers
            const hopByHopHeaders = [
                'host', 'connection', 'upgrade', 'keep-alive', 'proxy-authenticate',
                'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
                'content-encoding', 'content-length'
            ];

            for (const [key, value] of Object.entries(response.headers)) {
                const lowerKey = key.toLowerCase();
                if (hopByHopHeaders.includes(lowerKey)) continue;
                if (lowerKey.startsWith('access-control-')) continue; // Let Fastify CORS handle

                // Capitalize known headers for Client Compatibility
                let headerName = key;
                if (lowerKey === 'subscription-userinfo') headerName = 'Subscription-UserInfo';
                else if (lowerKey === 'profile-title') headerName = 'Profile-Title';
                else if (lowerKey === 'profile-web-page-url') headerName = 'Profile-Web-Page-Url';
                else if (lowerKey === 'profile-update-interval') headerName = 'Profile-Update-Interval';
                else if (lowerKey === 'content-disposition') headerName = 'Content-Disposition';

                reply.header(headerName, value);
            }

            return reply.status(response.status).send(response.data);

        } catch (err: any) {
            if (err.code !== 'ECONNRESET') {
                fastify.log.error({ err: err.message, token: token.substring(0, 10) }, '[SubProxy] Proxy Request Failed');
            }
            return reply.status(502).send('Bad Gateway');
        }
    };

    fastify.get<{ Params: { token: string } }>('/sub/:token', (req, rep) => handleProxy(req, rep, false));
    fastify.get<{ Params: { token: string } }>('/sub/:token/info', (req, rep) => handleProxy(req, rep, true));
}

function extractUserRefFromToken(token: string): string | null {
    if (!token) return null;
    try {
        const parts = token.split('.');
        if (parts.length === 3) {
            try {
                const payload = parts[1];
                const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
                const json = Buffer.from(base64, 'base64').toString('utf-8');
                const data = JSON.parse(json);
                if (data.sub && typeof data.sub === 'string' && data.sub.startsWith('tg_')) {
                    return data.sub;
                }
            } catch (e) { }
        }
        const chunk = token.substring(0, 100).replace(/-/g, '+').replace(/_/g, '/');
        const buffer = Buffer.from(chunk, 'base64');
        const decoded = buffer.toString('utf-8');
        const match = decoded.match(/(tg_\d+)/);
        if (match && match[1]) {
            return match[1];
        }
        return null;
    } catch {
        return null;
    }
}
