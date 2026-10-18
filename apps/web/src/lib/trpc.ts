'use client';

import type { AppRouter } from '@autodev/api/router';
import { createTRPCReact, type inferReactQueryProcedureOptions } from '@trpc/react-query';
import type { inferRouterOutputs } from '@trpc/server';

export const trpc = createTRPCReact<AppRouter>();
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type ReactQueryOptions = inferReactQueryProcedureOptions<AppRouter>;

/**
 * The org the UI is currently in, sent as x-org-id on every request.
 * The API checks membership on each call, so this is a routing hint, not an authorization.
 */
let currentOrgId: string | null = null;
export const setCurrentOrgId = (id: string | null) => {
  currentOrgId = id;
};
export const getCurrentOrgId = () => currentOrgId;
