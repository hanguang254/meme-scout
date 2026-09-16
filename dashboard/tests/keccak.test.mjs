import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, keccakUtf8, keccakHex, selector } from '../scanner/keccak.mjs';

// This project has no web3 dependency, so keccak is hand-rolled. It underpins
// every call selector and every V4 storage slot, and a wrong digest does not
// fail loudly — it reads a slot that exists and returns a plausible number. The
// published vectors are the only thing standing between that and a silently
// wrong price, so they are checked first.
test('the published Keccak-256 vectors come out exactly', () => {
  assert.equal(
    keccak256(new Uint8Array()),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
  assert.equal(
    keccakUtf8('abc'),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
  assert.equal(
    keccakUtf8('The quick brown fox jumps over the lazy dog'),
    '4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15',
  );
});

// Node ships a sha3-256 and it is NOT this: SHA3 pads with 0x06, Ethereum's
// Keccak pads with 0x01. The two agree on nothing, so a vector that separates
// them is what proves the right padding is in use.
test('the digest is Keccak, not the NIST SHA3 beside it', async () => {
  const { createHash } = await import('node:crypto');
  const sha3 = createHash('sha3-256').update('abc').digest('hex');
  assert.notEqual(sha3, keccakUtf8('abc'));
  assert.equal(
    sha3,
    '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532',
  );
});

// Correctness is pinned by the published vectors above; all of them are shorter
// than the 136-byte rate, so this covers what they cannot reach: a 135-byte
// message leaves exactly one byte free and both pad bytes land on it, which an
// `=` instead of `|=` would silently collapse into a shorter message's padding.
// Every length across two block boundaries must still hash to its own value.
test('padding holds at and across the block boundary', () => {
  const lengths = [0, 1, 134, 135, 136, 137, 270, 271, 272, 273];
  const seen = new Map();
  for (const n of lengths) {
    const digest = keccakUtf8('a'.repeat(n));
    assert.equal(digest.length, 64, `${n} 字节的摘要长度不对`);
    assert.equal(seen.has(digest), false, `${n} 和 ${seen.get(digest)} 撞了`);
    seen.set(digest, n);
  }
});

test('hex input is parsed as bytes, not as text', () => {
  // "abc" as bytes is 0x616263, and hashing the hex must equal hashing the text.
  assert.equal(keccakHex('616263'), keccakUtf8('abc'));
  assert.equal(keccakHex('0x616263'), keccakUtf8('abc'));
  assert.equal(keccakHex(''), keccak256(new Uint8Array()));
  // A half byte is not a byte. Padding it to one would hash a value nobody
  // supplied, and the slot derived from it would be somebody else's.
  assert.throws(() => keccakHex('abc'));
  assert.throws(() => keccakHex('0xzz'));
});

// The selectors in pool-price.mjs are written as literals so the hot path never
// hashes. That is only safe if something proves they are the hashes they claim.
test('every hard-coded selector is the hash it claims to be', () => {
  assert.equal(selector('slot0()'), '3850c7bd');
  assert.equal(selector('getReserves()'), '0902f1ac');
  assert.equal(selector('extsload(bytes32)'), '1e2eaeaf');
  assert.equal(selector('token0()'), '0dfe1681');
  assert.equal(selector('decimals()'), '313ce567');
  assert.equal(selector('getBlockNumber()'), '42cbb15c');
  assert.equal(selector('balanceOf(address)'), '70a08231');
  assert.equal(
    selector('aggregate3((address,bool,bytes)[])'),
    '82ad56cb',
  );
});
