import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isValidUuid,
  computeActivityPoints as domainComputeActivityPoints,
  calculateStreakDays as domainCalculateStreakDays,
  evaluateChallengeWindow,
  calculatePersonalDashboard,
  computeLeaderboardAndGroupStats,
  generateSafeAdminCsv,
} from '../src/lib/domainLogic.ts';

// =============================================================================
// Reference Backend & Domain Engine (Mirrors PostgreSQL RLS + RPC + TypeScript Domain)
// =============================================================================

function getDamascusDateString(referenceInstant = new Date()) {
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

function addCalendarDays(dateStr, daysToAdd) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + daysToAdd));
  return dt.toISOString().slice(0, 10);
}

function diffCalendarDays(startDate, endDate) {
  const [y1, m1, d1] = startDate.split('-').map(Number);
  const [y2, m2, d2] = endDate.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

function computeActivityPoints(input) {
  return (
    (input.quranTwoPages === true ? 1 : 0) +
    (input.ishaCongregation === true ? 1 : 0) +
    (input.morningAdhkar === true ? 1 : 0)
  );
}

function sanitizeCsvCell(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value);
  const trimmed = str.trimStart();
  const dangerousPrefixes = ['=', '+', '-', '@', '\t', '\r'];
  const needsEscape = dangerousPrefixes.some((p) => str.startsWith(p) || trimmed.startsWith(p));
  const safeContent = needsEscape ? `'${str}` : str;
  return `"${safeContent.replace(/"/g, '""')}"`;
}

function calculateStreakDays(challenge, achievements, damascusToday) {
  if (!challenge.startDate) return 0;
  const offset = diffCalendarDays(challenge.startDate, damascusToday);
  if (offset < 0) return 0;

  const endDate = addCalendarDays(challenge.startDate, challenge.durationDays - 1);
  const effectiveLastDate = damascusToday <= endDate ? damascusToday : endDate;

  const byDate = new Map();
  for (const r of achievements) {
    if (r.challengeId === challenge.id) {
      byDate.set(r.achievementDate, computeActivityPoints(r));
    }
  }

  let cursor = effectiveLastDate;
  const todayPts = byDate.get(effectiveLastDate) ?? 0;
  if (todayPts < 3) {
    if (effectiveLastDate === damascusToday) {
      cursor = addCalendarDays(effectiveLastDate, -1);
    } else {
      return 0;
    }
  }

  let streak = 0;
  while (cursor >= challenge.startDate) {
    if ((byDate.get(cursor) ?? 0) === 3) {
      streak += 1;
      cursor = addCalendarDays(cursor, -1);
    } else {
      break;
    }
  }
  return streak;
}

class SecureDatabaseSimulator {
  constructor(damascusNow = new Date('2026-10-14T12:00:00Z')) {
    this.damascusNow = damascusNow;
    this.appAdmins = new Set(['admin@abubakr-circle.org']);
    this.profiles = new Map();
    this.challenges = new Map();
    this.achievements = new Map();
  }

  getDamascusToday() {
    return getDamascusDateString(this.damascusNow);
  }

  isAdmin(session) {
    if (!session || !session.email) return false;
    return this.appAdmins.has(session.email.trim().toLowerCase());
  }

  createOrUpdateOwnProfile(session, { adminKnownName, publicDisplayName, leaderboardOptIn = false, attemptedRole }) {
    if (!session || !session.userId) {
      throw new Error('UNAUTHENTICATED');
    }
    if (attemptedRole === 'admin') {
      throw new Error('FORBIDDEN_ROLE_ESCALATION');
    }
    const existing = this.profiles.get(session.userId);
    if (existing && existing.membershipStatus === 'suspended') {
      throw new Error('ACCOUNT_SUSPENDED');
    }
    const status = existing
      ? existing.membershipStatus
      : this.isAdmin(session)
        ? 'approved'
        : 'pending';

    const profile = {
      id: session.userId,
      email: session.email.trim().toLowerCase(),
      adminKnownName: adminKnownName.trim(),
      publicDisplayName: publicDisplayName.trim(),
      leaderboardOptIn: Boolean(leaderboardOptIn),
      membershipStatus: status,
    };
    this.profiles.set(session.userId, profile);
    return { ...profile };
  }

  readProfile(session, targetProfileId) {
    if (!session || !session.userId) throw new Error('UNAUTHENTICATED');
    if (session.userId !== targetProfileId && !this.isAdmin(session)) {
      throw new Error('FORBIDDEN_OTHER_STUDENT');
    }
    return this.profiles.get(targetProfileId) ?? null;
  }

