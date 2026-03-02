import axios from 'axios';
import crypto from 'crypto';

const HELEKET_API_URL = 'https://api.heleket.com/v1/payment';

export interface HeleketInvoiceResult {
  paymentUrl: string;
  paymentId: string | null;
}

export class HeleketClient {
  private merchantId: string;
  private apiKey: string;
  private webhookUrl: string;

  constructor(merchantId: string, apiKey: string, webhookUrl: string) {
    this.merchantId = merchantId;
    this.apiKey = apiKey;
    this.webhookUrl = webhookUrl;
  }

  isConfigured(): boolean {
    return Boolean(this.merchantId && this.apiKey);
  }

  async createInvoice(
    orderId: string,
    amount: number,
    returnUrl: string,
    currency: string = 'RUB'
  ): Promise<HeleketInvoiceResult> {
    const body = JSON.stringify({
      merchant: this.merchantId,
      amount: String(amount),
      currency,
      order_id: orderId,
      description: `Outlivion VPN (Order ${orderId})`,
      success_url: returnUrl,
      fail_url: returnUrl,
      url_callback: this.webhookUrl,
    });

    const base64Body = Buffer.from(body).toString('base64');
    const sign = crypto.createHash('md5').update(base64Body + this.apiKey).digest('hex');

    const response = await axios.post(HELEKET_API_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        'merchant': this.merchantId,
        'sign': sign,
      },
      timeout: 10000,
    });

    const data = response.data;
    let paymentUrl: string | null = null;
    let paymentId: string | null = null;

    if (data?.result?.url) {
      paymentUrl = data.result.url;
      paymentId = data.result?.uuid || data.result?.id || null;
    } else if (data?.url) {
      paymentUrl = data.url;
      paymentId = data.uuid || data.id || null;
    } else if (data?.link) {
      paymentUrl = data.link;
    } else if (data?.data?.url) {
      paymentUrl = data.data.url;
      paymentId = data.data?.uuid || data.data?.id || null;
    }

    if (!paymentUrl) {
      throw new Error('Heleket: payment URL not found in response');
    }

    return { paymentUrl, paymentId };
  }

  /**
   * Verify Heleket webhook signature
   * Signature: MD5(base64(rawBody) + apiKey)
   */
  verifySignature(rawBody: string | Buffer, receivedSign: string): boolean {
    const base64Body = Buffer.from(rawBody).toString('base64');
    const expected = crypto.createHash('md5').update(base64Body + this.apiKey).digest('hex');
    return expected === receivedSign;
  }
}
