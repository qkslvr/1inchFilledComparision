/** Smoke test 7: Base RPC — gas price, base fee, and a receipt -> block timestamp
 *  lookup for a transaction from the latest block. */
import { config } from '../config.js';
import { getBaseFee, getBlockTimestampMs, getGasPrice } from '../src/chain/rpc.js';

console.log(`RPC: ${config.baseRpcUrl}`);
const [gasPrice, baseFee] = await Promise.all([getGasPrice(), getBaseFee()]);
console.log(`eth_gasPrice: ${gasPrice} wei (${Number(gasPrice) / 1e9} gwei)`);
console.log(`next base fee: ${baseFee} wei (${Number(baseFee) / 1e9} gwei)`);
const fillGasEth = Number(config.gasUnits * gasPrice) / 1e18;
console.log(`hypothetical fill gas (${config.gasUnits} units): ${fillGasEth.toFixed(8)} ETH`);

// receipt -> block timestamp path, using a tx from the latest block
const latest = await fetch(config.baseRpcUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }),
}).then((r) => r.json() as Promise<{ result: { number: string; timestamp: string; transactions: string[] } }>);

const blockNum = Number(BigInt(latest.result.number));
const txHash = latest.result.transactions[0];
console.log(`latest block ${blockNum}, ${latest.result.transactions.length} txs`);
if (txHash) {
  const { getTransactionReceipt } = await import('../src/chain/rpc.js');
  const receipt = await getTransactionReceipt(txHash);
  if (!receipt) {
    console.error('FAIL: receipt not found for a tx in the latest block');
    process.exit(1);
  }
  const tsMs = await getBlockTimestampMs(receipt.blockNumber);
  const ageS = (Date.now() - tsMs) / 1000;
  console.log(`tx ${txHash.slice(0, 14)}... block ${receipt.blockNumber} ts ${new Date(tsMs).toISOString()} (${ageS.toFixed(1)}s ago)`);
  if (Math.abs(ageS) > 300) {
    console.error('FAIL: latest block timestamp implausibly old/future');
    process.exit(1);
  }
}
console.log('SMOKE OK');
