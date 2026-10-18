import { meRouter } from './routers/me';
import { membersRouter } from './routers/members';
import { orgsRouter } from './routers/orgs';
import { githubRouter, installationsRouter, reposRouter } from './routers/repos';
import { teamsRouter } from './routers/teams';
import { createCallerFactory, router } from './trpc';

export const appRouter = router({
  me: meRouter,
  orgs: orgsRouter,
  members: membersRouter,
  teams: teamsRouter,
  repos: reposRouter,
  installations: installationsRouter,
  github: githubRouter,
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
