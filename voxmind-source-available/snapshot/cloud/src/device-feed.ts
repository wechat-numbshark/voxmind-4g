/** The original firmware has 3072 bytes including the terminating NUL.
 * Protocol 2 uses a bounded 16KiB receive buffer. Keep headroom for evolution. */
export const DEVICE_FEED_BYTES = { legacy: 3071, v2: 12287 } as const;

interface FeedRow { t: string; n: string; s: string; a: string; e: string }
interface Feed {
  receipts: (FeedRow & { i: string })[];
  timeline: FeedRow[];
  today: { recordedSec: number; sentences: number; done: number };
}

/** Budget serialized UTF-8 bytes, including JSON escaping. Keep newest receipts
 * and their titles first; old firmware can consult full details on the web. */
export function fitDeviceFeed(feed: Feed, budget: number): Feed {
  const result: Feed = { ...feed, receipts: feed.receipts.map((r) => ({ ...r })), timeline: feed.timeline.map((r) => ({ ...r })) };
  const fits = () => Buffer.byteLength(JSON.stringify(result), "utf8") <= budget;
  if (fits()) return result;
  for (const row of result.timeline) row.e = "";
  if (fits()) return result;
  for (const row of result.receipts) row.e = [...row.e].slice(0, 29).join("") + (row.e.length > 29 ? "…" : "");
  while (!fits() && result.timeline.length) result.timeline.pop();
  while (!fits() && result.receipts.length) result.receipts.pop();
  return result;
}
