import { getDatabase } from './db.js';
import { getTicketsFromPlanIdSQL, checkContestTables } from './contestUtils.js';

export interface Contest {
  id: string;
  title: string;
  starts_at: string; // ISO datetime
  ends_at: string; // ISO datetime
  attribution_window_days: number;
  rules_version: string;
  is_active: boolean;
  prizes?: Array<{ icon: string; name: string; position?: string }>; // Опциональный массив призов
}

export interface ContestSummary {
  contest: Contest;
  ref_link: string;
  tickets_total: number;
  invited_total: number;
  qualified_total: number;
  pending_total: number;
}

export interface ReferralFriend {
  id: string;
  name: string | null;
  tg_username: string | null;
  status: 'bound' | 'qualified' | 'blocked' | 'not_qualified';
  status_reason: string | null;
  tickets_from_friend_total: number;
  bound_at: string; // ISO datetime
}

export interface TicketHistoryEntry {
  id: string;
  created_at: string; // ISO datetime
  delta: number;
  label: string;
  invitee_name: string | null;
}

/**
 * Получить активный конкурс
 */
export function getActiveContest(botDbPath: string): Contest | null {
  const db = getDatabase();

  try {
    // Прикрепляем базу бота
    try {
      db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    } catch (error) {
      console.error(`[ContestRepo] Failed to attach database: ${botDbPath}`, error);
      if (error instanceof Error) {
        throw new Error(`Failed to attach bot database: ${error.message}`);
      }
      throw error;
    }

    try {
      // Проверяем, есть ли таблица contests
      const tableExists = db.prepare(`
        SELECT name FROM bot_db.sqlite_master 
        WHERE type='table' AND name='contests'
      `).get() as { name: string } | undefined;

      if (!tableExists) {
        console.warn('[ContestRepo] Table contests does not exist in bot database');
        return null;
      }

      const now = new Date().toISOString();

      // Сначала проверяем, есть ли вообще конкурсы
      const allContests = db.prepare(`
        SELECT id, title, is_active, starts_at, ends_at
        FROM bot_db.contests
        ORDER BY starts_at DESC
      `).all() as Array<{
        id: string;
        title: string;
        is_active: number;
        starts_at: string;
        ends_at: string;
      }>;

      if (allContests.length === 0) {
        console.warn('[ContestRepo] No contests found in database');
        return null;
      }

      console.log(`[ContestRepo] Found ${allContests.length} contest(s) in database`);

      // Ищем активный конкурс
      // Сначала ищем конкурс, который уже начался и еще не закончился
      let contest = db.prepare(`
        SELECT 
          id,
          title,
          starts_at,
          ends_at,
          attribution_window_days,
          rules_version,
          is_active
        FROM bot_db.contests
        WHERE is_active = 1 
          AND starts_at <= ?
          AND ends_at >= ?
        ORDER BY starts_at DESC
        LIMIT 1
      `).get(now, now) as {
        id: string;
        title: string;
        starts_at: string;
        ends_at: string;
        attribution_window_days: number;
        rules_version: string;
        is_active: number;
      } | undefined;

      // Если не нашли активный конкурс, ищем конкурс, который еще не начался, но скоро начнется
      // Это нужно для отображения таймера обратного отсчета
      if (!contest) {
        contest = db.prepare(`
          SELECT 
            id,
            title,
            starts_at,
            ends_at,
            attribution_window_days,
            rules_version,
            is_active
          FROM bot_db.contests
          WHERE is_active = 1 
            AND starts_at > ?
          ORDER BY starts_at ASC
          LIMIT 1
        `).get(now) as {
          id: string;
          title: string;
          starts_at: string;
          ends_at: string;
          attribution_window_days: number;
          rules_version: string;
          is_active: number;
        } | undefined;
      }

      if (!contest) {
        // Логируем детали для отладки
        const activeContests = allContests.filter(c => c.is_active === 1);
        console.warn('[ContestRepo] No active contest found matching date criteria', {
          now,
          activeContestsCount: activeContests.length,
          contests: allContests.map(c => ({
            id: c.id,
            title: c.title,
            is_active: c.is_active,
            starts_at: c.starts_at,
            ends_at: c.ends_at,
            matches: c.is_active === 1 && c.starts_at <= now && c.ends_at >= now
          }))
        });
        return null;
      }

      console.log('[ContestRepo] Active contest found', { contestId: contest.id, title: contest.title });
      return {
        id: contest.id,
        title: contest.title,
        starts_at: contest.starts_at,
        ends_at: contest.ends_at,
        attribution_window_days: contest.attribution_window_days,
        rules_version: contest.rules_version,
        is_active: contest.is_active === 1,
      };
    } finally {
      db.prepare('DETACH DATABASE bot_db').run();
    }
  } catch (error) {
    console.error('[ContestRepo] Error fetching active contest:', error);
    if (error instanceof Error) {
      console.error('[ContestRepo] Error details:', {
        message: error.message,
        stack: error.stack,
        botDbPath
      });
    }
    return null;
  }
}

