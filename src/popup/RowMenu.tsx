import { DotsIcon, ExternalIcon, PencilIcon } from '../ui/icons'
import { Dropdown } from './Dropdown'
import type { DropdownItem } from './Dropdown'

interface RowMenuProps {
  entryId: string
  company: string
  // Already checked by safeJobUrl; null hides "Open job posting".
  url: string | null
  signedOut: boolean
  onChangeResume: () => void
}

// The row's ⋯ menu: Change resume version, Open job posting. Status changes
// live only in the status chip. The button's id (more-<entry id>) is where
// focus returns after the resume editor closes.
export function RowMenu({ entryId, company, url, signedOut, onChangeResume }: RowMenuProps) {
  const items: DropdownItem[] = [
    {
      key: 'resume',
      label: 'Change resume version',
      icon: <PencilIcon size={16} />,
      disabled: signedOut,
      title: signedOut ? 'Reconnect Google Sheets first' : undefined,
      onSelect: onChangeResume,
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
