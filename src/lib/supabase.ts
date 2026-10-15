// Supabase client used for two purposes:
//  - verifying mobile app JWTs (auth.getUser)
//  - the anon/service-role clients the mobile app itself uses for Realtime

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } from '../config.js';

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
export const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** Verifies a Supabase access token and returns the user id, or null. */
export async function verifySupabaseToken(token: string): Promise<string | null> {
  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}
