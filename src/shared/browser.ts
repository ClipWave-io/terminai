export interface BrowserTab { id: string; url: string; title: string; profileId: string; group: string; owner: string }
export interface BrowserProfile { id: string; name: string; private?: boolean }
export interface BrowserState {
  url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error: string
  tabs?: BrowserTab[]; profiles?: BrowserProfile[]; activeId?: string; profileId?: string; owner?: string
}
export function browserUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw new Error('Enter a web address.')
  const input = value.trim()
  // As in Chrome: words, or a name without a dot ("google"), are a search; hosts, IPs and localhost are addresses.
  const scheme = /^[a-z][a-z\d+.-]*:/i.test(input) && !/^(localhost|[^\s/:]+\.[^\s/:]+):\d/i.test(input)
  const host = /^(localhost|\[[\da-f:.]+\]|\d{1,3}(\.\d{1,3}){3}|[^\s/:?#]+\.[a-z\d-]{2,})(:\d+)?([/?#]|$)/i.test(input)
  if (!scheme && (/\s/.test(input) || !host)) return `https://www.google.com/search?q=${encodeURIComponent(input)}`
  const candidate = scheme
    ? input : `${/^localhost(?::|\/|$)|^127\.0\.0\.1(?::|\/|$)/i.test(input) ? 'http' : 'https'}://${input}`
  const url = new URL(candidate)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS addresses without embedded credentials are allowed.')
  return url.href
}
