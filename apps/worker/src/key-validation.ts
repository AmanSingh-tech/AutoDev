import type { CredentialService } from '@autodev/llm';

/** Daily: re-checks every active and invalid LLM key (the job name is "revalidate-all"). */
export const createKeyValidationProcessor = (credentials: Pick<CredentialService, 'revalidateAll'>) => async () =>
  credentials.revalidateAll();
