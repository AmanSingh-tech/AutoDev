import type { ServerResponse } from 'node:http';

/**
 * A scripted stand-in for Anthropic's streaming Messages API, used by the end-to-end test.
 * It reads the phase from the system prompt and answers with the tool call that phase needs:
 *   PLAN   → submit_plan (v2 after the reviewer asks for changes)
 *   DESIGN → submit_design
 *   CODE   → edit src/app.ts, then finish
 */
interface Req {
  model: string;
  system?: { text: string }[];
  messages: { role: string; content: { type: string; content?: string; text?: string }[] | string }[];
}

const PLAN = (v: number) => `## Approach
Make greet() say hello${v > 1 ? ', and handle empty names' : ''}.

## Files to change
- \`src/app.ts\`

## Risks
Low.

## Open questions
None.`;

const DESIGN = `## Files and functions
- \`src/app.ts\`: change greet()

## Schema and API changes
None.

## Edge cases
- Empty name

## Test cases to add
- greet() returns "hello"`;

let n = 0;
const tool = (name: string, input: unknown) => ({ type: 'tool_use', id: `toolu_${++n}`, name, input });

function respond(req: Req) {
  const system = (req.system ?? []).map((s) => s.text).join('\n');
  const flat = JSON.stringify(req.messages);
  if (system.includes('Phase: PLAN')) return [tool('submit_plan', { markdown: PLAN(flat.includes('requested changes') ? 2 : 1) })];
  if (system.includes('LOW-LEVEL DESIGN')) return [tool('submit_design', { markdown: DESIGN })];
  if (!flat.includes('Saved src/app.ts')) return [{ type: 'text', text: 'Updating greet().' }, tool('edit_file', { path: 'src/app.ts', old_string: '"hi"', new_string: '"hello"' })];
  return [tool('finish', { summary: 'greet() now says hello.' })];
}

export function anthropicMessages(body: string, res: ServerResponse) {
  const req = JSON.parse(body) as Req;
  const content = respond(req);
  const usage = { input_tokens: 1200, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const events: object[] = [
    { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: req.model, content: [], stop_reason: null, stop_sequence: null, usage } },
  ];
  content.forEach((b, index) => {
    if (b.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: (b as { text: string }).text } });
    } else {
      const t = b as ReturnType<typeof tool>;
      events.push({ type: 'content_block_start', index, content_block: { ...t, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage });
  events.push({ type: 'message_stop' });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_${n}` });
  res.end(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
}

/** The demo repo's files for git trees/blobs (acme-demo/* all share it). */
export const REPO_FILES: Record<string, string> = {
  'README.md': '# Demo\nRun `pnpm test`.\n',
  'src/app.ts': 'export const greet = () => "hi";\n',
};
