import { describe, expect, it } from 'vitest';
import { BUILT_IN_TEMPLATES, scoreBand, scorePrompt, TEMPLATE_KINDS } from './prompt-check';

const GOOD = {
  title: 'Redirect to the original page after login',
  descriptionMd:
    'After signing in, users always land on /dashboard. They should go back to the page that sent them to the login screen. The return path is lost in `src/auth/callback.ts`.',
  acceptanceCriteriaMd: '- Signing in from /settings returns to /settings\n- Login tests still pass',
};

describe('scorePrompt', () => {
  it('gives a complete feature draft 100 with no flags', () => {
    expect(scorePrompt(GOOD)).toEqual({ score: 100, flags: [] });
  });

  it('flags a bug report without repro steps, and clears the flag once steps are added', () => {
    const bug = { ...GOOD, title: 'Fix crash on the orders page', descriptionMd: 'The orders page crashes for some customers who have many orders in `src/orders/list.tsx`.' };
    expect(scorePrompt(bug).flags).toEqual(['missing_repro']);
    expect(scorePrompt(bug).score).toBe(75);
    const withSteps = { ...bug, descriptionMd: `${bug.descriptionMd}\n\n1. Open /orders as a customer with 500 orders\n2. Scroll down` };
    expect(scorePrompt(withSteps).flags).toEqual([]);
  });

  it('flags missing acceptance criteria, including lines too short to check', () => {
    expect(scorePrompt({ ...GOOD, acceptanceCriteriaMd: '' }).flags).toEqual(['missing_acceptance_criteria']);
    expect(scorePrompt({ ...GOOD, acceptanceCriteriaMd: '- works' }).flags).toEqual(['missing_acceptance_criteria']);
  });

  it('flags no file hints, unless the task is limited to a folder', () => {
    const noHints = { ...GOOD, descriptionMd: GOOD.descriptionMd.replace(' The return path is lost in `src/auth/callback.ts`.', ' The return address gets lost somewhere along the way here.') };
    expect(scorePrompt(noHints).flags).toEqual(['missing_file_hints']);
    expect(scorePrompt({ ...noHints, scopePath: 'apps/web' }).flags).toEqual([]);
  });

  it('flags vague scope: a short title, a thin description or vague wording', () => {
    expect(scorePrompt({ ...GOOD, title: 'Login' }).flags).toContain('vague_scope');
    expect(scorePrompt({ ...GOOD, descriptionMd: 'Tidy `src/auth`.' }).flags).toContain('vague_scope');
    expect(scorePrompt({ ...GOOD, descriptionMd: `${GOOD.descriptionMd} Also improve stuff and clean up things.` }).flags).toContain('vague_scope');
  });

  it('scores an empty draft 0 and never goes below it', () => {
    const r = scorePrompt({ title: 'fix bug', descriptionMd: '', acceptanceCriteriaMd: '' });
    expect(r.score).toBe(10);
    expect(r.flags).toEqual(['missing_repro', 'missing_acceptance_criteria', 'missing_file_hints', 'vague_scope']);
    expect(scorePrompt({ title: 'fix bug', descriptionMd: '[TODO', acceptanceCriteriaMd: '' }).score).toBe(0);
  });
});

describe('built-in templates', () => {
  it('has one template per kind, and an unfilled template is flagged until the TODOs are filled', () => {
    expect(BUILT_IN_TEMPLATES.map((t) => t.kind)).toEqual([...TEMPLATE_KINDS]);
    for (const t of BUILT_IN_TEMPLATES) {
      const r = scorePrompt({ title: 'A clear and specific title', descriptionMd: t.descriptionMd, acceptanceCriteriaMd: t.acceptanceCriteriaMd });
      expect(r.flags, t.kind).toContain('unfilled_todo');
      const filled = (s: string) => s.replace(/\[TODO: [^\]]*\]/g, 'the checkout total in `src/cart/total.ts` shows the right amount');
      expect(scorePrompt({ title: 'Show the checkout total with tax included', descriptionMd: filled(t.descriptionMd), acceptanceCriteriaMd: filled(t.acceptanceCriteriaMd) }), t.kind).toEqual({ score: 100, flags: [] });
    }
  });
});

describe('scoreBand', () => {
  it('maps scores to bands', () => {
    expect([scoreBand(100), scoreBand(80), scoreBand(79), scoreBand(50), scoreBand(49)]).toEqual(['good', 'good', 'fair', 'fair', 'weak']);
  });
});
