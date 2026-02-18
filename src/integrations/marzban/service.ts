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

  private formatSubscriptionUrl(user: MarzbanUser): string {
    if (user.subscription_url) {
      return `${this.publicUrl}${this.subscriptionPath}${user.subscription_url}`;
    }
    return user.links?.[0] || '';
  }

  async getUserConfig(tgId: number): Promise<string | null> {
    const userRef = `tg_${tgId}`;
    const cachedKey = keysRepo.getActiveKey(userRef);
    if (cachedKey) return cachedKey.key;

    const user = await this.findUser(tgId);
    if (!user) return null;

    const url = this.formatSubscriptionUrl(user);
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
      const isExpired = !user.expire || user.expire < now;
      if (isExpired || user.status !== 'active') {
        user = await this.client.updateUser(user.username, {
          ...user,
          expire: expireDate,
          status: 'active'
        });
      } else {
        const newExpire = (user.expire || now) + (days * 86400);
        user = await this.client.updateUser(user.username, {
          ...user,
          expire: newExpire
        });
      }
    }

    if (!user) throw new Error('Failed to activate user');
    const url = this.formatSubscriptionUrl(user);
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

    await this.client.request({
      method: 'post',
      url: `/api/user/${user.username}/reset`,
    });

    const updatedUser = await this.findUser(tgId);
    if (!updatedUser) return null;

    const url = this.formatSubscriptionUrl(updatedUser);
    keysRepo.saveKey({
      userRef,
      marzbanUsername: updatedUser.username,
      key: url
    });

    return url;
  }

  async getUserDevices(tgId: number): Promise<any[]> {
    const user = await this.findUser(tgId);
    if (!user) return [];

    const onlines = user.onlines || [];
    const devices = onlines.map((session: any, index: number) => {
      const ip = session.ip || 'Unknown';
      return {
        id: `dev_${index}_${ip.replace(/\./g, '_')}`,
        type: this.detectDeviceType(null, ip),
        name: `Устройство ${index + 1}`,
        ip: ip,
        location: 'Нидерланды',
        lastActive: session.online_at || new Date().toISOString(),
        status: 'online',
        metadata: {
          protocol: session.protocol || 'VLESS',
        }
      };
    });

    if (devices.length === 0 && user.online_at) {
      devices.push({
        id: 'last_active',
        type: 'iPhone',
        name: 'Последнее устройство',
        ip: 'Скрыт',
        location: 'Нидерланды',
        lastActive: user.online_at,
        status: 'offline',
        metadata: {
          protocol: 'VLESS',
        }
      });
    }

    return devices;
  }

  private detectDeviceType(userAgent: string | null, ip: string): string {
    if (!userAgent) return 'iPhone';
    const ua = userAgent.toLowerCase();
    if (ua.includes('iphone')) return 'iPhone';
    if (ua.includes('android')) return 'Android';
    if (ua.includes('windows')) return 'Windows';
    if (ua.includes('macintosh') || ua.includes('mac os')) return 'Mac';
    if (ua.includes('ipad')) return 'iPad';
    if (ua.includes('linux')) return 'Linux';
    return 'iPhone';
  }
}
