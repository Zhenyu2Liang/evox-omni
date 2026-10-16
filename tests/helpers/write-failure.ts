/**
 * tests/helpers/write-failure.ts — inject a failure into exactly ONE `model.method` call INSIDE the
 * SDK's interactive Prisma transaction, so money-movement ROLLBACK can be proven for real: the REAL
 * `$transaction` is still used, so the earlier write GENUINELY rolls back instead of the outcome
 * being faked.
 *
 * WHY a Proxy and not `vi.spyOn`: `vi.spyOn` + `restoreAllMocks` does NOT round-trip Prisma's
 * `$transaction` (a later read comes back `undefined`), so the patched method is installed/restored
 * with `Object.defineProperty`. Every NON-injected call is forwarded to the real `tx`, so only the
 * chosen `model.method` fails.
 *
 * Shared by the banking-sdk atomicity, investment-flow and card-replacement regression specs:
 * `tests/unit/banking-sdk/atomicity.test.ts`, `investment-flow.test.ts` and
 * `card-replacement.test.ts`. Pure test infra — it contains no business logic and never touches
 * the app code under test.
 */
import { getTestPrisma } from './db';

/** The structural part of the Prisma client this helper patches. */
interface TxRunner {
  $transaction: (arg: unknown) => Promise<unknown>;
}

/** What the injected method does when called — it must throw (a bare Error or a typed `AppError`). */
export type FailureThrower = () => never;

/** The default injection: a bare (non-SDK) error, i.e. an unexpected infrastructure failure. */
export function injectedBareFailure(model: string, method: string): FailureThrower {
  return () => {
    throw new Error(`injected failure: ${model}.${method}`);
  };
}

/**
 * Wrap the interactive transaction's `tx` so `model.method` throws; every other access is forwarded
 * to the REAL `tx`. Because the real transaction is still used, any earlier write in the unit is
 * genuinely rolled back when the injected method throws.
 */
export function injectWriteFailure(
  tx: unknown,
  model: string,
  method: string,
  fail: FailureThrower,
): unknown {
  return new Proxy(tx as object, {
    get(target, prop) {
      if (prop === model) {
        const modelClient = Reflect.get(target, prop) as object;
        return new Proxy(modelClient, {
          get(modelTarget, modelProp) {
            if (modelProp === method) {
              return () => {
                fail();
              };
            }
            const value = Reflect.get(modelTarget, modelProp);
            return typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(modelTarget)
              : value;
          },
        });
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Run `work` with `model.method` throwing inside the SDK's interactive transaction. */
export async function withInjectedWriteFailure<T>(
  model: string,
  method: string,
  work: () => Promise<T>,
  fail: FailureThrower = injectedBareFailure(model, method),
): Promise<T> {
  const client = getTestPrisma() as unknown as TxRunner;
  const original = client.$transaction;
  if (typeof original !== 'function') {
    throw new Error('withInjectedWriteFailure: client.$transaction is not a function');
  }
  const injected: TxRunner['$transaction'] = (arg: unknown) =>
    original.call(client, (tx: unknown) =>
      (arg as (client: unknown) => Promise<unknown>)(injectWriteFailure(tx, model, method, fail)),
    );

  // Install/restore the mock ourselves via `defineProperty` — `vi.spyOn` + `restoreAllMocks`
  // does NOT round-trip Prisma's `$transaction` (a later read comes back `undefined`).
  Object.defineProperty(client, '$transaction', {
    value: injected,
    configurable: true,
    writable: true,
  });
  try {
    return await work();
  } finally {
    Object.defineProperty(client, '$transaction', {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}