/**
 * Получить сводку по реферальной программе для пользователя
 */
export function getReferralSummary(
  tgId: number,
  contestId: string,
  botDbPath: string
): ContestSummary | null {
  const db = getDatabase();

  try {
    // Прикрепляем базу бота
    try {
      db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    } catch (error) {
      console.error(`[ContestRepo] Failed to attach database: ${botDbPath}`, error);
      if (error instanceof Error) {
        throw new Error(`Failed to attach bot database: ${error.message}`);
      }
      throw error;
    }

    try {
      // Получаем конкурс
      const contest = db.prepare(`
        SELECT 
          id,
          title,
          starts_at,
          ends_at,
          attribution_window_days,
          rules_version,
          is_active
        FROM bot_db.contests
        WHERE id = ?
      `).get(contestId) as {
        id: string;
        title: string;
        starts_at: string;
        ends_at: string;
        attribution_window_days: number;
        rules_version: string;
        is_active: number;
      } | undefined;

      if (!contest) {
        db.prepare('DETACH DATABASE bot_db').run();
        return null;
      }

      // Получаем реферальную ссылку
      const referralCode = `REF${tgId}`;
      const refLink = `https://t.me/outlivion_bot?start=${referralCode}`;

      // Проверяем наличие таблиц ref_events и ticket_ledger
      const { refEventsExists, ticketLedgerExists } = checkContestTables(db, 'bot_db');

      let invitedTotal = 0;
      let qualifiedTotal = 0;
      let ticketsTotal = 0;

      if (refEventsExists && ticketLedgerExists) {
        // Используем новые таблицы
        const stats = db.prepare(`
          SELECT 
            COUNT(*) as invited_total,
            COUNT(CASE WHEN status = 'qualified' THEN 1 END) as qualified_total
          FROM bot_db.ref_events
          WHERE contest_id = ? AND referrer_id = ?
        `).get(contestId, tgId) as {
          invited_total: number;
          qualified_total: number;
        } | undefined;

        invitedTotal = stats?.invited_total || 0;
        qualifiedTotal = stats?.qualified_total || 0;

        // Получаем общее количество билетов из ticket_ledger
        const ticketsResult = db.prepare(`
          SELECT COALESCE(SUM(delta), 0) as tickets_total
          FROM bot_db.ticket_ledger
          WHERE contest_id = ? AND referrer_id = ?
        `).get(contestId, tgId) as { tickets_total: number } | undefined;

        ticketsTotal = ticketsResult?.tickets_total || 0;
      } else {
        // Fallback на старую логику, если таблицы еще не созданы
        // ВАЖНО: Проверяем окно атрибуции, период конкурса и квалификацию

        // Получаем приглашенных друзей за период конкурса
        // Используем COALESCE для совместимости со старыми данными
        const stats = db.prepare(`
          SELECT COUNT(DISTINCT ur.referred_id) as invited_total
          FROM bot_db.user_referrals ur
          WHERE ur.referrer_id = ?
            -- Проверка периода конкурса (если есть информация о времени привязки)
            AND (ur.created_at IS NULL 
              OR (ur.created_at >= ? AND ur.created_at <= ?))
        `).get(tgId, contest.starts_at, contest.ends_at) as {
          invited_total: number;
        } | undefined;

        // Получаем квалифицированных друзей с проверкой окна атрибуции
        const qualifiedCount = db.prepare(`
          SELECT COUNT(DISTINCT ur.referred_id) as qualified_total
          FROM bot_db.user_referrals ur
          JOIN bot_db.orders o ON o.user_id = ur.referred_id
          WHERE ur.referrer_id = ?
            AND o.status IN ('PAID', 'COMPLETED')
            -- Проверка периода конкурса
            AND o.created_at >= ?
            AND o.created_at <= ?
            -- Проверка окна атрибуции (7 дней от привязки)
            AND o.created_at <= datetime(COALESCE(ur.created_at, o.created_at), '+' || ? || ' days')
            -- Проверка квалификации: первый заказ должен быть ПОСЛЕ привязки
            AND NOT EXISTS (
              SELECT 1 FROM bot_db.orders o2
              WHERE o2.user_id = ur.referred_id
                AND o2.status IN ('PAID', 'COMPLETED')
                AND o2.created_at < COALESCE(ur.created_at, o.created_at)
            )
        `).get(tgId, contest.starts_at, contest.ends_at, contest.attribution_window_days) as { qualified_total: number } | undefined;

        // Получаем билеты с теми же проверками
        const ticketsResult = db.prepare(`
          SELECT COALESCE(SUM(${getTicketsFromPlanIdSQL('o.plan_id')}), 0) as tickets_total
          FROM bot_db.orders o
          JOIN bot_db.user_referrals ur ON ur.referred_id = o.user_id
          WHERE ur.referrer_id = ?
            AND o.status IN ('PAID', 'COMPLETED')
            -- Проверка периода конкурса
            AND o.created_at >= ?
            AND o.created_at <= ?
            -- Проверка окна атрибуции
            AND o.created_at <= datetime(COALESCE(ur.created_at, o.created_at), '+' || ? || ' days')
            -- Проверка квалификации
            AND NOT EXISTS (
              SELECT 1 FROM bot_db.orders o2
              WHERE o2.user_id = ur.referred_id
                AND o2.status IN ('PAID', 'COMPLETED')
                AND o2.created_at < COALESCE(ur.created_at, o.created_at)
            )
        `).get(tgId, contest.starts_at, contest.ends_at, contest.attribution_window_days) as { tickets_total: number } | undefined;

        invitedTotal = stats?.invited_total || 0;
        qualifiedTotal = qualifiedCount?.qualified_total || 0;
        ticketsTotal = ticketsResult?.tickets_total || 0;
      }

      const pendingTotal = invitedTotal - qualifiedTotal;

      // УДАЛЕНО: Расчет rank и total_participants (не используется фронтендом)

      return {
        contest: {
          id: contest.id,
          title: contest.title,
          starts_at: contest.starts_at,
          ends_at: contest.ends_at,
          attribution_window_days: contest.attribution_window_days,
          rules_version: contest.rules_version,
          is_active: contest.is_active === 1,
        },
        ref_link: refLink,
        tickets_total: ticketsTotal,
        invited_total: invitedTotal,
        qualified_total: qualifiedTotal,
        pending_total: pendingTotal,
      };
    } finally {
      db.prepare('DETACH DATABASE bot_db').run();
    }
  } catch (error) {
    console.error('Error fetching referral summary:', error);
    return null;
  }
}

