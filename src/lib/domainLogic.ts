import {
  CalendarDayDetail,
  ChallengeConfig,
  ChallengeLifecycleState,
  DailyAchievementRecord,
  DailyActivitiesInput,
  LeaderboardAndGroupSummary,
  PersonalDashboardMetrics,
  PublicLeaderboardRow,
  StudentProfile,
} from '../types/domain';

export const DAILY_ACTIVITIES_META = [
  {
    key: 'quranTwoPages' as const,
    title: 'قراءة صفحتين من القرآن الكريم',
    subtitle: 'ورد يومي ثابت يربط القلب بكتاب الله عز وجل',
    points: 1,
  },
  {
    key: 'ishaCongregation' as const,
    title: 'صلاة العشاء في جماعة',
    subtitle: 'الحرص على شهود الجماعة في المسجد أو مع الأهل والرفقة',
    points: 1,
  },
  {
    key: 'morningAdhkar' as const,
    title: 'أذكار الصباح',
    subtitle: 'تحصين اليوم وبدء الصباح بذكر الله وطمأنينة القلب',
    points: 1,
  },
] as const;

export const ENCOURAGEMENT_MOTTO =
  'نتنافس على المواظبة، والنقاط لا تقيس صلاح أحد أو إخلاصه.';

/**
 * Returns the current date string (YYYY-MM-DD) in Asia/Damascus timezone.
 * Uses formatToParts so it is locale-independent across all browsers and runtimes.
 */
export function getDamascusDateString(referenceInstant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Damascus',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceInstant);

  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/**
 * Adds a whole number of calendar days to a YYYY-MM-DD string in UTC-neutral calendar math.
 */
export function addCalendarDays(dateStr: string, daysToAdd: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + daysToAdd));
  return dt.toISOString().slice(0, 10);
}

/**
 * Computes whole calendar day difference (endDate - startDate).
 */
export function diffCalendarDays(startDate: string, endDate: string): number {
  const [y1, m1, d1] = startDate.split('-').map(Number);
  const [y2, m2, d2] = endDate.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / 86_400_000);
}

/**
 * Derives points strictly from the 3 boolean activity flags (0..3).
 * Never trusts any external/browser score field.
 */
export function computeActivityPoints(input: DailyActivitiesInput): number {
  return (
    (input.quranTwoPages ? 1 : 0) +
    (input.ishaCongregation ? 1 : 0) +
    (input.morningAdhkar ? 1 : 0)
  );
}

/**
 * Evaluates the challenge status and day/week boundaries relative to Damascus today.
 */
export function evaluateChallengeWindow(
  challenge: ChallengeConfig,
  damascusToday: string
): {
  state: ChallengeLifecycleState;
  endDate: string | null;
  currentDayNumber: number | null;
  elapsedDays: number;
  currentWeekNumber: number;
  weekStartDate: string | null;
  weekEndDate: string | null;
} {
  if (challenge.isArchived) {
    const endDate = challenge.startDate
      ? addCalendarDays(challenge.startDate, challenge.durationDays - 1)
      : null;
    return {
      state: 'archived',
      endDate,
      currentDayNumber: null,
      elapsedDays: challenge.startDate ? challenge.durationDays : 0,
      currentWeekNumber: Math.ceil(challenge.durationDays / 7),
      weekStartDate: challenge.startDate,
      weekEndDate: endDate,
    };
  }

  if (!challenge.startDate) {
    return {
      state: 'upcoming',
      endDate: null,
      currentDayNumber: null,
      elapsedDays: 0,
      currentWeekNumber: 1,
      weekStartDate: null,
      weekEndDate: null,
    };
  }

  const endDate = addCalendarDays(challenge.startDate, challenge.durationDays - 1);
  const offset = diffCalendarDays(challenge.startDate, damascusToday);

  if (offset < 0) {
    return {
      state: 'upcoming',
      endDate,
      currentDayNumber: null,
      elapsedDays: 0,
      currentWeekNumber: 1,
      weekStartDate: challenge.startDate,
      weekEndDate: addCalendarDays(challenge.startDate, Math.min(6, challenge.durationDays - 1)),
    };
  }

  if (offset >= challenge.durationDays) {
    const lastWeekNumber = Math.floor((challenge.durationDays - 1) / 7) + 1;
    const weekStartOffset = (lastWeekNumber - 1) * 7;
    return {
      state: 'completed',
      endDate,
      currentDayNumber: challenge.durationDays,
      elapsedDays: challenge.durationDays,
      currentWeekNumber: lastWeekNumber,
      weekStartDate: addCalendarDays(challenge.startDate, weekStartOffset),
      weekEndDate: endDate,
    };
  }

  const currentDayNumber = offset + 1;
  const elapsedDays = currentDayNumber;
  const currentWeekNumber = Math.floor((currentDayNumber - 1) / 7) + 1;
  const weekStartOffset = (currentWeekNumber - 1) * 7;
  const weekStartDate = addCalendarDays(challenge.startDate, weekStartOffset);
  const weekEndDate = addCalendarDays(
    challenge.startDate,
    Math.min(weekStartOffset + 6, challenge.durationDays - 1)
  );

  return {
    state: 'active',
    endDate,
    currentDayNumber,
    elapsedDays,
    currentWeekNumber,
    weekStartDate,
    weekEndDate,
  };
}

