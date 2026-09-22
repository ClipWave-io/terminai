export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string
}

/** Both the address bar and every remote navigation use this protocol boundary. */
export function browserUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw new Error('Enter a web address.')
  const input = value.trim()
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(input) && !/^localhost:\d/i.test(input)
    ? input : `${/^localhost(?::|\/|$)|^127\.0\.0\.1(?::|\/|$)/i.test(input) ? 'http' : 'https'}://${input}`
  const url = new URL(candidate)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS addresses without embedded credentials are allowed.')
  return url.href
}
