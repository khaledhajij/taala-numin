import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  AlertCircle,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Download,
  Flame,
  LogOut,
  RefreshCw,
  Settings,
  ShieldAlert,
  Sparkles,
  Trophy,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { supabase, isSupabaseConfigured } from './lib/supabase';
import { EMPTY_CHALLENGE, errorMessage, validateProfileNames, mapProfile, mapAchievement, mapChallenge, mapReport } from './lib/appData';
import {
  ChallengeConfig,
  DailyAchievementRecord,
  DailyActivitiesInput,
  MembershipStatus,
  StudentProfile,
} from './types/domain';
import {
  DAILY_ACTIVITIES_META,
  ENCOURAGEMENT_MOTTO,
  calculatePersonalDashboard,
  calculateStreakDays,
  computeActivityPoints,
  computeLeaderboardAndGroupStats,
  evaluateChallengeWindow,
  generateSafeAdminCsv,
  getDamascusDateString,
  isValidUuid,
} from './lib/domainLogic';

type ActiveTab = 'today' | 'dashboard' | 'leaderboard' | 'profile' | 'admin';
type AuthFormMode = 'sign_in' | 'sign_up';

function translateAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('invalid login credentials')) {
    return 'البريد الإلكتروني أو كلمة المرور غير صحيحة. إذا كنت طالباً جديداً، اختر «إنشاء حساب جديد».';
  }
  if (lower.includes('already registered') || lower.includes('already been registered')) {
    return 'هذا البريد الإلكتروني مسجل مسبقاً. يرجى اختيار «تسجيل الدخول بحساب حالي».';
  }
  if (lower.includes('password should be at least')) {
    return 'يجب ألا تقل كلمة المرور عن 6 أحرف.';
  }
  if (lower.includes('email not confirmed')) {
    return 'يرجى تأكيد بريدك الإلكتروني عبر الرسالة المرسلة إليه ثم تسجيل الدخول.';
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return 'تم تجاوز الحد المسموح من المحاولات مؤقتاً. يرجى الانتظار دقيقة والمحاولة مجدداً.';
  }
  if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
    return 'تعذّر الاتصال بالخادم. يرجى التحقق من اتصال الإنترنت.';
  }
  return message;
}