/**
 * Calculates consecutive fully completed days (3/3 activities).
 * Rule: An incomplete current day must NOT prematurely erase a streak that was valid through yesterday.
 */
export function calculateStreakDays(
  challenge: ChallengeConfig,
  studentAchievements: DailyAchievementRecord[],
  damascusToday: string
): number {
  if (!challenge.startDate) return 0;
  const offset = diffCalendarDays(challenge.startDate, damascusToday);
  if (offset < 0) return 0;

  const endDate = addCalendarDays(challenge.startDate, challenge.durationDays - 1);
  const effectiveLastDate = damascusToday <= endDate ? damascusToday : endDate;

  const byDate = new Map<string, number>();
  for (const rec of studentAchievements) {
    if (rec.challengeId === challenge.id) {
      byDate.set(rec.achievementDate, computeActivityPoints(rec));
    }
  }

  let cursorDate = effectiveLastDate;
  const todayPoints = byDate.get(effectiveLastDate) ?? 0;

  if (todayPoints < 3) {
    if (effectiveLastDate === damascusToday) {
      cursorDate = addCalendarDays(effectiveLastDate, -1);
    } else {
      return 0;
    }
  }

  let streak = 0;
  while (cursorDate >= challenge.startDate) {
    const pts = byDate.get(cursorDate) ?? 0;
    if (pts === 3) {
      streak += 1;
      cursorDate = addCalendarDays(cursorDate, -1);
    } else {
      break;
    }
  }

  return streak;
}

/**
 * Computes full personal dashboard metrics and 30-day calendar breakdown for a student.
 */
export function calculatePersonalDashboard(
  challenge: ChallengeConfig,
  studentAchievements: DailyAchievementRecord[],
  damascusToday: string
): PersonalDashboardMetrics {
  const windowInfo = evaluateChallengeWindow(challenge, damascusToday);
  const byDate = new Map<string, DailyAchievementRecord>();
  let latestRecordedDate: string | null = null;

  for (const rec of studentAchievements) {
    if (rec.challengeId !== challenge.id) continue;
    byDate.set(rec.achievementDate, rec);
    const derivedPoints = computeActivityPoints(rec);
    if (derivedPoints > 0 && (!latestRecordedDate || rec.achievementDate > latestRecordedDate)) {
      latestRecordedDate = rec.achievementDate;
    }
  }

  const calendarDays: CalendarDayDetail[] = [];
  let totalPoints = 0;
  let currentWeekPoints = 0;
  let fullDaysCount = 0;

  for (let i = 0; i < challenge.durationDays; i++) {
    const dayNumber = i + 1;
    const weekNumber = Math.floor(i / 7) + 1;
    const date = challenge.startDate
      ? addCalendarDays(challenge.startDate, i)
      : `اليوم-${dayNumber}`;
    const rec = challenge.startDate ? byDate.get(date) : undefined;
    const points = rec ? computeActivityPoints(rec) : 0;

    const isToday = Boolean(challenge.startDate && date === damascusToday);
    const isPast = Boolean(challenge.startDate && date < damascusToday);
    const isFuture = Boolean(!challenge.startDate || date > damascusToday);

    if (challenge.startDate && date <= damascusToday) {
      totalPoints += points;
      if (points === 3) {
        fullDaysCount += 1;
      }
      if (weekNumber === windowInfo.currentWeekNumber) {
        currentWeekPoints += points;
      }
    }

    calendarDays.push({
      dayNumber,
      date,
      weekNumber,
      isToday,
      isPast,
      isFuture,
      quranTwoPages: rec?.quranTwoPages ?? false,
      ishaCongregation: rec?.ishaCongregation ?? false,
      morningAdhkar: rec?.morningAdhkar ?? false,
      points,
      revision: rec?.revision ?? 0,
      hasRecord: Boolean(rec),
    });
  }

  const maxPossiblePoints = challenge.durationDays * 3;
  const availablePointsToDate = windowInfo.elapsedDays * 3;
  const completionPercentage =
    availablePointsToDate > 0
      ? Number(((totalPoints * 100) / availablePointsToDate).toFixed(1))
      : 0;

  const daysInCurrentWeek = calendarDays.filter(
    (d) => d.weekNumber === windowInfo.currentWeekNumber
  ).length;

  return {
    totalPoints,
    maxPossiblePoints,
    currentWeekPoints,
    currentWeekMaxPoints: daysInCurrentWeek * 3,
    elapsedDays: windowInfo.elapsedDays,
    availablePointsToDate,
    completionPercentage,
    streakDays: calculateStreakDays(challenge, studentAchievements, damascusToday),
    fullDaysCount,
    latestRecordedDate,
    calendarDays,
  };
}

