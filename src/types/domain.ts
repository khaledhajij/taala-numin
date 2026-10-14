export type MembershipStatus = 'pending' | 'approved' | 'suspended';

export type ChallengeLifecycleState = 'upcoming' | 'active' | 'completed' | 'archived';

export interface StudentProfile {
  id: string;
  email: string;
  adminKnownName: string;
  publicDisplayName: string;
  leaderboardOptIn: boolean;
  membershipStatus: MembershipStatus;
  statusReason?: string | null;
  statusUpdatedAt: string;
}

export interface ChallengeConfig {
  id: string;
  title: string;
  communityName: string;
  startDate: string | null; // YYYY-MM-DD in Asia/Damascus, null until admin sets it
  durationDays: number; // default 30
  collectiveGoalPct: number; // default 80
  isArchived: boolean;
  archivedAt?: string | null;
}

export interface DailyActivitiesInput {
  quranTwoPages: boolean;
  ishaCongregation: boolean;
  morningAdhkar: boolean;
}

export interface DailyAchievementRecord extends DailyActivitiesInput {
  id: string;
  challengeId: string;
  studentId: string;
  achievementDate: string; // YYYY-MM-DD
  points: number; // 0..3 derived
  revision: number; // starts at 1, increments on each save
  updatedAt: string;
}

export interface CalendarDayDetail {
  dayNumber: number; // 1..30
  date: string; // YYYY-MM-DD
  weekNumber: number; // 1..5
  isToday: boolean;
  isPast: boolean;
  isFuture: boolean;
  quranTwoPages: boolean;
  ishaCongregation: boolean;
  morningAdhkar: boolean;
  points: number; // 0..3
  revision: number;
  hasRecord: boolean;
}

export interface PersonalDashboardMetrics {
  totalPoints: number;
  maxPossiblePoints: number; // 90 for 30-day challenge
  currentWeekPoints: number;
  currentWeekMaxPoints: number;
  elapsedDays: number;
  availablePointsToDate: number;
  completionPercentage: number;
  streakDays: number;
  fullDaysCount: number;
  latestRecordedDate: string | null;
  calendarDays: CalendarDayDetail[];
}

export interface PublicLeaderboardRow {
  rank: number;
  displayName: string;
  points: number;
  fullDaysCount?: number;
  isCurrentUser: boolean;
}

export interface LeaderboardAndGroupSummary {
  challengeId: string;
  damascusToday: string;
  elapsedDays: number;
  currentWeekNumber: number;
  collectiveGoalPct: number;
  approvedStudentCount: number;
  groupTotalPoints: number;
  groupAvailablePoints: number;
  groupCompletionPct: number;
  overallRankings: PublicLeaderboardRow[];
  weeklyRankings: PublicLeaderboardRow[];
  myRankSummary: {
    overallRank: number;
    weekRank: number;
    totalPoints: number;
    weekPoints: number;
    leaderboardOptIn: boolean;
    displayName: string;
  } | null;
}
