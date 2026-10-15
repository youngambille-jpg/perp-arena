// Integration test: tournament scoring + leader stats against
// a real Postgres. Requires the local test DB on :55433 with
// sql/schema.sql applied. Run with:
//   pnpm exec tsx integration.ts

process.env.SUPABASE_DB_URL =
  'postgresql://runner@/postgres?host=/tmp/opencode/pgsock&port=55433';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.KEY_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { pool } = await import('./src/lib/db.js');
const { TournamentEngine } = await import('./src/engine/tournaments.js');
const { refreshLeaderStats } = await import('./src/engine/leaders.js');

let failures = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, extra ?? '');
  }
};

const sessions = {
  sessionFor: () => undefined,
  restFor: () => undefined,
  equityOf: () => undefined,
};

// Clean slate
await pool.query(`delete from leaderboard_snapshots`);
await pool.query(`delete from tournament_entries`);
await pool.query(`delete from tournaments`);
await pool.query(`delete from equity_snapshots`);
await pool.query(`delete from leader_profiles`);

const alice = '11111111-1111-1111-1111-111111111111';
const bob = '22222222-2222-2222-2222-222222222222';

// Alice: 1000 -> 1200 (peak 1250, trough dips) ; Bob: 1000 -> 900.
const now = Date.now();
const curve = async (userId: string, equities: number[]) => {
  for (let i = 0; i < equities.length; i++) {
    await pool.query(
      `insert into equity_snapshots (user_id, at, equity) values ($1, $2, $3)`,
      [userId, new Date(now - (equities.length - i) * 3600_000), equities[i]],
    );
  }
};
await curve(alice, [1000, 1100, 1250, 1150, 1200]);
await curve(bob, [1000, 950, 980, 920, 900]);

await pool.query(
  `insert into leader_profiles (user_id, is_public, styles) values ($1, true, '{swing}'), ($2, true, '{scalper}')`,
  [alice, bob],
);

const { rows: trows } = await pool.query(
  `insert into tournaments (name, metric, status, starts_at, ends_at)
   values ('weekly-1', 'risk_adjusted_pnl', 'active', now() - interval '1 day', now() + interval '6 days')
   returning id`,
);
const tournamentId = trows[0].id as string;
await pool.query(
  `insert into tournament_entries (tournament_id, user_id, equity_start, equity_peak, equity_low)
   values ($1, $2, 1000, 1000, 1000), ($1, $3, 1000, 1000, 1000)`,
  [tournamentId, alice, bob],
);

await new TournamentEngine(sessions).scoreOnce();

const { rows: entries } = await pool.query(
  `select user_id, net_pnl, max_drawdown, score, rank from tournament_entries
    where tournament_id = $1 order by rank`,
  [tournamentId],
);
check('two entries ranked', entries.length === 2, entries);
const [first, second] = entries;
check('alice ranks first', first.user_id === alice && first.rank === 1, first);
check('alice net pnl = 200', Math.abs(first.net_pnl - 200) < 1e-9, first);
// Alice peak 1250, low 1150 -> DD = 100/1250 = 0.08; score = 200/1.08.
check(
  'alice score = 200/1.08',
  Math.abs(first.score - 200 / 1.08) < 1e-9 && Math.abs(first.max_drawdown - 0.08) < 1e-9,
  first,
);
check('bob negative score, rank 2', second.user_id === bob && second.rank === 2 && second.score < 0, second);

const { rows: snaps } = await pool.query(
  `select count(*)::int as n from leaderboard_snapshots where tournament_id = $1`,
  [tournamentId],
);
check('leaderboard snapshots written', snaps[0].n === 2, snaps[0]);

await refreshLeaderStats();
const { rows: profiles } = await pool.query(
  `select user_id, total_pnl_usd, win_rate, max_drawdown from leader_profiles order by user_id`,
);
const aliceProfile = profiles.find((p) => p.user_id === alice);
check('alice total pnl = 200', Math.abs(aliceProfile.total_pnl_usd - 200) < 1e-9, aliceProfile);
check('alice drawdown = 0.08', Math.abs(aliceProfile.max_drawdown - 0.08) < 1e-9, aliceProfile);

await pool.end();
if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nall integration tests passed');
