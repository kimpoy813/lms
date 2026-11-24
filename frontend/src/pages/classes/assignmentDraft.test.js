import { describe, expect, it } from 'vitest';
import { activityInstructionsHtml, extractRubricFromHtml, starterActivityRubric } from './assignmentDraft.js';

describe('AI activity to assignment helpers', () => {
  it('escapes activity text before putting it in assignment HTML', () => {
    expect(activityInstructionsHtml('Read <script>alert(1)</script>\n\nExplain the result.'))
      .toBe('<p>Read &lt;script&gt;alert(1)&lt;/script&gt;</p><p>Explain the result.</p>');
  });

  it('builds an editable starter rubric whose criteria add up to the selected points', () => {
    const rubric = starterActivityRubric('Threat-model exercise', 103);

    expect(rubric.title).toBe('Threat-model exercise — Starter rubric');
    expect(rubric.criteria).toHaveLength(4);
    expect(rubric.criteria.reduce((sum, criterion) => sum + criterion.maxPoints, 0)).toBe(103);
    expect(rubric.criteria.every((criterion) => criterion.levels.length === 4)).toBe(true);
    expect(rubric.criteria.every((criterion) => criterion.levels.every((level) => level.points <= criterion.maxPoints))).toBe(true);
  });

  it('imports point-scored performance levels and criteria from a lesson rubric table', () => {
    const rubric = extractRubricFromHtml(`
      <h3>Activity Rubric</h3>
      <table>
        <thead><tr><th>Criterion</th><th>Excellent (4 pts)</th><th>Developing (2 pts)</th></tr></thead>
        <tbody>
          <tr><th scope="row">Accuracy (max 4 points)</th><td>Correct and complete.</td><td>Several errors.</td></tr>
          <tr><th scope="row">Evidence (6 points)</th><td>Strong sources.</td><td>Few examples.</td></tr>
        </tbody>
      </table>`, 'Threat-model exercise');

    expect(rubric).toEqual({
      title: 'Activity Rubric',
      description: '',
      criteria: [
        {
          title: 'Accuracy', description: '', maxPoints: 4,
          levels: [
            { title: 'Excellent', points: 4, description: 'Correct and complete.' },
            { title: 'Developing', points: 2, description: 'Several errors.' },
          ],
        },
        {
          title: 'Evidence', description: '', maxPoints: 6,
          levels: [
            { title: 'Excellent', points: 4, description: 'Strong sources.' },
            { title: 'Developing', points: 2, description: 'Few examples.' },
          ],
        },
      ],
    });
  });

  it('imports a rubric copied as criterion-point and level-point cells', () => {
    const rubric = extractRubricFromHtml(`
      <h2>Rubric</h2>
      <table><tbody>
        <tr>
          <th>Research (5 pts)</th>
          <td><p><strong>Excellent · 5</strong></p><p>Sources are relevant.</p></td>
          <td><p><strong>Beginning · 2</strong></p><p>Few sources.</p></td>
        </tr>
      </tbody></table>`, 'Threat-model exercise');

    expect(rubric).toEqual({
      title: 'Threat-model exercise rubric',
      description: '',
      criteria: [{
        title: 'Research', description: '', maxPoints: 5,
        levels: [
          { title: 'Excellent', points: 5, description: 'Sources are relevant.' },
          { title: 'Beginning', points: 2, description: 'Few sources.' },
        ],
      }],
    });
  });

  it('imports a criterion-and-points rubric without performance level descriptions', () => {
    const rubric = extractRubricFromHtml(`
      <table>
        <thead><tr><th>Criterion</th><th>Maximum points</th><th>Description</th></tr></thead>
        <tbody><tr><td>Evidence</td><td>6</td><td>Cites relevant sources.</td></tr></tbody>
      </table>`, 'Research report');

    expect(rubric).toMatchObject({
      title: 'Research report rubric',
      criteria: [{ title: 'Evidence', description: 'Cites relevant sources.', maxPoints: 6, levels: [] }],
    });
  });

  it('does not treat unrelated lesson tables as rubrics', () => {
    expect(extractRubricFromHtml('<table><tr><td>Term</td><td>Definition</td></tr></table>')).toBeNull();
    expect(extractRubricFromHtml('No rubric table here.')).toBeNull();
  });

  it('requires enough whole points for its four criteria', () => {
    expect(() => starterActivityRubric('Small activity', 3)).toThrow(/between 4 and 1,000/);
    expect(() => starterActivityRubric('Invalid activity', 4.5)).toThrow(/between 4 and 1,000/);
  });
});
