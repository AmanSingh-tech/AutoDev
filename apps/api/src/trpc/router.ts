import { agentRouter } from './routers/agent';
import { chatRouter } from './routers/chat';
import { codeIndexRouter } from './routers/code-index';
import { budgetsRouter } from './routers/budgets';
import { buildersRouter } from './routers/builders';
import { llmKeysRouter } from './routers/llm-keys';
import { meRouter } from './routers/me';
import { membersRouter } from './routers/members';
import { modelsRouter } from './routers/models';
import { notificationsRouter } from './routers/notifications';
import { billingRouter } from './routers/billing';
import { onboardingRouter } from './routers/onboarding';
import { groupAgentRouter } from './routers/group-agent';
import { insightsRouter } from './routers/insights';
import { promptGuideRouter } from './routers/prompt-guide';
import { repoAgentRouter } from './routers/repo-agent';
import { repoLinksRouter } from './routers/repo-links';
import { roomRouter } from './routers/room';
import { orgsRouter } from './routers/orgs';
import { githubRouter, installationsRouter, reposRouter } from './routers/repos';
import { tasksRouter } from './routers/tasks';
import { teamsRouter } from './routers/teams';
import { usageRouter } from './routers/usage';
import { createCallerFactory, router } from './trpc';

export const appRouter = router({
  me: meRouter,
  orgs: orgsRouter,
  members: membersRouter,
  teams: teamsRouter,
  repos: reposRouter,
  installations: installationsRouter,
  github: githubRouter,
  llmKeys: llmKeysRouter,
  models: modelsRouter,
  budgets: budgetsRouter,
  usage: usageRouter,
  notifications: notificationsRouter,
  tasks: tasksRouter,
  agent: agentRouter,
  builders: buildersRouter,
  chat: chatRouter,
  promptGuide: promptGuideRouter,
  insights: insightsRouter,
  groupAgent: groupAgentRouter,
  billing: billingRouter,
  onboarding: onboardingRouter,
  room: roomRouter,
  repoAgent: repoAgentRouter,
  codeIndex: codeIndexRouter,
  repoLinks: repoLinksRouter,
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