/**
 * Получить список приглашенных друзей
 */
export function getReferralFriends(
  tgId: number,
  contestId: string,
  limit: number,
  botDbPath: string
): ReferralFriend[] {
  const db = getDatabase();

  try {
    // Прикрепляем базу бота
    try {
      db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    } catch (error) {
      console.error(`[ContestRepo] Failed to attach database: ${botDbPath}`, error);
      if (error instanceof Error) {
        throw new Error(`Failed to attach bot database: ${error.message}`);
      }
      throw error;
    }

    try {
      // Получаем конкурс для проверок периода и окна атрибуции
      const contest = db.prepare(`
        SELECT 
          id,
          title,
          starts_at,
          ends_at,
          attribution_window_days,
          rules_version,
          is_active
        FROM bot_db.contests
        WHERE id = ?
      `).get(contestId) as {
        id: string;
        title: string;
        starts_at: string;
        ends_at: string;
        attribution_window_days: number;
        rules_version: string;
        is_active: number;
      } | undefined;

      if (!contest) {
        db.prepare('DETACH DATABASE bot_db').run();
        return [];
      }

      // Проверяем наличие таблиц ref_events и ticket_ledger
      const { refEventsExists, ticketLedgerExists } = checkContestTables(db, 'bot_db');

      let friendsRaw: Array<{
        id: string | number;
        name: string | null;
        tg_username: string | null;
        status: string;
        status_reason: string | null;
        bound_at: string | number | null;
        tickets_from_friend_total: number;
      }> = [];

      if (refEventsExists && ticketLedgerExists) {
        // Используем новые таблицы
        friendsRaw = db.prepare(`
          SELECT 
            re.id,
            u.first_name as name,
            u.username as tg_username,
            re.status,
            re.status_reason,
            re.bound_at,
            COALESCE(SUM(tl.delta), 0) as tickets_from_friend_total
          FROM bot_db.ref_events re
          LEFT JOIN bot_db.users u ON u.id = re.referred_id
          LEFT JOIN bot_db.ticket_ledger tl ON tl.contest_id = re.contest_id 
            AND tl.referrer_id = re.referrer_id 
            AND tl.referred_id = re.referred_id
            AND tl.reason = 'INVITEE_PAYMENT'
          WHERE re.contest_id = ? AND re.referrer_id = ?
          GROUP BY re.id, u.first_name, u.username, re.status, re.status_reason, re.bound_at
          ORDER BY re.bound_at DESC
          LIMIT ?
        `).all(contestId, tgId, limit) as Array<{
          id: string;
          name: string | null;
          tg_username: string | null;
          status: string;
          status_reason: string | null;
          bound_at: string;
          tickets_from_friend_total: number;
        }>;
      } else {
        // Fallback на старую логику
        // ВАЖНО: Проверяем окно атрибуции, период конкурса и квалификацию
        friendsRaw = db.prepare(`
          SELECT 
            ur.ROWID as id,
            u.first_name as name,
            u.username as tg_username,
            CASE 
              WHEN EXISTS (
                SELECT 1 FROM bot_db.orders o 
                WHERE o.user_id = ur.referred_id 
                AND o.status IN ('PAID', 'COMPLETED')
                -- Проверка периода конкурса
                AND o.created_at >= ?
                AND o.created_at <= ?
                -- Проверка окна атрибуции (N дней от привязки)
                AND o.created_at <= datetime(COALESCE(ur.created_at, o.created_at), '+' || ? || ' days')
                -- Проверка квалификации: первый заказ должен быть ПОСЛЕ привязки
                AND NOT EXISTS (
                  SELECT 1 FROM bot_db.orders o2
                  WHERE o2.user_id = ur.referred_id
                    AND o2.status IN ('PAID', 'COMPLETED')
                    AND o2.created_at < COALESCE(ur.created_at, o.created_at)
                )
              ) THEN 'qualified'
              ELSE 'bound'
            END as status,
            NULL as status_reason,
            (SELECT MIN(created_at) FROM bot_db.orders WHERE user_id = ur.referred_id) as bound_at,
            COALESCE(SUM(${getTicketsFromPlanIdSQL('o.plan_id')}), 0) as tickets_from_friend_total
          FROM bot_db.user_referrals ur
          LEFT JOIN bot_db.users u ON u.id = ur.referred_id
          LEFT JOIN bot_db.orders o ON o.user_id = ur.referred_id 
            AND o.status IN ('PAID', 'COMPLETED')
            -- Проверка периода конкурса
            AND o.created_at >= ?
            AND o.created_at <= ?
            -- Проверка окна атрибуции
            AND o.created_at <= datetime(COALESCE(ur.created_at, o.created_at), '+' || ? || ' days')
          WHERE ur.referrer_id = ?
          GROUP BY ur.ROWID, u.first_name, u.username
          ORDER BY bound_at DESC
          LIMIT ?
        `).all(contest.starts_at, contest.ends_at, contest.attribution_window_days, contest.starts_at, contest.ends_at, contest.attribution_window_days, tgId, limit) as Array<{
          id: number;
          name: string | null;
          tg_username: string | null;
          status: string;
          status_reason: string | null;
          bound_at: number | null;
          tickets_from_friend_total: number;
        }>;
      }

      // Преобразуем для единого формата
      const friends: ReferralFriend[] = friendsRaw.map(f => ({
        id: String(f.id),
        name: f.name,
        tg_username: f.tg_username,
        status: f.status as ReferralFriend['status'],
        status_reason: f.status_reason,
        bound_at: typeof f.bound_at === 'string'
          ? f.bound_at
          : f.bound_at
            ? new Date(f.bound_at * 1000).toISOString()
            : new Date().toISOString(),
        tickets_from_friend_total: f.tickets_from_friend_total,
      }));

      return friends.map(friend => ({
        id: friend.id,
        name: friend.name,
        tg_username: friend.tg_username,
        status: friend.status as ReferralFriend['status'],
        status_reason: friend.status_reason,
        tickets_from_friend_total: friend.tickets_from_friend_total,
        bound_at: friend.bound_at,
      }));
    } finally {
      db.prepare('DETACH DATABASE bot_db').run();
    }
  } catch (error) {
    console.error('Error fetching referral friends:', error);
    return [];
  }
}