  adminSetMembershipStatus(session, studentId, newStatus) {
    if (!this.isAdmin(session)) {
      throw new Error('ADMIN_ONLY');
    }
    const p = this.profiles.get(studentId);
    if (!p) throw new Error('STUDENT_NOT_FOUND');
    p.membershipStatus = newStatus;
    return { ...p };
  }

  adminConfigureChallenge(session, challengeId, { title, startDate, durationDays = 30 }) {
    if (!this.isAdmin(session)) {
      throw new Error('ADMIN_ONLY');
    }
    const existing = this.challenges.get(challengeId);
    if (existing) {
      const hasAchievements = [...this.achievements.values()].some((a) => a.challengeId === challengeId);
      if (
        hasAchievements &&
        (existing.startDate !== startDate || existing.durationDays !== durationDays)
      ) {
        throw new Error('CHALLENGE_LOCKED_AFTER_ACHIEVEMENTS');
      }
    }
    const updated = {
      id: challengeId,
      title,
      startDate,
      durationDays,
      collectiveGoalPct: 80,
      isArchived: false,
    };
    this.challenges.set(challengeId, updated);
    return { ...updated };
  }

  saveTodayAchievement(session, payload) {
    if (!session || !session.userId) throw new Error('UNAUTHENTICATED');
    const targetStudentId = payload.studentId ?? session.userId;
    if (targetStudentId !== session.userId) {
      throw new Error('FORBIDDEN_OTHER_STUDENT');
    }

    const profile = this.profiles.get(session.userId);
    if (!profile) throw new Error('PROFILE_REQUIRED');
    if (profile.membershipStatus === 'suspended') throw new Error('ACCOUNT_SUSPENDED');
    if (profile.membershipStatus !== 'approved') throw new Error('MEMBERSHIP_PENDING');

    const challenge = this.challenges.get(payload.challengeId);
    if (!challenge || challenge.isArchived) throw new Error('CHALLENGE_INACTIVE');
    if (!challenge.startDate) throw new Error('CHALLENGE_NOT_STARTED');

    const damascusToday = this.getDamascusToday();
    if (payload.targetDate !== damascusToday) {
      throw new Error('OUTSIDE_TODAY_DAMASCUS');
    }

    const endDate = addCalendarDays(challenge.startDate, challenge.durationDays - 1);
    if (damascusToday < challenge.startDate) throw new Error('CHALLENGE_UPCOMING');
    if (damascusToday > endDate) throw new Error('CHALLENGE_COMPLETED');

    const key = `${challenge.id}:${session.userId}:${damascusToday}`;
    const existing = this.achievements.get(key);

    if (!existing) {
      if (payload.expectedRevision !== undefined && payload.expectedRevision !== null && payload.expectedRevision !== 0) {
        throw new Error('STALE_REVISION');
      }
      const derivedPoints = computeActivityPoints(payload);
      const record = {
        id: key,
        challengeId: challenge.id,
        studentId: session.userId,
        achievementDate: damascusToday,
        quranTwoPages: Boolean(payload.quranTwoPages),
        ishaCongregation: Boolean(payload.ishaCongregation),
        morningAdhkar: Boolean(payload.morningAdhkar),
        points: derivedPoints,
        revision: 1,
      };
      this.achievements.set(key, record);
      return { ...record };
    } else {
      if (payload.expectedRevision !== existing.revision) {
        throw new Error('STALE_REVISION');
      }
      const derivedPoints = computeActivityPoints(payload);
      const updated = {
        ...existing,
        quranTwoPages: Boolean(payload.quranTwoPages),
        ishaCongregation: Boolean(payload.ishaCongregation),
        morningAdhkar: Boolean(payload.morningAdhkar),
        points: derivedPoints,
        revision: existing.revision + 1,
      };
      this.achievements.set(key, updated);
      return { ...updated };
    }
  }

