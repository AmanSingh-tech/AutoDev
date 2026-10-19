import { LlmBlocked, type LlmGateway } from '@autodev/llm';
import { describe, expect, it } from 'vitest';
import { scripted, text, toolUse } from '../test/scripted';
import { CHECK_TOOL, checkTaskDraft, PromptGuideError, REWRITE_TOOL, rewriteTaskDraft } from './prompt-guide';

const DRAFT = {
  repoFullName: 'acme/web',
  title: 'Fix login',
  descriptionMd: 'It breaks sometimes.',
  acceptanceCriteriaMd: '',
  scopePath: 'apps/web',
};
const CTX = { orgId: 'org-1', userId: 'user-1', repoId: 'repo-1' };
const CHECK = {
  score: 35,
  summary: 'Needs a clear failure and a check.',
  flags: ['missing_repro', 'missing_acceptance_criteria'],
  suggestions: ['Say which error users see.'],
};
const REWRITE = {
  title: 'Fix login failure on expired sessions',
  descriptionMd: 'Users are logged out. [TODO: which error?]',
  acceptanceCriteriaMd: '- Expired sessions redirect to sign-in',
};

/** A gateway double: budget is allowed unless `blocked` is set, and calls go to the scripted model. */
function gatewayWith(turns: ReturnType<typeof scripted>, blocked = false) {
  const useCases: string[] = [];
  const gateway = {
    assertRunAllowed: async (_o: string, _u: string, useCase: string) => {
      useCases.push(useCase);
      if (blocked) throw new LlmBlocked('budget_exceeded', 'The monthly AI budget is used up.');
    },
    call: (ctx: { useCase: string }, req: never) => {
      useCases.push(ctx.useCase);
      return turns.call(req);
    },
  } as unknown as Pick<LlmGateway, 'assertRunAllowed' | 'call'>;
  return { gateway, useCases };
}

describe('checkTaskDraft', () => {
  it('returns the check submitted through the tool, under the prompt_check policy', async () => {
    const turns = scripted([[toolUse(CHECK_TOOL.name, CHECK)]]);
    const { gateway, useCases } = gatewayWith(turns);

    expect(await checkTaskDraft(gateway, CTX, DRAFT)).toEqual(CHECK);
    const req = turns.requests[0]!;
    expect(req.tools).toEqual([CHECK_TOOL]);
    expect(JSON.stringify(req.messages)).toContain('Title: Fix login');
    expect(JSON.stringify(req.messages)).toContain('Limited to folder: apps/web');
    expect(JSON.stringify(req.messages)).toContain('(empty)');
    expect(useCases).toEqual(['prompt_check', 'prompt_check']);
  });

  it('rejects a score outside 0–100 or an unknown flag', async () => {
    for (const bad of [{ ...CHECK, score: 140 }, { ...CHECK, flags: ['nope'] }]) {
      const turns = scripted([[toolUse(CHECK_TOOL.name, bad)]]);
      await expect(checkTaskDraft(gatewayWith(turns).gateway, CTX, DRAFT)).rejects.toBeInstanceOf(PromptGuideError);
    }
  });

  it('fails instead of showing a half-formed answer when the model skips the tool', async () => {
    const turns = scripted([[text('Looks fine to me.')]]);
    await expect(checkTaskDraft(gatewayWith(turns).gateway, CTX, DRAFT)).rejects.toBeInstanceOf(PromptGuideError);
  });

  it('does not call the model when the budget is used up', async () => {
    const turns = scripted([[toolUse(CHECK_TOOL.name, CHECK)]]);
    await expect(checkTaskDraft(gatewayWith(turns, true).gateway, CTX, DRAFT)).rejects.toBeInstanceOf(LlmBlocked);
    expect(turns.requests).toHaveLength(0);
  });
});

describe('rewriteTaskDraft', () => {
  it('returns the rewrite submitted through the tool', async () => {
    const turns = scripted([[toolUse(REWRITE_TOOL.name, REWRITE)]]);
    expect(await rewriteTaskDraft(gatewayWith(turns).gateway, CTX, DRAFT)).toEqual(REWRITE);
    expect(turns.requests[0]!.tools).toEqual([REWRITE_TOOL]);
  });

  it('rejects a rewrite with an empty title', async () => {
    const turns = scripted([[toolUse(REWRITE_TOOL.name, { ...REWRITE, title: '  ' })]]);
    await expect(rewriteTaskDraft(gatewayWith(turns).gateway, CTX, DRAFT)).rejects.toBeInstanceOf(PromptGuideError);
  });
});
