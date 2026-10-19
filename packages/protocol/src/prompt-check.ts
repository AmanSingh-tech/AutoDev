/**
 * Prompt guide (B-1): the built-in task templates and the rule-based draft score. Both the task
 * form (live, on every keystroke) and the API (stored on the task) use these, so the number the
 * author sees is the number that is saved. No model is involved here.
 */

export const TEMPLATE_KINDS = ['bug_fix', 'feature', 'refactor', 'add_tests', 'ui_change'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_KIND_LABEL: Record<TemplateKind, string> = {
  bug_fix: 'Bug fix',
  feature: 'Feature',
  refactor: 'Refactor',
  add_tests: 'Add tests',
  ui_change: 'UI change',
};

export interface TaskTemplate {
  kind: TemplateKind;
  name: string;
  descriptionMd: string;
  acceptanceCriteriaMd: string;
}

/** Placeholders are written as [TODO: …], which the score flags until they are filled in. */
export const BUILT_IN_TEMPLATES: readonly TaskTemplate[] = [
  {
    kind: 'bug_fix',
    name: 'Bug fix',
    descriptionMd: [
      '## What happens',
      '[TODO: the wrong behavior, with the exact error message if there is one]',
      '',
      '## Steps to reproduce',
      '1. [TODO: first step]',
      '2. [TODO: next step]',
      '',
      '## Expected',
      '[TODO: what should happen instead]',
      '',
      '## Where to look',
      '[TODO: files, functions or folders, e.g. `src/auth/session.ts`]',
    ].join('\n'),
    acceptanceCriteriaMd: [
      '- [TODO: the steps above no longer reproduce the bug]',
      '- A test covers this case and fails without the fix',
      '- Existing tests still pass',
    ].join('\n'),
  },
  {
    kind: 'feature',
    name: 'Feature',
    descriptionMd: [
      '## Goal',
      '[TODO: what users can do after this change, and why it matters]',
      '',
      '## Behavior',
      '- [TODO: the main flow]',
      '- [TODO: edge cases and errors]',
      '',
      '## Where to build it',
      '[TODO: files or folders to change or add, e.g. `src/billing/`]',
      '',
      '## Out of scope',
      '- [TODO: what this task should not touch]',
    ].join('\n'),
    acceptanceCriteriaMd: [
      '- [TODO: a user-visible result that can be checked]',
      '- New code has tests',
      '- Existing tests still pass',
    ].join('\n'),
  },
  {
    kind: 'refactor',
    name: 'Refactor',
    descriptionMd: [
      '## What to change',
      '[TODO: the code to restructure, e.g. `src/orders/service.ts`]',
      '',
      '## Why',
      '[TODO: the problem with the current shape]',
      '',
      '## Target shape',
      '[TODO: how the code should look afterwards]',
      '',
      'Behavior must not change.',
    ].join('\n'),
    acceptanceCriteriaMd: [
      '- No change in behavior: existing tests pass without edits',
      '- [TODO: a structural check, e.g. "no imports from `legacy/` remain"]',
    ].join('\n'),
  },
  {
    kind: 'add_tests',
    name: 'Add tests',
    descriptionMd: [
      '## Code to cover',
      '[TODO: files or functions, e.g. `src/pricing/discounts.ts`]',
      '',
      '## Cases',
      '- [TODO: normal case]',
      '- [TODO: edge cases and errors]',
      '',
      'Use the existing test framework and conventions. Do not change production code unless a test shows it misbehaves, and say so if it does.',
    ].join('\n'),
    acceptanceCriteriaMd: [
      '- [TODO: the cases above each have a test]',
      '- All tests pass',
    ].join('\n'),
  },
  {
    kind: 'ui_change',
    name: 'UI change',
    descriptionMd: [
      '## Screen',
      '[TODO: the page or component, e.g. `app/settings/page.tsx`]',
      '',
      '## Change',
      '[TODO: what should look or behave differently]',
      '',
      '## States',
      '- [TODO: loading, empty, error, and narrow screens]',
    ].join('\n'),
    acceptanceCriteriaMd: [
      '- [TODO: what a person sees after the change]',
      '- Works with the keyboard and at phone width',
      '- Existing tests still pass',
    ].join('\n'),
  },
];

export const PROMPT_FLAGS = [
  'missing_repro',
  'missing_acceptance_criteria',
  'missing_file_hints',
  'vague_scope',
  'unfilled_todo',
] as const;
export type PromptFlag = (typeof PROMPT_FLAGS)[number];

/** Points each flag costs. A draft with no flags scores 100. */
const PENALTY: Record<PromptFlag, number> = {
  missing_acceptance_criteria: 30,
  missing_repro: 25,
  vague_scope: 20,
  missing_file_hints: 15,
  unfilled_todo: 10,
};

export const PROMPT_FLAG_TEXT: Record<PromptFlag, string> = {
  missing_repro: 'Looks like a bug, but there are no steps to reproduce it or expected behavior.',
  missing_acceptance_criteria: 'Add acceptance criteria: checkable lines the agent tests its work against.',
  missing_file_hints: 'Name the files, functions or folder involved, or limit the task to a folder.',
  vague_scope: 'The scope is vague. Say exactly what should change.',
  unfilled_todo: 'Some [TODO: …] placeholders are still empty.',
};

export interface PromptDraft {
  title: string;
  descriptionMd: string;
  acceptanceCriteriaMd: string;
  extraContext?: string | null;
  scopePath?: string | null;
}

export interface PromptScore {
  score: number;
  flags: PromptFlag[];
}

/** Bumped when the rules change, so stored scores can be told apart. */
export const PROMPT_SCORE_VERSION = 1;

/** A bug report: any of these in the title, or a strong signal in the description ("error handling" is not a bug). */
const BUG_TITLE = /\b(bug|fix(es|ed)?|broken|crash(es|ed)?|error|exception|fails?|failing|regression|wrong|500|404)\b/i;
const BUG_DESC = /\b(bug|broken|crash(es|ed)?|exception|regression|stack ?trace)\b/i;
const REPRO_WORDS = /\b(steps?|repro(duce)?|expected|actual|when i|after i|to trigger)\b/i;
const NUMBERED_STEPS = /^\s*\d+[.)]\s+\S/m;
/** A path, a file name with an extension, or something in backticks. */
const FILE_HINT = /(`[^`\n]+`|[\w.-]+\/[\w./-]+|\b[\w-]+\.(tsx?|jsx?|py|go|rs|rb|java|kt|cs|php|swift|vue|svelte|css|scss|sql|ya?ml|json|md)\b)/;
const VAGUE_WORDS = /\b(stuff|things?|something|somehow|etc|improve|better|clean ?up|various|misc|some issues|make it work|tweak)\b/gi;
const TODO = /\[TODO\b/i;

/** Lines that read like separate criteria: bullets, numbers or plain non-empty lines. */
const criteriaLines = (md: string) =>
  md
    .split('\n')
    .map((l) => l.replace(/^\s*([-*+]|\d+[.)])\s*(\[[ x]\]\s*)?/, '').trim())
    .filter((l) => l.length >= 8);

export function scorePrompt(d: PromptDraft): PromptScore {
  const title = d.title.trim();
  const desc = d.descriptionMd.trim();
  const ac = d.acceptanceCriteriaMd.trim();
  const all = [title, desc, ac, d.extraContext ?? ''].join('\n');
  const flags: PromptFlag[] = [];

  if ((BUG_TITLE.test(title) || BUG_DESC.test(desc)) && !(REPRO_WORDS.test(desc) || NUMBERED_STEPS.test(desc)))
    flags.push('missing_repro');
  if (criteriaLines(ac).length === 0) flags.push('missing_acceptance_criteria');
  if (!d.scopePath?.trim() && !FILE_HINT.test(all)) flags.push('missing_file_hints');

  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const vagueHits = (`${title}\n${desc}`.match(VAGUE_WORDS) ?? []).length;
  if (words(title) < 3 || words(desc) < 12 || vagueHits >= 2) flags.push('vague_scope');

  if (TODO.test(all)) flags.push('unfilled_todo');

  const score = Math.max(0, 100 - flags.reduce((n, f) => n + PENALTY[f], 0));
  return { score, flags: PROMPT_FLAGS.filter((f) => flags.includes(f)) };
}

/** Badge wording shared by the form and the task page. */
export function scoreBand(score: number): 'good' | 'fair' | 'weak' {
  return score >= 80 ? 'good' : score >= 50 ? 'fair' : 'weak';
}
