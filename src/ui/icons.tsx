import type { ReactNode } from 'react'

// Inline SVG icons shared by the popup and the Settings page. Decorative
// only: every control that uses one has its own text or aria-label.
interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 18, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      {children}
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  )
}

export function TickIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  )
}

export function GearIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path fill="none" stroke="currentColor" strokeWidth={1.8} d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinejoin="round"
        d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.7 7.7 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.7 7.7 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.7 7.7 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.7 7.7 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.6Z"
      />
    </Svg>
  )
}

export function SheetIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth={1.8} />
      <path d="M4 9h16M4 15h16M10 9v12" stroke="currentColor" strokeWidth={1.8} />
    </Svg>
  )
}

export function WarnIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={2} />
      <path d="M12 7.5v5.5M12 16.2v.3" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  )
}
