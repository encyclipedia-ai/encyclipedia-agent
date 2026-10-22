/**
 * Section downloads may overlap. A burst of YouTube player requests comes
 * back as 403, so two slots start a second apart. A block drops the gate
 * back to one download until the caller opens it again.
 */
export const DOWNLOAD_SLOTS = 2;
export const DOWNLOAD_START_GAP_MS = 1_000;

type Resolver<T> = (value: T) => void;

export type DownloadGate = {
  shared<T>(fn: () => Promise<T>): Promise<T>;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  noteBlocked(): void;
  allowParallel(): void;
  readonly serial: boolean;
};

export function createDownloadGate(input: {
  slots?: number;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): DownloadGate {
  const slots = Math.max(1, input.slots ?? DOWNLOAD_SLOTS);
  const gapMs = Math.max(0, input.gapMs ?? DOWNLOAD_START_GAP_MS);
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;

  let active = 0;
  let serial = false;
  let exclusiveDepth = 0;
  let lastStartAt = Number.NEGATIVE_INFINITY;
  const sharedWaiters: Array<Resolver<number>> = [];
  const exclusiveWaiters: Array<Resolver<void>> = [];

  const limit = () => (serial ? 1 : slots);

  const reserve = (): number => {
    const current = now();
    const startAt = Math.max(current, lastStartAt + gapMs);
    lastStartAt = startAt;
    return startAt - current;
  };

  const settle = (): void => {
    if (exclusiveDepth > 0) return;
    if (exclusiveWaiters.length > 0) {
      if (active === 0) {
        exclusiveDepth = 1;
        active = 1;
        exclusiveWaiters.shift()?.();
      }
      return;
    }
    while (active < limit() && sharedWaiters.length > 0) {
      active += 1;
      const waitMs = reserve();
      sharedWaiters.shift()?.(waitMs);
    }
  };

  return {
    get serial() {
      return serial;
    },
    noteBlocked() {
      serial = true;
    },
    allowParallel() {
      serial = false;
      settle();
    },
    async shared<T>(fn: () => Promise<T>): Promise<T> {
      let waitMs: number;
      if (exclusiveDepth === 0 && exclusiveWaiters.length === 0 && active < limit()) {
        active += 1;
        waitMs = reserve();
      } else {
        waitMs = await new Promise<number>((resolve) => {
          sharedWaiters.push(resolve);
          settle();
        });
      }
      if (waitMs > 0) await sleep(waitMs);
      try {
        return await fn();
      } finally {
        active -= 1;
        settle();
      }
    },
    async exclusive<T>(fn: () => Promise<T>): Promise<T> {
      if (exclusiveDepth > 0) {
        exclusiveDepth += 1;
        try {
          return await fn();
        } finally {
          exclusiveDepth -= 1;
        }
      }
      await new Promise<void>((resolve) => {
        exclusiveWaiters.push(resolve);
        settle();
      });
      try {
        return await fn();
      } finally {
        exclusiveDepth = 0;
        active -= 1;
        settle();
      }
    },
  };
}

export const downloadGate = createDownloadGate();