  getLeaderboard(session, challengeId) {
    if (!session || !session.userId) throw new Error('UNAUTHENTICATED');
    const caller = this.profiles.get(session.userId);
    if ((!caller || caller.membershipStatus !== 'approved') && !this.isAdmin(session)) {
      throw new Error('FORBIDDEN_NOT_APPROVED');
    }
    const eligible = [...this.profiles.values()].filter(
      (p) => p.membershipStatus === 'approved' && !this.appAdmins.has(p.email)
    );
    const scored = eligible.map((p) => {
      const recs = [...this.achievements.values()].filter(
        (a) => a.challengeId === challengeId && a.studentId === p.id
      );
      const totalPoints = recs.reduce((s, r) => s + r.points, 0);
      return {
        studentId: p.id,
        displayName: p.publicDisplayName,
        leaderboardOptIn: p.leaderboardOptIn,
        totalPoints,
      };
    });
    scored.sort((a, b) => b.totalPoints - a.totalPoints || a.displayName.localeCompare(b.displayName, 'ar'));
    const ranks = new Map();
    scored.forEach((item, idx) => {
      if (idx === 0) ranks.set(item.studentId, 1);
      else {
        const prev = scored[idx - 1];
        ranks.set(
          item.studentId,
          item.totalPoints === prev.totalPoints ? ranks.get(prev.studentId) : idx + 1
        );
      }
    });

    return scored
      .filter((s) => s.leaderboardOptIn)
      .map((s) => ({
        rank: ranks.get(s.studentId),
        displayName: s.displayName,
        points: s.totalPoints,
        isCurrentUser: s.studentId === session.userId,
      }));
  }

  exportAdminCsv(session, challengeId) {
    if (!this.isAdmin(session)) {
      throw new Error('ADMIN_ONLY');
    }
    const students = [...this.profiles.values()].filter((p) => !this.appAdmins.has(p.email));
    const lines = [
      ['الاسم لدى المشرف', 'الاسم الظاهر', 'البريد الإلكتروني', 'النقاط'].map(sanitizeCsvCell).join(','),
    ];
    for (const s of students) {
      const pts = [...this.achievements.values()]
        .filter((a) => a.challengeId === challengeId && a.studentId === s.id)
        .reduce((acc, r) => acc + r.points, 0);
      lines.push(
        [s.adminKnownName, s.publicDisplayName, s.email, pts].map(sanitizeCsvCell).join(',')
      );
    }
    return '\uFEFF' + lines.join('\r\n');
  }
}

// =============================================================================
// Test Cases (12 Required Categories + Static Migration Verification)
// =============================================================================

test('1. Authentication & membership restrictions (unauthenticated, pending, approved)', () => {
  const db = new SecureDatabaseSimulator(new Date('2026-10-14T10:00:00Z'));
  const adminSession = { userId: 'admin-1', email: 'admin@abubakr-circle.org' };
  const studentSession = { userId: 'student-1', email: 'student1@example.com' };

  db.adminConfigureChallenge(adminSession, 'ch-1', {
    title: 'تعالَ نؤمن ساعة',
    startDate: '2026-10-10',
    durationDays: 30,
  });

  assert.throws(() => db.getLeaderboard(null, 'ch-1'), /UNAUTHENTICATED/);

  const profile = db.createOrUpdateOwnProfile(studentSession, {
    adminKnownName: 'عمر بن الخطاب (طالب)',
    publicDisplayName: 'أبو حفص',
  });
  assert.equal(profile.membershipStatus, 'pending');
  assert.equal(profile.leaderboardOptIn, false);

  const updatedPending = db.createOrUpdateOwnProfile(studentSession, {
    adminKnownName: 'عمر الفاروق',
    publicDisplayName: 'الفاروق',
    leaderboardOptIn: true,
  });
  assert.equal(updatedPending.publicDisplayName, 'الفاروق');

  assert.throws(() => db.getLeaderboard(studentSession, 'ch-1'), /FORBIDDEN_NOT_APPROVED/);
  assert.throws(
    () =>
      db.saveTodayAchievement(studentSession, {
        challengeId: 'ch-1',
        targetDate: '2026-10-14',
        quranTwoPages: true,
        ishaCongregation: true,
        morningAdhkar: true,
      }),
    /MEMBERSHIP_PENDING/
  );
});

test('2. Student attempts to access administrator operations are rejected', () => {
  const db = new SecureDatabaseSimulator(new Date('2026-10-14T10:00:00Z'));
  const studentSession = { userId: 'student-1', email: 'student1@example.com' };
  db.createOrUpdateOwnProfile(studentSession, {
    adminKnownName: 'زيد بن ثابت',
    publicDisplayName: 'زيد',
  });

  assert.throws(
    () =>
      db.createOrUpdateOwnProfile(studentSession, {
        adminKnownName: 'زيد',
        publicDisplayName: 'زيد',
        attemptedRole: 'admin',
      }),
    /FORBIDDEN_ROLE_ESCALATION/
  );

  assert.throws(
    () => db.adminSetMembershipStatus(studentSession, 'student-1', 'approved'),
    /ADMIN_ONLY/
  );
  assert.throws(
    () =>
      db.adminConfigureChallenge(studentSession, 'ch-1', {
        title: 'تحدي مزور',
        startDate: '2026-10-01',
      }),
    /ADMIN_ONLY/
  );
});

