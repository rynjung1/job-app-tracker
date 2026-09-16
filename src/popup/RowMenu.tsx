import { DotsIcon, ExternalIcon, NoteIcon, PencilIcon } from '../ui/icons'
import { Dropdown } from './Dropdown'
import type { DropdownItem } from './Dropdown'

interface RowMenuProps {
  entryId: string
  company: string
  // Already checked by safeJobUrl; null hides "Open job posting".
  url: string | null
  // Why "Change resume version" and "Add note" can't reach the sheet right
  // now (signed out, or the sheet is in the trash or deleted); null when
  // they can.
  blockedReason: string | null
  onChangeResume: () => void
  onAddNote: () => void
}

// The row's ⋯ menu: Change resume version, Add note (2026-09-15), Open job
// posting. Status changes live only in the status chip. The button's id
// (more-<entry id>) is where focus returns after an editor closes.
export function RowMenu({ entryId, company, url, blockedReason, onChangeResume, onAddNote }: RowMenuProps) {
  const items: DropdownItem[] = [
    {
      key: 'resume',
      label: 'Change resume version',
      icon: <PencilIcon size={16} />,
      disabled: blockedReason !== null,
      title: blockedReason ?? undefined,
      onSelect: onChangeResume,
    },
    {
      key: 'note',
      label: 'Add note',
      icon: <NoteIcon size={16} />,
      disabled: blockedReason !== null,
      title: blockedReason ?? undefined,
      onSelect: onAddNote,
    },
  ]
  if (url) {
    items.push({
      key: 'open',
      label: 'Open job posting',
      icon: <ExternalIcon size={16} />,
      // tabs.create needs no "tabs" permission; the popup closes as the tab opens.
      onSelect: () => {
        chrome.tabs.create({ url })
      },
    })
  }
  return (
    <Dropdown
      kind="menu"
      id={`more-${entryId}`}
      width={220}
      triggerLabel={`More actions for ${company}`}
      triggerClassName="more"
      triggerContent={<DotsIcon size={18} />}
      items={items}
    />
  )
}
