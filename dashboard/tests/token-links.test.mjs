import test from 'node:test';
import assert from 'node:assert/strict';
import { gmgnTokenUrl, GMGN_CHAINS } from '../lib/token-links.ts';
import { CHAINS } from '../scanner/risk.mjs';

// The coin name is the only way out of this page to a chart, so a chain that
// silently yields `#` looks to the user like a click that does nothing. The
// list this guards is GMGN's coverage, which is a different list from the
// chains the panel watches and from the chains that supply the panel's prices —
// and the last time those were confused, one chain's rows stopped linking
// anywhere at all.
const ADDRESS = `0x${'1'.repeat(40)}`;

test('面板监控的每一条链都能点开 GMGN', () => {
  for (const chain of Object.keys(CHAINS))
    assert.equal(
      gmgnTokenUrl(chain, ADDRESS),
      `https://gmgn.ai/${chain}/token/${ADDRESS}`,
      `${chain} 点不开 GMGN——要么把它加进 GMGN_CHAINS，要么确认 GMGN 真的不收录这条链`,
    );
});

test('数据来自别处不影响能不能打开 GMGN', () => {
  // Arc's candidates and prices come from GeckoTerminal because DexScreener
  // does not index the chain; GMGN still has a page for it, and where a coin
  // was discovered says nothing about whether that page exists.
  assert.equal(CHAINS.arc.dex, null);
  assert.equal(GMGN_CHAINS.includes('arc'), true);
  assert.equal(
    gmgnTokenUrl('arc', ADDRESS),
    `https://gmgn.ai/arc/token/${ADDRESS}`,
  );
});

test('GMGN 不收录的链不给链接，而不是给一个会 404 的', () => {
  assert.equal(gmgnTokenUrl('doge', ADDRESS), '#');
  assert.equal(gmgnTokenUrl('', ADDRESS), '#');
  // Close enough to a real slug to be worth pinning: membership is exact.
  assert.equal(gmgnTokenUrl('ethereum', ADDRESS), '#');
});

test('地址只能落在路径的最后一段', () => {
  // A crafted address must not be able to steer the URL to another page on the
  // same host, which is the one thing a template string cannot prevent by itself.
  assert.equal(
    gmgnTokenUrl('sol', '../../address/evil'),
    'https://gmgn.ai/sol/token/..%2F..%2Faddress%2Fevil',
  );
  assert.equal(
    gmgnTokenUrl('sol', 'abc?next=https://evil.example'),
    'https://gmgn.ai/sol/token/abc%3Fnext%3Dhttps%3A%2F%2Fevil.example',
  );
});