/**
 * Получить историю билетов
 */
export function getTicketHistory(
  tgId: number,
  contestId: string,
  limit: number,
  botDbPath: string
): TicketHistoryEntry[] {
  const db = getDatabase();

  try {
    // Прикрепляем базу бота
    try {
      db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    } catch (error) {
      console.error(`[ContestRepo] Failed to attach database: ${botDbPath}`, error);
      if (error instanceof Error) {
        throw new Error(`Failed to attach bot database: ${error.message}`);
      }
      throw error;
    }

    try {
      // Получаем конкурс для проверок периода и окна атрибуции
      const contest = db.prepare(`
        SELECT 
          id,
          title,
          starts_at,
          ends_at,
          attribution_window_days,
          rules_version,
          is_active
        FROM bot_db.contests
        WHERE id = ?
      `).get(contestId) as {
        id: string;
        title: string;
        starts_at: string;
        ends_at: string;
        attribution_window_days: number;
        rules_version: string;
        is_active: number;
      } | undefined;

      if (!contest) {
        db.prepare('DETACH DATABASE bot_db').run();
        return [];
      }

      // Проверяем наличие таблицы ticket_ledger
      const { ticketLedgerExists } = checkContestTables(db, 'bot_db');

      let history: Array<{
        id: string;
        created_at: string;
        delta: number;
        invitee_name: string | null;
      }> = [];

      if (ticketLedgerExists) {
        // Используем ticket_ledger
        history = db.prepare(`
          SELECT 
            tl.id,
            tl.created_at,
            tl.delta,
            u.first_name as invitee_name
          FROM bot_db.ticket_ledger tl
          LEFT JOIN bot_db.users u ON u.id = tl.referred_id
          WHERE tl.contest_id = ? AND tl.referrer_id = ?
          ORDER BY tl.created_at DESC
          LIMIT ?
        `).all(contestId, tgId, limit) as Array<{
          id: string;
          created_at: string;
          delta: number;
          invitee_name: string | null;
        }>;
      } else {
        // Fallback на старую логику
        // ВАЖНО: Проверяем окно атрибуции и период конкурса
        const historyFallback = db.prepare(`
          SELECT 
            o.id,
            o.created_at,
            ${getTicketsFromPlanIdSQL('o.plan_id')} as delta,
            u.first_name as invitee_name
          FROM bot_db.orders o
          JOIN bot_db.user_referrals ur ON ur.referred_id = o.user_id
          LEFT JOIN bot_db.users u ON u.id = o.user_id
          WHERE ur.referrer_id = ?
            AND o.status IN ('PAID', 'COMPLETED')
            -- Проверка периода конкурса
            AND o.created_at >= ?
            AND o.created_at <= ?
            -- Проверка окна атрибуции (N дней от привязки)
            AND o.created_at <= datetime(COALESCE(ur.created_at, o.created_at), '+' || ? || ' days')
          ORDER BY o.created_at DESC
          LIMIT ?
        `).all(tgId, contest.starts_at, contest.ends_at, contest.attribution_window_days, limit) as Array<{
          id: string;
          created_at: number;
          delta: number;
          invitee_name: string | null;
        }>;

        // Преобразуем для единого формата
        history = historyFallback.map(entry => ({
          id: entry.id,
          created_at: new Date(entry.created_at * 1000).toISOString(),
          delta: entry.delta,
          invitee_name: entry.invitee_name,
        }));
      }

      return history.map(entry => ({
        id: entry.id,
        created_at: entry.created_at,
        delta: entry.delta,
        label: entry.delta > 0
          ? entry.delta === 1
            ? `Оплата 1 месяц от ${entry.invitee_name || 'друга'}`
            : entry.delta < 5
              ? `Оплата ${entry.delta} месяца от ${entry.invitee_name || 'друга'}`
              : `Оплата ${entry.delta} месяцев от ${entry.invitee_name || 'друга'}`
          : `Возврат ${Math.abs(entry.delta)} ${Math.abs(entry.delta) === 1 ? 'месяц' : Math.abs(entry.delta) < 5 ? 'месяца' : 'месяцев'}`,
        invitee_name: entry.invitee_name,
      }));
    } finally {
      db.prepare('DETACH DATABASE bot_db').run();
    }
  } catch (error) {
    console.error('Error fetching ticket history:', error);
    return [];
  }
}

