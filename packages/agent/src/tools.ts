import type { AgentPhase } from '@autodev/db';
import type { ToolDef } from '@autodev/llm';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Tool inputs are validated with these schemas: streamed tool inputs can arrive truncated. */
export const toolSchemas = {
  list_dir: z.object({ path: z.string().max(500).optional().describe('Directory relative to the repo root. Omit for the task folder or root.') }).strict(),
  read_file: z
    .object({
      path: z.string().min(1).max(500),
      offset: z.number().int().min(1).optional().describe('1-based line to start at'),
      limit: z.number().int().min(1).max(4000).optional().describe('Number of lines (default 2000)'),
    })
    .strict(),
  grep: z
    .object({
      pattern: z.string().min(1).max(500).describe('JavaScript regular expression, matched per line'),
      path: z.string().max(500).optional().describe('Directory to search (default: task folder or root)'),
      glob: z.string().max(100).optional().describe('File name filter such as *.ts'),
    })
    .strict(),
  edit_file: z
    .object({
      path: z.string().min(1).max(500),
      old_string: z.string().min(1).describe('Exact text to replace. Must appear exactly once in the file.'),
      new_string: z.string(),
    })
    .strict(),
  create_file: z.object({ path: z.string().min(1).max(500), content: z.string() }).strict(),
  delete_file: z.object({ path: z.string().min(1).max(500) }).strict(),
  ask_user: z
    .object({
      question: z.string().min(1).max(4000),
      kind: z.enum(['question', 'deviation']).default('question'),
      paths: z.array(z.string().max(500)).max(50).optional().describe('For deviations: the files outside the approved design you need to change'),
    })
    .strict(),
  submit_plan: z.object({ markdown: z.string().min(1).max(60_000) }).strict(),
  submit_design: z.object({ markdown: z.string().min(1).max(100_000) }).strict(),
  request_local_test: z.object({ reason: z.string().max(1000).optional() }).strict(),
  finish: z
    .object({
      summary: z.string().min(1).max(10_000).describe('What changed and why, for the PR and for follow-up tasks'),
      files: z
        .array(z.object({ path: z.string().max(500), note: z.string().max(300) }).strict())
        .max(200)
        .optional()
        .describe('One short line per changed file, for the PR description'),
    })
    .strict(),
} as const;

export type ToolName = keyof typeof toolSchemas;
export type ToolInput<N extends ToolName> = z.infer<(typeof toolSchemas)[N]>;

const DESCRIPTIONS: Record<ToolName, string> = {
  list_dir: 'List files and folders in a directory of the repository (base commit plus your edits).',
  read_file: 'Read a text file. Returns the raw content for the requested line range.',
  grep: 'Search file contents with a regular expression. Returns path:line: text matches.',
  edit_file: 'Replace one exact occurrence of old_string with new_string in a file. Read the file first and copy old_string exactly.',
  create_file: 'Create a new file. Fails if it already exists.',
  delete_file: 'Delete a file.',
  ask_user:
    "Pause and ask the task owner something. Use kind 'deviation' (with paths) when you must change files the approved design doesn't cover, and explain why.",
  submit_plan: 'Submit the plan as markdown for human review. This ends your turn.',
  submit_design: 'Submit the low-level design as markdown for human review. This ends your turn.',
  request_local_test: "Run the repository's tests on the developer's machine with your current changes. You'll get the results back.",
  finish: 'Finish coding with a summary of the change. Tests are run next, then the change is pushed.',
};

export const TOOLS_BY_PHASE: Record<AgentPhase, ToolName[]> = {
  plan: ['list_dir', 'read_file', 'grep', 'ask_user', 'submit_plan'],
  lld: ['list_dir', 'read_file', 'grep', 'ask_user', 'submit_design'],
  code: ['list_dir', 'read_file', 'grep', 'edit_file', 'create_file', 'delete_file', 'ask_user', 'request_local_test', 'finish'],
  fix: ['list_dir', 'read_file', 'grep', 'edit_file', 'create_file', 'delete_file', 'ask_user', 'request_local_test', 'finish'],
};

/** Tools that end the turn and wait for a person or the builder. */
export const PAUSING_TOOLS: ToolName[] = ['ask_user', 'submit_plan', 'submit_design', 'request_local_test', 'finish'];

export function toolDefs(phase: AgentPhase): ToolDef[] {
  return TOOLS_BY_PHASE[phase].map((name) => {
    const schema = zodToJsonSchema(toolSchemas[name], { $refStrategy: 'none', target: 'jsonSchema7' }) as Record<string, unknown>;
    delete schema.$schema;
    return { name, description: DESCRIPTIONS[name], inputSchema: schema };
  });
}
