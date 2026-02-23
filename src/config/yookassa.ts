// IP адреса YooKassa для проверки webhook
// Источник: https://yookassa.ru/developers/using-api/webhooks#ip
export const YOOKASSA_WEBHOOK_IPS = [
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
  // Маска: например /27 → 0xFFFFFFE0
  const mask = prefix === 0 ? 0 : (~(0xFFFFFFFF >>> prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) >>> 0 === (ipv4ToInt(network) & mask) >>> 0;
}

export function isYooKassaIP(ip: string): boolean {
  // Убираем IPv6-mapped IPv4 (::ffff:1.2.3.4)
  const normalizedIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  for (const entry of YOOKASSA_WEBHOOK_IPS) {
    if (entry.includes('/')) {
      // Пропускаем IPv6-CIDR при проверке IPv4-адреса и наоборот
      const isIpv6Entry = entry.includes(':');
      const isIpv6Ip = normalizedIp.includes(':');
      if (isIpv6Entry !== isIpv6Ip) continue;
      if (!isIpv6Entry && isInCIDR(normalizedIp, entry)) {
        return true;
      }
    } else {
      if (entry === normalizedIp) {
        return true;
      }
    }
  }
  return false;
}
