// The Summary tab (2026-09-16): what createSheet sends for it, that its
// formulas address the applications tab by name with columns taken from the
// template, and that no other provider call ever names it.
import { ctl, HEADERS_WITH_LOG_ID, log, reset, sheet } from './fakes/background-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { googleSheetsProvider, summarySheetIdFor } from '../src/providers/googleSheets'
import { SHEET_TEMPLATE_COLUMNS } from '../src/lib/sheetTemplate'

const REF = { spreadsheetId: 'sheet1', sheetName: 'Sheet1', sheetId: 0 }
/* eslint-disable @typescript-eslint/no-explicit-any */
const batch = () => (log.batchUpdates.at(-1) ?? []) as any[]
const summaryCells = () => batch().find((r) => r.updateCells)?.updateCells
const cell = (row: number, column: number) => summaryCells().rows[row - 1]?.values?.[column - 1]
const formula = (row: number, column: number) => cell(row, column)?.userEnteredValue?.formulaValue
const text = (row: number, column: number) => cell(row, column)?.userEnteredValue?.stringValue

test('the Summary tab', async (t) => {
  reset()
  await googleSheetsProvider.createSheet([...SHEET_TEMPLATE_COLUMNS])

  await t.test('createSheet still makes three requests; the tab is added and filled in the same batch', () => {
    assert.equal(log.fetches.length, 3, `requests: ${JSON.stringify(log.fetches)}`)
    const added = batch()[0]?.addSheet?.properties
    assert.deepEqual(
      { title: added?.title, index: added?.index },
      { title: 'Summary', index: 1 },
      JSON.stringify(batch()[0]),
    )
    assert.equal(summaryCells().range.sheetId, added.sheetId)
    assert.equal(summaryCells().fields, 'userEnteredValue,userEnteredFormat,note')
  })

  await t.test('totals by status name the applications tab, with open-ended ranges from row 2', () => {
    assert.equal(text(5, 1), 'Applied')
    assert.equal(formula(5, 2), '=COUNTIF(\'Sheet1\'!$F$2:$F,"Applied")')
    assert.equal(formula(9, 2), '=COUNTIF(\'Sheet1\'!$F$2:$F,"Cancelled")')
    assert.equal(formula(10, 2), "=COUNTA('Sheet1'!$B$2:$B)")
  })

  await t.test('the week rows: each row\'s own Monday, Cancelled left out, and the bar capped at 20', () => {
    assert.equal(formula(13, 1), '=TODAY()-WEEKDAY(TODAY(),3)-7*(ROW()-13)')
    assert.equal(
      formula(13, 2),
      '=COUNTIFS(\'Sheet1\'!$A$2:$A,">="&$A13,\'Sheet1\'!$A$2:$A,"<"&$A13+7,\'Sheet1\'!$F$2:$F,"<>Cancelled")',
    )
    assert.equal(formula(14, 2).includes('$A14'), true, formula(14, 2))
    assert.equal(formula(13, 3), '=REPT("█",MIN($B13,20))')
    assert.equal(formula(20, 3), '=REPT("█",MIN($B20,20))')
    assert.equal(summaryCells().rows.length, 20)
  })

  await t.test('Pace: this week, last week and the 8-week average', () => {
    assert.equal(text(5, 4), 'This week')
    assert.equal(formula(5, 5).includes('$A13'), true, formula(5, 5))
    assert.equal(text(6, 4), 'Last week')
    assert.equal(formula(6, 5).includes('$A14'), true, formula(6, 5))
    assert.equal(formula(7, 5), '=ROUND(AVERAGE($B$13:$B$20),1)')
  })

  await t.test('the labels say where Cancelled counts, and repeat it as cell notes', () => {
    assert.equal(text(10, 3), 'includes Cancelled')
    assert.match(cell(10, 3).note, /Cancelled ones included/)
    assert.equal(text(12, 3), 'Cancelled not counted; bars cap at 20')
    assert.match(cell(12, 3).note, /the count beside it is exact/)
  })

  await t.test('column letters come from the template: a reordered template moves the ranges', async () => {
    reset()
    // Status first, then Company, then Date: the formulas must follow.
    await googleSheetsProvider.createSheet(['Status', 'Company', 'Date', 'Notes', 'Log ID'])
    assert.equal(formula(5, 2), '=COUNTIF(\'Sheet1\'!$A$2:$A,"Applied")')
    assert.equal(formula(10, 2), "=COUNTA('Sheet1'!$B$2:$B)")
    assert.equal(formula(13, 2).startsWith('=COUNTIFS(\'Sheet1\'!$C$2:$C'), true, formula(13, 2))
  })

  // Audit finding, 2026-09-17: the Summary tab's grid id used to be a
  // hardcoded 1000001 sent blind. addSheet fails the whole batch if that id
  // is taken, which would take the header formatting down with it.
  await t.test("the Summary tab's grid id is never the applications tab's own id", async () => {
    reset()
    ctl.createdSheetId = 1000001
    const created = await googleSheetsProvider.createSheet([...SHEET_TEMPLATE_COLUMNS])
    const added = batch()[0]?.addSheet?.properties
    assert.equal(created.sheetId, 1000001)
    assert.notEqual(added.sheetId, created.sheetId)
    assert.equal(summaryCells().range.sheetId, added.sheetId)
    for (const request of batch().filter((r) => r.updateDimensionProperties)) {
      const range = request.updateDimensionProperties.range
      if (range.dimension === 'COLUMNS' && range.sheetId !== created.sheetId) assert.equal(range.sheetId, added.sheetId)
    }
    assert.equal(summarySheetIdFor(0), 1000001)
    assert.notEqual(summarySheetIdFor(1000001), 1000001)
  })

  await t.test('no provider call other than createSheet ever names the Summary tab', async () => {
    reset()
    ctl.headers = HEADERS_WITH_LOG_ID
    sheet.rows[2] = ['46277.5', 'Acme', 'SWE Intern', 'Remote', 'https://example.com/1', 'SWE v3', 'Applied', '', 'id-1']
    await googleSheetsProvider.readHeaders(REF)
    await googleSheetsProvider.appendRow(REF, { Date: '2026-09-16T10:00:00.000Z', Company: 'Acme', Title: 'SWE Intern', Location: '', URL: '', Status: 'Applied', Notes: '', 'Log ID': 'id-2' })
    await googleSheetsProvider.readRow(REF, 2)
    await googleSheetsProvider.readCells(REF, [2], ['Company', 'Title', 'Status'])
    await googleSheetsProvider.readLogIds(REF)
    await googleSheetsProvider.updateCell(REF, 2, 'Status', 'Interview')
    await googleSheetsProvider.isTrashed(REF)
    const everythingSent = [...log.fetches, JSON.stringify(log.batchUpdates), JSON.stringify(sheet.writes)].join(' ')
    assert.equal(everythingSent.includes('Summary'), false, everythingSent.slice(0, 400))
    assert.ok(log.fetches.length >= 7, `calls made: ${log.fetches.length}`)
  })
})
