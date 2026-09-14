import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { TickIcon } from '../ui/icons'

export interface DropdownItem {
  key: string
  label: ReactNode
  icon?: ReactNode
  selected?: boolean
  disabled?: boolean
  title?: string
  onSelect: () => void
}

interface DropdownProps {
  kind: 'menu' | 'listbox'
  id?: string
  triggerLabel: string
  triggerClassName: string
  triggerContent: ReactNode
  triggerTitle?: string
  disabled?: boolean
  busy?: boolean
  items: DropdownItem[]
  footer?: ReactNode
  width: number
}

// A button that opens a small menu (kind 'menu', the ARIA menu button
// pattern: the row's ⋯) or a single-choice list (kind 'listbox': the status
// chip). Keyboard: ArrowDown/ArrowUp, or Enter/Space through the button's
// click, open it; inside, ArrowUp/ArrowDown move, Home/End jump, Enter/Space
// choose, Esc closes and returns focus to the button, Tab closes. A click
// outside closes it.
//
// Positioned fixed, so the list's scroll box doesn't clip it. It opens
// below the button, or above when there's no room below; when neither fits
// (a popup with one or two rows), the page grows by the missing height
// while it's open, since Chrome sizes the popup to its content.
export function Dropdown(props: DropdownProps) {
  const { kind, id, triggerLabel, triggerClassName, triggerContent, triggerTitle, disabled, busy, items, footer, width } =
    props
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const popId = useId()

  const startIndex = () => Math.max(0, items.findIndex((item) => item.selected))

  function openAt(index: number) {
    setActive(index)
    setOpen(true)
  }

  function close(returnFocus: boolean) {
    setOpen(false)
    setPos(null)
    document.body.style.minHeight = ''
    if (returnFocus) triggerRef.current?.focus()
  }

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !popRef.current) return
    const button = triggerRef.current.getBoundingClientRect()
    const height = popRef.current.offsetHeight
    let top = button.bottom + 4
    if (top + height > window.innerHeight - 4) {
      if (button.top - height - 4 >= 4) top = button.top - height - 4
      else document.body.style.minHeight = `${Math.ceil(top + height + 8 + window.scrollY)}px`
    }
    setPos({ top, left: Math.max(4, Math.min(button.right - width, window.innerWidth - width - 4)) })
  }, [open, width])

  useEffect(() => {
    if (open && pos) itemRefs.current[active]?.focus()
  }, [open, pos, active])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
      setPos(null)
      document.body.style.minHeight = ''
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  function choose(index: number) {
    const item = items[index]
    if (!item || item.disabled) return
    close(true)
    item.onSelect()
  }

  function onTriggerKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openAt(startIndex())
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAt(kind === 'listbox' ? startIndex() : items.length - 1)
    }
  }

  function onPopKeyDown(event: KeyboardEvent) {
    const count = items.length
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((a) => (a + 1) % count)
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((a) => (a - 1 + count) % count)
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(count - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(active)
        break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        close(true)
        break
      case 'Tab':
        close(false)
        break
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={triggerClassName}
        aria-label={triggerLabel}
        title={triggerTitle}
        aria-haspopup={kind}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-busy={busy || undefined}
        disabled={disabled}
        onClick={() => (open ? close(true) : openAt(startIndex()))}
        onKeyDown={onTriggerKeyDown}
      >
        {triggerContent}
      </button>
      {open && (
        <div
          ref={popRef}
          id={popId}
          role={kind}
          aria-label={triggerLabel}
          className="dd"
          style={{ width, top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          onKeyDown={onPopKeyDown}
        >
          {items.map((item, i) => (
            <button
              key={item.key}
              ref={(el) => {
                itemRefs.current[i] = el
              }}
              type="button"
              role={kind === 'menu' ? 'menuitem' : 'option'}
              aria-selected={kind === 'listbox' ? Boolean(item.selected) : undefined}
              aria-disabled={item.disabled || undefined}
              title={item.title}
              tabIndex={i === active ? 0 : -1}
              className={`dd-item${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              {item.icon}
              <span className="dd-label">{item.label}</span>
              {item.selected && <TickIcon size={15} className="dd-check" />}
            </button>
          ))}
          {footer && <div className="dd-foot">{footer}</div>}
        </div>
      )}
    </>
  )
}
