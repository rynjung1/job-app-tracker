import { STATUS_VALUES } from '../lib/sheetTemplate'
import type { StatusValue } from '../lib/sheetTemplate'
import { CaretIcon } from '../ui/icons'
import { Dropdown } from './Dropdown'

// Decorative dots beside each status name (the names carry the meaning).
const DOT_COLORS: Record<StatusValue, string> = {
  Applied: '#ca8a04',
  Interview: '#2563eb',
  Offer: '#16a34a',
  Rejected: '#dc2626',
  Cancelled: '#9ca3af',
}

interface StatusSelectProps {
  company: string
  status: string
  disabled: boolean
  disabledReason?: string
  busy: boolean
  onChange: (status: StatusValue) => void
}

// The row's status chip, which opens the five statuses. Picking one sends
// SET_STATUS (App.tsx); picking the current one does nothing.
export function StatusSelect({ company, status, disabled, disabledReason, busy, onChange }: StatusSelectProps) {
  const variant = (STATUS_VALUES as readonly string[]).includes(status) ? ` chip-${status.toLowerCase()}` : ''
  return (
    <Dropdown
      kind="listbox"
      width={200}
      triggerLabel={`${status || 'No status'}: change the status of ${company}`}
      triggerClassName={`chip chip-btn${variant}`}
      triggerContent={
        <>
          {busy ? 'Saving…' : status || 'No status'}
          <CaretIcon size={13} />
        </>
      }
      triggerTitle={disabled && !busy ? disabledReason : undefined}
      disabled={disabled}
      busy={busy}
      items={STATUS_VALUES.map((value) => ({
        key: value,
        label: value,
        icon: <span className="dd-dot" style={{ background: DOT_COLORS[value] }} aria-hidden="true" />,
        selected: value === status,
        onSelect: () => {
          if (value !== status) onChange(value)
        },
      }))}
      footer="Updates the Status cell in your sheet."
    />
  )
}
