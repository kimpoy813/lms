// Institution-wide settings. Defaults live here; an administrator can override any of them and
// the override is stored in the SystemSetting table. Reads are served from a short-lived cache.
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { isValidTimeZone } from '../lib/time.js';
import { fieldErrors } from '../lib/errors.js';
import { mailAvailable } from './mail.js';

const int = (min, max) => z.number().int().min(min).max(max);

/**
 * key → { default, schema, public, group, label, help }
 * `public: true` settings are sent to every signed-in client (and the sign-in page).
 */
export const SETTING_DEFINITIONS = {
  'institution.name': {
    default: 'EduSphere University', schema: z.string().trim().min(1).max(120), public: true,
    group: 'Institution', label: 'Institution name',
  },
  'institution.timezone': {
    default: 'Asia/Manila', schema: z.string().refine(isValidTimeZone, 'Unknown IANA timezone'), public: true,
    group: 'Institution', label: 'Timezone', help: 'IANA name, e.g. Asia/Manila. Decides "today" for attendance and schedules.',
  },
  'registration.allowStudentSelfSignup': {
    default: true, schema: z.boolean(), public: true,
    group: 'Accounts', label: 'Students may create their own accounts',
  },
  'registration.allowTeacherSelfSignup': {
    default: false, schema: z.boolean(), public: true,
    group: 'Accounts', label: 'Teachers may request an account', help: 'Requests stay pending until an administrator approves them.',
  },
  'registration.requireEmailVerification': {
    default: false, schema: z.boolean(), public: true,
    group: 'Accounts', label: 'Require e-mail verification before first sign-in', help: 'Needs a working SMTP configuration.',
  },
  'security.maxFailedLogins': {
    default: 5, schema: int(3, 20), group: 'Security', label: 'Failed sign-ins before temporary lockout',
  },
  'security.lockoutMinutes': {
    default: 15, schema: int(1, 1440), group: 'Security', label: 'Lockout duration (minutes)',
  },
  'attendance.defaultRadiusMeters': {
    default: 50, schema: int(5, 5000), public: true, group: 'Attendance', label: 'Default geofence radius (m)',
  },
  'attendance.minRadiusMeters': {
    default: 10, schema: int(5, 5000), public: true, group: 'Attendance', label: 'Smallest radius a teacher may set (m)',
  },
  'attendance.maxRadiusMeters': {
    default: 300, schema: int(5, 5000), public: true, group: 'Attendance', label: 'Largest radius a teacher may set (m)',
  },
  'attendance.maxAccuracyMeters': {
    default: 100, schema: int(5, 2000), public: true, group: 'Attendance', label: 'Least accurate GPS reading accepted (m)',
    help: 'Readings with a larger uncertainty are rejected and the student is asked to try again.',
  },
  'attendance.qrRotationSeconds': {
    default: 20, schema: z.number().int().refine((n) => n === 0 || (n >= 15 && n <= 60), 'Use 0 (no rotation) or 15–60 seconds'),
    public: true, group: 'Attendance', label: 'QR code rotation interval (s)', help: '0 keeps one QR code for the whole session.',
  },
  'attendance.locationRetentionDays': {
    default: 180, schema: int(1, 3650), group: 'Attendance', label: 'Keep location verification data for (days)',
    help: 'After this period distances, accuracy values and check-in attempts are erased. Attendance statuses are kept.',
  },
  'grading.allowAttendanceInGrades': {
    default: false, schema: z.boolean(), public: true, group: 'Grading', label: 'Attendance may count toward grades',
  },
  'privacy.classmatesVisibleDefault': {
    default: true, schema: z.boolean(), group: 'Privacy', label: 'New classes show the class list to students',
  },
  'analytics.atRiskGradeBelow': {
    default: 75, schema: z.number().min(0).max(100), public: true, group: 'At-risk indicators', label: 'Flag when the running grade is below (%)',
  },
  'analytics.atRiskAttendanceBelow': {
    default: 80, schema: z.number().min(0).max(100), public: true, group: 'At-risk indicators', label: 'Flag when attendance is below (%)',
  },
  'analytics.atRiskMissingAtLeast': {
    default: 2, schema: int(1, 50), public: true, group: 'At-risk indicators', label: 'Flag when missing submissions reach',
  },
  'programming.runPythonInBrowser': {
    default: true, schema: z.boolean(), public: true, group: 'Programming', label: 'Try Python programs in the student’s browser',
    help: '“Run sample tests” and “Try my own input” then run a Python program on the student’s own device and use nothing of the code runner’s allowance. Programs the browser cannot run faithfully still go to the server, and so does every submission that counts.',
  },
  'ai.dailyRequestLimit': {
    default: 30, schema: int(0, 1000), group: 'AI', label: 'AI requests per teacher per day', help: '0 disables AI features.',
  },
  'email.notificationsEnabled': {
    default: false, schema: z.boolean(), group: 'E-mail', label: 'Send e-mail notifications to users who opted in', help: 'Needs a working SMTP configuration.',
  },
};

