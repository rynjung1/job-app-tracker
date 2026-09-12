// Converts an ISO timestamp (what buildRow writes) to a spreadsheet date
// serial: whole days since 1899-12-30, the epoch Google Sheets and Excel
// both use, with the time of day as the fraction. A serial carries no
// timezone of its own and is displayed as-is, so it's shifted to the
// browser's local wall clock first.
//
// The offset is taken from the timestamp being converted, not from the
// current time: a row queued before a DST change and drained after it must
// still show the local time the user actually applied.
//
// Floored to the minute first: Sheets rounds an hh:mm display to the
// nearest minute (confirmed live: 12:00:59.9 showed as 12:01), so without
// this anything from hh:mm:30 on shows the next minute, and 23:59:30 or
// later shows the next day.
const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000
const UNIX_EPOCH_SERIAL = 25569 // serial of 1970-01-01

export function isoToLocalDateSerial(iso: string): number | undefined {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return undefined
  const ms = Math.floor(parsed / MS_PER_MINUTE) * MS_PER_MINUTE
  const offsetMinutes = new Date(ms).getTimezoneOffset()
  return (ms - offsetMinutes * MS_PER_MINUTE) / MS_PER_DAY + UNIX_EPOCH_SERIAL
}
