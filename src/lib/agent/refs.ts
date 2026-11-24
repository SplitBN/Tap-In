// References between the actions of one request_changes call (docs/agent-contract.md → "Multi-step requests"):
// a later action's input may hold a string "$<index>.<path>" — index = 0-based position of an EARLIER action in the
// same request, path = dot path into that action's result ("$0.id", "$1.items.-1.key"; negative array indexes count
// from the end). The whole string must be the ref, and the path needs at least one field name, so "$0.50" stays text.
// Refs are resolved at apply time, in order; until then they stay in the input as plain strings (they pass string /
// id schemas, so the card can be validated and shown before anything exists).

export type Ref = { index: number; path: string[] };
const SEG = /^(-?\d+|[A-Za-z_]\w*)$/;

export function parseRef(v: unknown): Ref | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/^\$(\d+)\.(.+)$/);
  if (!m) return null;
  const path = m[2].split('.');
  if (!path.every((s) => SEG.test(s)) || !path.some((s) => /^[A-Za-z_]/.test(s))) return null;
  return { index: Number(m[1]), path };
}
export const isRef = (v: unknown): v is string => parseRef(v) !== null;

/** Every ref string in a value (deep). */
export function refsIn(v: unknown, out: string[] = []): string[] {
  if (isRef(v)) out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => refsIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => refsIn(x, out));
  return out;
}

/** Deep copy with every ref replaced by fn(ref) (may be async). */
export async function mapRefs(v: unknown, fn: (ref: string) => unknown | Promise<unknown>): Promise<unknown> {
  if (isRef(v)) return fn(v);
  if (Array.isArray(v)) return Promise.all(v.map((x) => mapRefs(x, fn)));
  if (v && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await mapRefs(x, fn)] as const)));
  return v;
}

/** Value at a path of a result; undefined when missing. */
export function atPath(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur) && /^-?\d+$/.test(seg)) { const i = Number(seg); cur = cur[i < 0 ? cur.length + i : i]; }
    else cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Problems with the refs of action `i` before anything runs (refs must point at an earlier action). */
export function refErrors(input: unknown, i: number, total: number): string[] {
  return refsIn(input).flatMap((r) => {
    const { index } = parseRef(r)!;
    return index >= i || index >= total ? [`"${r}" must refer to an earlier action of this request (0-based index below ${i})`] : [];
  });
}

/** Substitute the results of earlier actions. Throws a readable error when a ref can't be resolved. */
export async function resolveRefs(input: Record<string, unknown>, outputs: ReadonlyMap<number, { name: string; result?: unknown; ok: boolean }>): Promise<Record<string, unknown>> {
  return (await mapRefs(input, (r) => {
    const { index, path } = parseRef(r)!;
    const o = outputs.get(index);
    if (!o) throw new Error(`"${r}": action $${index} was not applied (unchecked on the card)`);
    if (!o.ok) throw new Error(`"${r}": action $${index} (${o.name}) failed`);
    const v = atPath(o.result, path);
    if (v === undefined || v === null) throw new Error(`"${r}": the result of action $${index} (${o.name}) has no ${path.join('.')}`);
    return v;
  })) as Record<string, unknown>;
}