/**
 * Computes leaderboard and group statistics:
 * - Excludes administrator accounts from rankings and group scoring
 * - Assigns equal competition ranks for equal scores (1, 1, 3)
 * - Respects leaderboardOptIn (only opted-in students appear in public rankings)
 * - Never exposes student emails, adminKnownName, or individual activity breakdowns
 */
export function computeLeaderboardAndGroupStats(
  challenge: ChallengeConfig,
  profiles: StudentProfile[],
  adminEmails: string[],
  allAchievements: DailyAchievementRecord[],
  callerStudentId: string | null,
  damascusToday: string
): LeaderboardAndGroupSummary {
  const adminEmailSet = new Set(adminEmails.map((e) => e.trim().toLowerCase()));
  const windowInfo = evaluateChallengeWindow(challenge, damascusToday);

  const eligibleStudents = profiles.filter(
    (p) =>
      p.membershipStatus === 'approved' &&
      !adminEmailSet.has(p.email.trim().toLowerCase())
  );

  const studentAggregates = eligibleStudents.map((student) => {
    const records = allAchievements.filter(
      (a) => a.challengeId === challenge.id && a.studentId === student.id
    );
    let totalPoints = 0;
    let weekPoints = 0;
    let fullDaysCount = 0;

    if (challenge.startDate && windowInfo.endDate) {
      for (const r of records) {
        if (r.achievementDate < challenge.startDate || r.achievementDate > windowInfo.endDate) {
          continue;
        }
        if (r.achievementDate > damascusToday) {
          continue;
        }
        const pts = computeActivityPoints(r);
        totalPoints += pts;
        if (pts === 3) fullDaysCount += 1;
        if (
          windowInfo.weekStartDate &&
          windowInfo.weekEndDate &&
          r.achievementDate >= windowInfo.weekStartDate &&
          r.achievementDate <= windowInfo.weekEndDate
        ) {
          weekPoints += pts;
        }
      }
    }

    return {
      studentId: student.id,
      displayName: student.publicDisplayName,
      leaderboardOptIn: student.leaderboardOptIn,
      totalPoints,
      weekPoints,
      fullDaysCount,
    };
  });

  const sortedOverall = [...studentAggregates].sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    return a.displayName.localeCompare(b.displayName, 'ar');
  });

  const overallRankById = new Map<string, number>();
  sortedOverall.forEach((item, index) => {
    if (index === 0) {
      overallRankById.set(item.studentId, 1);
    } else {
      const prev = sortedOverall[index - 1];
      const rank =
        item.totalPoints === prev.totalPoints
          ? overallRankById.get(prev.studentId)!
          : index + 1;
      overallRankById.set(item.studentId, rank);
    }
  });

  const sortedWeekly = [...studentAggregates].sort((a, b) => {
    if (b.weekPoints !== a.weekPoints) return b.weekPoints - a.weekPoints;
    return a.displayName.localeCompare(b.displayName, 'ar');
  });

  const weekRankById = new Map<string, number>();
  sortedWeekly.forEach((item, index) => {
    if (index === 0) {
      weekRankById.set(item.studentId, 1);
    } else {
      const prev = sortedWeekly[index - 1];
      const rank =
        item.weekPoints === prev.weekPoints
          ? weekRankById.get(prev.studentId)!
          : index + 1;
      weekRankById.set(item.studentId, rank);
    }
  });

  const overallRankings: PublicLeaderboardRow[] = sortedOverall
    .filter((s) => s.leaderboardOptIn)
    .map((s) => ({
      rank: overallRankById.get(s.studentId)!,
      displayName: s.displayName,
      points: s.totalPoints,
      fullDaysCount: s.fullDaysCount,
      isCurrentUser: s.studentId === callerStudentId,
    }));

  const weeklyRankings: PublicLeaderboardRow[] = sortedWeekly
    .filter((s) => s.leaderboardOptIn)
    .map((s) => ({
      rank: weekRankById.get(s.studentId)!,
      displayName: s.displayName,
      points: s.weekPoints,
      isCurrentUser: s.studentId === callerStudentId,
    }));

  const callerRecord = callerStudentId
    ? studentAggregates.find((s) => s.studentId === callerStudentId) ?? null
    : null;

  const groupTotalPoints = studentAggregates.reduce((acc, s) => acc + s.totalPoints, 0);
  const groupAvailablePoints =
    eligibleStudents.length * windowInfo.elapsedDays * 3;
  const groupCompletionPct =
    groupAvailablePoints > 0
      ? Number(((groupTotalPoints * 100) / groupAvailablePoints).toFixed(1))
      : 0;

  return {
    challengeId: challenge.id,
    damascusToday,
    elapsedDays: windowInfo.elapsedDays,
    currentWeekNumber: windowInfo.currentWeekNumber,
    collectiveGoalPct: challenge.collectiveGoalPct,
    approvedStudentCount: eligibleStudents.length,
    groupTotalPoints,
    groupAvailablePoints,
    groupCompletionPct,
    overallRankings,
    weeklyRankings,
    myRankSummary: callerRecord
      ? {
          overallRank: overallRankById.get(callerRecord.studentId)!,
          weekRank: weekRankById.get(callerRecord.studentId)!,
          totalPoints: callerRecord.totalPoints,
          weekPoints: callerRecord.weekPoints,
          leaderboardOptIn: callerRecord.leaderboardOptIn,
          displayName: callerRecord.displayName,
        }
      : null,
  };
}