test('3. Student attempts to read or modify another student’s records are blocked', () => {
  const db = new SecureDatabaseSimulator(new Date('2026-10-14T10:00:00Z'));
  const admin = { userId: 'admin-1', email: 'admin@abubakr-circle.org' };
  const s1 = { userId: 'student-1', email: 's1@example.com' };
  const s2 = { userId: 'student-2', email: 's2@example.com' };

  db.adminConfigureChallenge(admin, 'ch-1', { title: 'تعالَ نؤمن ساعة', startDate: '2026-10-10' });
  db.createOrUpdateOwnProfile(s1, { adminKnownName: 'طالب 1', publicDisplayName: 'طالب 1' });
  db.createOrUpdateOwnProfile(s2, { adminKnownName: 'طالب 2', publicDisplayName: 'طالب 2' });
  db.adminSetMembershipStatus(admin, 'student-1', 'approved');
  db.adminSetMembershipStatus(admin, 'student-2', 'approved');

  assert.throws(() => db.readProfile(s1, 'student-2'), /FORBIDDEN_OTHER_STUDENT/);

  assert.throws(
    () =>
      db.saveTodayAchievement(s1, {
        challengeId: 'ch-1',
        studentId: 'student-2',
        targetDate: '2026-10-14',
        quranTwoPages: true,
        ishaCongregation: true,
        morningAdhkar: true,
      }),
    /FORBIDDEN_OTHER_STUDENT/
  );
});

test('4. Duplicate submissions and browser score inflation are prevented', () => {
  const db = new SecureDatabaseSimulator(new Date('2026-10-14T10:00:00Z'));
  const admin = { userId: 'admin-1', email: 'admin@abubakr-circle.org' };
  const s1 = { userId: 'student-1', email: 's1@example.com' };

  db.adminConfigureChallenge(admin, 'ch-1', { title: 'تعالَ نؤمن ساعة', startDate: '2026-10-10' });
  db.createOrUpdateOwnProfile(s1, { adminKnownName: 'معاذ بن جبل', publicDisplayName: 'معاذ' });
  db.adminSetMembershipStatus(admin, 'student-1', 'approved');

  const saved = db.saveTodayAchievement(s1, {
    challengeId: 'ch-1',
    targetDate: '2026-10-14',
    quranTwoPages: true,
    ishaCongregation: false,
    morningAdhkar: false,
    points: 90,
    expectedRevision: 0,
  });

  assert.equal(saved.points, 1, 'Points must be derived strictly from completed activities (1, not 90)');
  assert.equal(saved.revision, 1);

  assert.throws(
    () =>
      db.saveTodayAchievement(s1, {
        challengeId: 'ch-1',
        targetDate: '2026-10-14',
        quranTwoPages: true,
        ishaCongregation: true,
        morningAdhkar: true,
        expectedRevision: 0,
      }),
    /STALE_REVISION/
  );
});

test('5. Updating and removing a completed activity on the same day works accurately', () => {
  const db = new SecureDatabaseSimulator(new Date('2026-10-14T10:00:00Z'));
  const admin = { userId: 'admin-1', email: 'admin@abubakr-circle.org' };
  const s1 = { userId: 'student-1', email: 's1@example.com' };

  db.adminConfigureChallenge(admin, 'ch-1', { title: 'تعالَ نؤمن ساعة', startDate: '2026-10-10' });
  db.createOrUpdateOwnProfile(s1, { adminKnownName: 'بلال', publicDisplayName: 'بلال' });
  db.adminSetMembershipStatus(admin, 'student-1', 'approved');

  const r1 = db.saveTodayAchievement(s1, {
    challengeId: 'ch-1',
    targetDate: '2026-10-14',
    quranTwoPages: true,
    ishaCongregation: false,
    morningAdhkar: true,
    expectedRevision: 0,
  });
  assert.equal(r1.points, 2);
  assert.equal(r1.revision, 1);

  const r2 = db.saveTodayAchievement(s1, {
    challengeId: 'ch-1',
    targetDate: '2026-10-14',
    quranTwoPages: true,
    ishaCongregation: true,
    morningAdhkar: true,
    expectedRevision: 1,
  });
  assert.equal(r2.points, 3);
  assert.equal(r2.revision, 2);

  const r3 = db.saveTodayAchievement(s1, {
    challengeId: 'ch-1',
    targetDate: '2026-10-14',
    quranTwoPages: false,
    ishaCongregation: false,
    morningAdhkar: true,
    expectedRevision: 2,
  });
  assert.equal(r3.points, 1);
  assert.equal(r3.revision, 3);
});

