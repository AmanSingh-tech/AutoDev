import { sql } from 'drizzle-orm';
import { check, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './_shared';
import { users } from './identity';
import { orgs } from './orgs';

/**
 * An org's own task templates, shown next to the built-in ones (@autodev/protocol prompt-check).
 * Members read them; only admins change them (enforced by the API; RLS keeps them inside the org).
 */
export const promptTemplates = pgTable(
  'prompt_templates',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** One of TEMPLATE_KINDS; groups the template in the picker. */
    kind: text('kind').notNull(),
    descriptionMd: text('description_md').notNull().default(''),
    acceptanceCriteriaMd: text('acceptance_criteria_md').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('prompt_templates_org_name_uq').on(t.orgId, t.name),
    check('prompt_templates_name_length', sql`char_length(${t.name}) between 1 and 80`),
    check('prompt_templates_kind', sql`${t.kind} in ('bug_fix', 'feature', 'refactor', 'add_tests', 'ui_change')`),
  ],
);
