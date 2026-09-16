// GMGN's own chain slugs, from the CLI shipped in this project's dependencies
// (gmgn-cli Readme §9 Supported Chains: sol / bsc / base / eth / robinhood /
// arc / stable). This is deliberately NOT the list of chains the panel watches:
// it answers whether GMGN has a page to open at all. A chain GMGN does not
// cover has to yield no link rather than a URL that lands on someone else's
// 404, and a chain it does cover has to yield one even when its prices and its
// candidates came from somewhere else entirely — where a coin was discovered
// says nothing about whether GMGN can show it.
export const GMGN_CHAINS = ['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc'];
export function gmgnTokenUrl(chain: string, address: string) {
  if (!GMGN_CHAINS.includes(chain)) return '#';
  return `https://gmgn.ai/${chain}/token/${encodeURIComponent(address)}`;
}
