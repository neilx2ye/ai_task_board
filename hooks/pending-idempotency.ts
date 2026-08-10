/**
 * Keep one idempotency key for an unconfirmed logical request. A transport or
 * 5xx failure leaves it pending; confirmed success clears it. A content change
 * starts a different logical request immediately.
 */
export function createPendingIdempotencyTracker(
  generateKey: () => string = () => crypto.randomUUID(),
) {
  let pending: { fingerprint: string; key: string } | null = null;

  return {
    keyFor(fingerprint: string): string {
      if (!pending || pending.fingerprint !== fingerprint) {
        pending = { fingerprint, key: generateKey() };
      }
      return pending.key;
    },
    confirm(fingerprint: string, key: string): void {
      if (pending?.fingerprint === fingerprint && pending.key === key) {
        pending = null;
      }
    },
  };
}
