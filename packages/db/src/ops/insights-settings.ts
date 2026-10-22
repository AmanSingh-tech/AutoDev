/**
 * Insights settings (B-4), kept in `orgs.settings` like the other Section B settings. The defaults
 * are deliberately private: leaderboards can be sensitive, so each org opts in.
 */
export const LEADERBOARD_VISIBILITY = ['all', 'team_leads', 'admins'] as const;
export type LeaderboardVisibility = (typeof LEADERBOARD_VISIBILITY)[number];

export interface InsightsSettings {
  /** Who sees the leaderboard: every member, team leads (their own teams) and admins, or admins only. */
  leaderboardVisibility: LeaderboardVisibility;
  /** Hide cost figures (cost, cost per PR) from everyone but admins. */
  hideCostFromNonAdmins: boolean;
  badgesEnabled: boolean;
  /** When the nightly rollup last finished, for "data through" labels. ISO string. */
  insightsComputedAt: string | null;
}

export function insightsSettings(settings: Record<string, unknown> | null | undefined): InsightsSettings {
  const s = settings ?? {};
  const visibility = s.leaderboardVisibility;
  return {
    leaderboardVisibility: (LEADERBOARD_VISIBILITY as readonly unknown[]).includes(visibility) ? (visibility as LeaderboardVisibility) : 'admins',
    hideCostFromNonAdmins: s.hideCostFromNonAdmins !== false,
    badgesEnabled: s.badgesEnabled === true,
    insightsComputedAt: typeof s.insightsComputedAt === 'string' ? s.insightsComputedAt : null,
  };
}
