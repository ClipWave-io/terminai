// Only operator-reviewed descriptors can be returned. No user-supplied shell, package, args or URL.
export function catalog(config) {
  return [
    { id: 'chrome-devtools', name: 'Chrome browsing', description: 'Inspect and browse in an isolated Chrome session on your desktop.',
      docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
      requirements: ['Node.js 22+', 'Google Chrome'], installation: { transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.9.0', '--isolated', '--no-usage-statistics'] } },
    { id: 'google-ads', name: 'Google Ads', description: 'Run the official Google Ads MCP server locally with your own Google credentials.',
      docsUrl: 'https://github.com/googleads/google-ads-mcp', requirements: ['pipx and Python', 'Personal Application Default Credentials with Google Ads scope', 'Google Cloud project with Google Ads API enabled', 'Developer token if required by your account'],
      installation: { transport: 'stdio', command: 'pipx', args: ['run', '--spec', 'git+https://github.com/googleads/google-ads-mcp.git@0b78c0caa6d1dfbd21817487c7e571514c627c87', 'google-ads-mcp'] } },
  ];
}
