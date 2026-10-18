import type { AgentPhase } from '@autodev/db';
import type { ContentBlock, GatewayRequest, LlmResponse, Message, SystemBlock } from '@autodev/llm';
import { isAllowedByDesign, missingSections } from './documents';
import { PAUSING_TOOLS, toolDefs, toolSchemas, TOOLS_BY_PHASE, type ToolName } from './tools';
import { WorkspaceError, type VirtualWorkspace } from './workspace';

export type ToolResult = Extract<ContentBlock, { type: 'tool_result' }>;

export type Outcome =
  | { type: 'submitted'; kind: 'plan' | 'lld'; markdown: string; toolUseId: string }
  | { type: 'question'; toolUseId: string; question: string; kind: 'question' | 'deviation'; paths: string[] }
  | { type: 'finished'; summary: string; files: { path: string; note: string }[]; toolUseId: string }
  | { type: 'test_requested'; reason: string | null; toolUseId: string }
  | { type: 'cancelled' }
  | { type: 'failed'; reason: string };

export interface StepRecord {
  kind: 'llm_call' | 'tool_call' | 'message';
  toolName?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface LoopDeps {
  phase: AgentPhase;
  workspace: VirtualWorkspace;
  /** Files the approved plan/LLD names. null = no restriction (direct mode, or nothing approved). */
  allowedPaths: Set<string> | null;
  call: (req: GatewayRequest) => Promise<{ response: LlmResponse }>;
  isCancelled: () => Promise<boolean>;
  onStep: (s: StepRecord) => Promise<void>;
  /** Called after every turn so a crash or pause never loses the conversation. */
  persist: (s: { transcript: Message[]; pendingResults: ToolResult[] }) => Promise<void>;
  maxTurns?: number;
}

const MAX_RESULT_CHARS = 60_000;
const MAX_NUDGES = 2;

/**
 * Drives one phase: model call → run tools → feed results back, until a pausing tool fires.
 * The transcript is append-only; assistant content (thinking blocks included) is kept verbatim.
 */
export async function runLoop(deps: LoopDeps, system: SystemBlock[], transcript: Message[]): Promise<{ outcome: Outcome; transcript: Message[]; pendingResults: ToolResult[] }> {
  const tools = toolDefs(deps.phase);
  const maxTurns = deps.maxTurns ?? 60;
  let nudges = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (await deps.isCancelled()) return { outcome: { type: 'cancelled' }, transcript, pendingResults: [] };

    const started = Date.now();
    const { response } = await deps.call({ system, messages: transcript, tools, cacheConversation: true, refusalFallback: true });
    transcript = [...transcript, { role: 'assistant', content: response.content }];
    const text = response.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');
    await deps.onStep({ kind: 'llm_call', input: { stopReason: response.stopReason, model: response.model, usage: response.usage }, output: truncate(text, 4000), durationMs: Date.now() - started });

    if (response.stopReason === 'refusal') {
      await deps.persist({ transcript, pendingResults: [] });
      return { outcome: { type: 'failed', reason: 'The model declined this request.' }, transcript, pendingResults: [] };
    }

    const calls = response.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!calls.length) {
      if (++nudges > MAX_NUDGES) return { outcome: { type: 'failed', reason: 'The agent stopped without using its tools.' }, transcript, pendingResults: [] };
      const hint = response.stopReason === 'max_tokens' ? 'Your response was cut off. Continue, and keep each step shorter.' : `Continue using the tools. ${finishHint(deps.phase)}`;
      transcript = [...transcript, { role: 'user', content: [{ type: 'text', text: hint }] }];
      await deps.persist({ transcript, pendingResults: [] });
      continue;
    }

    const results: ToolResult[] = [];
    let pause: Outcome | null = null;
    for (const call of calls) {
      const t0 = Date.now();
      const exec: { result?: ToolResult; pause?: Outcome } = pause
        ? { result: err(call.id, 'Only one hand-off tool (ask_user, submit, test, finish) can be used per turn.') }
        : await execute(deps, call);
      if (exec.pause) pause = exec.pause;
      if (exec.result) results.push(exec.result);
      await deps.onStep({
        kind: 'tool_call',
        toolName: call.name,
        input: shrink(call.input),
        output: exec.result ? truncate(exec.result.content, 4000) : '(waiting)',
        isError: exec.result?.isError ?? false,
        durationMs: Date.now() - t0,
      });
    }

    if (pause) {
      // The paused call's result is supplied on resume (answer, review comment, test logs).
      await deps.persist({ transcript, pendingResults: results });
      return { outcome: pause, transcript, pendingResults: results };
    }
    transcript = [...transcript, { role: 'user', content: results }];
    await deps.persist({ transcript, pendingResults: [] });
  }
  return { outcome: { type: 'failed', reason: `The agent hit the ${maxTurns}-step limit for one phase.` }, transcript, pendingResults: [] };
}

