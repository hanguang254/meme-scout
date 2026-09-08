import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readRobinhoodContract,
  summarizeExplorer,
} from '../scanner/contract-evidence.mjs';
const address = '0x' + 'a'.repeat(40);
test('RPC checks chain and pins owner/code reads to an observed block', async () => {
  const calls = [];
  const r = await readRobinhoodContract(address, async (_url, body) => {
    calls.push(body);
    return body[0].id === 1
      ? [
          { id: 2, result: '0x10' },
          { id: 1, result: '0x1237' },
        ]
      : [
          { id: 4, result: '0x' + '0'.repeat(24) + 'b'.repeat(40) },
          { id: 3, result: '0x6000' },
        ];
  });
  assert.equal(r.owner, '0x' + 'b'.repeat(40));
  assert.equal(r.block, 16);
  assert.equal(calls[1][1].params[1], '0x10');
});
test('wrong chain aborts and reverted owner calls stay unknown', async () => {
  await assert.rejects(
    () =>
      readRobinhoodContract(address, async () => [{ id: 1, result: '0x1' }]),
    /链 ID/,
  );
  const r = await readRobinhoodContract(address, async (_u, b) =>
    b[0].id === 1
      ? [
          { id: 1, result: '0x1237' },
          { id: 2, result: '0x10' },
        ]
      : [
          { id: 3, result: '0x6000' },
          { id: 4, error: { message: 'execution reverted' } },
        ],
  );
  assert.equal(r.owner, null);
  assert.equal(r.ownerStatus, 'unavailable');
});
test('explorer metadata identifies a clone without assuming it is upgradeable', () => {
  const r = summarizeExplorer(
    {
      proxy_type: 'eip1167',
      implementations: [{ address_hash: address, name: 'DopplerERC20V1' }],
    },
    address,
  );
  assert.equal(r.proxyType, 'eip1167');
  assert.equal(r.sourceAvailable, false);
  assert.equal(r.isUpgradeable, undefined);
  assert.equal(r.implementations[0].address, address);
});

test('exact runtime clone detection rejects trailing, truncated and unrelated code', async () => {
  const { identifyMinimalClone } =
    await import('../scanner/contract-evidence.mjs');
  const impl = '3be8b97fd0e713b5abe0649fa830223b6b4bc599';
  const runtime = `0x3d3d3d3d363d3d37363d73${impl}5af43d3d93803e602a57fd5bf3`;
  assert.equal(identifyMinimalClone(runtime).implementation, `0x${impl}`);
  assert.equal(identifyMinimalClone(runtime).type, 'minimal-clone-0age');
  assert.equal(identifyMinimalClone(runtime + '00'), null);
  assert.equal(identifyMinimalClone(runtime.slice(0, -2)), null);
  assert.equal(identifyMinimalClone('0x6000'), null);
  const standard = `0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`;
  assert.equal(identifyMinimalClone(standard).type, 'eip1167');
});