export default function App() {
  const [identity, setIdentity] = useState<string | null>(null);
  const [ready, setReady] = useState(!isSupabaseConfigured);
  useEffect(() => {
    if (!supabase) return;
    // INITIAL_SESSION also covers persisted sessions. Same-user auth events do not remount forms.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setIdentity(session?.user.id ?? null);
      setReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  if (!ready) return <p dir="rtl" role="status">جاري التحقق من الجلسة...</p>;
  // Discard every account-scoped state value and request on an identity change.
  return <AccountApp key={identity ?? 'signed-out'} identity={identity} />;
}

function AccountApp({ identity }: { identity: string | null }) {
  const [loadingSession, setLoadingSession] = useState<boolean>(Boolean(identity));
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccessMsg, setAuthSuccessMsg] = useState<string | null>(null);
  const [authFormMode, setAuthFormMode] = useState<AuthFormMode>('sign_in');
  const [emailInput, setEmailInput] = useState<string>('');
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [authSubmitting, setAuthSubmitting] = useState<boolean>(false);

  const [sessionUserId, setSessionUserId] = useState<string | null>(identity);
  const [, setSessionEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [damascusToday, setDamascusToday] = useState<string>(() =>
    getDamascusDateString(new Date())
  );

  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [challenge, setChallenge] = useState<ChallengeConfig>(EMPTY_CHALLENGE);

  const [myAchievements, setMyAchievements] = useState<DailyAchievementRecord[]>([]);
  const [allProfilesForAdmin, setAllProfilesForAdmin] = useState<StudentProfile[]>([]);
  const [allAchievementsForAdmin, setAllAchievementsForAdmin] = useState<DailyAchievementRecord[]>(
    []
  );
  const [serverLeaderboard, setServerLeaderboard] = useState<{
    elapsedDays: number;
    currentWeekNum: number;
    collectiveGoalPct: number;
    approvedStudentCount: number;
    groupTotalPoints: number;
    groupAvailablePoints: number;
    groupCompletionPct: number;
    overallRankings: Array<{
      rank: number;
      display_name: string;
      total_points: number;
      full_days_count: number;
      is_me: boolean;
    }>;
    weeklyRankings: Array<{
      rank: number;
      display_name: string;
      week_points: number;
      is_me: boolean;
    }>;
    mySummary: {
      overall_rank: number;
      week_rank: number;
      total_points: number;
      week_points: number;
      leaderboard_opt_in: boolean;
      display_name: string;
    } | null;
  } | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('today');

  // Draft activities for today
  const [draft, setDraft] = useState<DailyActivitiesInput>({
    quranTwoPages: false,
    ishaCongregation: false,
    morningAdhkar: false,
  });
  const [loadedRevision, setLoadedRevision] = useState<number>(0);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

  // Onboarding / Profile form
  const [adminKnownNameInput, setAdminKnownNameInput] = useState<string>('');
  const [publicDisplayNameInput, setPublicDisplayNameInput] = useState<string>('');
  const [leaderboardOptInInput, setLeaderboardOptInInput] = useState<boolean>(false);
  const [profileFeedback, setProfileFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Selected day in 30-day calendar
  const [selectedDayNum, setSelectedDayNum] = useState<number>(1);
  const [leaderboardScope, setLeaderboardScope] = useState<'overall' | 'weekly'>('overall');

  // Admin configuration inputs
  const [cfgTitle, setCfgTitle] = useState<string>('تعالَ نؤمن ساعة');
  const [cfgStartDate, setCfgStartDate] = useState<string>('');
  const [cfgDuration, setCfgDuration] = useState<number>(30);
  const [adminBanner, setAdminBanner] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [newChallengeTitle, setNewChallengeTitle] = useState('تعالَ نؤمن ساعة — الدورة التالية');
  const [newChallengeStartDate, setNewChallengeStartDate] = useState('');
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [reportGeneratedAt, setReportGeneratedAt] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const mutationLock = useRef(false);
  const alive = useRef(true);
  const requestId = useRef(0);
  const bootstrapFlight = useRef<number | null>(null);
  const profileDirty = useRef(false);
  const configDirty = useRef(false);
  const draftDirty = useRef(false);
  const draftContext = useRef('');
  const configContext = useRef('');
  const [challengeMembership, setChallengeMembership] = useState<MembershipStatus | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; requestId.current++; };
  }, []);

  const runMutation = async (work: () => Promise<void>, onError: (message: string) => void) => {
    if (mutationLock.current || !alive.current) return;
    mutationLock.current = true;
    setMutationBusy(true);
    requestId.current++; // Invalidate background reads started before the mutation.
    try { await work(); }
    catch (error) { if (alive.current) onError(errorMessage(error)); }
    finally {
      mutationLock.current = false;
      if (alive.current) setMutationBusy(false);
    }
  };

  const fetchBootstrapData = useCallback(async () => {
    if (!supabase || !identity) return;
    if (bootstrapFlight.current === requestId.current) return;
    const ticket = ++requestId.current;
    bootstrapFlight.current = ticket;
    const current = () => alive.current && ticket === requestId.current;
    try {
      const { data: boot, error } = await supabase.rpc('get_session_bootstrap');
      if (error) throw error;
      if (!boot || boot.user_id !== identity) throw new Error('تغيّرت الجلسة. يرجى تسجيل الدخول مجدداً.');
      const callerIsAdmin = Boolean(boot.is_admin);
      const ch = mapChallenge(boot.current_challenge);
      const p = boot.profile ? mapProfile(boot.profile) : null;
      const canRead = Boolean(ch.id && isValidUuid(ch.id) && (callerIsAdmin || p?.membershipStatus === 'approved'));
      const [records, leaderboard, report] = await Promise.all([
        canRead ? supabase.from('daily_achievements').select('*').eq('challenge_id', ch.id).eq('student_id', identity)
          : Promise.resolve({ data: [], error: null }),
        canRead ? supabase.rpc('get_leaderboard_and_group_stats', { p_challenge_id: ch.id })
          : Promise.resolve({ data: null, error: null }),
        callerIsAdmin ? supabase.rpc('get_admin_report', { p_challenge_id: isValidUuid(ch.id) ? ch.id : null })
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (records.error) throw records.error;
      if (leaderboard.error) throw leaderboard.error;
      if (report.error) throw report.error;
      if (!current()) return;
      setSessionUserId(identity);
      setSessionEmail(boot.email ?? null);
      setIsAdmin(callerIsAdmin);
      setProfile(p);
      setChallengeMembership(boot.challenge_membership_status ?? null);
      setDamascusToday(boot.damascus_today);
      setChallenge(ch);
      if (configContext.current !== ch.id) { configDirty.current = false; configContext.current = ch.id; }
      if (!configDirty.current) {
        setCfgTitle(ch.title); setCfgStartDate(ch.startDate ?? ''); setCfgDuration(ch.durationDays);
      }
      if (p && !profileDirty.current) {
        setAdminKnownNameInput(p.adminKnownName); setPublicDisplayNameInput(p.publicDisplayName);
        setLeaderboardOptInInput(p.leaderboardOptIn);
      }
      setMyAchievements((records.data ?? []).map(mapAchievement));
      const lb = leaderboard.data;
      setServerLeaderboard(lb ? {
        elapsedDays: Number(lb.elapsed_days), currentWeekNum: Number(lb.current_week_num),
        collectiveGoalPct: Number(lb.collective_goal_pct), approvedStudentCount: Number(lb.approved_student_count),
        groupTotalPoints: Number(lb.group_total_points), groupAvailablePoints: Number(lb.group_available_points),
        groupCompletionPct: Number(lb.group_completion_pct), overallRankings: lb.overall_rankings ?? [],
        weeklyRankings: lb.weekly_rankings ?? [], mySummary: lb.my_summary ?? null,
      } : null);
      const adminReport = report.data ? mapReport(report.data) : null;
      setAllProfilesForAdmin(adminReport?.profiles ?? []);
      setAllAchievementsForAdmin(adminReport?.achievements ?? []);
      setReportGeneratedAt(adminReport?.generatedAt ?? null);
      setDataError(null);
    } catch (error) {
      if (current()) setDataError(errorMessage(error));
    } finally {
      if (bootstrapFlight.current === ticket) bootstrapFlight.current = null;
      if (current()) setLoadingSession(false);
    }
  }, [identity]);

  useEffect(() => {
    if (!identity) return;
    void fetchBootstrapData();
    const refresh = () => {
      if (!mutationLock.current && document.visibilityState === 'visible') void fetchBootstrapData();
    };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      requestId.current++;
    };
  }, [identity, fetchBootstrapData]);

  useEffect(() => {
    const checkDateRollover = () => {
      const nowDamascus = getDamascusDateString(new Date());
      setDamascusToday((prev) => (prev !== nowDamascus ? nowDamascus : prev));
    };
    const timer = window.setInterval(checkDateRollover, 15000);
    window.addEventListener('focus', checkDateRollover);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', checkDateRollover);
    };
  }, []);

  const savedToday = useMemo(
    () => myAchievements.find((a) => a.challengeId === challenge.id && a.achievementDate === damascusToday) ?? null,
    [myAchievements, damascusToday, challenge.id]
  );

  useEffect(() => {
    const context = challenge.id + ':' + damascusToday;
    if (draftContext.current !== context) {
      if (draftDirty.current) setSaveFeedback('بدأ يوم أو تحدٍ جديد. لم تُنقل تعديلات اليوم السابق؛ راجع سجل اليوم قبل الحفظ.');
      draftDirty.current = false;
      draftContext.current = context;
    }
    if (draftDirty.current) return;
    if (savedToday) {
      setDraft({
        quranTwoPages: savedToday.quranTwoPages,
        ishaCongregation: savedToday.ishaCongregation,
        morningAdhkar: savedToday.morningAdhkar,
      });
      setLoadedRevision(savedToday.revision);
    } else {
      setDraft({ quranTwoPages: false, ishaCongregation: false, morningAdhkar: false });
      setLoadedRevision(0);
    }
  }, [savedToday, challenge.id, damascusToday]);

  const hasUnsavedChanges = useMemo(() => {
    const bq = savedToday?.quranTwoPages ?? false;
    const bi = savedToday?.ishaCongregation ?? false;
    const bm = savedToday?.morningAdhkar ?? false;
    return (
      draft.quranTwoPages !== bq ||
      draft.ishaCongregation !== bi ||
      draft.morningAdhkar !== bm
    );
  }, [draft, savedToday]);

  const windowInfo = useMemo(
    () => evaluateChallengeWindow(challenge, damascusToday),
    [challenge, damascusToday]
  );

  useEffect(() => {
    if (windowInfo.currentDayNumber) {
      setSelectedDayNum(windowInfo.currentDayNumber);
    }
  }, [windowInfo.currentDayNumber]);

  const dashboardMetrics = useMemo(
    () => calculatePersonalDashboard(challenge, myAchievements, damascusToday),
    [challenge, myAchievements, damascusToday]
  );

  const selectedCalendarDay = useMemo(
    () =>
      dashboardMetrics.calendarDays.find((d) => d.dayNumber === selectedDayNum) ??
      dashboardMetrics.calendarDays[0],
    [dashboardMetrics.calendarDays, selectedDayNum]
  );

  // Admin statistics computation
  const adminComputedStats = useMemo(() => {
    return computeLeaderboardAndGroupStats(
      challenge,
      allProfilesForAdmin,
      allProfilesForAdmin.filter((p) => p.isAdmin).map((p) => p.email),
      allAchievementsForAdmin,
      sessionUserId,
      damascusToday
    );
  }, [
    challenge,
    allProfilesForAdmin,
    isAdmin,
    allAchievementsForAdmin,
    sessionUserId,
    damascusToday,
  ]);

  // Email + Password Sign-In / Sign-Up Handler
  const handleEmailPasswordAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccessMsg(null);

    if (!supabase) {
      setAuthError(
        'لم يتم ضبط إعدادات Supabase بعد. أضف VITE_SUPABASE_URL و VITE_SUPABASE_PUBLISHABLE_KEY (أو VITE_SUPABASE_ANON_KEY) في إعدادات الاستضافة ثم أعد النشر، أو في ملف .env.local ثم أعد تشغيل خادم التطوير.'
      );
      return;
    }

    const cleanEmail = emailInput.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setAuthError('يرجى إدخال بريد إلكتروني صحيح.');
      return;
    }
    if (passwordInput.length < 6) {
      setAuthError('يجب ألا تقل كلمة المرور عن 6 أحرف.');
      return;
    }

    setAuthSubmitting(true);
    try {
      if (authFormMode === 'sign_in') {
        const { error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password: passwordInput,
        });
        if (error) throw error;
      } else {
        // Sign Up new account
        const nameError = validateProfileNames(adminKnownNameInput, publicDisplayNameInput);
        if (nameError) throw new Error(nameError);

        const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
          email: cleanEmail,
          password: passwordInput,
          options: {
            data: {
              admin_known_name: adminKnownNameInput.trim(),
              public_display_name: publicDisplayNameInput.trim(),
              leaderboard_opt_in: leaderboardOptInInput,
            },
          },
        });
        if (signUpErr) throw signUpErr;

        if (!signUpData.session) {
          setAuthSuccessMsg(
            'تم إنشاء الحساب بنجاح! إذا كان خيار تأكيد البريد مفعّلاً في Supabase، يرجى فتح الرسالة في بريدك للتأكيد، أو تسجيل الدخول فوراً إذا كان معطلاً.'
          );
          setAuthFormMode('sign_in');
        }
      }
    } catch (err: unknown) {
      const msg = errorMessage(err);
      setAuthError(translateAuthError(msg));
    } finally {
      setAuthSubmitting(false);
    }
  };

  const resetAllSessionState = useCallback(() => {
    setSessionUserId(null);
    setSessionEmail(null);
    setIsAdmin(false);
    setProfile(null);
    setChallengeMembership(null);
    setChallenge(EMPTY_CHALLENGE);
    setMyAchievements([]);
    setAllProfilesForAdmin([]);
    setAllAchievementsForAdmin([]);
    setServerLeaderboard(null);
    setDraft({ quranTwoPages: false, ishaCongregation: false, morningAdhkar: false });
    setLoadedRevision(0);
    setSaveStatus('idle');
    setSaveFeedback(null);
    setAdminKnownNameInput('');
    setPublicDisplayNameInput('');
    setLeaderboardOptInInput(false);
    setProfileFeedback(null);
    setAdminBanner(null);
    setDataError(null);
    profileDirty.current = false;
    configDirty.current = false;
    draftDirty.current = false;
    draftContext.current = '';
    configContext.current = '';
  }, []);

  const handleSignOut = () => runMutation(async () => {
    if (supabase) {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    }
    resetAllSessionState();
  }, (text) => setDataError(text));

  const handleUpsertProfile = (e: React.FormEvent) => {
    e.preventDefault();
    return runMutation(async () => {
      setProfileFeedback(null);
      const nameError = validateProfileNames(adminKnownNameInput, publicDisplayNameInput);
      if (nameError) throw new Error(nameError);
      const { error } = await supabase!.rpc('upsert_my_profile', {
        p_admin_known_name: adminKnownNameInput.trim(), p_public_display_name: publicDisplayNameInput.trim(),
        p_leaderboard_opt_in: leaderboardOptInInput,
      });
      if (error) throw error;
      if (!alive.current) return;
      profileDirty.current = false;
      setProfileFeedback({ type: 'success', text: 'تم حفظ الملف الشخصي بنجاح.' });
      await fetchBootstrapData();
    }, (text) => setProfileFeedback({ type: 'error', text }));
  };

  const handleSaveToday = () => runMutation(async () => {
    if (!isValidUuid(challenge.id)) {
      throw new Error('لا يوجد تحدٍ نشط حالياً.');
    }
    setSaveStatus('saving'); setSaveFeedback(null);
    const { error } = await supabase!.rpc('save_today_achievement', {
      p_challenge_id: challenge.id, p_target_date: damascusToday,
      p_quran_two_pages: draft.quranTwoPages, p_isha_congregation: draft.ishaCongregation,
      p_morning_adhkar: draft.morningAdhkar, p_expected_revision: loadedRevision,
    });
    if (!alive.current) return;
    if (error) {
      // Refresh status/date immediately; dirty same-day drafts retain their old revision until reviewed.
      await fetchBootstrapData();
      throw error;
    }
    draftDirty.current = false;
    setSaveStatus('success'); setSaveFeedback('تم حفظ إنجاز اليوم بنجاح.');
    await fetchBootstrapData();
  }, (text) => { setSaveStatus('error'); setSaveFeedback(text); });

  const handleAdminSetMemberStatus = (studentId: string, newStatus: MembershipStatus) => runMutation(async () => {
    if (!isAdmin) return;
    setAdminBanner(null);
    const challengeId = isValidUuid(challenge.id) ? challenge.id : null;
    const { error } = await supabase!.rpc('admin_set_membership_status', {
      p_student_id: studentId, p_challenge_id: challengeId, p_new_status: newStatus,
      p_reason: newStatus === 'suspended' ? 'إيقاف مؤقت من مشرف الحلقة' : null,
    });
    if (error) throw error;
    if (!alive.current) return;
    setAdminBanner({ type: 'success', text: 'تم تحديث حالة العضوية.' });
    await fetchBootstrapData();
  }, (text) => setAdminBanner({ type: 'error', text }));

  const handleAdminSaveChallenge = (e: React.FormEvent) => {
    e.preventDefault();
    return runMutation(async () => {
      if (!isAdmin || !isValidUuid(challenge.id)) return;
      const challengeId = isValidUuid(challenge.id) ? challenge.id : null;
      const { error } = await supabase!.rpc('admin_configure_challenge', {
        p_challenge_id: challengeId, p_title: cfgTitle.trim(),
        p_start_date: cfgStartDate || null, p_duration_days: cfgDuration,
      });
      if (error) throw error;
      if (!alive.current) return;
      configDirty.current = false;
      setAdminBanner({ type: 'success', text: 'تم حفظ إعدادات التحدي.' });
      await fetchBootstrapData();
    }, (text) => setAdminBanner({ type: 'error', text }));
  };

  const handleAdminArchiveChallenge = () => runMutation(async () => {
    if (!isAdmin) return;
    const challengeId = isValidUuid(challenge.id) ? challenge.id : null;
    const { error } = await supabase!.rpc('admin_archive_and_create_challenge', {
      p_current_challenge_id: challengeId, p_new_title: newChallengeTitle.trim(),
      p_new_start_date: newChallengeStartDate || null, p_new_duration_days: 30,
    });
    if (error) throw error;
    if (!alive.current) return;
    setShowArchiveConfirm(false);
    setAdminBanner({ type: 'success', text: 'تم فتح الدورة الجديدة مع الاحتفاظ بالسجلات السابقة.' });
    await fetchBootstrapData();
  }, (text) => setAdminBanner({ type: 'error', text }));

  const handleAdminExportCsv = () => runMutation(async () => {
    if (!isAdmin) return;
    const challengeId = isValidUuid(challenge.id) ? challenge.id : null;
    const { data, error } = await supabase!.rpc('get_admin_report', { p_challenge_id: challengeId });
    if (error) throw error;
    if (!alive.current) return;
    const fresh = mapReport(data);
    const reportWindow = evaluateChallengeWindow(fresh.challenge, fresh.today);
    setReportGeneratedAt(fresh.generatedAt);
    setAllProfilesForAdmin(fresh.profiles);
    setAllAchievementsForAdmin(fresh.achievements);
    const rows = fresh.profiles
      .filter((p) => !p.isAdmin)
      .map((p) => {
        const recs = fresh.achievements.filter((a) => a.studentId === p.id);
        const totalPoints = recs.reduce((s, r) => s + computeActivityPoints(r), 0);
        const avail = reportWindow.elapsedDays * 3;
        const completionPct =
          avail > 0 ? Number(((totalPoints * 100) / avail).toFixed(1)) : 0;
        const streakDays = calculateStreakDays(fresh.challenge, recs, fresh.today);
        const fullDaysCount = recs.filter((r) => computeActivityPoints(r) === 3).length;
        const quranCount = recs.filter((r) => r.quranTwoPages).length;
        const ishaCount = recs.filter((r) => r.ishaCongregation).length;
        const adhkarCount = recs.filter((r) => r.morningAdhkar).length;
        const latestRecordedDate =
          recs
            .filter((r) => computeActivityPoints(r) > 0)
            .map((r) => r.achievementDate)
            .sort()
            .pop() ?? 'لا يوجد';

        return {
          adminKnownName: p.adminKnownName,
          publicDisplayName: p.publicDisplayName,
          email: p.email,
          membershipStatus: p.membershipStatus,
          totalPoints,
          completionPct,
          streakDays,
          fullDaysCount,
          quranCount,
          ishaCount,
          adhkarCount,
          latestRecordedDate,
        };
      });

    const csv = generateSafeAdminCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `تقرير-حلقة-أبي-بكر-الصديق-${fresh.today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, (text) => setAdminBanner({ type: 'error', text }));

  if (loadingSession) {
    return (
      <div
        dir="rtl"
        className="min-h-screen bg-[#FAF7F0] flex items-center justify-center p-6 text-center"
      >
        <div className="space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-[#144734] text-[#D4AF37] flex items-center justify-center mx-auto animate-pulse">
            <Sparkles className="w-6 h-6" />
          </div>
          <p className="text-sm font-semibold text-[#144734]">جاري التحقق من الجلسة...</p>
        </div>
      </div>
    );
  }

  return (
    <div dir="rtl" lang="ar" className="min-h-screen bg-[#FAF7F0] text-[#162921] flex flex-col">
      <header className="bg-white border-b border-[#E6DEC8] sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-3.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#144734] text-[#D4AF37] flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-bold text-[#144734]">{challenge.title}</h1>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-[#FBF6E8] text-[#94721B] border border-[#D4AF37]/40">
                  {challenge.communityName}
                </span>
              </div>
              <p className="text-xs text-[#5B6E65]">{ENCOURAGEMENT_MOTTO}</p>
            </div>
          </div>

          {sessionUserId && (
            <div className="flex items-center gap-2">
              {profile && (
                <span className="hidden sm:inline text-xs font-semibold text-[#144734]">
                  {profile.adminKnownName}
                </span>
              )}
              <button
                type="button"
                onClick={handleSignOut}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#FDF2F2] text-[#7F2323] border border-[#F5C2C2] text-xs font-semibold hover:bg-[#FBE8E8] transition"
              >
                <LogOut className="w-4 h-4" />
                <span>خروج</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6 pb-20">
        <fieldset disabled={mutationBusy} className="contents">
        {dataError ? <section role="alert" className="p-6 bg-white rounded-2xl">
          <p>{dataError}</p><button type="button" onClick={() => void fetchBootstrapData()}>إعادة المحاولة</button>
        </section> : <>
        {!sessionUserId ? (
          <section className="max-w-2xl mx-auto bg-white rounded-3xl p-6 sm:p-8 border border-[#E6DEC8] shadow-sm space-y-6">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#EAF3EE] text-[#144734] text-xs font-semibold mb-3">
                <Sparkles className="w-3.5 h-3.5 text-[#B8922A]" />
                <span>حلقة سيدنا أبو بكر الصديق • برنامج متابعة يومية تطوعي</span>
              </div>
              <h2 className="text-2xl sm:text-3xl font-bold text-[#144734]">
                مرحباً بك في تحدي «تعالَ نؤمن ساعة»
              </h2>
              <p className="text-sm text-[#364940] mt-2 leading-relaxed">
                مساحة أخوية خاصة لطلاب الحلقة، نتعاون فيها على بناء عادات إيمانية يومية ثابتة.
                المشاركة <strong>تطوعية بالكامل</strong>، وغايتنا منها
                التشجيع المتبادل ودوام العمل وإن قلّ.
              </p>
              <blockquote className="mt-4 p-4 rounded-2xl bg-[#FAF7F0] border-r-4 border-[#B8922A] text-sm font-medium text-[#144734]">
                «{ENCOURAGEMENT_MOTTO}»
              </blockquote>
            </div>

            {!isSupabaseConfigured && (
              <div
                role="alert"
                className="p-4 rounded-2xl bg-[#FFF9E6] border border-[#E6C665] text-[#7A5C12] text-xs space-y-1.5"
              >
                <p className="font-bold flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 text-[#B8922A] shrink-0" />
                  <span>تنبيه: يلزم ضبط متغيرات الربط مع Supabase</span>
                </p>
                <p className="leading-relaxed">
                  أضف <code>VITE_SUPABASE_URL</code> و <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> في
                  إعدادات الاستضافة (Vercel) أو في ملف <code>.env.local</code> محلياً.
                </p>
              </div>
            )}

            <div className="space-y-2.5">
              <h3 className="text-xs sm:text-sm font-bold text-[#162921]">
                الأنشطة اليومية الثلاثة (3 نقاط يومياً):
              </h3>
              {DAILY_ACTIVITIES_META.map((act, idx) => (
                <div
                  key={act.key}
                  className="p-3.5 rounded-2xl bg-[#FAF7F0] border border-[#E6DEC8] flex items-center justify-between gap-2"
                >
                  <div>
                    <p className="font-bold text-sm text-[#162921]">
                      {idx + 1}. {act.title}
                    </p>
                    <p className="text-xs text-[#5B6E65] mt-0.5">{act.subtitle}</p>
                  </div>
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-[#EAF3EE] text-[#144734] shrink-0">
                    نقطة واحدة
                  </span>
                </div>
              ))}
            </div>

            {/* Email + Password Auth Card */}
            <div className="pt-2 border-t border-[#E6DEC8] space-y-4">
              <div className="grid grid-cols-2 rounded-2xl bg-[#FAF7F0] p-1 border border-[#E6DEC8]">
                <button
                  type="button"
                  onClick={() => {
                    setAuthFormMode('sign_in');
                    setAuthError(null);
                  }}
                  className={`min-h-[42px] rounded-xl text-xs sm:text-sm font-bold transition ${
                    authFormMode === 'sign_in'
                      ? 'bg-[#144734] text-white shadow-sm'
                      : 'text-[#364940]'
                  }`}
                >
                  تسجيل الدخول بحساب حالي
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthFormMode('sign_up');
                    setAuthError(null);
                  }}
                  className={`min-h-[42px] rounded-xl text-xs sm:text-sm font-bold transition ${
                    authFormMode === 'sign_up'
                      ? 'bg-[#144734] text-white shadow-sm'
                      : 'text-[#364940]'
                  }`}
                >
                  إنشاء حساب جديد للطالب
                </button>
              </div>

              {authError && (
                <div
                  role="alert"
                  className="p-4 rounded-2xl bg-[#FDF2F2] border border-[#F5C2C2] text-[#7F2323] text-xs flex items-start gap-2"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{authError}</span>
                </div>
              )}

              {authSuccessMsg && (
                <div className="p-4 rounded-2xl bg-[#EAF3EE] border border-[#144734]/20 text-[#144734] text-xs flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{authSuccessMsg}</span>
                </div>
              )}

              <form onSubmit={handleEmailPasswordAuth} className="space-y-3.5">
                <div>
                  <label className="block text-xs font-semibold text-[#162921] mb-1">
                    البريد الإلكتروني
                  </label>
                  <input
                    type="email"
                    required
                    dir="ltr"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="student@gmail.com"
                    className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border border-[#D5CBB4] text-sm text-left focus:outline-none focus:ring-2 focus:ring-[#144734]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[#162921] mb-1">
                    كلمة المرور (6 أحرف على الأقل)
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      minLength={6}
                      dir="ltr"
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      placeholder="••••••••"
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border border-[#D5CBB4] text-sm text-left focus:outline-none focus:ring-2 focus:ring-[#144734]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#5B6E65] hover:text-[#144734]"
                    >
                      {showPassword ? 'إخفاء' : 'إظهار'}
                    </button>
                  </div>
                </div>

                {authFormMode === 'sign_up' && (
                  <div className="space-y-3.5 pt-2 border-t border-[#E6DEC8]">
                    <div>
                      <label className="block text-xs font-semibold text-[#162921] mb-1">
                        الاسم الكامل المعروف لدى مشرف الحلقة (خاص بالمشرف فقط)
                      </label>
                      <input
                        type="text"
                        required
                        minLength={2}
                      maxLength={80}
                      value={adminKnownNameInput}
                        onChange={(e) => { profileDirty.current = true; setAdminKnownNameInput(e.target.value); }}
                        placeholder="مثال: عبد الله بن مسعود"
                        className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-[#162921] mb-1">
                        الاسم المختار للظهور في لوحة الصدارة (كنية أو لقب)
                      </label>
                      <input
                        type="text"
                        required
                        minLength={2}
                      maxLength={50}
                      value={publicDisplayNameInput}
                        onChange={(e) => { profileDirty.current = true; setPublicDisplayNameInput(e.target.value); }}
                        placeholder="مثال: أبو عبد الرحمن"
                        className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                      />
                    </div>

                    <label className="flex items-start gap-2.5 p-3.5 rounded-2xl bg-[#FAF7F0] border border-[#E6DEC8] text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={leaderboardOptInInput}
                        onChange={(e) => { profileDirty.current = true; setLeaderboardOptInInput(e.target.checked); }}
                        className="mt-0.5 w-4 h-4 accent-[#144734]"
                      />
                      <span>
                        المشاركة الاختيارية في لوحة الصدارة العامة باسمي المستعار (الوضع الافتراضي:
                        غير مفعّل)
                      </span>
                    </label>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="w-full min-h-[50px] rounded-2xl bg-[#144734] hover:bg-[#0D3123] disabled:opacity-50 text-white font-bold text-sm transition shadow-sm"
                >
                  {authSubmitting
                    ? 'جاري المعالجة...'
                    : authFormMode === 'sign_in'
                      ? 'تسجيل الدخول بالبريد وكلمة المرور'
                      : 'إنشاء الحساب وإرسال طلب الانضمام'}
                </button>
              </form>
            </div>
          </section>
        ) : !profile ? (
          <section className="max-w-xl mx-auto bg-white rounded-3xl p-6 border border-[#E6DEC8] shadow-sm space-y-4">
            <div className="inline-flex items-center gap-2 text-xs font-bold text-[#94721B]">
              <UserPlus className="w-4 h-4" />
              <span>إعداد الملف الشخصي وطلب الانضمام</span>
            </div>
            <h2 className="text-xl font-bold text-[#144734]">إكمال بيانات الانضمام للحلقة</h2>

            {profileFeedback && (
              <div
                role="alert"
                className={`p-3.5 rounded-2xl text-xs flex items-start gap-2 ${
                  profileFeedback.type === 'success'
                    ? 'bg-[#EAF3EE] border border-[#144734]/20 text-[#144734]'
                    : 'bg-[#FDF2F2] border border-[#F5C2C2] text-[#7F2323]'
                }`}
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{profileFeedback.text}</span>
              </div>
            )}

            <form onSubmit={handleUpsertProfile} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold mb-1">
                  الاسم الكامل المعروف لدى المشرف
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                      maxLength={80}
                      value={adminKnownNameInput}
                  onChange={(e) => { profileDirty.current = true; setAdminKnownNameInput(e.target.value); }}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1">
                  الاسم المختار للظهور في لوحة الصدارة
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                      maxLength={50}
                      value={publicDisplayNameInput}
                  onChange={(e) => { profileDirty.current = true; setPublicDisplayNameInput(e.target.value); }}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                />
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={leaderboardOptInInput}
                  onChange={(e) => { profileDirty.current = true; setLeaderboardOptInInput(e.target.checked); }}
                />
                <span>الظهور الاختياري في لوحة الصدارة العامة</span>
              </label>
              <button
                type="submit"
                className="w-full min-h-[48px] rounded-xl bg-[#144734] hover:bg-[#0D3123] text-white font-bold text-sm transition"
              >
                إرسال طلب الانضمام
              </button>
            </form>
          </section>
        ) : profile.membershipStatus === 'pending' && !isAdmin ? (
          <section className="max-w-xl mx-auto bg-white rounded-3xl p-6 border border-[#D4AF37] space-y-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[#94721B] font-bold">
                <Clock className="w-5 h-5" />
                <h2>طلب انضمامك قيد المراجعة من مشرف الحلقة</h2>
              </div>
              <button
                type="button"
                onClick={() => void fetchBootstrapData()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#FAF7F0] text-[#144734] border border-[#144734]/30 text-xs font-bold hover:bg-[#EAF3EE] transition"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>فحص القبول</span>
              </button>
            </div>
            <p className="text-xs text-[#4A5D54] leading-relaxed">
              أهلاً بك يا <strong>{profile.adminKnownName}</strong>. لحين موافقة المشرف على عضويتك،
              لا يمكنك قراءة بيانات المشاركين أو لوحة الصدارة أو تسجيل الإنجازات، ولكن يمكنك تعديل
              ملفك الشخصي أدناه في أي وقت.
            </p>
            {profileFeedback && (
              <div
                className={`p-3 rounded-xl text-xs ${
                  profileFeedback.type === 'success'
                    ? 'bg-[#EAF3EE] text-[#144734]'
                    : 'bg-[#FDF2F2] text-[#7F2323]'
                }`}
              >
                {profileFeedback.text}
              </div>
            )}
            <form onSubmit={handleUpsertProfile} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold mb-1">الاسم لدى المشرف</label>
                <input
                  type="text"
                  minLength={2}
                      maxLength={80}
                      value={adminKnownNameInput}
                  onChange={(e) => { profileDirty.current = true; setAdminKnownNameInput(e.target.value); }}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1">الاسم الظاهر في اللوحة</label>
                <input
                  type="text"
                  minLength={2}
                      maxLength={50}
                      value={publicDisplayNameInput}
                  onChange={(e) => { profileDirty.current = true; setPublicDisplayNameInput(e.target.value); }}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                />
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={leaderboardOptInInput}
                  onChange={(e) => { profileDirty.current = true; setLeaderboardOptInInput(e.target.checked); }}
                />
                <span>الظهور في لوحة الصدارة بعد التفعيل</span>
              </label>
              <button
                type="submit"
                className="w-full min-h-[44px] rounded-xl bg-[#144734] hover:bg-[#0D3123] text-white font-bold text-xs transition"
              >
                حفظ تعديلات الملف الشخصي
              </button>
            </form>
          </section>
        ) : profile.membershipStatus === 'suspended' && !isAdmin ? (
          <section className="max-w-xl mx-auto bg-white rounded-3xl p-6 border border-[#F5C2C2] space-y-3">
            <div className="flex items-center gap-2 text-[#7F2323] font-bold">
              <ShieldAlert className="w-5 h-5" />
              <h2>تم إيقاف العضوية مؤقتاً</h2>
            </div>
            <p className="text-xs text-[#4A5D54] leading-relaxed">
              تم إيقاف وصول حسابك إلى سجلات الحلقة والعمليات المحمية فوراً. يرجى التواصل مع مشرف
              الحلقة.
            </p>
          </section>
        ) : (
          <div className="space-y-6">
            <nav className="bg-white rounded-2xl p-1.5 border border-[#E6DEC8] flex items-center gap-1 overflow-x-auto">
              {[
                { id: 'today' as ActiveTab, label: 'إنجاز اليوم', icon: CheckCircle2 },
                { id: 'dashboard' as ActiveTab, label: 'لوحتي والتقويم', icon: Calendar },
                { id: 'leaderboard' as ActiveTab, label: 'لوحة الصدارة', icon: Trophy },
                { id: 'profile' as ActiveTab, label: 'الملف الشخصي', icon: UserCheck },
                ...(isAdmin
                  ? [{ id: 'admin' as ActiveTab, label: 'لوحة المشرف', icon: Settings }]
                  : []),
              ].map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
                    className={`flex-1 min-w-[74px] min-h-[44px] px-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                      activeTab === t.id
                        ? 'bg-[#144734] text-white shadow-sm'
                        : 'text-[#364940] hover:bg-[#FAF7F0]'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{t.label}</span>
                  </button>
                );
              })}
            </nav>

            {activeTab === 'today' && (
              <div className="space-y-4">
                <section className="bg-white rounded-3xl p-6 border border-[#E6DEC8] space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="text-xl font-bold text-[#144734]">
                        {profile?.adminKnownName ?? 'طالب الحلقة'}
                      </h2>
                      <p className="text-xs text-[#5B6E65]">
                        تاريخ اليوم (توقيت دمشق): {damascusToday}
                      </p>
                    </div>
                    {windowInfo.state === 'active' && windowInfo.currentDayNumber && (
                      <span className="px-4 py-2 rounded-2xl bg-[#144734] text-white text-xs sm:text-sm font-bold flex items-center gap-1.5">
                        <Flame className="w-4 h-4 text-[#D4AF37]" />
                        <span>
                          اليوم {windowInfo.currentDayNumber} من {challenge.durationDays}
                        </span>
                      </span>
                    )}
                    {windowInfo.state === 'upcoming' && (
                      <span className="px-4 py-2 rounded-2xl bg-[#FBF6E8] text-[#94721B] text-xs font-bold border border-[#D4AF37]/30">
                        {challenge.startDate
                          ? `يبدأ التحدي في ${challenge.startDate}`
                          : 'بانتظار تحديد تاريخ البدء من المشرف'}
                      </span>
                    )}
                    {windowInfo.state === 'completed' && (
                      <span className="px-4 py-2 rounded-2xl bg-[#EAF3EE] text-[#144734] text-xs font-bold border border-[#144734]/30">
                        اكتملت أيام الدورة الحالية
                      </span>
                    )}
                  </div>

                  {!isAdmin && challengeMembership !== 'approved' && <p role="status">عضويتك في هذا التحدي بانتظار موافقة المشرف.</p>}
                  {saveStatus === 'error' && <button type="button" onClick={() => {
                    draftDirty.current = false;
                    void fetchBootstrapData();
                  }}>تحميل أحدث سجل واستبدال التعديلات المحلية</button>}
                  {hasUnsavedChanges && (
                    <div className="p-3.5 rounded-xl bg-[#FBF6E8] border border-[#D4AF37] text-xs font-semibold text-[#7A5C12]">
                      لديك تغييرات غير محفوظة — اضغط على زر «حفظ إنجاز اليوم» لتأكيدها.
                    </div>
                  )}

                  <div className="space-y-3">
                    {DAILY_ACTIVITIES_META.map((act) => {
                      const checked = draft[act.key];
                      const disabled = mutationBusy || windowInfo.state !== 'active' || (!isAdmin && challengeMembership !== 'approved');
                      return (
                        <button
                          key={act.key}
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            draftDirty.current = true;
                            setDraft((prev) => ({ ...prev, [act.key]: !prev[act.key] }));
                            setSaveStatus('idle');
                          }}
                          className={`w-full text-right p-4 rounded-2xl border-2 flex items-center justify-between gap-3 transition ${
                            checked
                              ? 'bg-[#EAF3EE]/70 border-[#144734]'
                              : 'bg-[#FAF7F0]/60 border-[#E6DEC8]'
                          } ${disabled ? 'opacity-60 cursor-not-allowed' : 'hover:border-[#144734]/60'}`}
                        >
                          <div>
                            <p className="font-bold text-sm sm:text-base text-[#162921]">
                              {act.title}
                            </p>
                            <p className="text-xs text-[#5B6E65] mt-0.5">{act.subtitle}</p>
                          </div>
                          <div
                            className={`w-7 h-7 rounded-xl flex items-center justify-center border-2 transition ${
                              checked
                                ? 'bg-[#144734] border-[#144734] text-white'
                                : 'bg-white border-[#B9B09B]'
                            }`}
                          >
                            {checked && <Check className="w-4 h-4" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {saveFeedback && (
                    <div
                      className={`p-3.5 rounded-xl text-xs font-semibold ${
                        saveStatus === 'success'
                          ? 'bg-[#EAF3EE] text-[#144734] border border-[#144734]/20'
                          : 'bg-[#FDF2F2] text-[#7F2323] border border-[#F5C2C2]'
                      }`}
                    >
                      {saveFeedback}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleSaveToday}
                    disabled={mutationBusy || windowInfo.state !== 'active' || (!isAdmin && challengeMembership !== 'approved')}
                    className="w-full min-h-[50px] rounded-2xl bg-[#144734] hover:bg-[#0D3123] disabled:opacity-50 text-white font-bold text-sm transition shadow-sm"
                  >
                    {saveStatus === 'saving' ? 'جاري الحفظ...' : 'حفظ إنجاز اليوم'}
                  </button>
                </section>
              </div>
            )}

            {activeTab === 'dashboard' && (
              <div className="space-y-5">
                <section className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
                  <div className="bg-white rounded-2xl p-4 border border-[#E6DEC8]">
                    <span className="text-xs text-[#5B6E65]">مجموع النقاط</span>
                    <p className="text-2xl font-bold text-[#144734] mt-1">
                      {dashboardMetrics.totalPoints} / {dashboardMetrics.maxPossiblePoints}
                    </p>
                  </div>
                  <div className="bg-white rounded-2xl p-4 border border-[#E6DEC8]">
                    <span className="text-xs text-[#5B6E65]">نقاط الأسبوع الحالي</span>
                    <p className="text-2xl font-bold text-[#144734] mt-1">
                      {dashboardMetrics.currentWeekPoints} / {dashboardMetrics.currentWeekMaxPoints}
                    </p>
                  </div>
                  <div className="bg-white rounded-2xl p-4 border border-[#E6DEC8]">
                    <span className="text-xs text-[#5B6E65]">نسبة الإنجاز حتى اليوم</span>
                    <p className="text-2xl font-bold text-[#144734] mt-1">
                      {dashboardMetrics.completionPercentage}%
                    </p>
                  </div>
                  <div className="bg-white rounded-2xl p-4 border border-[#E6DEC8]">
                    <span className="text-xs text-[#5B6E65]">أيام المواظبة المتتالية</span>
                    <p className="text-2xl font-bold text-[#144734] mt-1">
                      {dashboardMetrics.streakDays} أيام
                    </p>
                  </div>
                  <div className="bg-white rounded-2xl p-4 border border-[#E6DEC8]">
                    <span className="text-xs text-[#5B6E65]">أيام مكتملة (3/3)</span>
                    <p className="text-2xl font-bold text-[#144734] mt-1">
                      {dashboardMetrics.fullDaysCount}
                    </p>
                  </div>
                  <div className="bg-[#FAF7F0] rounded-2xl p-4 border border-[#D4AF37]/40 text-xs text-[#364940]">
                    <strong className="text-[#144734] block mb-1">حساب نسبة الإنجاز:</strong>
                    النقاط المكتسبة مقسومة على النقاط المتاحة خلال الأيام المنقضية شاملاً اليوم (3
                    نقاط لكل يوم).
                  </div>
                </section>

                <section className="bg-white rounded-3xl p-5 border border-[#E6DEC8] space-y-4">
                  <h3 className="text-base font-bold text-[#162921]">تقويم الـ {challenge.durationDays} يوماً</h3>
                  <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
                    {dashboardMetrics.calendarDays.map((day) => (
                      <button
                        key={day.dayNumber}
                        type="button"
                        onClick={() => setSelectedDayNum(day.dayNumber)}
                        className={`min-h-[52px] rounded-xl border p-1.5 flex flex-col items-center justify-center text-xs transition ${
                          !day.isFuture && day.points === 3
                            ? 'bg-[#144734] text-white border-[#144734]'
                            : !day.isFuture && day.points > 0
                              ? 'bg-[#EAF3EE] text-[#144734] border-[#144734]/40 font-bold'
                              : 'bg-[#FAF7F0] text-[#5B6E65] border-[#E6DEC8]'
                        } ${selectedDayNum === day.dayNumber ? 'ring-2 ring-[#B8922A]' : ''}`}
                      >
                        <span className="text-[10px]">يوم {day.dayNumber}</span>
                        <span className="font-bold">{day.isFuture ? '—' : `${day.points}/3`}</span>
                      </button>
                    ))}
                  </div>

                  {selectedCalendarDay && (
                    <div className="p-4 rounded-2xl bg-[#FAF7F0] border border-[#E6DEC8] text-xs space-y-2">
                      <p className="font-bold text-[#144734]">
                        تفاصيل اليوم {selectedCalendarDay.dayNumber} ({selectedCalendarDay.date}) —{' '}
                        {selectedCalendarDay.points} من 3 نقاط
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {DAILY_ACTIVITIES_META.map((act) => (
                          <div
                            key={act.key}
                            className="p-2.5 rounded-xl bg-white border border-[#E6DEC8] flex justify-between"
                          >
                            <span>{act.title}</span>
                            <span className="font-bold text-[#144734]">
                              {selectedCalendarDay[act.key] ? 'تم ✓' : '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              </div>
            )}

            {activeTab === 'leaderboard' && (
              <div className="space-y-5">
                <section className="bg-white rounded-3xl p-6 border border-[#E6DEC8] space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-bold text-[#144734]">
                      الهدف الجماعي للحلقة (80%)
                    </h2>
                    <span className="text-xl font-bold text-[#144734]">
                      {serverLeaderboard?.groupCompletionPct ?? 0}%
                    </span>
                  </div>
                  <div className="h-3.5 rounded-full bg-[#F3EDE0] overflow-hidden">
                    <div
                      className="h-full bg-[#144734] rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, serverLeaderboard?.groupCompletionPct ?? 0)}%`,
                      }}
                    />
                  </div>
                </section>

                {serverLeaderboard?.mySummary && (
                  <div className="p-4 rounded-2xl bg-[#EAF3EE] border border-[#144734]/30 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div>
                      <span className="font-bold text-[#144734]">ترتيبك الشخصي:</span>{' '}
                      <span>
                        المركز #
                        {leaderboardScope === 'overall'
                          ? serverLeaderboard.mySummary.overall_rank
                          : serverLeaderboard.mySummary.week_rank}{' '}
                        (
                        {leaderboardScope === 'overall'
                          ? serverLeaderboard.mySummary.total_points
                          : serverLeaderboard.mySummary.week_points}{' '}
                        نقطة)
                      </span>
                      {!serverLeaderboard.mySummary.leaderboard_opt_in && (
                        <p className="text-[#5B6E65] text-[11px] mt-0.5">
                          اسمك غير ظاهر للآخرين في لوحة الصدارة العامة (يمكنك تفعيل الظهور من تبويب
                          الملف الشخصي).
                        </p>
                      )}
                    </div>
                    <span className="px-2.5 py-1 rounded-full bg-white text-[#144734] font-bold border border-[#144734]/20">
                      {serverLeaderboard.mySummary.display_name}
                    </span>
                  </div>
                )}

                <section className="bg-white rounded-3xl p-6 border border-[#E6DEC8] space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold text-[#162921]">لوحة التشجيع والمواظبة</h3>
                    <div className="inline-flex rounded-xl bg-[#FAF7F0] p-1 border border-[#E6DEC8]">
                      <button
                        type="button"
                        onClick={() => setLeaderboardScope('overall')}
                        className={`px-3 py-1 rounded-lg text-xs font-bold transition ${
                          leaderboardScope === 'overall'
                            ? 'bg-[#144734] text-white shadow-sm'
                            : 'text-[#364940]'
                        }`}
                      >
                        الترتيب العام
                      </button>
                      <button
                        type="button"
                        onClick={() => setLeaderboardScope('weekly')}
                        className={`px-3 py-1 rounded-lg text-xs font-bold transition ${
                          leaderboardScope === 'weekly'
                            ? 'bg-[#144734] text-white shadow-sm'
                            : 'text-[#364940]'
                        }`}
                      >
                        الأسبوع الحالي
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {(leaderboardScope === 'overall'
                      ? (serverLeaderboard?.overallRankings ?? [])
                      : (serverLeaderboard?.weeklyRankings ?? [])
                    ).length === 0 ? (
                      <div className="p-6 rounded-2xl bg-[#FAF7F0] border border-[#E6DEC8] text-center text-xs text-[#5B6E65]">
                        لا توجد أسماء مشاركة في لوحة الصدارة العامة حالياً. (تظهر فقط أسماء الطلاب
                        الذين اختاروا تفعيل الظهور في اللوحة).
                      </div>
                    ) : leaderboardScope === 'overall' ? (
                      serverLeaderboard?.overallRankings.map((r, i) => (
                        <div
                          key={i}
                          className={`p-3.5 rounded-2xl border flex items-center justify-between ${
                            r.is_me
                              ? 'bg-[#EAF3EE] border-[#144734]'
                              : 'bg-[#FAF7F0] border-[#E6DEC8]'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span className="w-8 h-8 rounded-xl bg-white border border-[#D5CBB4] font-bold text-xs flex items-center justify-center">
                              #{r.rank}
                            </span>
                            <span className="font-bold text-sm">{r.display_name}</span>
                          </div>
                          <span className="font-bold text-[#144734]">{r.total_points} نقطة</span>
                        </div>
                      ))
                    ) : (
                      serverLeaderboard?.weeklyRankings.map((r, i) => (
                        <div
                          key={i}
                          className={`p-3.5 rounded-2xl border flex items-center justify-between ${
                            r.is_me
                              ? 'bg-[#EAF3EE] border-[#144734]'
                              : 'bg-[#FAF7F0] border-[#E6DEC8]'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span className="w-8 h-8 rounded-xl bg-white border border-[#D5CBB4] font-bold text-xs flex items-center justify-center">
                              #{r.rank}
                            </span>
                            <span className="font-bold text-sm">{r.display_name}</span>
                          </div>
                          <span className="font-bold text-[#144734]">{r.week_points} نقطة</span>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'profile' && (
              <section className="max-w-xl mx-auto bg-white rounded-3xl p-6 border border-[#E6DEC8] space-y-4">
                <h2 className="text-lg font-bold text-[#144734]">إعدادات الملف الشخصي والخصوصية</h2>
                {profileFeedback && (
                  <div
                    className={`p-3 rounded-xl text-xs ${
                      profileFeedback.type === 'success'
                        ? 'bg-[#EAF3EE] text-[#144734]'
                        : 'bg-[#FDF2F2] text-[#7F2323]'
                    }`}
                  >
                    {profileFeedback.text}
                  </div>
                )}
                <form onSubmit={handleUpsertProfile} className="space-y-3.5">
                  <div>
                    <label className="block text-xs font-semibold mb-1">
                      الاسم المعروف لدى مشرف الحلقة
                    </label>
                    <input
                      type="text"
                      required
                      minLength={2}
                      maxLength={80}
                      value={adminKnownNameInput}
                      onChange={(e) => { profileDirty.current = true; setAdminKnownNameInput(e.target.value); }}
                      className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1">
                      الاسم المختار للظهور في لوحة الصدارة
                    </label>
                    <input
                      type="text"
                      required
                      minLength={2}
                      maxLength={50}
                      value={publicDisplayNameInput}
                      onChange={(e) => { profileDirty.current = true; setPublicDisplayNameInput(e.target.value); }}
                      className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={leaderboardOptInInput}
                      onChange={(e) => { profileDirty.current = true; setLeaderboardOptInInput(e.target.checked); }}
                    />
                    <span>الظهور الاختياري في لوحة الصدارة العامة</span>
                  </label>
                  <button
                    type="submit"
                    className="w-full min-h-[46px] rounded-xl bg-[#144734] hover:bg-[#0D3123] text-white font-bold text-xs transition"
                  >
                    حفظ التغييرات
                  </button>
                </form>
              </section>
            )}

            {activeTab === 'admin' && isAdmin && (
              <div className="space-y-6">
                {adminBanner && (
                  <div
                    className={`p-4 rounded-2xl text-xs font-semibold ${
                      adminBanner.type === 'success'
                        ? 'bg-[#EAF3EE] text-[#144734]'
                        : 'bg-[#FDF2F2] text-[#7F2323]'
                    }`}
                  >
                    {adminBanner.text}
                  </div>
                )}

                <section className="bg-white rounded-3xl p-6 border border-[#E6DEC8] space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <h2 className="text-lg font-bold text-[#144734]">
                        لوحة مشرف الحلقة ({adminComputedStats.groupCompletionPct}% إنجاز جماعي)
                      </h2>
                      <button
                        type="button"
                        onClick={() => void fetchBootstrapData()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#FAF7F0] text-[#144734] border border-[#144734]/30 text-xs font-bold hover:bg-[#EAF3EE] transition"
                        title="تحديث قائمة الطلبات"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>تحديث</span>
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={handleAdminExportCsv}
                      className="px-4 py-2 rounded-xl bg-[#144734] hover:bg-[#0D3123] text-white text-xs font-bold flex items-center gap-1.5 transition"
                    >
                      <Download className="w-4 h-4 text-[#D4AF37]" />
                      <span>تصدير CSV آمن</span>
                    </button>
                  </div>

                  {reportGeneratedAt && (
                    <div className="text-xs text-[#5B6E65]">
                      <span>آخر تحديث: {new Date(reportGeneratedAt).toLocaleString('ar')}</span>
                    </div>
                  )}

                  <div className="space-y-2.5">
                    {allProfilesForAdmin.filter((p) => !p.isAdmin)
                      .length === 0 ? (
                      <div className="p-6 rounded-2xl bg-[#FAF7F0] border border-[#E6DEC8] text-center text-xs text-[#5B6E65]">
                        لا توجد طلبات انضمام جديدة من الطلاب حالياً. عندما يسجل أي طالب ستظهر بياناته
                        هنا للاعتماد الفوري.
                      </div>
                    ) : (
                      allProfilesForAdmin
                        .filter((p) => !p.isAdmin)
                        .map((s) => (
                          <div
                            key={s.id}
                            className="p-3.5 rounded-2xl bg-[#FAF7F0] border border-[#E6DEC8] flex flex-wrap items-center justify-between gap-2"
                          >
                            <div className="text-xs">
                              <p className="font-bold text-sm text-[#162921]">
                                {s.adminKnownName} ({s.publicDisplayName})
                              </p>
                              <p className="text-[#5B6E65]">
                                {s.email} • الحالة:{' '}
                                <strong
                                  className={
                                    s.membershipStatus === 'approved'
                                      ? 'text-[#144734]'
                                      : s.membershipStatus === 'suspended'
                                        ? 'text-[#7F2323]'
                                        : 'text-[#94721B]'
                                  }
                                >
                                  {s.membershipStatus === 'approved'
                                    ? 'معتمد ✓'
                                    : s.membershipStatus === 'suspended'
                                      ? 'موقوف ✕'
                                      : 'قيد المراجعة ⏳'}
                                </strong>
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {(s.membershipStatus !== 'approved' || (challenge.id && s.challengeMembershipStatus !== 'approved')) && (
                                <button
                                  type="button"
                                  onClick={() => handleAdminSetMemberStatus(s.id, 'approved')}
                                  className="px-3 py-1.5 rounded-xl bg-[#144734] hover:bg-[#0D3123] text-white text-xs font-bold transition"
                                >
                                  قبول وتفعيل
                                </button>
                              )}
                              {s.membershipStatus !== 'suspended' && (
                                <button
                                  type="button"
                                  onClick={() => handleAdminSetMemberStatus(s.id, 'suspended')}
                                  className="px-3 py-1.5 rounded-xl bg-[#FDF2F2] hover:bg-[#FBE8E8] text-[#7F2323] border border-[#F5C2C2] text-xs font-bold transition"
                                >
                                  إيقاف
                                </button>
                              )}
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                </section>

                <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <form
                    onSubmit={handleAdminSaveChallenge}
                    className="bg-white rounded-3xl p-6 border border-[#E6DEC8] space-y-3"
                  >
                    <h3 className="text-base font-bold text-[#162921]">إعدادات التحدي وتاريخ البدء</h3>
                    <div>
                      <label className="block text-xs font-semibold text-[#162921] mb-1">
                        عنوان التحدي
                      </label>
                      <input
                        type="text"
                        required
                        disabled={!challenge.id}
                        value={cfgTitle}
                        onChange={(e) => { configDirty.current = true; setCfgTitle(e.target.value); }}
                        placeholder="تعالَ نؤمن ساعة"
                        className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#162921] mb-1">
                        تاريخ البدء (بتوقيت دمشق)
                      </label>
                      <input
                        type="date"
                        disabled={!challenge.id}
                        value={cfgStartDate}
                        onChange={(e) => { configDirty.current = true; setCfgStartDate(e.target.value); }}
                        className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={!challenge.id}
                      className="w-full min-h-[44px] rounded-xl bg-[#144734] hover:bg-[#0D3123] text-white text-xs font-bold transition"
                    >
                      حفظ إعدادات التحدي
                    </button>
                  </form>

                  <div className="bg-white rounded-3xl p-6 border border-[#E6DEC8] space-y-3">
                    <h3 className="text-base font-bold text-[#162921]">
                      أرشفة الدورة الحالية وفتح دورة جديدة
                    </h3>
                    <div>
                      <label className="block text-xs font-semibold text-[#162921] mb-1">
                        عنوان الدورة الجديدة
                      </label>
                      <input
                        type="text"
                        value={newChallengeTitle}
                        onChange={(e) => setNewChallengeTitle(e.target.value)}
                        placeholder="تعالَ نؤمن ساعة — الدورة التالية"
                        className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-[#162921] mb-1">
                        تاريخ بدء الدورة الجديدة
                      </label>
                      <input
                        type="date"
                        value={newChallengeStartDate}
                        onChange={(e) => setNewChallengeStartDate(e.target.value)}
                        className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm focus:outline-none focus:ring-2 focus:ring-[#144734]"
                      />
                    </div>
                    {!showArchiveConfirm ? (
                      <button
                        type="button"
                        onClick={() => setShowArchiveConfirm(true)}
                        className="w-full min-h-[44px] rounded-xl bg-[#FAF7F0] text-[#144734] border border-[#144734]/30 text-xs font-bold hover:bg-[#EAF3EE] transition"
                      >
                        أرشفة الدورة الحالية وفتح دورة جديدة
                      </button>
                    ) : (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={handleAdminArchiveChallenge}
                          className="w-full min-h-[44px] rounded-xl bg-[#144734] hover:bg-[#0D3123] text-white text-xs font-bold transition"
                        >
                          تأكيد الأرشفة وإنشاء الدورة الجديدة
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowArchiveConfirm(false)}
                          className="w-full min-h-[38px] rounded-xl bg-[#FAF7F0] text-[#5B6E65] border border-[#E6DEC8] text-xs font-semibold hover:bg-[#F3EDE0] transition"
                        >
                          إلغاء والتراجع
                        </button>
                      </div>
                    )}
                  </div>
                </section>
              </div>
            )}
          </div>
        )}
        </>}
        </fieldset>
      </main>
    </div>
  );
}