async function execute(deps: LoopDeps, call: Extract<ContentBlock, { type: 'tool_use' }>): Promise<{ result?: ToolResult; pause?: Outcome }> {
  const name = call.name as ToolName;
  if (!TOOLS_BY_PHASE[deps.phase].includes(name)) return { result: err(call.id, `Tool "${call.name}" isn't available in this phase.`) };
  const parsed = toolSchemas[name].safeParse(call.input);
  if (!parsed.success) {
    return { result: err(call.id, `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}. The input may have been cut off; send it again.`) };
  }
  const input = parsed.data as Record<string, unknown>;
  const ws = deps.workspace;
  try {
    switch (name) {
      case 'list_dir': {
        const entries = await ws.listDir((input.path as string | undefined) ?? '');
        return ok(call.id, entries.map((e) => (e.type === 'dir' ? `${e.path}/` : `${e.path}${e.size !== undefined ? ` (${e.size} B)` : ''}`)).join('\n') || '(empty)');
      }
      case 'read_file': {
        const content = await ws.readFile(input.path as string);
        const lines = content.split('\n');
        const from = ((input.offset as number | undefined) ?? 1) - 1;
        const count = (input.limit as number | undefined) ?? 2000;
        const slice = lines.slice(from, from + count).join('\n');
        const note = from > 0 || from + count < lines.length ? `\n[lines ${from + 1}-${Math.min(from + count, lines.length)} of ${lines.length}]` : '';
        return ok(call.id, slice + note);
      }
      case 'grep': {
        const res = await ws.grep(input.pattern as string, (input.path as string | undefined) ?? '', input.glob ? { glob: input.glob as string } : {});
        const head = res.source === 'github' ? '[too many files to scan; results from GitHub code search on the default branch]\n' : '';
        return ok(call.id, head + (res.matches.join('\n') || 'No matches.') + (res.truncated ? '\n[more matches omitted; narrow the search]' : ''));
      }
      case 'edit_file':
      case 'create_file':
      case 'delete_file': {
        const path = input.path as string;
        if (deps.allowedPaths && !isAllowedByDesign(path.replace(/^\.\//, ''), deps.allowedPaths)) {
          return { result: err(call.id, `"${path}" isn't part of the approved design. If you must change it, call ask_user with kind "deviation", the paths, and the reason.`) };
        }
        if (name === 'edit_file') await ws.editFile(path, input.old_string as string, input.new_string as string);
        else if (name === 'create_file') await ws.createFile(path, input.content as string);
        else await ws.deleteFile(path);
        return ok(call.id, name === 'delete_file' ? `Deleted ${path}.` : `Saved ${path}.`);
      }
      case 'submit_plan':
      case 'submit_design': {
        const kind = name === 'submit_plan' ? 'plan' : 'lld';
        const missing = missingSections(kind, input.markdown as string);
        if (missing.length) return { result: err(call.id, `The document is missing these sections (as markdown headings): ${missing.join(', ')}. Submit it again with all of them.`) };
        return { pause: { type: 'submitted', kind, markdown: input.markdown as string, toolUseId: call.id } };
      }
      case 'ask_user':
        return { pause: { type: 'question', toolUseId: call.id, question: input.question as string, kind: input.kind as 'question' | 'deviation', paths: (input.paths as string[] | undefined) ?? [] } };
      case 'request_local_test':
        if (!(await ws.changes()).length) return { result: err(call.id, 'There are no changes to test yet.') };
        return { pause: { type: 'test_requested', reason: (input.reason as string | undefined) ?? null, toolUseId: call.id } };
      case 'finish':
        if (!(await ws.changes()).length) return { result: err(call.id, "You haven't changed any files. Make the change first, or ask_user if nothing needs to change.") };
        return { pause: { type: 'finished', summary: input.summary as string, files: (input.files as { path: string; note: string }[] | undefined) ?? [], toolUseId: call.id } };
    }
  } catch (e) {
    if (e instanceof WorkspaceError) return { result: err(call.id, e.message) };
    throw e;
  }
  return { result: err(call.id, 'Unknown tool') };
}

const finishHint = (phase: AgentPhase) =>
  phase === 'plan' ? 'When ready, call submit_plan.' : phase === 'lld' ? 'When ready, call submit_design.' : 'When the change is complete, call finish.';

const ok = (id: string, content: string): { result: ToolResult } => ({ result: { type: 'tool_result', toolUseId: id, content: truncate(content, MAX_RESULT_CHARS) } });
const err = (id: string, content: string): ToolResult => ({ type: 'tool_result', toolUseId: id, content, isError: true });

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}\n[truncated ${s.length - n} characters]` : s;
}

/** Shortens long strings in a tool input for the step log (the transcript keeps everything). */
function shrink(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 2000 ? `${v.slice(0, 2000)}… [${v.length} chars]` : v;
  if (Array.isArray(v)) return v.slice(0, 50).map(shrink);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
  return v;
}

export { PAUSING_TOOLS };