/**
 * Участник конкурса (админский вид)
 */
export interface ContestParticipant {
  referrer_id: number; // Telegram ID участника
  referrer_name: string | null;
  referrer_username: string | null;
  tickets_total: number;
  invited_total: number;
  qualified_total: number;
  rank: number;
  orders: Array<{
    order_id: string;
    payment_date: string; // ISO datetime
    invitee_id: number;
    invitee_name: string | null;
    plan_id: string;
    months: number;
    tickets: number;
  }>;
}

/**
 * Запись билета для розыгрыша (развернутая форма)
 */
export interface ContestTicket {
  referrer_id: number; // ID участника (получатель билета)
  referred_id: number; // ID приглашенного (или сам участник для SELF_PURCHASE)
  order_id: string; // ID заказа
}

/**
 * Получить все билеты конкурса развернуто (для розыгрыша)
 * Каждая запись из ticket_ledger разворачивается на delta строк
 */
export function getAllContestTickets(
  contestId: string,
  botDbPath: string
): ContestTicket[] {
  const db = getDatabase();

  try {
    // Прикрепляем базу бота
    try {
      db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    } catch (error) {
      console.error(`[ContestRepo] Failed to attach database: ${botDbPath}`, error);
      if (error instanceof Error) {
        throw new Error(`Failed to attach bot database: ${error.message}`);
      }
      throw error;
    }

    try {
      // Проверяем наличие таблицы ticket_ledger
      const { ticketLedgerExists } = checkContestTables(db, 'bot_db');

      if (!ticketLedgerExists) {
        console.warn('[ContestRepo] Table ticket_ledger not found');
        return [];
      }

      // Получаем все записи из ticket_ledger с положительным delta (игнорируем REFUND)
      const ledgerEntries = db.prepare(`
        SELECT 
          tl.referrer_id,
          tl.referred_id,
          COALESCE(tl.order_id, tl.id) as order_id,
          tl.delta
        FROM bot_db.ticket_ledger tl
        WHERE tl.contest_id = ? AND tl.delta > 0
        ORDER BY tl.created_at ASC
      `).all(contestId) as Array<{
        referrer_id: number;
        referred_id: number;
        order_id: string;
        delta: number;
      }>;

      // Разворачиваем каждую запись на delta строк
      const tickets: ContestTicket[] = [];
      for (const entry of ledgerEntries) {
        for (let i = 0; i < entry.delta; i++) {
          tickets.push({
            referrer_id: entry.referrer_id,
            referred_id: entry.referred_id,
            order_id: entry.order_id,
          });
        }
      }

      return tickets;
    } finally {
      db.prepare('DETACH DATABASE bot_db').run();
    }
  } catch (error) {
    console.error('[ContestRepo] Error fetching all contest tickets:', error);
    return [];
  }
}

