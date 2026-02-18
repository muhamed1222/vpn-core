import cron from 'node-cron';
import { awardTicketsForPayment } from '../storage/contestUtils.js';

interface FailedAward {
  tgId: number;
  orderId: string;
  planId: string;
  orderCreatedAt: string;
  attemptCount: number;
  lastAttemptAt: string;
  error?: string;
}

class AwardRetryScheduler {
  private retryQueue: Map<string, FailedAward> = new Map();
  private retryTask: ReturnType<typeof cron.schedule> | null = null;
  private botDbPath: string;
  private isProcessing = false; // Флаг для предотвращения параллельных запусков

  constructor(
    private awardFunction: (
      botDbPath: string,
      tgId: number,
      orderId: string,
      planId: string,
      orderCreatedAt: string
    ) => Promise<boolean>
  ) {
    this.botDbPath = process.env.BOT_DATABASE_PATH || '/root/vpn-bot/data/database.sqlite';
    
    // Создаем cron задачу: каждые 5 минут
    this.retryTask = cron.schedule('*/5 * * * *', async () => {
      // Предотвращаем параллельные запуски
      if (this.isProcessing) {
        console.log('[AwardRetryScheduler] Previous execution still running, skipping...');
        return;
      }
      
      this.isProcessing = true;
      try {
        await this.processRetryQueue();
      } catch (err: any) {
        console.error('[AwardRetryScheduler] Cron job error:', err);
      } finally {
        this.isProcessing = false;
      }
    });
    
    console.log('[AwardRetryScheduler] ✅ Retry scheduler started (runs every 5 minutes)');
  }

  /**
   * Добавить неудачное начисление в очередь повторных попыток
   */
  addToRetryQueue(
    tgId: number,
    orderId: string,
    planId: string,
    orderCreatedAt: string,
    error?: string
  ): void {
    const key = `${tgId}_${orderId}`;
    
    const existing = this.retryQueue.get(key);
    if (existing) {
      // Обновляем счетчик попыток
      existing.attemptCount += 1;
      existing.lastAttemptAt = new Date().toISOString();
      existing.error = error;
    } else {
      // Создаем новую запись
      this.retryQueue.set(key, {
        tgId,
        orderId,
        planId,
        orderCreatedAt,
        attemptCount: 1,
        lastAttemptAt: new Date().toISOString(),
        error,
      });
    }
    
    console.log(
      `[AwardRetryScheduler] Added to retry queue: ${key} (attempt ${this.retryQueue.get(key)!.attemptCount})`
    );
  }

  /**
   * Обработать очередь повторных попыток
   */
  private async processRetryQueue(): Promise<void> {
    if (this.retryQueue.size === 0) {
      return; // Очередь пуста
    }

    console.log(`[AwardRetryScheduler] Processing ${this.retryQueue.size} items in retry queue...`);

    const maxAttempts = 3; // Максимум 3 попытки
    const itemsToRetry: string[] = [];
    const itemsToRemove: string[] = [];

    // Собираем ключи для повторной попытки и для удаления
    for (const [key, item] of this.retryQueue.entries()) {
      if (item.attemptCount <= maxAttempts) {
        itemsToRetry.push(key);
      } else {
        // Превышен лимит попыток - помечаем для удаления
        console.warn(
          `[AwardRetryScheduler] Max attempts (${maxAttempts}) reached for ${key}, removing from queue`
        );
        itemsToRemove.push(key);
      }
    }

    // Удаляем элементы с превышенным лимитом
    for (const key of itemsToRemove) {
      this.retryQueue.delete(key);
    }

    // Повторяем начисление
    for (const key of itemsToRetry) {
      const item = this.retryQueue.get(key)!;

      try {
        console.log(
          `[AwardRetryScheduler] Retrying award for ${key} (attempt ${item.attemptCount + 1}/${maxAttempts})...`
        );

        const success = await this.awardFunction(
          this.botDbPath,
          item.tgId,
          item.orderId,
          item.planId,
          item.orderCreatedAt
        );

        if (success) {
          // Успешно начислено - удаляем из очереди
          console.log(`[AwardRetryScheduler] ✅ Successfully awarded tickets for ${key}`);
          this.retryQueue.delete(key);
        } else {
          // Не удалось (нет активного конкурса, вне периода и т.д.)
          // Обновляем счетчик попыток
          item.attemptCount += 1;
          item.lastAttemptAt = new Date().toISOString();
          console.log(
            `[AwardRetryScheduler] ⚠️ Award failed for ${key} (no contest/outside period), will retry (attempt ${item.attemptCount}/${maxAttempts})`
          );
        }
      } catch (error: any) {
        // Ошибка при начислении - обновляем счетчик
        console.error(`[AwardRetryScheduler] ❌ Error retrying ${key}:`, error?.message);
        item.attemptCount += 1;
        item.lastAttemptAt = new Date().toISOString();
        item.error = error?.message;

        // Если превышен лимит, удаляем из очереди
        if (item.attemptCount > maxAttempts) {
          console.warn(`[AwardRetryScheduler] Removing ${key} from queue after max attempts`);
          this.retryQueue.delete(key);
        }
      }
    }

    console.log(
      `[AwardRetryScheduler] Processed retry queue. Remaining: ${this.retryQueue.size}`
    );
  }

  /**
   * Остановить планировщик
   */
  stop(): void {
    if (this.retryTask) {
      this.retryTask.stop();
      this.retryTask = null;
      console.log('[AwardRetryScheduler] Retry scheduler stopped');
    }
  }

  /**
   * Получить статистику очереди
   */
  getStats(): { queueSize: number; items: FailedAward[] } {
    return {
      queueSize: this.retryQueue.size,
      items: Array.from(this.retryQueue.values()),
    };
  }
}

// Экспортируем единственный экземпляр
export const awardRetryScheduler = new AwardRetryScheduler(awardTicketsForPayment);
