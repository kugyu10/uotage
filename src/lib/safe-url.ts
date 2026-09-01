/** オペレーター入力のURLを href / iframe src に出す前の安全確認。http(s) 以外（javascript: 等）を拒否する。 */
export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
