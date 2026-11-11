import { Router } from 'express';
import { z } from 'zod';
import { exportFormat, sendTable } from '../../lib/exporter.js';
import { idParams, ok } from '../../lib/http.js';
import { dateKey } from '../../lib/time.js';
import { assertPermission, requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../services/audit.js';
import { getTimeZone } from '../../services/settings.js';
import { classLabel, requireClassManager } from '../classes/access.js';
import { classAnalytics } from './service.js';

export const classAnalyticsRouter = Router({ mergeParams: true }); // /classes/:classId/analytics
classAnalyticsRouter.use(requireAuth);

classAnalyticsRouter.get('/', validate({ params: idParams('classId') }), async (req, res) => {
  const { cls } = await requireClassManager(req.user, req.valid.params.classId);
  ok(res, await classAnalytics(cls));
});

/** Class performance report: one row per student with grade, attendance, missing work and flags. */
classAnalyticsRouter.get('/export', validate({ params: idParams('classId'), query: z.object({ format: exportFormat }) }), async (req, res) => {
  const { cls } = await requireClassManager(req.user, req.valid.params.classId);
  await assertPermission(req.user, 'grades.export');
  const { format } = req.valid.query;
  const data = await classAnalytics(cls);
  const tz = await getTimeZone();
  await audit(req, { action: 'report.class.export', entityType: 'Class', entityId: cls.id, classId: cls.id, summary: `Exported the class performance report (${format.toUpperCase()})` });
  await sendTable(res, format, {
    filename: `report-${cls.course.code}${cls.section ? `-${cls.section.name}` : ''}`,
    title: `Class performance report — ${classLabel(cls)}`,
    subtitle: `${cls.course.title} · ${cls.semester.name}, ${cls.semester.academicYear.name}`,
    meta: [
      `${data.summary.students} student(s) · average grade ${data.summary.averageGrade ?? '—'}% · average attendance ${data.summary.averageAttendance ?? '—'}%`,
      `Flags: grade below ${data.thresholds.gradeBelow}%, attendance below ${data.thresholds.attendanceBelow}%, ${data.thresholds.missingAtLeast}+ missing · Generated ${dateKey(new Date(), tz)} (${tz})`,
    ],
    columns: [
      { header: 'Student No.', value: (s) => s.studentNumber ?? '', pdfWidth: 1.2 },
      { header: 'Name', value: (s) => s.name, width: 28, pdfWidth: 2.4 },
      { header: 'Grade %', value: (s) => s.percent ?? '', pdfWidth: 0.9, align: 'right' },
      { header: 'Grade', value: (s) => s.label ?? '', pdfWidth: 0.8, align: 'center' },
      { header: 'Attendance %', value: (s) => s.attendanceRate ?? '', width: 14, pdfWidth: 1.1, align: 'right' },
      { header: 'Absences', value: (s) => s.absences, pdfWidth: 0.9, align: 'right' },
      { header: 'Missing', value: (s) => s.missing, pdfWidth: 0.8, align: 'right' },
      { header: 'Indicators', value: (s) => s.risk.reasons.map((r) => r.text).join('; '), width: 50, pdfWidth: 3.6 },
    ],
    rows: [...data.students].sort((a, b) => a.name.localeCompare(b.name)),
    landscape: true,
    footer: 'Confidential student record — handle in accordance with the Data Privacy Act of 2012 (RA 10173).',
    summary: ['Indicators are rule-based flags for the teacher\'s attention, not a prediction or an official status.'],
  });
});
