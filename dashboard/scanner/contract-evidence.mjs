import { validAddress } from './risk.mjs';

export const ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const ROBINHOOD_EXPLORER = 'https://robinhoodchain.blockscout.com';

export function identifyMinimalClone(code) {
  // Exact standard ERC-1167 and 0age/Solady LibClone runtimes only.
  // No match says nothing about other proxy or upgrade patterns.
  const patterns = [
    [
      'eip1167',
      /^0x363d3d373d3d3d363d73([\da-f]{40})5af43d82803e903d91602b57fd5bf3$/i,
    ],
    [
      'minimal-clone-0age',
      /^0x3d3d3d3d363d3d37363d73([\da-f]{40})5af43d3d93803e602a57fd5bf3$/i,
    ],
  ];
  for (const [type, pattern] of patterns) {
    const match = typeof code === 'string' ? code.match(pattern) : null;
    if (match)
      return {
        type,
        implementation: `0x${match[1].toLowerCase()}`,
        runtime: code,
      };
  }
  return null;
}

export function responseFor(rows, id) {
  if (!Array.isArray(rows)) throw new Error('RPC 批量响应格式无效');
  const row = rows.find((r) => r.id === id);
  if (!row || row.error) throw new Error(row?.error?.message || 'RPC 缺少响应');
  return row.result;
}

export async function readRobinhoodContract(address, request) {
  if (!validAddress('robinhood', address)) throw new Error('合约地址无效');
  const head = await request(ROBINHOOD_RPC, [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
  ]);
  if (responseFor(head, 1) !== '0x1237') throw new Error('RPC 链 ID 不匹配');
  const block = responseFor(head, 2);
  if (!/^0x[\da-f]+$/i.test(block)) throw new Error('RPC 区块编号无效');
  const rows = await request(ROBINHOOD_RPC, [
    { jsonrpc: '2.0', id: 3, method: 'eth_getCode', params: [address, block] },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'eth_call',
      params: [{ to: address, data: '0x8da5cb5b' }, block],
    },
  ]);
  const code = responseFor(rows, 3);
  if (typeof code !== 'string' || !/^0x([\da-f]{2})*$/i.test(code))
    throw new Error('RPC 字节码格式无效');
  const ownerRow = Array.isArray(rows) ? rows.find((r) => r.id === 4) : null;
  const word = ownerRow?.result;
  const owner =
    typeof word === 'string' && /^0x0{24}[\da-f]{40}$/i.test(word)
      ? `0x${word.slice(-40).toLowerCase()}`
      : null;
  return {
    address,
    block: Number(BigInt(block)),
    codePresent: code !== '0x',
    codeBytes: (code.length - 2) / 2,
    minimalProxy: identifyMinimalClone(code),
    owner,
    ownerStatus: owner ? 'returned' : 'unavailable',
    ownerError: owner
      ? null
      : 'owner() 调用失败或未返回标准 address；不能解释为已放弃所有权',
    observedAt: new Date().toISOString(),
  };
}

export function summarizeExplorer(raw, address) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.message)
    throw new Error('浏览器未返回合约资料');
  const proxyType = typeof raw.proxy_type === 'string' ? raw.proxy_type : null;
  const sourceAvailable =
    typeof raw.source_code === 'string' && raw.source_code.trim().length > 0;
  return {
    address,
    proxyType,
    sourceAvailable,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : null,
    implementations: (Array.isArray(raw.implementations)
      ? raw.implementations
      : []
    )
      .filter((i) => validAddress('robinhood', i.address_hash))
      .slice(0, 5)
      .map((i) => ({
        address: i.address_hash,
        name: typeof i.name === 'string' ? i.name.slice(0, 120) : null,
      })),
    // Absence of a selector, ABI or proxy_type never proves absence of a privilege.
    abiFunctions: (Array.isArray(raw.abi) ? raw.abi : [])
      .filter((f) => f.type === 'function' && typeof f.name === 'string')
      .map((f) => f.name.slice(0, 120))
      .slice(0, 250),
    observedAt: new Date().toISOString(),
  };
}
