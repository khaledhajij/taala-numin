import type { ChallengeConfig, DailyAchievementRecord, MembershipStatus, StudentProfile } from '../types/domain';

export const EMPTY_CHALLENGE: ChallengeConfig = {
  id: '', title: 'تعالَ نؤمن ساعة', communityName: 'حلقة سيدنا أبو بكر الصديق',
  startDate: null, durationDays: 30, collectiveGoalPct: 80, isArchived: false,
};

export function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String(error.message) : 'تعذّر الاتصال بالخادم. يرجى المحاولة مجدداً.';
}

export function validateProfileNames(adminName: string, displayName: string): string | null {
  const adminLength = [...adminName.trim()].length;
  const displayLength = [...displayName.trim()].length;
  return adminLength < 2 || adminLength > 80 || displayLength < 2 || displayLength > 50
    ? 'يجب أن يكون الاسم لدى المشرف بين حرفين و80 حرفاً، والاسم الظاهر بين حرفين و50 حرفاً.' : null;
}

export function mapProfile(p: Record<string, unknown>): StudentProfile {
  return {
    id: String(p.id), email: String(p.email), adminKnownName: String(p.admin_known_name),
    publicDisplayName: String(p.public_display_name), leaderboardOptIn: Boolean(p.leaderboard_opt_in),
    membershipStatus: p.membership_status as MembershipStatus, statusReason: p.status_reason as string | null,
    statusUpdatedAt: String(p.status_updated_at ?? ''), isAdmin: Boolean(p.is_admin),
    challengeMembershipStatus: (p.challenge_membership_status ?? null) as MembershipStatus | null,
  };
}

export function mapAchievement(r: Record<string, unknown>): DailyAchievementRecord {
  return {
    id: String(r.id), challengeId: String(r.challenge_id), studentId: String(r.student_id),
    achievementDate: String(r.achievement_date), quranTwoPages: Boolean(r.quran_two_pages),
    ishaCongregation: Boolean(r.isha_congregation), morningAdhkar: Boolean(r.morning_adhkar),
    points: Number(r.points), revision: Number(r.revision), updatedAt: String(r.updated_at),
  };
}

export function mapChallenge(c: Record<string, unknown> | null): ChallengeConfig {
  if (!c) return EMPTY_CHALLENGE;
  return {
    id: String(c.id), title: String(c.title), communityName: String(c.community_name),
    startDate: c.start_date as string | null, durationDays: Number(c.duration_days),
    collectiveGoalPct: Number(c.collective_goal_pct), isArchived: Boolean(c.is_archived),
  };
}

export function mapReport(data: Record<string, unknown>) {
  return {
    profiles: (data.profiles as Record<string, unknown>[]).map(mapProfile),
    achievements: (data.achievements as Record<string, unknown>[]).map(mapAchievement),
    challenge: mapChallenge(data.challenge as Record<string, unknown> | null),
    today: String(data.damascus_today), generatedAt: String(data.generated_at),
  };
}
