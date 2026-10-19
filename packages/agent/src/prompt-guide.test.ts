import { LlmBlocked, type LlmGateway } from '@autodev/llm';
import { describe, expect, it } from 'vitest';
import { scripted, text, toolUse } from '../test/scripted';
import { PromptGuideError, REVIEW_TOOL, reviewTaskDraft } from './prompt-guide';

const DRAFT = {
  repoFullName: 'acme/web',
  title: 'Fix login',
  descriptionMd: 'It breaks sometimes.',
  acceptanceCriteriaMd: '',
};
const CTX = { orgId: 'org-1', userId: 'user-1', repoId: 'repo-1' };
const REVIEW = {
  summary: 'Needs a clear failure and a check.',
  issues: [{ kind: 'missing', text: 'No expected behavior is stated.' }],
  rewrite: {
    title: 'Fix login failure on expired sessions',
    descriptionMd: 'Users are logged out. [TODO: which error?]',
    acceptanceCriteriaMd: '- Expired sessions redirect to sign-in',
  },
};

/** A gateway double: budget is allowed unless `blocked` is set, and calls go to the scripted model. */
function gatewayWith(turns: ReturnType<typeof scripted>, blocked = false) {
  return {
    assertRunAllowed: async () => {
      if (blocked) throw new LlmBlocked('budget_exceeded', 'The monthly AI budget is used up.');
    },
    call: (_ctx: unknown, req: never) => turns.call(req),
  } as unknown as Pick<LlmGateway, 'assertRunAllowed' | 'call'>;
}

describe('reviewTaskDraft', () => {
  it('returns the review the model submitted through the tool, and sends the draft as data', async () => {
    const turns = scripted([[toolUse(REVIEW_TOOL.name, REVIEW)]]);

    const review = await reviewTaskDraft(gatewayWith(turns), CTX, DRAFT);

    expect(review).toEqual(REVIEW);
    const req = turns.requests[0]!;
    expect(req.tools).toEqual([REVIEW_TOOL]);
    expect(JSON.stringify(req.messages)).toContain('Title: Fix login');
    expect(JSON.stringify(req.messages)).toContain('(empty)');
  });

  it('fails instead of showing a half-formed answer when the model skips the tool', async () => {
    const turns = scripted([[text('Looks fine to me.')]]);
    await expect(reviewTaskDraft(gatewayWith(turns), CTX, DRAFT)).rejects.toBeInstanceOf(
      PromptGuideError,
    );
  });

  it('rejects a tool answer that does not match the shape', async () => {
    const turns = scripted([
      [
        toolUse(REVIEW_TOOL.name, {
          summary: 'x',
          issues: [{ kind: 'nope', text: 'y' }],
          rewrite: {},
        }),
      ],
    ]);
    await expect(reviewTaskDraft(gatewayWith(turns), CTX, DRAFT)).rejects.toBeInstanceOf(
      PromptGuideError,
    );
  });

  it('does not call the model when the budget is used up', async () => {
    const turns = scripted([[toolUse(REVIEW_TOOL.name, REVIEW)]]);
    await expect(reviewTaskDraft(gatewayWith(turns, true), CTX, DRAFT)).rejects.toBeInstanceOf(
      LlmBlocked,
    );
    expect(turns.requests).toHaveLength(0);
  });
});