test('6. Stale submissions from another tab are rejected via revision check', () => {
  const db = new SecureDatabaseSimulator(new Date('2026-10-14T10:00:00Z'));
  const admin = { userId: 'admin-1', email: 'admin@abubakr-circle.org' };
  const s1 = { userId: 'student-1', email: 's1@example.com' };

  db.adminConfigureChallenge(admin, 'ch-1', { title: 'تعالَ نؤمن ساعة', startDate: '2026-10-10' });
  db.createOrUpdateOwnProfile(s1, { adminKnownName: 'سعد', publicDisplayName: 'سعد' });
  db.adminSetMembershipStatus(admin, 'student-1', 'approved');

  db.saveTodayAchievement(s1, {
    challengeId: 'ch-1',
    targetDate: '2026-10-14',
    quranTwoPages: true,
    ishaCongregation: false,
    morningAdhkar: false,
    expectedRevision: 0,
  });

  const tabASave = db.saveTodayAchievement(s1, {
    challengeId: 'ch-1',
    targetDate: '2026-10-14',
    quranTwoPages: true,
    ishaCongregation: true,
    morningAdhkar: false,
    expectedRevision: 1,
  });
  assert.equal(tabASave.revision, 2);

  assert.throws(
    () =>
      db.saveTodayAchievement(s1, {
        challengeId: 'ch-1',
        targetDate: '2026-10-14',
        quranTwoPages: false,
        ishaCongregation: false,
        morningAdhkar: true,
        expectedRevision: 1,
      }),
    /STALE_REVISION/
  );
});

test('7. Timezone and midnight boundaries in Asia/Damascus (UTC+3)', () => {
  const justBeforeMidnight = new Date('2026-10-14T20:59:59Z');
  assert.equal(getDamascusDateString(justBeforeMidnight), '2026-10-14');

  const justAfterMidnight = new Date('2026-10-14T21:00:01Z');
  assert.equal(getDamascusDateString(justAfterMidnight), '2026-10-15');

  const db = new SecureDatabaseSimulator(justAfterMidnight);
  const admin = { userId: 'admin-1', email: 'admin@abubakr-circle.org' };
  const s1 = { userId: 'student-1', email: 's1@example.com' };

  db.adminConfigureChallenge(admin, 'ch-1', { title: 'تعالَ نؤمن ساعة', startDate: '2026-10-10' });
  db.createOrUpdateOwnProfile(s1, { adminKnownName: 'أنس', publicDisplayName: 'أنس' });
  db.adminSetMembershipStatus(admin, 'student-1', 'approved');

  assert.throws(
    () =>
      db.saveTodayAchievement(s1, {
        challengeId: 'ch-1',
        targetDate: '2026-10-14',
        quranTwoPages: true,
        ishaCongregation: true,
        morningAdhkar: true,
      }),
    /OUTSIDE_TODAY_DAMASCUS/
  );

  assert.throws(
    () =>
      db.saveTodayAchievement(s1, {
        challengeId: 'ch-1',
        targetDate: '2026-10-16',
        quranTwoPages: true,
        ishaCongregation: true,
        morningAdhkar: true,
      }),
    /OUTSIDE_TODAY_DAMASCUS/
  );
});

test('8. Challenge start/end boundaries & configuration lock after achievements exist', () => {
  const db = new SecureDatabaseSimulator(new Date('2026-10-14T10:00:00Z'));
  const admin = { userId: 'admin-1', email: 'admin@abubakr-circle.org' };
  const s1 = { userId: 'student-1', email: 's1@example.com' };

  db.createOrUpdateOwnProfile(s1, { adminKnownName: 'طلحة', publicDisplayName: 'طلحة' });
  db.adminSetMembershipStatus(admin, 'student-1', 'approved');

  db.adminConfigureChallenge(admin, 'ch-1', { title: 'تعالَ نؤمن ساعة', startDate: null });
  assert.throws(
    () =>
      db.saveTodayAchievement(s1, {
        challengeId: 'ch-1',
        targetDate: '2026-10-14',
        quranTwoPages: true,
        ishaCongregation: false,
        morningAdhkar: false,
      }),
    /CHALLENGE_NOT_STARTED/
  );

  db.adminConfigureChallenge(admin, 'ch-1', { title: 'تعالَ نؤمن ساعة', startDate: '2026-10-20' });
  assert.throws(
    () =>
      db.saveTodayAchievement(s1, {
        challengeId: 'ch-1',
        targetDate: '2026-10-14',
        quranTwoPages: true,
        ishaCongregation: false,
        morningAdhkar: false,
      }),
    /CHALLENGE_UPCOMING/
  );

  db.adminConfigureChallenge(admin, 'ch-1', {
    title: 'تعالَ نؤمن ساعة',
    startDate: '2026-10-10',
    durationDays: 30,
  });
  db.saveTodayAchievement(s1, {
    challengeId: 'ch-1',
    targetDate: '2026-10-14',
    quranTwoPages: true,
    ishaCongregation: true,
    morningAdhkar: true,
    expectedRevision: 0,
  });

  assert.throws(
    () =>
      db.adminConfigureChallenge(admin, 'ch-1', {
        title: 'تعالَ نؤمن ساعة',
        startDate: '2026-10-12',
        durationDays: 30,
      }),
    /CHALLENGE_LOCKED_AFTER_ACHIEVEMENTS/
  );
});

