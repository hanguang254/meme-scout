// Ethereum's keccak256, which is not SHA3-256 and cannot be delegated to
// node:crypto. The two are the same permutation with one byte of difference:
// SHA3 appends the domain separator 0x06 before padding, the original Keccak
// submission appends 0x01. Node ships 'sha3-256' (the 0x06 one), so asking it
// for a function selector or a storage slot returns a digest that is wrong
// everywhere it matters and wrong in a way nothing downstream can detect.
//
// Reading a Uniswap V4 pool needs this: the singleton keeps every pool's state
// in one contract, and the slot is keccak256(abi.encode(poolId, uint256(6))).
// That is the only reason to carry a hash implementation in a project with no
// web3 dependency; it is deliberately small and only ever hashes bytes this
// process assembled itself.
const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// ρ offsets, laid out flat for a state indexed as x + 5y.
const ROT = [
  0n, 1n, 62n, 28n, 27n,
  36n, 44n, 6n, 55n, 20n,
  3n, 10n, 43n, 25n, 39n,
  41n, 45n, 15n, 21n, 8n,
  18n, 2n, 61n, 56n, 14n,
];
const rotl = (v, n) => n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK;
function keccakF(A) {
  // Scratch, fully rewritten before it is read on every round. Allocated once
  // outside the loop because this runs per selector and per storage slot.
  const C = Array.from({ length: 5 });
  const D = Array.from({ length: 5 });
  const B = Array.from({ length: 25 });
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++)
      C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++)
      D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 5; x++) A[x + 5 * y] ^= D[x];
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 5; x++)
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 5; x++)
        A[x + 5 * y] =
          B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & B[((x + 2) % 5) + 5 * y]);
    A[0] ^= RC[round];
  }
  return A;
}
// Rate for a 256-bit digest: 1600 bits of state minus twice the capacity.
const RATE = 136;
export function keccak256(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const padded = new Uint8Array(
    Math.ceil((input.length + 1) / RATE) * RATE,
  );
  padded.set(input);
  // The two padding bytes may land on the same byte when the message leaves
  // exactly one byte of the block free; |= rather than = keeps both.
  padded[input.length] |= 0x01;
  padded[padded.length - 1] |= 0x80;
  const A = Array.from({ length: 25 }, () => 0n);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      // Little-endian lanes, which is why this reads the bytes backwards.
      for (let b = 7; b >= 0; b--)
        lane = (lane << 8n) | BigInt(padded[offset + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  let out = '';
  for (let i = 0; i < 4; i++) {
    const lane = A[i];
    for (let b = 0; b < 8; b++)
      out += (((lane >> BigInt(b * 8)) & 0xffn).toString(16)).padStart(2, '0');
  }
  return out;
}
const enc = new TextEncoder();
export const keccakUtf8 = (text) => keccak256(enc.encode(text));
// Bare hex in, bare hex out: everything in this project assembles calldata
// unprefixed and adds the 0x once, at the call.
export function keccakHex(hex) {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^([\da-fA-F]{2})*$/.test(data))
    throw new Error('keccak 输入不是完整的十六进制字节');
  const bytes = new Uint8Array(data.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
  return keccak256(bytes);
}
// The first four bytes of the hash of a canonical signature. Used by the tests
// to prove the hard-coded selectors in pool-price.mjs are what they claim.
export const selector = (signature) => keccakUtf8(signature).slice(0, 8);
