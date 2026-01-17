import { getDatabase } from './db.js';

export interface Contest {
  id: string;
  title: string;
  starts_at: string; // ISO datetime
  ends_at: string; // ISO datetime
  attribution_window_days: number;
  rules_version: string;
  is_active: boolean;
}

export interface ContestSummary {
  contest: Contest;
  ref_link: string;
  tickets_total: number;
  invited_total: number;
  qualified_total: number;
  pending_total: number;
  rank?: number | null; // Позиция в рейтинге (1 = первое место)
  total_participants?: number | null; // Общее количество участников
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
    db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    
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
    db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    
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
      db.close();
      return null;
    }

    // Получаем реферальную ссылку
    const referralCode = `REF${tgId}`;
    const refLink = `https://t.me/outlivion_bot?start=${referralCode}`;

      // Проверяем наличие таблиц ref_events и ticket_ledger
      const refEventsExists = db.prepare(`
        SELECT name FROM bot_db.sqlite_master 
        WHERE type='table' AND name='ref_events'
      `).get() as { name: string } | undefined;

      const ticketLedgerExists = db.prepare(`
        SELECT name FROM bot_db.sqlite_master 
        WHERE type='table' AND name='ticket_ledger'
      `).get() as { name: string } | undefined;

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
        const stats = db.prepare(`
          SELECT COUNT(*) as invited_total
          FROM bot_db.user_referrals
          WHERE referrer_id = ?
        `).get(tgId) as {
          invited_total: number;
        } | undefined;

        const qualifiedCount = db.prepare(`
          SELECT COUNT(DISTINCT ur.referred_id) as qualified_total
          FROM bot_db.user_referrals ur
          JOIN bot_db.orders o ON o.user_id = ur.referred_id
          WHERE ur.referrer_id = ?
            AND o.status IN ('PAID', 'COMPLETED')
        `).get(tgId) as { qualified_total: number } | undefined;

        invitedTotal = stats?.invited_total || 0;
        qualifiedTotal = qualifiedCount?.qualified_total || 0;

        const ticketsResult = db.prepare(`
          SELECT COALESCE(SUM(
            CASE 
              WHEN o.plan_id = 'plan_30' THEN 1
              WHEN o.plan_id = 'plan_90' THEN 3
              WHEN o.plan_id = 'plan_180' THEN 6
              WHEN o.plan_id = 'plan_365' THEN 12
              WHEN o.plan_id LIKE 'plan_%' THEN CAST(SUBSTR(o.plan_id, 6) AS INTEGER) / 30
              ELSE 1
            END
          ), 0) as tickets_total
          FROM bot_db.orders o
          JOIN bot_db.user_referrals ur ON ur.referred_id = o.user_id
          WHERE ur.referrer_id = ?
            AND o.status IN ('PAID', 'COMPLETED')
        `).get(tgId) as { tickets_total: number } | undefined;

        ticketsTotal = ticketsResult?.tickets_total || 0;
      }

      const pendingTotal = invitedTotal - qualifiedTotal;

      // Рассчитываем позицию в рейтинге
      // Считаем количество участников с большим количеством билетов
      let rank: number | null = null;
      let totalParticipants: number | null = null;

      if (refEventsExists && ticketLedgerExists) {
        // Получаем общее количество участников
        const participantsResult = db.prepare(`
          SELECT COUNT(DISTINCT referrer_id) as total_participants
          FROM bot_db.ticket_ledger
          WHERE contest_id = ?
        `).get(contestId) as { total_participants: number } | undefined;

        totalParticipants = participantsResult?.total_participants || 0;

        // Рассчитываем позицию: сколько участников имеют больше билетов
        if (totalParticipants > 0) {
          // Считаем количество участников с большим количеством билетов
          const rankResult = db.prepare(`
            WITH user_tickets AS (
              SELECT referrer_id, COALESCE(SUM(delta), 0) as total_tickets
              FROM bot_db.ticket_ledger
              WHERE contest_id = ?
              GROUP BY referrer_id
            ),
            current_user_tickets AS (
              SELECT COALESCE(SUM(delta), 0) as total_tickets
              FROM bot_db.ticket_ledger
              WHERE contest_id = ? AND referrer_id = ?
            )
            SELECT COUNT(*) + 1 as rank
            FROM user_tickets
            WHERE total_tickets > (SELECT total_tickets FROM current_user_tickets)
          `).get(contestId, contestId, tgId) as { rank: number } | undefined;

          rank = rankResult?.rank || null;

          // Если у пользователя нет билетов, но он участвует, позиция = общее количество участников
          if (ticketsTotal === 0 && totalParticipants > 0) {
            rank = totalParticipants;
          } else if (rank === null && ticketsTotal > 0) {
            // Если пользователь есть в таблице, но запрос вернул null, значит он первый
            rank = 1;
          }
        }
      }

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
        rank: rank,
        total_participants: totalParticipants,
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
    db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    
    try {
      // Проверяем наличие таблицы ref_events
      const refEventsExists = db.prepare(`
        SELECT name FROM bot_db.sqlite_master 
        WHERE type='table' AND name='ref_events'
      `).get() as { name: string } | undefined;

      const ticketLedgerExists = db.prepare(`
        SELECT name FROM bot_db.sqlite_master 
        WHERE type='table' AND name='ticket_ledger'
      `).get() as { name: string } | undefined;

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
              ) THEN 'qualified'
              ELSE 'bound'
            END as status,
            NULL as status_reason,
            (SELECT MIN(created_at) FROM bot_db.orders WHERE user_id = ur.referred_id) as bound_at,
            COALESCE(SUM(
              CASE 
                WHEN o.plan_id = 'plan_30' THEN 1
                WHEN o.plan_id = 'plan_90' THEN 3
                WHEN o.plan_id = 'plan_180' THEN 6
                WHEN o.plan_id = 'plan_365' THEN 12
                WHEN o.plan_id LIKE 'plan_%' THEN CAST(SUBSTR(o.plan_id, 6) AS INTEGER) / 30
                ELSE 1
              END
            ), 0) as tickets_from_friend_total
          FROM bot_db.user_referrals ur
          LEFT JOIN bot_db.users u ON u.id = ur.referred_id
          LEFT JOIN bot_db.orders o ON o.user_id = ur.referred_id AND o.status IN ('PAID', 'COMPLETED')
          WHERE ur.referrer_id = ?
          GROUP BY ur.ROWID, u.first_name, u.username
          ORDER BY bound_at DESC
          LIMIT ?
        `).all(tgId, limit) as Array<{
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
    db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    
    try {
      // Проверяем наличие таблицы ticket_ledger
      const ticketLedgerExists = db.prepare(`
        SELECT name FROM bot_db.sqlite_master 
        WHERE type='table' AND name='ticket_ledger'
      `).get() as { name: string } | undefined;

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
        const historyFallback = db.prepare(`
          SELECT 
            o.id,
            o.created_at,
            CASE 
              WHEN o.plan_id = 'plan_30' THEN 1
              WHEN o.plan_id = 'plan_90' THEN 3
              WHEN o.plan_id = 'plan_180' THEN 6
              WHEN o.plan_id = 'plan_365' THEN 12
              WHEN o.plan_id LIKE 'plan_%' THEN CAST(SUBSTR(o.plan_id, 6) AS INTEGER) / 30
              ELSE 1
            END as delta,
            u.first_name as invitee_name
          FROM bot_db.orders o
          JOIN bot_db.user_referrals ur ON ur.referred_id = o.user_id
          LEFT JOIN bot_db.users u ON u.id = o.user_id
          WHERE ur.referrer_id = ?
            AND o.status IN ('PAID', 'COMPLETED')
          ORDER BY o.created_at DESC
          LIMIT ?
        `).all(tgId, limit) as Array<{
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
    db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    
    try {
      // Проверяем наличие таблицы ticket_ledger
      const ticketLedgerExists = db.prepare(`
        SELECT name FROM bot_db.sqlite_master 
        WHERE type='table' AND name='ticket_ledger'
      `).get() as { name: string } | undefined;

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
    db.prepare('ATTACH DATABASE ? AS bot_db').run(botDbPath);
    
    try {
      // Проверяем наличие таблиц
      const refEventsExists = db.prepare(`
        SELECT name FROM bot_db.sqlite_master 
        WHERE type='table' AND name='ref_events'
      `).get() as { name: string } | undefined;

      const ticketLedgerExists = db.prepare(`
        SELECT name FROM bot_db.sqlite_master 
        WHERE type='table' AND name='ticket_ledger'
      `).get() as { name: string } | undefined;

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
              WHEN o.plan_id = 'plan_30' THEN 1
              WHEN o.plan_id = 'plan_90' THEN 3
              WHEN o.plan_id = 'plan_180' THEN 6
              WHEN o.plan_id = 'plan_365' THEN 12
              WHEN o.plan_id LIKE 'plan_%' THEN CAST(SUBSTR(o.plan_id, 6) AS INTEGER) / 30
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
