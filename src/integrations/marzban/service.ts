import { MarzbanClient, MarzbanUser } from './client.js';

export class MarzbanService {
  public client: MarzbanClient;

  constructor(apiUrl: string, username: string, password: string) {
    this.client = new MarzbanClient(apiUrl, username, password);
  }

  /**
   * Получает или создает пользователя и возвращает его конфиг
   */
  async getOrCreateUserConfig(tgId: number): Promise<string | null> {
    try {
      const username = tgId.toString();
      let user = await this.client.getUser(username);
      
      if (!user) {
        console.log(`[MarzbanService] User ${username} not found, creating...`);
        const serverName = `🇳🇱 Нидерланды [VLESS - tcp]`;
        
        user = await this.client.createUser({
          username: username,
          proxies: { vless: {} },
          inbounds: { vless: ["VLESS_REALITY"] },
          expire: 0,
          data_limit: 0,
          status: 'active',
          remark: serverName,
          note: serverName
        });
      }

      if (!user) return null;

      // ЛОГИКА ПОЛУЧЕНИЯ ССЫЛКИ:
      // 1. Приоритет - ссылка на подписку (Subscription URL), так как она универсальна
      if (user.subscription_url) {
        // Превращаем /sub/... в https://vpn.outlivion.space/bot-api/sub/...
        // Мы используем /bot-api/ префикс, так как он проксируется через nginx к Marzban
        return `https://vpn.outlivion.space/bot-api${user.subscription_url}`;
      }

      // 2. Если нет подписки, берем первую прямую ссылку (vless://...)
      if (user.links && user.links.length > 0) {
        return user.links[0];
      }

      return null;
    } catch (error: any) {
      console.error(`[MarzbanService] Error getting/creating config for ${tgId}:`, error.response?.data || error.message);
      return null;
    }
  }

  async getUserConfig(tgId: number): Promise<string | null> {
    return this.getOrCreateUserConfig(tgId);
  }

  async getUserStatus(tgId: number): Promise<MarzbanUser | null> {
    const username = tgId.toString();
    return await this.client.getUser(username);
  }
}
