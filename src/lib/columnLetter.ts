// The Sheets API addresses columns by letter, not index — A, B, ... Z, AA,
// AB, ... Standard base-26 (no zero digit) conversion, correct past 26
// columns even though this project only has 8 right now.
export function columnIndexToLetter(index: number): string {
  let letter = ''
  let n = index
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter
    n = Math.floor(n / 26) - 1
  }
  return letter
}
