export type RoleType = 'SWE' | 'DE' | 'unknown'

// Hardcoded, not configurable — CLAUDE.md's options-page responsibilities
// don't list resume/keyword configuration, so this matches what's actually
// specified rather than adding settings UI that wasn't asked for. Revisit
// if that changes.
const ROLE_TYPE_KEYWORDS: Record<'SWE' | 'DE', string[]> = {
  SWE: [
    'software engineer',
    'software developer',
    'swe',
    'full stack',
    'fullstack',
    'backend',
    'back-end',
    'frontend',
    'front-end',
  ],
  DE: ['data engineer', 'data engineering', 'analytics engineer', 'etl'],
}

// First match wins if a title matches both (order: SWE, then DE) — a real
// but rare edge case (e.g. "Software Engineer, Data Engineering team"),
// not worth more than this for a two-category personal-use classifier.
export function inferRoleType(title: string): RoleType {
  const normalized = title.toLowerCase()
  for (const roleType of Object.keys(ROLE_TYPE_KEYWORDS) as Array<'SWE' | 'DE'>) {
    if (ROLE_TYPE_KEYWORDS[roleType].some((keyword) => normalized.includes(keyword))) {
      return roleType
    }
  }
  return 'unknown'
}
