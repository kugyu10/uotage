/** UTAGE互換CSVはAsia/Tokyo表記を要求するため、タイムゾーン変換をここに集約する。 */

/** ISO文字列（もしくはDate）を "yyyy-MM-dd HH:mm:ss" のAsia/Tokyo表記に変換する。 */
export function formatJstDateTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * `<input type="datetime-local">` の値（タイムゾーン情報なし）を、
 * Asia/Tokyo（UTC+9、夏時間なし）の壁時計時刻として解釈しUTCのISO文字列に変換する。
 */
export function jstDatetimeLocalToUtcIso(value: string): string {
  const match = DATETIME_LOCAL_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error("INVALID_DATETIME");
  }
  const [, year, month, day, hour, minute, second] = match;
  const utcMs =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second ?? "0"),
    ) -
    9 * 60 * 60 * 1000;
  return new Date(utcMs).toISOString();
}
