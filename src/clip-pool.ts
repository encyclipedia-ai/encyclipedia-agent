/**
 * Download and Gemini-check a few windows at once, then hand them to the
 * cropper in stream order. Three is enough to hide the wait without
 * sending every moment to Gemini at the same time.
 */
export const CLIP_CHECK_POOL = 3;

export function rememberCategory(names: string[], category: string | undefined): void {
  const name = category?.trim();
  if (!name) return;
  if (names.some((known) => known.toLowerCase() === name.toLowerCase())) return;
  names.push(name);
}

/**
 * Keep `limit` calls of `start` running. `finish` runs in index order, so
 * a later window can be checked before an earlier one is handed to the cropper.
 */
export async function runOrderedPool<T>(input: {
  count: number;
  limit: number;
  start: (index: number) => Promise<T>;
  finish: (index: number, value: T) => Promise<void>;
}): Promise<void> {
  if (input.count <= 0) return;
  const limit = Math.max(1, Math.min(input.limit, input.count));
  const pending = new Map<number, Promise<{ ok: true; value: T } | { ok: false; error: unknown }>>();
  let next = 0;
  const launch = () => {
    while (pending.size < limit && next < input.count) {
      const index = next;
      next += 1;
      pending.set(
        index,
        input.start(index).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
    }
  };
  launch();
  for (let index = 0; index < input.count; index += 1) {
    const settled = await pending.get(index)!;
    pending.delete(index);
    if (!settled.ok) throw settled.error;
    await input.finish(index, settled.value);
    launch();
  }
}