/**
 * Sanitizes a single CSV cell against spreadsheet formula injection (CSV Injection / DDE).
 * Any string whose raw or leading-trimmed value starts with '=', '+', '-', '@', '\t', or '\r'
 * is prefixed with a single quote (') and safely wrapped in double quotes.
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const str = String(value);
  const trimmed = str.trimStart();
  const dangerousPrefixes = ['=', '+', '-', '@', '\t', '\r'];
  const needsFormulaEscape =
    dangerousPrefixes.some((p) => str.startsWith(p) || trimmed.startsWith(p));
  const safeContent = needsFormulaEscape ? `'${str}` : str;
  const escapedQuotes = safeContent.replace(/"/g, '""');
  return `"${escapedQuotes}"`;
}

export interface AdminExportStudentRow {
  adminKnownName: string;
  publicDisplayName: string;
  email: string;
  membershipStatus: string;
  totalPoints: number;
  completionPct: number;
  streakDays: number;
  fullDaysCount: number;
  quranCount: number;
  ishaCount: number;
  adhkarCount: number;
  latestRecordedDate: string;
}

/**
 * Generates a UTF-8 BOM CSV string for administrators with formula-injection protection.
 */
export function generateSafeAdminCsv(rows: AdminExportStudentRow[]): string {
  const headers = [
    'الاسم لدى المشرف',
    'الاسم الظاهر في اللوحة',
    'البريد الإلكتروني',
    'حالة العضوية',
    'مجموع النقاط (من 90)',
    'نسبة الإنجاز (%)',
    'أيام المواظبة المتتالية (السلسلة)',
    'الأيام المكتملة (3/3)',
    'قراءة صفحتين من القرآن',
    'صلاة العشاء في جماعة',
    'أذكار الصباح',
    'آخر نشاط مسجل',
  ];

  const lines = [headers.map(sanitizeCsvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.adminKnownName,
        r.publicDisplayName,
        r.email,
        r.membershipStatus,
        r.totalPoints,
        `${r.completionPct}%`,
        r.streakDays,
        r.fullDaysCount,
        r.quranCount,
        r.ishaCount,
        r.adhkarCount,
        r.latestRecordedDate || 'لا يوجد',
      ]
        .map(sanitizeCsvCell)
        .join(',')
    );
  }

  return '\uFEFF' + lines.join('\r\n');
}
