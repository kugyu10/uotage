type Entry = { count: number; resetAt: number };
const entries = new Map<string, Entry>();

/** 単一インスタンス内のbot連打を抑える補助。永続的な制限は基盤側でも設定する。 */
export function allowRegistration(key: string, now = Date.now()): boolean {
  const current = entries.get(key);
  if (!current || current.resetAt <= now) {
    entries.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (current.count >= 5) return false;
  current.count += 1;
  return true;
}
