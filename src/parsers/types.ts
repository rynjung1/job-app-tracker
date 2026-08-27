export interface JobPostingData {
  title: string
  company: string
  location: string | null
  url: string
}

export interface JobPageParser {
  siteId: string
  detect(): boolean
  extract(): JobPostingData | null
  getApplyButtonSelector(): string
}
