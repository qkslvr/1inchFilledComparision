import { config } from '../../config.js';

let nextId = 1;

async function rpc<T>(method: string, params: unknown[], rpcUrl = config.baseRpcUrl): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} for ${method}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message} (${body.error.code})`);
  return body.result as T;
}

export async function ethCall(to: string, data: string, rpcUrl?: string): Promise<string> {
  return rpc<string>('eth_call', [{ to, data }, 'latest'], rpcUrl);
}

export async function getGasPrice(): Promise<bigint> {
  return BigInt(await rpc<string>('eth_gasPrice', []));
}

/** Base fee of the next block, from eth_feeHistory. */
export async function getBaseFee(): Promise<bigint> {
  const res = await rpc<{ baseFeePerGas: string[] }>('eth_feeHistory', ['0x1', 'latest', []]);
  const fees = res.baseFeePerGas;
  const last = fees[fees.length - 1];
  if (!last) throw new Error('eth_feeHistory returned no baseFeePerGas');
  return BigInt(last);
}

export async function getTransactionReceipt(
  txHash: string
): Promise<{ blockNumber: number } | null> {
  const r = await rpc<{ blockNumber: string } | null>('eth_getTransactionReceipt', [txHash]);
  return r ? { blockNumber: Number(BigInt(r.blockNumber)) } : null;
}

export async function getBlockTimestampMs(blockNumber: number): Promise<number> {
  const block = await rpc<{ timestamp: string } | null>('eth_getBlockByNumber', [
    '0x' + blockNumber.toString(16),
    false,
  ]);
  if (!block) throw new Error(`block ${blockNumber} not found`);
  return Number(BigInt(block.timestamp)) * 1000;
}