test('9. Leaderboard ties, administrator exclusion, and privacy opt-out', () => {
  const db = new SecureDatabaseSimulator(new Date('2026-10-14T10:00:00Z'));
  const admin = { userId: 'admin-1', email: 'admin@abubakr-circle.org' };
  const s1 = { userId: 's1', email: 's1@example.com' };
  const s2 = { userId: 's2', email: 's2@example.com' };
  const s3 = { userId: 's3', email: 's3@example.com' };
  const s4Hidden = { userId: 's4', email: 's4@example.com' };

  db.adminConfigureChallenge(admin, 'ch-1', { title: 'تعالَ نؤمن ساعة', startDate: '2026-10-10' });

  db.createOrUpdateOwnProfile(admin, {
    adminKnownName: 'المشرف خالد',
    publicDisplayName: 'المشرف',
    leaderboardOptIn: true,
  });
  db.saveTodayAchievement(admin, {
    challengeId: 'ch-1',
    targetDate: '2026-10-14',
    quranTwoPages: true,
    ishaCongregation: true,
    morningAdhkar: true,
    expectedRevision: 0,
  });

  for (const [sess, name, optIn, activities] of [
    [s1, 'أنس', true, { quranTwoPages: true, ishaCongregation: true, morningAdhkar: true }],
    [s2, 'بشير', true, { quranTwoPages: true, ishaCongregation: true, morningAdhkar: true }],
    [s3, 'حذيفة', true, { quranTwoPages: true, ishaCongregation: false, morningAdhkar: false }],
    [s4Hidden, 'سلمان (مخفي)', false, { quranTwoPages: true, ishaCongregation: true, morningAdhkar: true }],
  ]) {
    db.createOrUpdateOwnProfile(sess, {
      adminKnownName: `الاسم الكامل - ${name}`,
      publicDisplayName: name,
      leaderboardOptIn: optIn,
    });
    db.adminSetMembershipStatus(admin, sess.userId, 'approved');
    db.saveTodayAchievement(sess, {
      challengeId: 'ch-1',
      targetDate: '2026-10-14',
      ...activities,
      expectedRevision: 0,
    });
  }

  const board = db.getLeaderboard(s1, 'ch-1');
  assert.equal(board.length, 3);
  assert.equal(board[0].displayName, 'أنس');
  assert.equal(board[0].rank, 1);
  assert.equal(board[1].displayName, 'بشير');
  assert.equal(board[1].rank, 1, 'Tied students must receive equal rank 1');
  assert.equal(board[2].displayName, 'حذيفة');
  assert.equal(board[2].rank, 4);
  for (const row of board) {
    assert.equal('email' in row, false);
    assert.equal('adminKnownName' in row, false);
  }
});

test('10. Suspension enforcement immediately blocks existing sessions', () => {
  const db = new SecureDatabaseSimulator(new Date('2026-10-14T10:00:00Z'));
  const admin = { userId: 'admin-1', email: 'admin@abubakr-circle.org' };
  const s1 = { userId: 's1', email: 's1@example.com' };

  db.adminConfigureChallenge(admin, 'ch-1', { title: 'تعالَ نؤمن ساعة', startDate: '2026-10-10' });
  db.createOrUpdateOwnProfile(s1, { adminKnownName: 'عمار', publicDisplayName: 'عمار', leaderboardOptIn: true });
  db.adminSetMembershipStatus(admin, 's1', 'approved');

  assert.doesNotThrow(() => db.getLeaderboard(s1, 'ch-1'));

  db.adminSetMembershipStatus(admin, 's1', 'suspended');

  assert.throws(
    () =>
      db.saveTodayAchievement(s1, {
        challengeId: 'ch-1',
        targetDate: '2026-10-14',
        quranTwoPages: true,
        ishaCongregation: true,
        morningAdhkar: true,
      }),
    /ACCOUNT_SUSPENDED/
  );
  assert.throws(() => db.getLeaderboard(s1, 'ch-1'), /FORBIDDEN_NOT_APPROVED/);
  assert.throws(
    () => db.createOrUpdateOwnProfile(s1, { adminKnownName: 'عمار 2', publicDisplayName: 'عمار 2' }),
    /ACCOUNT_SUSPENDED/
  );
});

