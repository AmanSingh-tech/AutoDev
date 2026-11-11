import { eq, sql } from 'drizzle-orm';
import type { SystemDb, Tx } from '../client';
import { orgs } from '../schema';

/**
 * What does the agent's thinking for an org's tasks, kept in `orgs.settings.agent.engine`:
 *   'api'         AutoDev's own agent, calling a model with the org's API key (the default);
 *   'claude_code' the Claude Code on the task owner's builder, with that person's own sign-in.
 */
export const AGENT_ENGINES = ['api', 'claude_code'] as const;
export type AgentEngine = (typeof AGENT_ENGINES)[number];

export function agentEngineOf(settings: Record<string, unknown> | null | undefined): AgentEngine {
  const engine = (settings?.agent as { engine?: unknown } | undefined)?.engine;
  return engine === 'claude_code' ? 'claude_code' : 'api';
}

export async function agentEngine(db: SystemDb | Tx, orgId: string): Promise<AgentEngine> {
  const [o] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  return agentEngineOf(o?.settings);
}

export async function setAgentEngine(db: SystemDb | Tx, orgId: string, engine: AgentEngine) {
  await db
    .update(orgs)
    .set({ settings: sql`jsonb_set(${orgs.settings}, '{agent}', coalesce(${orgs.settings} -> 'agent', '{}'::jsonb) || ${JSON.stringify({ engine })}::jsonb)` })
    .where(eq(orgs.id, orgId));
}
