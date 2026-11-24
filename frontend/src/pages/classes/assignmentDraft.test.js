import { describe, expect, it } from 'vitest';
import { activityInstructionsHtml, starterActivityRubric } from './assignmentDraft.js';

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

  it('requires enough whole points for its four criteria', () => {
    expect(() => starterActivityRubric('Small activity', 3)).toThrow(/between 4 and 1,000/);
    expect(() => starterActivityRubric('Invalid activity', 4.5)).toThrow(/between 4 and 1,000/);
  });
});
