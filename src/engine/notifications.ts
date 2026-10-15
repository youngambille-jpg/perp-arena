// In-app notification rows. The mobile app receives these
// instantly over Supabase Realtime (postgres_changes).

import { pool } from '../lib/db.js';

export async function notify(
  userId: string,
  kind: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    await pool.query(
      `insert into notifications (user_id, kind, payload) values ($1, $2, $3)`,
      [userId, kind, JSON.stringify(payload)],
    );
  } catch (error) {
    // A failed notification must never break the engine loop.
    console.error('notification insert failed', error);
  }
}