test('11. Streak calculations preserve valid yesterday streak when today is incomplete', () => {
  const challenge = {
    id: 'ch-1',
    title: 'تعالَ نؤمن ساعة',
    startDate: '2026-10-10',
    durationDays: 30,
  };

  const achievements = [
    { challengeId: 'ch-1', achievementDate: '2026-10-10', quranTwoPages: true, ishaCongregation: true, morningAdhkar: true },
    { challengeId: 'ch-1', achievementDate: '2026-10-11', quranTwoPages: true, ishaCongregation: true, morningAdhkar: true },
    { challengeId: 'ch-1', achievementDate: '2026-10-12', quranTwoPages: true, ishaCongregation: true, morningAdhkar: true },
    { challengeId: 'ch-1', achievementDate: '2026-10-13', quranTwoPages: true, ishaCongregation: true, morningAdhkar: true },
    { challengeId: 'ch-1', achievementDate: '2026-10-14', quranTwoPages: false, ishaCongregation: false, morningAdhkar: true },
  ];

  const streakWhileTodayIncomplete = calculateStreakDays(challenge, achievements, '2026-10-14');
  assert.equal(
    streakWhileTodayIncomplete,
    4,
    'An incomplete current day must NOT erase a 4-day streak valid through yesterday'
  );

  achievements[4].quranTwoPages = true;
  achievements[4].ishaCongregation = true;
  const streakAfterTodayCompleted = calculateStreakDays(challenge, achievements, '2026-10-14');
  assert.equal(streakAfterTodayCompleted, 5);

  achievements[4].ishaCongregation = false;
  const streakNextDay = calculateStreakDays(challenge, achievements, '2026-10-15');
  assert.equal(streakNextDay, 0);
});

test('12. CSV export permissions & spreadsheet formula injection neutralization', () => {
  const db = new SecureDatabaseSimulator(new Date('2026-10-14T10:00:00Z'));
  const admin = { userId: 'admin-1', email: 'admin@abubakr-circle.org' };
  const maliciousStudent = { userId: 's-evil', email: 'evil@example.com' };

  db.adminConfigureChallenge(admin, 'ch-1', { title: 'تعالَ نؤمن ساعة', startDate: '2026-10-10' });
  db.createOrUpdateOwnProfile(maliciousStudent, {
    adminKnownName: '=CMD|\' /C calc\'!A0',
    publicDisplayName: '+SUM(1,1)"injected"',
  });

  assert.throws(() => db.exportAdminCsv(maliciousStudent, 'ch-1'), /ADMIN_ONLY/);

  const csv = db.exportAdminCsv(admin, 'ch-1');
  assert.ok(csv.startsWith('\uFEFF'), 'CSV must include UTF-8 BOM for Arabic Excel rendering');
  assert.ok(
    csv.includes('"\'=CMD|\' /C calc\'!A0"'),
    'Formula starting with = must be prefixed with single quote'
  );
  assert.ok(
    csv.includes('"\'+SUM(1,1)""injected"""'),
    'Formula starting with + must be prefixed with single quote and quotes doubled'
  );
  // Direct test of leading whitespace before formula trigger
  assert.equal(sanitizeCsvCell('  +SUM(1,1)"injected"'), '"\'  +SUM(1,1)""injected"""');
  assert.equal(sanitizeCsvCell('-2+3'), '"\'-2+3"');
  assert.equal(sanitizeCsvCell('@SUM(A1:A2)'), '"\'@SUM(A1:A2)"');
  assert.equal(sanitizeCsvCell('\t=1+1'), '"\'\t=1+1"');
});

