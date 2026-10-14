import type { Prisma } from '@/lib/db/prisma';

/** Trusted invocation-context check awaited inside the banking write transaction. */
export type ExecutionFenceCheck = (client: Prisma.TransactionClient) => Promise<void>;
