'use client';

import { BOARD_COLUMNS } from '@autodev/db/task-machine';
import { Input, NativeSelect } from '@autodev/ui';

export interface Filters {
  q: string;
  column: string;
  priority: string;
  mine: boolean;
}
export const EMPTY_FILTERS: Filters = { q: '', column: '', priority: '', mine: false };

/** One row of filters above the list. */
export function TaskFilters({ value, onChange, showColumn = true }: { value: Filters; onChange: (f: Filters) => void; showColumn?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label="Search tasks" placeholder="Search title or key…" className="w-56" value={value.q} onChange={(e) => onChange({ ...value, q: e.target.value })} />
      {showColumn && (
        <NativeSelect aria-label="Status" className="w-40" value={value.column} onChange={(e) => onChange({ ...value, column: e.target.value })}>
          <option value="">Any status</option>
          {BOARD_COLUMNS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
      )}
      <NativeSelect aria-label="Priority" className="w-36" value={value.priority} onChange={(e) => onChange({ ...value, priority: e.target.value })}>
        <option value="">Any priority</option>
        <option value="urgent">Urgent</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </NativeSelect>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.mine} onChange={(e) => onChange({ ...value, mine: e.target.checked })} /> Only mine
      </label>
    </div>
  );
}

export function toQuery(f: Filters) {
  return {
    ...(f.q.trim() ? { q: f.q.trim() } : {}),
    ...(f.column ? { column: f.column as (typeof BOARD_COLUMNS)[number]['id'] } : {}),
    ...(f.priority ? { priority: f.priority as 'low' | 'medium' | 'high' | 'urgent' } : {}),
    ...(f.mine ? { mine: true } : {}),
  };
}