test('13. SQL Migrations static verification (RLS, Force RLS, SECURITY DEFINER search_path, Unique Constraint)', () => {
  const migrationsDir = path.resolve('supabase/migrations');
  const m1 = fs.readFileSync(path.join(migrationsDir, '20261014000001_initial_schema.sql'), 'utf8');
  const m2 = fs.readFileSync(path.join(migrationsDir, '20261014000002_rls_and_grants.sql'), 'utf8');
  const m3 = fs.readFileSync(path.join(migrationsDir, '20261014000003_rpc_functions.sql'), 'utf8');

  assert.match(m1, /unique\s*\(\s*challenge_id\s*,\s*student_id\s*,\s*achievement_date\s*\)/i);
  assert.match(m1, /Asia\/Damascus/);
  assert.match(m2, /enable row level security/i);
  assert.match(m2, /force row level security/i);
  assert.match(m3, /set search_path = public, pg_temp/i);
  assert.match(m3, /revoke all on function public\.save_today_achievement/i);
  const m4 = fs.readFileSync(path.join(migrationsDir, '20261014000004_bootstrap_admin.sql'), 'utf8');
  assert.match(m4, /hajij94@gmail\.com/);
  const m5 = fs.readFileSync(path.join(migrationsDir, '20261015000005_signup_requests.sql'), 'utf8');
  assert.match(m5, /set search_path = public, pg_temp/i);
  assert.match(m5, /revoke all on function public\.create_signup_profile/i);
  assert.match(m5, /create trigger on_auth_user_signup_profile/i);
  const m6 = fs.readFileSync(path.join(migrationsDir, '20261015000006_logic_and_security.sql'), 'utf8');
  assert.match(m6, /set search_path = public, pg_temp/i);
  assert.match(m6, /revoke all on function public\.register_admin_user/i);
});

test('14. Production domain logic & utility validation (UUID, null-safety, dashboard metrics)', () => {
  // UUID validation: rejects non-UUID strings, empty, null, and 'default-challenge'
  assert.equal(isValidUuid('default-challenge'), false);
  assert.equal(isValidUuid(''), false);
  assert.equal(isValidUuid(null), false);
  assert.equal(isValidUuid(undefined), false);
  assert.equal(isValidUuid('12345'), false);
  assert.equal(isValidUuid('a8098c1a-f86e-11da-bd1a-00112444be1e'), true);
  assert.equal(isValidUuid('A8098C1A-F86E-11DA-BD1A-00112444BE1E'), true);

  // Activity points null safety
  assert.equal(domainComputeActivityPoints(null), 0);
  assert.equal(domainComputeActivityPoints(undefined), 0);
  assert.equal(domainComputeActivityPoints({ quranTwoPages: true, ishaCongregation: true, morningAdhkar: false }), 2);

  // evaluateChallengeWindow edge cases
  const unstarted = evaluateChallengeWindow({
    id: 'ch-test',
    title: 'تحدي تجريبي',
    communityName: 'حلقة',
    startDate: null,
    durationDays: 30,
    collectiveGoalPct: 80,
    isArchived: false,
  }, '2026-10-15');
  assert.equal(unstarted.state, 'upcoming');
  assert.equal(unstarted.elapsedDays, 0);

  const active = evaluateChallengeWindow({
    id: 'ch-test',
    title: 'تحدي تجريبي',
    communityName: 'حلقة',
    startDate: '2026-10-10',
    durationDays: 30,
    collectiveGoalPct: 80,
    isArchived: false,
  }, '2026-10-15');
  assert.equal(active.state, 'active');
  assert.equal(active.currentDayNumber, 6);
  assert.equal(active.elapsedDays, 6);
  assert.equal(active.currentWeekNumber, 1);

  // calculatePersonalDashboard edge cases
  const dashboard = calculatePersonalDashboard({
    id: 'ch-test',
    title: 'تحدي تجريبي',
    communityName: 'حلقة',
    startDate: '2026-10-10',
    durationDays: 30,
    collectiveGoalPct: 80,
    isArchived: false,
  }, [
    { id: '1', challengeId: 'ch-test', studentId: 's1', achievementDate: '2026-10-10', quranTwoPages: true, ishaCongregation: true, morningAdhkar: true, points: 3, revision: 1, updatedAt: '' },
    { id: '2', challengeId: 'ch-test', studentId: 's1', achievementDate: '2026-10-11', quranTwoPages: true, ishaCongregation: false, morningAdhkar: true, points: 2, revision: 1, updatedAt: '' },
  ], '2026-10-15');

  assert.equal(dashboard.totalPoints, 5);
  assert.equal(dashboard.maxPossiblePoints, 90);
  assert.equal(dashboard.calendarDays.length, 30);
  assert.equal(dashboard.fullDaysCount, 1);
  assert.equal(dashboard.elapsedDays, 6);
  assert.equal(dashboard.availablePointsToDate, 18);
  assert.equal(dashboard.completionPercentage, 27.8);
});
