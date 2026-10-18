import { describe, expect, it } from 'vitest';
import { TASK_STATUSES } from './schema/enums';
import { assertTransition, BOARD_COLUMNS, canTransition, columnOf, InvalidTransition, STATUS_LABEL, TERMINAL_STATUSES } from './task-machine';

describe('task state machine', () => {
  it('puts every status in exactly one board column and gives it a label', () => {
    const all = BOARD_COLUMNS.flatMap((c) => c.statuses);
    expect([...all].sort()).toEqual([...TASK_STATUSES].sort());
    for (const s of TASK_STATUSES) expect(STATUS_LABEL[s]).toBeTruthy();
  });

  it('lets terminal statuses go nowhere, except retrying a failed task (from the queue, or just its push)', () => {
    for (const s of TERMINAL_STATUSES) {
      for (const to of TASK_STATUSES) expect(canTransition(s, to)).toBe(s === 'failed' && (to === 'queued' || to === 'testing'));
    }
  });

  it('only allows cancelling before work is pushed', () => {
    expect(canTransition('coding', 'cancelled')).toBe(true);
    expect(canTransition('pushed', 'cancelled')).toBe(false);
  });

  it('follows the approval gates', () => {
    expect(canTransition('planning', 'coding')).toBe(false);
    expect(canTransition('awaiting_plan_approval', 'designing')).toBe(true);
    expect(canTransition('awaiting_lld_approval', 'coding')).toBe(true);
    expect(() => assertTransition('draft', 'coding')).toThrow(InvalidTransition);
    expect(columnOf('blocked_on_key')).toBe('needs_you');
  });
});
