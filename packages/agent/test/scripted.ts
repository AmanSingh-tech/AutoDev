import type { ContentBlock, GatewayRequest, LlmResponse } from '@autodev/llm';

let n = 0;
export const toolUse = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: `tu_${++n}`, name, input });
export const text = (t: string): ContentBlock => ({ type: 'text', text: t });

/** A fake model that replays scripted turns and records every request it got. */
export function scripted(turns: ContentBlock[][]) {
  const requests: GatewayRequest[] = [];
  let i = 0;
  return {
    requests,
    call: async (req: GatewayRequest): Promise<{ response: LlmResponse }> => {
      requests.push(structuredClone(req));
      const content = turns[i++] ?? [text('(script exhausted)')];
      const stopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
      return { response: { model: 'claude-opus-5-5', content, stopReason, usage: [], requestId: null } };
    },
  };
}

export const PLAN = `# Plan
## Approach
Do it.
## Files to change
- \`src/app.ts\`
- \`src/app.test.ts\`
## Risks
None.
## Open questions
None.`;
