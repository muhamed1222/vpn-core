import { FastifyInstance } from 'fastify';

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeDeepLink(rawUrl: string, allowedHosts: Set<string>): { deeplink: string; subscriptionUrl: string } | null {
  let value = rawUrl.trim();
  if (!value) return null;

  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep original value if it's not URI-encoded.
  }

  const prefixes = ['happ://add/', 'v2raytun://import/'] as const;
  const prefix = prefixes.find((p) => value.toLowerCase().startsWith(p));
  if (!prefix) return null;

  const targetUrlRaw = value.slice(prefix.length);
  let targetUrl: URL;
  try {
    targetUrl = new URL(targetUrlRaw);
  } catch {
    return null;
  }

  if (targetUrl.protocol !== 'https:') return null;
  if (!allowedHosts.has(targetUrl.hostname.toLowerCase())) return null;

  const pathMatch = targetUrl.pathname.match(/^\/(sub|s)\/([A-Za-z0-9_-]{8,200})$/);
  if (!pathMatch) return null;

  const normalizedSubscriptionUrl = `${targetUrl.origin}${targetUrl.pathname}${targetUrl.search}`;
  const normalizedPrefix = prefix === 'happ://add/' ? 'happ://add/' : 'v2raytun://import/';
  const deeplink = `${normalizedPrefix}${normalizedSubscriptionUrl}`;

  return { deeplink, subscriptionUrl: normalizedSubscriptionUrl };
}

export async function rootRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request, reply) => {
    return {
      ok: true,
      service: 'VPN API',
    };
  });

  fastify.get<{ Querystring: { url?: string } }>('/redirect', async (request, reply) => {
    const rawUrl = request.query.url;
    if (!rawUrl) {
      return reply.status(400).type('text/html; charset=utf-8').send(
        '<!doctype html><html><body><h1>Missing url parameter</h1></body></html>'
      );
    }

    const allowedHosts = new Set(
      (process.env.REDIRECT_ALLOWED_HOSTS || 'vpn.outlivion.space')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
    );

    const normalized = normalizeDeepLink(rawUrl, allowedHosts);
    if (!normalized) {
      return reply.status(400).type('text/html; charset=utf-8').send(
        '<!doctype html><html><body><h1>Invalid redirect url</h1></body></html>'
      );
    }

    const deeplinkEscaped = escapeHtml(normalized.deeplink);
    const subscriptionEscaped = escapeHtml(normalized.subscriptionUrl);
    const deeplinkJson = JSON.stringify(normalized.deeplink);
    const subscriptionJson = JSON.stringify(normalized.subscriptionUrl);

    return reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Открытие Happ</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 24px; color: #111; }
    .wrap { max-width: 560px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 10px; }
    p { color: #333; line-height: 1.4; }
    .btn { display: block; width: 100%; margin-top: 10px; border: 0; border-radius: 10px; padding: 12px 14px; font-size: 16px; cursor: pointer; }
    .primary { background: #f55128; color: #fff; }
    .secondary { background: #f2f2f2; color: #111; }
    .mono { margin-top: 14px; padding: 10px; background: #f7f7f7; border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
    #fallback { display: none; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Открываем Happ</h1>
    <p>Если приложение не открылось автоматически, используйте кнопки ниже.</p>

    <button class="btn primary" onclick="openNow()">Открыть Happ</button>
    <div id="fallback">
      <button class="btn secondary" onclick="copySubscription()">Скопировать ссылку подписки</button>
      <p class="mono">${subscriptionEscaped}</p>
    </div>
  </div>

  <script>
    const deeplink = ${deeplinkJson};
    const subscriptionUrl = ${subscriptionJson};

    function openNow() {
      window.location.href = deeplink;
      setTimeout(() => { document.getElementById('fallback').style.display = 'block'; }, 1200);
    }

    async function copySubscription() {
      try {
        await navigator.clipboard.writeText(subscriptionUrl);
        alert('Ссылка скопирована');
      } catch (e) {
        alert('Не удалось скопировать. Скопируйте вручную из блока ниже.');
      }
    }

    setTimeout(openNow, 120);
  </script>
</body>
</html>`);
  });
}
