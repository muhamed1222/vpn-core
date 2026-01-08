import { MarzbanClient, MarzbanUser } from './client.js';
import * as keysRepo from '../../storage/keysRepo.js';

export class MarzbanService {
  public client: MarzbanClient;
  private publicUrl: string;
  private subscriptionPath: string;

  constructor(
    apiUrl: string,
    username: string,
    password: string,
    publicUrl: string = 'https://vpn.outlivion.space',
    subscriptionPath: string = ''
  ) {
    this.client = new MarzbanClient(apiUrl, username, password);
    this.publicUrl = publicUrl;
    this.subscriptionPath = subscriptionPath;
  }

  private async findUser(tgId: number): Promise<MarzbanUser | null> {
    const withPrefix = `tg_${tgId}`;
    const withoutPrefix = tgId.toString();
    try {
      // Прямой запрос данных пользователя (GET)
      let user = await this.client.getUser(withPrefix);
      if (user) return user;
      user = await this.client.getUser(withoutPrefix);
      return user;
    } catch (e) {
      return null;
    }
  }

  /**
   * Возвращает ссылку. 
   * Если в объекте пользователя есть subscription_url, используем его.
   * subscription_url имеет формат /sub/..., поэтому просто добавляем proxy path
   */
  private formatSubscriptionUrl(user: MarzbanUser): string {
    if (user.subscription_url) {
      // subscription_url уже содержит /sub/..., добавляем только proxy path
      return `${this.publicUrl}${this.subscriptionPath}${user.subscription_url}`;
    }
    // Если нет, берем первую из списка links
    return user.links?.[0] || '';
  }

  /**
   * ТОЛЬКО ЧТЕНИЕ ИЗ БД ИЛИ КЭША.
   * Гарантирует отсутствие побочных эффектов.
   */
  async getUserConfig(tgId: number): Promise<string | null> {
    const userRef = `tg_${tgId}`;
    
    // 1. Проверяем в нашей БД
    const cachedKey = keysRepo.getActiveKey(userRef);
    if (cachedKey) {
      return cachedKey.key;
    }

    // 2. Если в БД нет, тянем из Marzban (1 раз)
    const user = await this.findUser(tgId);
    if (!user) return null;
    
    const url = this.formatSubscriptionUrl(user);
    
    // Сохраняем для будущих GET-запросов (Идемпотентность)
    if (url) {
      keysRepo.saveKey({
        userRef,
        marzbanUsername: user.username,
        key: url
      });
    }

    return url;
  }

  async activateUser(tgId: number, days: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const userRef = `tg_${tgId}`;
    let user = await this.findUser(tgId);
    const expireDate = now + (days * 86400);
    
    if (!user) {
      console.log(`[MarzbanService] [WRITE] Creating user tg_${tgId}`);
      user = await this.client.createUser({
        username: `tg_${tgId}`,
        proxies: { vless: {} },
        inbounds: { vless: ["VLESS_REALITY"] },
        expire: expireDate,
        data_limit: 0,
        status: 'active',
        note: `🇳🇱 Нидерланды [VLESS - tcp]`
      });
    } else {
      // Обновляем ТОЛЬКО если подписка просрочена или нужно реально продлить
      const isExpired = !user.expire || user.expire < now;
      
      if (isExpired || user.status !== 'active') {
        console.log(`[MarzbanService] [WRITE] Renewing user ${user.username}`);
        user = await this.client.updateUser(user.username, {
          ...user,
          expire: expireDate,
          status: 'active'
        });
      } else {
        // Если уже активен — просто продлеваем срок
        console.log(`[MarzbanService] [WRITE] Adding time to user ${user.username}`);
        const newExpire = (user.expire || now) + (days * 86400);
        user = await this.client.updateUser(user.username, {
          ...user,
          expire: newExpire
        });
      }
    }

    if (!user) throw new Error('Failed to activate user');
    const url = this.formatSubscriptionUrl(user);

    // Обновляем в нашей БД
    keysRepo.saveKey({
      userRef,
      marzbanUsername: user.username,
      key: url
    });

    return url;
  }

  async getUserStatus(tgId: number): Promise<MarzbanUser | null> {
    return await this.findUser(tgId);
  }

  async renewUser(tgId: number, days: number): Promise<boolean> {
    await this.activateUser(tgId, days);
    return true;
  }

  async regenerateUser(tgId: number): Promise<string | null> {
    const userRef = `tg_${tgId}`;
    const user = await this.findUser(tgId);
    if (!user) return null;

    console.log(`[MarzbanService] [WRITE] ROTATE key for user: ${user.username} (tgId: ${tgId})`);
    
    // 1. Сброс токена в Marzban
    await this.client.request({
      method: 'post',
      url: `/api/user/${user.username}/reset`,
    });

    // 2. Получаем обновленного пользователя
    const updatedUser = await this.findUser(tgId);
    if (!updatedUser) return null;

    const url = this.formatSubscriptionUrl(updatedUser);

    // 3. Сохраняем новый ключ в БД (старый пометится как неактивный)
    keysRepo.saveKey({
      userRef,
      marzbanUsername: updatedUser.username,
      key: url
    });

    return url;
  }
}
