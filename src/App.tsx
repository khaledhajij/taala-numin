import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AlertCircle,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Download,
  Flame,
  LogOut,
  Settings,
  ShieldAlert,
  Sparkles,
  Trophy,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { supabase, isSupabaseConfigured } from './lib/supabase';
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
    return 'يرجى تفعيل خيار إيقاف تأكيد البريد (Confirm email = OFF) من لوحة تحكم Supabase أو تأكيد الرسالة المرسلة لبريدك.';
  }
  return message;
}

export default function App() {
  const [loadingSession, setLoadingSession] = useState<boolean>(isSupabaseConfigured);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccessMsg, setAuthSuccessMsg] = useState<string | null>(null);
  const [authFormMode, setAuthFormMode] = useState<AuthFormMode>('sign_in');
  const [emailInput, setEmailInput] = useState<string>('');
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [authSubmitting, setAuthSubmitting] = useState<boolean>(false);

  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [damascusToday, setDamascusToday] = useState<string>(() =>
    getDamascusDateString(new Date())
  );

  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [challenge, setChallenge] = useState<ChallengeConfig>({
    id: 'default-challenge',
    title: 'تعالَ نؤمن ساعة',
    communityName: 'حلقة سيدنا أبو بكر الصديق',
    startDate: null,
    durationDays: 30,
    collectiveGoalPct: 80,
    isArchived: false,
  });

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
  const [newChallengeTitle, setNewChallengeTitle] = useState<string>(
    'تعالَ نؤمن ساعة — الدورة التالية'
  );
  const [newChallengeStartDate, setNewChallengeStartDate] = useState<string>('');
  const [showArchiveConfirm, setShowArchiveConfirm] = useState<boolean>(false);

  const fetchBootstrapData = useCallback(async () => {
    if (!supabase) return;
    setLoadingSession(true);
    try {
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr) throw sessionErr;

      const user = sessionData.session?.user;
      if (!user) {
        setSessionUserId(null);
        setSessionEmail(null);
        setProfile(null);
        setIsAdmin(false);
        return;
      }

      setSessionUserId(user.id);
      setSessionEmail(user.email ?? null);

      const { data: boot, error: bootErr } = await supabase.rpc('get_session_bootstrap');
      if (bootErr) throw bootErr;

      if (boot) {
        const callerIsAdmin = Boolean(boot.is_admin);
        setIsAdmin(callerIsAdmin);
        if (boot.damascus_today) setDamascusToday(boot.damascus_today);

        const activeChallengeId = boot.current_challenge?.id;
        if (boot.current_challenge) {
          const ch: ChallengeConfig = {
            id: boot.current_challenge.id,
            title: boot.current_challenge.title,
            communityName: boot.current_challenge.community_name,
            startDate: boot.current_challenge.start_date,
            durationDays: boot.current_challenge.duration_days,
            collectiveGoalPct: boot.current_challenge.collective_goal_pct,
            isArchived: boot.current_challenge.is_archived,
          };
          setChallenge(ch);
          setCfgTitle(ch.title);
          setCfgStartDate(ch.startDate ?? '');
          setCfgDuration(ch.durationDays);
        }

        if (boot.profile) {
          const p: StudentProfile = {
            id: boot.profile.id,
            email: boot.profile.email,
            adminKnownName: boot.profile.admin_known_name,
            publicDisplayName: boot.profile.public_display_name,
            leaderboardOptIn: boot.profile.leaderboard_opt_in,
            membershipStatus: boot.profile.membership_status,
            statusReason: boot.profile.status_reason,
            statusUpdatedAt: new Date().toISOString(),
          };
          setProfile(p);
          setAdminKnownNameInput(p.adminKnownName);
          setPublicDisplayNameInput(p.publicDisplayName);
          setLeaderboardOptInInput(p.leaderboardOptIn);

          if ((p.membershipStatus === 'approved' || callerIsAdmin) && activeChallengeId) {
            const [{ data: recs }, { data: lbData }] = await Promise.all([
              supabase
                .from('daily_achievements')
                .select('*')
                .eq('challenge_id', activeChallengeId)
                .eq('student_id', user.id),
              supabase.rpc('get_leaderboard_and_group_stats', {
                p_challenge_id: activeChallengeId,
              }),
            ]);

            if (recs) {
              setMyAchievements(
                recs.map((r: Record<string, unknown>) => ({
                  id: String(r.id),
                  challengeId: String(r.challenge_id),
                  studentId: String(r.student_id),
                  achievementDate: String(r.achievement_date),
                  quranTwoPages: Boolean(r.quran_two_pages),
                  ishaCongregation: Boolean(r.isha_congregation),
                  morningAdhkar: Boolean(r.morning_adhkar),
                  points: Number(r.points ?? 0),
                  revision: Number(r.revision ?? 1),
                  updatedAt: String(r.updated_at ?? ''),
                }))
              );
            }

            if (lbData) {
              setServerLeaderboard({
                elapsedDays: Number(lbData.elapsed_days ?? 0),
                currentWeekNum: Number(lbData.current_week_num ?? 1),
                collectiveGoalPct: Number(lbData.collective_goal_pct ?? 80),
                approvedStudentCount: Number(lbData.approved_student_count ?? 0),
                groupTotalPoints: Number(lbData.group_total_points ?? 0),
                groupAvailablePoints: Number(lbData.group_available_points ?? 0),
                groupCompletionPct: Number(lbData.group_completion_pct ?? 0),
                overallRankings: lbData.overall_rankings ?? [],
                weeklyRankings: lbData.weekly_rankings ?? [],
                mySummary: lbData.my_summary ?? null,
              });
            }
          }
        } else {
          setProfile(null);
        }

        if (callerIsAdmin && activeChallengeId) {
          const [{ data: allProfs }, { data: allRecs }] = await Promise.all([
            supabase.from('profiles').select('*').order('created_at', { ascending: true }),
            supabase
              .from('daily_achievements')
              .select('*')
              .eq('challenge_id', activeChallengeId),
          ]);
          if (allProfs) {
            setAllProfilesForAdmin(
              allProfs.map((p: Record<string, unknown>) => ({
                id: String(p.id),
                email: String(p.email),
                adminKnownName: String(p.admin_known_name),
                publicDisplayName: String(p.public_display_name),
                leaderboardOptIn: Boolean(p.leaderboard_opt_in),
                membershipStatus: p.membership_status as MembershipStatus,
                statusReason: (p.status_reason as string) ?? null,
                statusUpdatedAt: String(p.status_updated_at ?? ''),
              }))
            );
          }
          if (allRecs) {
            setAllAchievementsForAdmin(
              allRecs.map((r: Record<string, unknown>) => ({
                id: String(r.id),
                challengeId: String(r.challenge_id),
                studentId: String(r.student_id),
                achievementDate: String(r.achievement_date),
                quranTwoPages: Boolean(r.quran_two_pages),
                ishaCongregation: Boolean(r.isha_congregation),
                morningAdhkar: Boolean(r.morning_adhkar),
                points: Number(r.points ?? 0),
                revision: Number(r.revision ?? 1),
                updatedAt: String(r.updated_at ?? ''),
              }))
            );
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'حدث خطأ أثناء الاتصال بالخادم.';
      setAuthError(translateAuthError(msg));
    } finally {
      setLoadingSession(false);
    }
  }, []);

  useEffect(() => {
    if (!supabase) return;
    fetchBootstrapData();
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      fetchBootstrapData();
    });
    return () => sub.subscription.unsubscribe();
  }, [fetchBootstrapData]);

  const savedToday = useMemo(
    () => myAchievements.find((a) => a.achievementDate === damascusToday) ?? null,
    [myAchievements, damascusToday]
  );

  useEffect(() => {
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
  }, [savedToday]);

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
      ['hajij94@gmail.com', ...(isAdmin && sessionEmail ? [sessionEmail] : [])],
      allAchievementsForAdmin,
      sessionUserId,
      damascusToday
    );
  }, [
    challenge,
    allProfilesForAdmin,
    isAdmin,
    sessionEmail,
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
        'لم يتم ضبط متغيرات البيئة VITE_SUPABASE_URL و VITE_SUPABASE_ANON_KEY بعد. يرجى إضافتها في إعدادات الاستضافة (Vercel / Netlify) أو في ملف .env.local.'
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
        if (
          adminKnownNameInput.trim().length < 2 ||
          publicDisplayNameInput.trim().length < 2
        ) {
          setAuthError(
            'يرجى إدخال الاسم الكامل لدى المشرف والاسم الظاهر في اللوحة (حرفان على الأقل).'
          );
          setAuthSubmitting(false);
          return;
        }

        const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
          email: cleanEmail,
          password: passwordInput,
        });
        if (signUpErr) throw signUpErr;

        if (signUpData.session) {
          // Immediately create the student's profile row via RPC
          const { error: profErr } = await supabase.rpc('upsert_my_profile', {
            p_admin_known_name: adminKnownNameInput.trim(),
            p_public_display_name: publicDisplayNameInput.trim(),
            p_leaderboard_opt_in: leaderboardOptInInput,
          });
          if (profErr) throw profErr;
          await fetchBootstrapData();
        } else {
          setAuthSuccessMsg(
            'تم إنشاء الحساب! إذا كان تأكيد البريد مفعلاً، يرجى فتح الرسالة المرسلة إلى بريدك الإلكتروني، أو إيقاف Confirm Email من لوحة Supabase ثم تسجيل الدخول.'
          );
          setAuthFormMode('sign_in');
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'تعذّر إتمام المصادقة.';
      setAuthError(translateAuthError(msg));
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    setSessionUserId(null);
    setProfile(null);
  };

  const handleUpsertProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setProfileFeedback(null);
    const { data, error } = await supabase.rpc('upsert_my_profile', {
      p_admin_known_name: adminKnownNameInput.trim(),
      p_public_display_name: publicDisplayNameInput.trim(),
      p_leaderboard_opt_in: leaderboardOptInInput,
    });
    if (error) {
      setProfileFeedback({ type: 'error', text: error.message });
      return;
    }
    if (data) {
      setProfileFeedback({
        type: 'success',
        text: 'تم حفظ بيانات الملف الشخصي وإعدادات الخصوصية بنجاح.',
      });
      await fetchBootstrapData();
    }
  };

  const handleSaveToday = async () => {
    if (!supabase) return;
    setSaveStatus('saving');
    setSaveFeedback(null);

    const { data, error } = await supabase.rpc('save_today_achievement', {
      p_challenge_id: challenge.id,
      p_target_date: damascusToday,
      p_quran_two_pages: draft.quranTwoPages,
      p_isha_congregation: draft.ishaCongregation,
      p_morning_adhkar: draft.morningAdhkar,
      p_expected_revision: loadedRevision,
    });

    if (error) {
      setSaveStatus('error');
      setSaveFeedback(error.message);
      return;
    }

    if (data) {
      setSaveStatus('success');
      setSaveFeedback('تم حفظ إنجاز اليوم بنجاح. يمكنك التعديل حتى منتصف الليل بتوقيت دمشق.');
      await fetchBootstrapData();
    }
  };

  const handleAdminSetMemberStatus = async (
    studentId: string,
    newStatus: MembershipStatus
  ) => {
    if (!supabase || !isAdmin) return;
    setAdminBanner(null);
    const { error } = await supabase.rpc('admin_set_membership_status', {
      p_student_id: studentId,
      p_challenge_id: challenge.id,
      p_new_status: newStatus,
      p_reason: newStatus === 'suspended' ? 'إيقاف مؤقت من مشرف الحلقة' : null,
    });
    if (error) {
      setAdminBanner({ type: 'error', text: error.message });
      return;
    }
    setAdminBanner({
      type: 'success',
      text: 'تم تحديث حالة العضوية بنجاح ويسري التغيير فوراً.',
    });
    await fetchBootstrapData();
  };

  const handleAdminSaveChallenge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !isAdmin) return;
    setAdminBanner(null);
    const { error } = await supabase.rpc('admin_configure_challenge', {
      p_challenge_id: challenge.id,
      p_title: cfgTitle.trim(),
      p_start_date: cfgStartDate.trim() || null,
      p_duration_days: cfgDuration,
    });
    if (error) {
      setAdminBanner({ type: 'error', text: error.message });
      return;
    }
    setAdminBanner({ type: 'success', text: 'تم حفظ إعدادات التحدي بنجاح.' });
    await fetchBootstrapData();
  };

  const handleAdminArchiveChallenge = async () => {
    if (!supabase || !isAdmin) return;
    setAdminBanner(null);
    const { error } = await supabase.rpc('admin_archive_and_create_challenge', {
      p_current_challenge_id: challenge.id,
      p_new_title: newChallengeTitle.trim() || 'تعالَ نؤمن ساعة',
      p_new_start_date: newChallengeStartDate.trim() || null,
      p_new_duration_days: 30,
    });
    if (error) {
      setAdminBanner({ type: 'error', text: error.message });
      return;
    }
    setShowArchiveConfirm(false);
    setAdminBanner({
      type: 'success',
      text: 'تمت أرشفة التحدي الحالي مع الاحتفاظ بجميع السجلات، وتم فتح الدورة الجديدة بنجاح.',
    });
    await fetchBootstrapData();
  };

  const handleAdminExportCsv = () => {
    if (!isAdmin) return;
    const rows = allProfilesForAdmin
      .filter((p) => p.email.toLowerCase() !== 'hajij94@gmail.com')
      .map((p) => {
        const recs = allAchievementsForAdmin.filter((a) => a.studentId === p.id);
        const totalPoints = recs.reduce((s, r) => s + computeActivityPoints(r), 0);
        const avail = windowInfo.elapsedDays * 3;
        const completionPct =
          avail > 0 ? Number(((totalPoints * 100) / avail).toFixed(1)) : 0;
        const streakDays = calculateStreakDays(challenge, recs, damascusToday);
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
    a.download = `تقرير-حلقة-أبي-بكر-الصديق-${damascusToday}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

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
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#FDF2F2] text-[#7F2323] border border-[#F5C2C2] text-xs font-semibold"
              >
                <LogOut className="w-4 h-4" />
                <span>خروج</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6 pb-20">
        {!sessionUserId ? (
          <section className="max-w-2xl mx-auto bg-white rounded-3xl p-6 sm:p-8 border border-[#E6DEC8] shadow-sm space-y-6">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#EAF3EE] text-[#144734] text-xs font-semibold mb-3">
                <Sparkles className="w-3.5 h-3.5 text-[#B8922A]" />
                <span>حلقة سيدنا أبو بكر الصديق • برنامج تطوعي لمدة 30 يوماً</span>
              </div>
              <h2 className="text-2xl sm:text-3xl font-bold text-[#144734]">
                مرحباً بك في تحدي «تعالَ نؤمن ساعة»
              </h2>
              <p className="text-sm text-[#364940] mt-2 leading-relaxed">
                مساحة أخوية خاصة لطلاب الحلقة، نتعاون فيها على بناء عادات إيمانية يومية ثابتة مدتها{' '}
                <strong>30 يوماً</strong>. المشاركة <strong>تطوعية بالكامل</strong>، وغايتنا منها
                التشجيع المتبادل ودوام العمل وإن قلّ.
              </p>
              <blockquote className="mt-4 p-4 rounded-2xl bg-[#FAF7F0] border-r-4 border-[#B8922A] text-sm font-medium text-[#144734]">
                «{ENCOURAGEMENT_MOTTO}»
              </blockquote>
            </div>

            <div className="space-y-2.5">
              <h3 className="text-xs sm:text-sm font-bold text-[#162921]">
                الأنشطة اليومية الثلاثة (3 نقاط يومياً • 90 نقطة خلال 30 يوماً):
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
                    className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border border-[#D5CBB4] text-sm text-left"
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
                      className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border border-[#D5CBB4] text-sm text-left"
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
                        value={adminKnownNameInput}
                        onChange={(e) => setAdminKnownNameInput(e.target.value)}
                        placeholder="مثال: عبد الله بن مسعود"
                        className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-[#162921] mb-1">
                        الاسم المختار للظهور في لوحة الصدارة (كنية أو لقب)
                      </label>
                      <input
                        type="text"
                        required
                        value={publicDisplayNameInput}
                        onChange={(e) => setPublicDisplayNameInput(e.target.value)}
                        placeholder="مثال: أبو عبد الرحمن"
                        className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                      />
                    </div>

                    <label className="flex items-start gap-2.5 p-3.5 rounded-2xl bg-[#FAF7F0] border border-[#E6DEC8] text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={leaderboardOptInInput}
                        onChange={(e) => setLeaderboardOptInInput(e.target.checked)}
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
            <form onSubmit={handleUpsertProfile} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold mb-1">
                  الاسم الكامل المعروف لدى المشرف
                </label>
                <input
                  type="text"
                  required
                  value={adminKnownNameInput}
                  onChange={(e) => setAdminKnownNameInput(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1">
                  الاسم المختار للظهور في لوحة الصدارة
                </label>
                <input
                  type="text"
                  required
                  value={publicDisplayNameInput}
                  onChange={(e) => setPublicDisplayNameInput(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                />
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={leaderboardOptInInput}
                  onChange={(e) => setLeaderboardOptInInput(e.target.checked)}
                />
                <span>الظهور الاختياري في لوحة الصدارة العامة</span>
              </label>
              <button
                type="submit"
                className="w-full min-h-[48px] rounded-xl bg-[#144734] text-white font-bold text-sm"
              >
                إرسال طلب الانضمام
              </button>
            </form>
          </section>
        ) : profile.membershipStatus === 'pending' && !isAdmin ? (
          <section className="max-w-xl mx-auto bg-white rounded-3xl p-6 border border-[#D4AF37] space-y-4">
            <div className="flex items-center gap-2 text-[#94721B] font-bold">
              <Clock className="w-5 h-5" />
              <h2>طلب انضمامك قيد المراجعة من مشرف الحلقة</h2>
            </div>
            <p className="text-xs text-[#4A5D54] leading-relaxed">
              أهلاً بك يا <strong>{profile.adminKnownName}</strong>. لحين موافقة المشرف على عضويتك،
              لا يمكنك قراءة بيانات المشاركين أو لوحة الصدارة أو تسجيل الإنجازات، ولكن يمكنك تعديل
              ملفك الشخصي أدناه في أي وقت.
            </p>
            {profileFeedback && (
              <div className="p-3 rounded-xl bg-[#EAF3EE] text-[#144734] text-xs">
                {profileFeedback.text}
              </div>
            )}
            <form onSubmit={handleUpsertProfile} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold mb-1">الاسم لدى المشرف</label>
                <input
                  type="text"
                  value={adminKnownNameInput}
                  onChange={(e) => setAdminKnownNameInput(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1">الاسم الظاهر في اللوحة</label>
                <input
                  type="text"
                  value={publicDisplayNameInput}
                  onChange={(e) => setPublicDisplayNameInput(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                />
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={leaderboardOptInInput}
                  onChange={(e) => setLeaderboardOptInInput(e.target.checked)}
                />
                <span>الظهور في لوحة الصدارة بعد التفعيل</span>
              </label>
              <button
                type="submit"
                className="w-full min-h-[44px] rounded-xl bg-[#144734] text-white font-bold text-xs"
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
                    className={`flex-1 min-w-[74px] min-h-[44px] px-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 ${
                      activeTab === t.id ? 'bg-[#144734] text-white' : 'text-[#364940]'
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
                      <h2 className="text-xl font-bold text-[#144734]">{profile.adminKnownName}</h2>
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
                      <span className="px-4 py-2 rounded-2xl bg-[#FBF6E8] text-[#94721B] text-xs font-bold">
                        {challenge.startDate
                          ? `يبدأ التحدي في ${challenge.startDate}`
                          : 'بانتظار تحديد تاريخ البدء من المشرف'}
                      </span>
                    )}
                  </div>

                  {hasUnsavedChanges && (
                    <div className="p-3.5 rounded-xl bg-[#FBF6E8] border border-[#D4AF37] text-xs font-semibold text-[#7A5C12]">
                      لديك تغييرات غير محفوظة — اضغط على زر «حفظ إنجاز اليوم» لتأكيدها.
                    </div>
                  )}

                  <div className="space-y-3">
                    {DAILY_ACTIVITIES_META.map((act) => {
                      const checked = draft[act.key];
                      const disabled = windowInfo.state !== 'active';
                      return (
                        <button
                          key={act.key}
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            setDraft((prev) => ({ ...prev, [act.key]: !prev[act.key] }));
                            setSaveStatus('idle');
                          }}
                          className={`w-full text-right p-4 rounded-2xl border-2 flex items-center justify-between gap-3 transition ${
                            checked
                              ? 'bg-[#EAF3EE]/70 border-[#144734]'
                              : 'bg-[#FAF7F0]/60 border-[#E6DEC8]'
                          } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
                        >
                          <div>
                            <p className="font-bold text-sm sm:text-base text-[#162921]">
                              {act.title}
                            </p>
                            <p className="text-xs text-[#5B6E65] mt-0.5">{act.subtitle}</p>
                          </div>
                          <div
                            className={`w-7 h-7 rounded-xl flex items-center justify-center border-2 ${
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
                      className={`p-3.5 rounded-xl text-xs ${
                        saveStatus === 'success'
                          ? 'bg-[#EAF3EE] text-[#144734]'
                          : 'bg-[#FDF2F2] text-[#7F2323]'
                      }`}
                    >
                      {saveFeedback}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleSaveToday}
                    disabled={saveStatus === 'saving' || windowInfo.state !== 'active'}
                    className="w-full min-h-[50px] rounded-2xl bg-[#144734] hover:bg-[#0D3123] disabled:opacity-50 text-white font-bold text-sm transition"
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
                      {dashboardMetrics.currentWeekPoints} / 21
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
                  <h3 className="text-base font-bold text-[#162921]">تقويم الـ 30 يوماً</h3>
                  <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
                    {dashboardMetrics.calendarDays.map((day) => (
                      <button
                        key={day.dayNumber}
                        type="button"
                        onClick={() => setSelectedDayNum(day.dayNumber)}
                        className={`min-h-[52px] rounded-xl border p-1.5 flex flex-col items-center justify-center text-xs ${
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
                      className="h-full bg-[#144734] rounded-full"
                      style={{
                        width: `${Math.min(100, serverLeaderboard?.groupCompletionPct ?? 0)}%`,
                      }}
                    />
                  </div>
                </section>

                <section className="bg-white rounded-3xl p-6 border border-[#E6DEC8] space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold text-[#162921]">لوحة التشجيع والمواظبة</h3>
                    <div className="inline-flex rounded-xl bg-[#FAF7F0] p-1 border border-[#E6DEC8]">
                      <button
                        type="button"
                        onClick={() => setLeaderboardScope('overall')}
                        className={`px-3 py-1 rounded-lg text-xs font-bold ${
                          leaderboardScope === 'overall' ? 'bg-[#144734] text-white' : ''
                        }`}
                      >
                        الترتيب العام
                      </button>
                      <button
                        type="button"
                        onClick={() => setLeaderboardScope('weekly')}
                        className={`px-3 py-1 rounded-lg text-xs font-bold ${
                          leaderboardScope === 'weekly' ? 'bg-[#144734] text-white' : ''
                        }`}
                      >
                        الأسبوع الحالي
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {leaderboardScope === 'overall'
                      ? (serverLeaderboard?.overallRankings ?? []).map((r, i) => (
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
                      : (serverLeaderboard?.weeklyRankings ?? []).map((r, i) => (
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
                        ))}
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
                      value={adminKnownNameInput}
                      onChange={(e) => setAdminKnownNameInput(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1">
                      الاسم المختار للظهور في لوحة الصدارة
                    </label>
                    <input
                      type="text"
                      required
                      value={publicDisplayNameInput}
                      onChange={(e) => setPublicDisplayNameInput(e.target.value)}
                      className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={leaderboardOptInInput}
                      onChange={(e) => setLeaderboardOptInInput(e.target.checked)}
                    />
                    <span>الظهور الاختياري في لوحة الصدارة العامة</span>
                  </label>
                  <button
                    type="submit"
                    className="w-full min-h-[46px] rounded-xl bg-[#144734] text-white font-bold text-xs"
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
                    <h2 className="text-lg font-bold text-[#144734]">
                      لوحة مشرف الحلقة ({adminComputedStats.groupCompletionPct}% إنجاز جماعي)
                    </h2>
                    <button
                      type="button"
                      onClick={handleAdminExportCsv}
                      className="px-4 py-2 rounded-xl bg-[#144734] text-white text-xs font-bold flex items-center gap-1.5"
                    >
                      <Download className="w-4 h-4 text-[#D4AF37]" />
                      <span>تصدير CSV آمن</span>
                    </button>
                  </div>

                  <div className="space-y-2.5">
                    {allProfilesForAdmin
                      .filter((p) => p.email.toLowerCase() !== 'hajij94@gmail.com')
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
                              {s.email} • الحالة: <strong>{s.membershipStatus}</strong>
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            {s.membershipStatus !== 'approved' && (
                              <button
                                type="button"
                                onClick={() => handleAdminSetMemberStatus(s.id, 'approved')}
                                className="px-3 py-1.5 rounded-xl bg-[#144734] text-white text-xs font-bold"
                              >
                                قبول وتفعيل
                              </button>
                            )}
                            {s.membershipStatus !== 'suspended' && (
                              <button
                                type="button"
                                onClick={() => handleAdminSetMemberStatus(s.id, 'suspended')}
                                className="px-3 py-1.5 rounded-xl bg-[#FDF2F2] text-[#7F2323] border border-[#F5C2C2] text-xs font-bold"
                              >
                                إيقاف
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                </section>

                <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <form
                    onSubmit={handleAdminSaveChallenge}
                    className="bg-white rounded-3xl p-6 border border-[#E6DEC8] space-y-3"
                  >
                    <h3 className="text-base font-bold text-[#162921]">إعدادات التحدي وتاريخ البدء</h3>
                    <input
                      type="text"
                      value={cfgTitle}
                      onChange={(e) => setCfgTitle(e.target.value)}
                      className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                    />
                    <input
                      type="date"
                      value={cfgStartDate}
                      onChange={(e) => setCfgStartDate(e.target.value)}
                      className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                    />
                    <button
                      type="submit"
                      className="w-full min-h-[44px] rounded-xl bg-[#144734] text-white text-xs font-bold"
                    >
                      حفظ إعدادات التحدي
                    </button>
                  </form>

                  <div className="bg-white rounded-3xl p-6 border border-[#E6DEC8] space-y-3">
                    <h3 className="text-base font-bold text-[#162921]">
                      أرشفة الدورة الحالية وفتح دورة جديدة
                    </h3>
                    <input
                      type="text"
                      value={newChallengeTitle}
                      onChange={(e) => setNewChallengeTitle(e.target.value)}
                      className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                    />
                    <input
                      type="date"
                      value={newChallengeStartDate}
                      onChange={(e) => setNewChallengeStartDate(e.target.value)}
                      className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[#D5CBB4] text-sm"
                    />
                    {!showArchiveConfirm ? (
                      <button
                        type="button"
                        onClick={() => setShowArchiveConfirm(true)}
                        className="w-full min-h-[44px] rounded-xl bg-[#FAF7F0] text-[#144734] border border-[#144734]/30 text-xs font-bold"
                      >
                        أرشفة الدورة الحالية وفتح دورة جديدة
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleAdminArchiveChallenge}
                        className="w-full min-h-[44px] rounded-xl bg-[#144734] text-white text-xs font-bold"
                      >
                        تأكيد الأرشفة وإنشاء الدورة الجديدة
                      </button>
                    )}
                  </div>
                </section>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
