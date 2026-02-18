import axios, { AxiosInstance } from 'axios';

export interface MarzbanUser {
  username: string;
  status: string;
  expire: number | null;
  data_limit: number | null;
  used_traffic: number;
  subscription_url: string;
  links: string[];
  remark?: string;
  note?: string;
}

export class MarzbanClient {
  private axiosInstance: AxiosInstance;
  private token: string | null = null;

  constructor(
    private apiUrl: string,
    private username: string,
    private password: string
  ) {
    this.axiosInstance = axios.create({
      baseURL: apiUrl,
    });
  }

  private async login() {
    try {
      const params = new URLSearchParams();
      params.append('username', this.username);
      params.append('password', this.password);

      const response = await this.axiosInstance.post('/api/admin/token', params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      this.token = response.data.access_token;
    } catch (error: any) {
      console.error('[MarzbanClient] Login error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Сделано публичным для использования в сервисах
   */
  public async request(config: any): Promise<any> {
    if (!this.token) {
      await this.login();
    }

    try {
      return await this.axiosInstance({
        ...config,
        headers: {
          ...config.headers,
          Authorization: `Bearer ${this.token}`,
        },
      });
    } catch (error: any) {
      if (error.response?.status === 401) {
        this.token = null;
        return await this.request(config);
      }
      throw error;
    }
  }

  async getUser(username: string): Promise<MarzbanUser | null> {
    try {
      const response = await this.request({
        method: 'get',
        url: `/api/user/${username}`,
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async createUser(userData: any): Promise<MarzbanUser> {
    const response = await this.request({
      method: 'post',
      url: '/api/user',
      data: userData,
    });
    return response.data;
  }

  async updateUser(username: string, userData: any): Promise<MarzbanUser> {
    const response = await this.request({
      method: 'put',
      url: `/api/user/${username}`,
      data: userData,
    });
    return response.data;
  }
}