/**
 * Получить всех участников конкурса с данными об оплатах (админский endpoint)
 */
export function getAllContestParticipants(
  contestId: string,
  botDbPath: string
): ContestParticipant[] {
  const db = getDatabase();

  try {
    // Прикрепляем базу бота
    try {
      db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    } catch (error) {
      console.error(`[ContestRepo] Failed to attach database: ${botDbPath}`, error);
      if (error instanceof Error) {
        throw new Error(`Failed to attach bot database: ${error.message}`);
      }
      throw error;
    }

    try {
      // Проверяем наличие таблиц
      const { refEventsExists, ticketLedgerExists } = checkContestTables(db, 'bot_db');

      if (!refEventsExists || !ticketLedgerExists) {
        console.warn('[ContestRepo] Tables ref_events or ticket_ledger not found');
        return [];
      }

      // Получаем всех участников конкурса с их статистикой
      const participantsRaw = db.prepare(`
        SELECT 
          tl.referrer_id,
          u.first_name as referrer_name,
          u.username as referrer_username,
          COALESCE(SUM(tl.delta), 0) as tickets_total,
          COUNT(DISTINCT re.id) as invited_total,
          COUNT(DISTINCT CASE WHEN re.status = 'qualified' THEN re.id END) as qualified_total
        FROM bot_db.ticket_ledger tl
        LEFT JOIN bot_db.users u ON u.id = tl.referrer_id
        LEFT JOIN bot_db.ref_events re ON re.contest_id = tl.contest_id 
          AND re.referrer_id = tl.referrer_id
        WHERE tl.contest_id = ?
        GROUP BY tl.referrer_id, u.first_name, u.username
        ORDER BY tickets_total DESC
      `).all(contestId) as Array<{
        referrer_id: number;
        referrer_name: string | null;
        referrer_username: string | null;
        tickets_total: number;
        invited_total: number;
        qualified_total: number;
      }>;

      // Для каждого участника получаем детали заказов
      const participants: ContestParticipant[] = participantsRaw.map((participant, index) => {
        // Получаем заказы участника с информацией об оплатах
        const orders = db.prepare(`
          SELECT 
            COALESCE(tl.order_id, tl.id) as order_id,
            tl.created_at as payment_date,
            tl.referred_id as invitee_id,
            u.first_name as invitee_name,
            COALESCE(o.plan_id, 'unknown') as plan_id,
            tl.delta as tickets,
            CASE 
              WHEN o.plan_id IS NOT NULL THEN ${getTicketsFromPlanIdSQL('o.plan_id')}
              ELSE ABS(tl.delta)
            END as months
          FROM bot_db.ticket_ledger tl
          LEFT JOIN bot_db.orders o ON o.id = tl.order_id OR o.id = CAST(tl.order_id AS TEXT)
          LEFT JOIN bot_db.users u ON u.id = tl.referred_id
          WHERE tl.contest_id = ? AND tl.referrer_id = ? AND tl.reason = 'INVITEE_PAYMENT'
          ORDER BY tl.created_at DESC
        `).all(contestId, participant.referrer_id) as Array<{
          order_id: string;
          payment_date: string;
          invitee_id: number;
          invitee_name: string | null;
          plan_id: string;
          tickets: number;
          months: number;
        }>;

        return {
          referrer_id: participant.referrer_id,
          referrer_name: participant.referrer_name,
          referrer_username: participant.referrer_username,
          tickets_total: participant.tickets_total,
          invited_total: participant.invited_total,
          qualified_total: participant.qualified_total,
          rank: index + 1, // Позиция в рейтинге
          orders: orders.map(order => ({
            order_id: order.order_id,
            payment_date: order.payment_date,
            invitee_id: order.invitee_id,
            invitee_name: order.invitee_name,
            plan_id: order.plan_id,
            months: order.months,
            tickets: order.tickets,
          })),
        };
      });

      return participants;
    } finally {
      db.prepare('DETACH DATABASE bot_db').run();
    }
  } catch (error) {
    console.error('[ContestRepo] Error fetching all participants:', error);
    return [];
  }
}