const CACHE_TTL_MS = 10_000;
let cache = null;
let cachedAt = 0;

export function invalidateSettings() {
  cache = null;
}

/** All settings as a plain object (defaults merged with stored overrides). */
export async function getSettings() {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  const rows = await prisma.systemSetting.findMany();
  const values = {};
  for (const [key, def] of Object.entries(SETTING_DEFINITIONS)) values[key] = def.default;
  for (const row of rows) {
    const def = SETTING_DEFINITIONS[row.key];
    if (!def) continue;
    const parsed = def.schema.safeParse(row.value);
    if (parsed.success) values[row.key] = parsed.data;
  }
  cache = values;
  cachedAt = Date.now();
  return values;
}

export async function getSetting(key) {
  return (await getSettings())[key];
}

export async function getTimeZone() {
  return getSetting('institution.timezone');
}

export async function getPublicSettings() {
  const all = await getSettings();
  return Object.fromEntries(Object.entries(all).filter(([key]) => SETTING_DEFINITIONS[key].public));
}

/** Validate and persist a partial update. Returns the new full settings map. */
export async function updateSettings(updates, userId) {
  const errors = {};
  const clean = {};
  for (const [key, value] of Object.entries(updates)) {
    const def = SETTING_DEFINITIONS[key];
    if (!def) {
      errors[key] = 'Unknown setting';
      continue;
    }
    const parsed = def.schema.safeParse(value);
    if (!parsed.success) errors[key] = parsed.error.issues[0]?.message ?? 'Invalid value';
    else clean[key] = parsed.data;
  }
  const current = await getSettings();
  const next = { ...current, ...clean };
  // Switching these on without e-mail would promise messages that never arrive; the first one
  // would also keep every new student out. (Leaving one on that already is on stays possible.)
  if (!mailAvailable()) {
    for (const key of ['registration.requireEmailVerification', 'email.notificationsEnabled']) {
      if (clean[key] === true && current[key] !== true) errors[key] = 'This server cannot send e-mail yet. Set up SMTP first (see the deployment guide).';
    }
  }
  if (next['attendance.minRadiusMeters'] > next['attendance.maxRadiusMeters']) {
    errors['attendance.minRadiusMeters'] = 'The smallest radius cannot exceed the largest radius.';
  }
  const def = next['attendance.defaultRadiusMeters'];
  if (def < next['attendance.minRadiusMeters'] || def > next['attendance.maxRadiusMeters']) {
    errors['attendance.defaultRadiusMeters'] = 'The default radius must lie between the smallest and largest radius.';
  }
  if (Object.keys(errors).length > 0) throw fieldErrors(errors);

  await prisma.$transaction(
    Object.entries(clean).map(([key, value]) =>
      prisma.systemSetting.upsert({
        where: { key },
        create: { key, value, updatedById: userId },
        update: { value, updatedById: userId },
      }),
    ),
  );
  invalidateSettings();
  return getSettings();
}
