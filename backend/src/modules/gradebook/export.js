// Shared tabular shape for the standard gradebook download and uploaded-template exports.
import { fieldErrors } from '../../lib/errors.js';
import { round } from '../../lib/http.js';
import { dateKey } from '../../lib/time.js';
import { classLabel } from '../classes/access.js';

/** Build the same columns and values regardless of whether the result is a new export or a filled template. */
export function gradebookExportTable(cls, data, { format, by, periodId, timeZone }) {
  const cell = (entry) => (!entry ? '' : entry.status === 'GRADED' ? entry.score : entry.status === 'MISSING' ? 'M' : entry.status === 'EXEMPT' ? 'EX' : '');
  const decimals = data.class.gradeRounding ?? 2;
  const wtd = (percent, weight) => (percent === null || percent === undefined || !(weight > 0) ? '' : round((percent * weight) / 100, decimals));

  let selectedPeriods = data.structure.periods;
  let scopedPeriod = null;
  if (periodId) {
    scopedPeriod = data.structure.periods.find((p) => p.id === periodId) ?? null;
    if (!scopedPeriod) throw fieldErrors({ periodId: 'Choose a grading period from this class.' });
    selectedPeriods = [scopedPeriod];
  }

  // A PDF page cannot hold one column per graded item, so item scores appear in CSV/XLSX while PDF uses weights or period summaries.
  const detailed = format !== 'pdf';
  const multiPeriod = selectedPeriods.length > 1;
  const hasDropped = data.students.some((s) => s.enrollmentStatus === 'DROPPED');

  const periodColumns = (p) => {
    const pPrefix = multiPeriod ? `${p.name} · ` : '';
    if (by === 'items') {
      return [
        ...(detailed
          ? p.categories.flatMap((c) => c.items.map((i) => ({ header: `${multiPeriod ? `${p.name} · ` : ''}${i.title} (${i.maxPoints})`, value: (s) => cell(s.entries[i.id]), width: 16, align: 'right' })))
          : []),
        ...(multiPeriod ? [{ header: `${p.name} %`, value: (s) => s.periods[p.id]?.percent ?? '', width: 12, pdfWidth: 1, align: 'right' }] : []),
      ];
    }
    const cols = [];
    for (const c of p.categories) {
      if (by === 'all' && detailed) {
        for (const i of c.items) {
          cols.push({ header: `${pPrefix}${i.title} (${i.maxPoints})`, value: (s) => cell(s.entries[i.id]), width: 16, align: 'right' });
        }
      }
      if (detailed) {
        cols.push({ header: `${pPrefix}${c.name} (${c.weight}%) %`, value: (s) => s.weightPeriods[p.id]?.categories[c.id]?.percent ?? '', width: 16, align: 'right' });
        if (c.weight > 0) {
          cols.push({ header: `${pPrefix}${c.name} Wtd (${c.weight}%)`, value: (s) => wtd(s.weightPeriods[p.id]?.categories[c.id]?.percent, c.weight), width: 17, align: 'right' });
        }
      } else {
        cols.push({
          header: `${pPrefix}${c.name} (${c.weight}%)`,
          value: (s) => {
            const cat = s.weightPeriods[p.id]?.categories[c.id];
            if (cat?.percent === null || cat?.percent === undefined) return '';
            return c.weight > 0 ? `${cat.percent}% (${wtd(cat.percent, c.weight)})` : `${cat.percent}%`;
          },
          width: 16,
          pdfWidth: 1.3,
          align: 'right',
        });
      }
    }
    if (multiPeriod) {
      if (detailed) {
        cols.push({ header: `${p.name} (${p.weight}%) %`, value: (s) => s.periods[p.id]?.percent ?? '', width: 15, align: 'right' });
        if (p.weight > 0) {
          cols.push({ header: `${p.name} Wtd (${p.weight}%)`, value: (s) => wtd(s.periods[p.id]?.percent, p.weight), width: 16, align: 'right' });
        }
      } else {
        cols.push({
          header: `${p.name} (${p.weight}%)`,
          value: (s) => {
            const pg = s.periods[p.id];
            if (pg?.percent === null || pg?.percent === undefined) return '';
            return p.weight > 0 ? `${pg.percent}% (${wtd(pg.percent, p.weight)})` : `${pg.percent}%`;
          },
          width: 16,
          pdfWidth: 1.25,
          align: 'right',
        });
      }
    }
    return cols;
  };

  const finalCell = (s) => (scopedPeriod ? s.periods[scopedPeriod.id] : s.overall);
  const columns = [
    { header: 'Student No.', value: (s) => s.studentNumber ?? '', pdfWidth: 1.3 },
    { header: 'Name', value: (s) => `${s.lastName}, ${s.firstName}`, width: 28, pdfWidth: 2.6 },
    ...(hasDropped ? [{ header: 'Status', value: (s) => (s.enrollmentStatus === 'DROPPED' ? 'Dropped' : 'Enrolled'), width: 11, pdfWidth: 1.0 }] : []),
    ...selectedPeriods.flatMap(periodColumns),
    { header: scopedPeriod ? `${scopedPeriod.name} (${scopedPeriod.weight}%) %` : 'Final %', value: (s) => finalCell(s)?.percent ?? '', width: 12, pdfWidth: 1, align: 'right' },
    { header: 'Grade', value: (s) => finalCell(s)?.label ?? '', width: 8, pdfWidth: 0.8, align: 'center' },
    { header: 'Remark', value: (s) => `${finalCell(s)?.remark ?? ''}${finalCell(s)?.isOverridden ? ' (override)' : ''}`, width: 16, pdfWidth: 1.3 },
  ];

  const modeTitle = by === 'weights' ? 'Grades by Weights' : by === 'all' ? 'Complete Grades & Weights' : 'Grades';
  const modeSlug = by === 'weights' ? 'grades-by-weights' : by === 'all' ? 'grades-complete' : 'grades';
  const periodSlug = scopedPeriod ? `-${scopedPeriod.name}` : '';
  const periodSuffixTitle = scopedPeriod ? ` · ${scopedPeriod.name} (${scopedPeriod.weight}%)` : '';
  const table = {
    filename: `${modeSlug}-${cls.course.code}${cls.section ? `-${cls.section.name}` : ''}${periodSlug}`,
    title: `${modeTitle} — ${classLabel(cls)}${periodSuffixTitle}`,
    subtitle: `${cls.course.title} · ${cls.semester.name}, ${cls.semester.academicYear.name}`,
    meta: [
      `${data.stats.students} enrolled${hasDropped ? ` · ${data.stats.dropped} dropped` : ''} · ${cls.gradesFinalizedAt ? `Finalised ${dateKey(cls.gradesFinalizedAt, timeZone)}` : 'NOT FINAL — grades may still change'}`,
      `Scale: ${data.class.gradingScale?.name ?? 'none'}${by === 'weights' ? ' · Category/Period columns show % and weighted contribution (Wtd)' : ' · M = missing, EX = exempt'} · Generated ${dateKey(new Date(), timeZone)} (${timeZone})`,
    ],
    columns,
    rows: data.students,
    landscape: multiPeriod || by !== 'items',
    footer: 'Confidential student record — handle in accordance with the Data Privacy Act of 2012 (RA 10173).',
    summary: [
      ...selectedPeriods.map((p) => `${p.name} (${p.weight}%): ${p.categories.map((c) => `${c.name} ${c.weight}%`).join(', ')}`),
      data.class.transmutationBase > 0 ? `Transmutation base ${data.class.transmutationBase}.` : 'No transmutation.',
      data.class.treatMissingAsZero ? 'Missing work counts as zero.' : 'Missing work is not counted.',
    ],
  };
  return { table, scopedPeriod, hasDropped };
}
