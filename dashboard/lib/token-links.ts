export function gmgnTokenUrl(chain: string, address: string) {
  if (!['sol', 'bsc', 'base', 'eth', 'robinhood'].includes(chain)) return '#';
  return `https://gmgn.ai/${chain}/token/${encodeURIComponent(address)}`;
}
