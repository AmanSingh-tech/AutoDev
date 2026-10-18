import { http, HttpResponse } from 'msw';

export const ANTHROPIC = 'http://anthropic.test';

/** Builds an SSE body the SDK's stream parser accepts. */
export function sse(events: { event: string; data: object }[]) {
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify({ type: e.event, ...e.data })}\n\n`).join('');
  return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test_1' } });
}

export function messageStream(opts: {
  model?: string;
  content: object[];
  stopReason?: string;
  usage?: object;
}) {
  const model = opts.model ?? 'claude-opus-5-5';
  const usage = opts.usage ?? { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  return sse([
    {
      event: 'message_start',
      data: {
        // Like the real API: input and cache usage arrive in message_start, output in message_delta.
        message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
      },
    },
    ...opts.content.flatMap((block, index) => {
      const b = block as { type: string; text?: string; input?: unknown };
      if (b.type === 'text') {
        return [
          { event: 'content_block_start', data: { index, content_block: { type: 'text', text: '' } } },
          { event: 'content_block_delta', data: { index, delta: { type: 'text_delta', text: b.text } } },
          { event: 'content_block_stop', data: { index } },
        ];
      }
      if (b.type === 'tool_use') {
        return [
          { event: 'content_block_start', data: { index, content_block: { ...b, input: {} } } },
          { event: 'content_block_delta', data: { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } } },
          { event: 'content_block_stop', data: { index } },
        ];
      }
      return [
        { event: 'content_block_start', data: { index, content_block: block } },
        { event: 'content_block_stop', data: { index } },
      ];
    }),
    { event: 'message_delta', data: { delta: { stop_reason: opts.stopReason ?? 'end_turn', stop_sequence: null }, usage } },
    { event: 'message_stop', data: {} },
  ]);
}

export const apiError = (status: number, type: string) =>
  HttpResponse.json({ type: 'error', error: { type, message: `mock ${type}` } }, { status });

export const modelsOk = () =>
  http.get(`${ANTHROPIC}/v1/models`, () => HttpResponse.json({ data: [{ id: 'claude-opus-5-5', type: 'model' }], has_more: false }));
