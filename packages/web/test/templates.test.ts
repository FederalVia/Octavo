import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTemplate } from '../src/templates.ts';

test('template variables', () => {
  const now = new Date(2026, 10, 6, 9, 5, 7); // Friday 6 November 2026, 09:05:07
  const t = (s: string) => applyTemplate(s, 'My Note', now, 'Projects');
  assert.equal(t('# {{title}} in {{folder}}'), '# My Note in Projects');
  assert.equal(t('{{date}} {{time}}'), '2026-11-06 09:05');
  assert.equal(t('{{date:dddd, D MMMM YYYY}}'), 'Friday, 6 November 2026');
  assert.equal(t('{{date:ddd D MMM}} {{time:HH:mm:ss}}'), 'Fri 6 Nov 09:05:07');
  assert.equal(t('{{date+7d}} {{date-1w:YYYY-MM-DD}} {{date+1m}} {{date+1y:YYYY}}'), '2026-11-13 2026-10-30 2026-12-06 2027');
  assert.equal(t('{{yesterday}} {{tomorrow}}'), '2026-11-05 2026-11-07');
  assert.equal(t('{{weekday}}, week {{week}} of {{month}} {{year}}'), 'Friday, week 45 of November 2026');
  assert.equal(t('{{unknown}} stays'), '{{unknown}} stays');
});
