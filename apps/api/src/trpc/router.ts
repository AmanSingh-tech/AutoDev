import { budgetsRouter } from './routers/budgets';
import { llmKeysRouter } from './routers/llm-keys';
import { meRouter } from './routers/me';
import { membersRouter } from './routers/members';
import { modelsRouter } from './routers/models';
import { notificationsRouter } from './routers/notifications';
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
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
