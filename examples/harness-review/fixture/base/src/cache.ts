const store = new Map<string, { value: string; expires: number }>();

export async function getOrLoad(key: string, load: () => Promise<string>, ttlMs: number): Promise<string> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await load();
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}
