import { Address, StrKey, type Transaction, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { Api } from '@stellar/stellar-sdk/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rpcServer } from '../../src/stellar/rpc.js';
import { readStream } from '../../src/stellar/vault.js';
import { fakeAddress } from '../helpers/db.js';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));

/** The donation-vault contract's `Stream` struct as get_stream returns it:
 * a Soroban map from symbol field names to values, keys in sorted order. */
function streamScVal(fields: { rate: bigint; balance: bigint; withdrawn: bigint }): xdr.ScVal {
  const entry = (key: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: nativeToScVal(key, { type: 'symbol' }), val });

  return xdr.ScVal.scvMap([
    entry('balance', nativeToScVal(fields.balance, { type: 'i128' })),
    entry('cancelled', xdr.ScVal.scvBool(false)),
    entry('created_at', nativeToScVal(1_700_000_000n, { type: 'u64' })),
    entry('donor', new Address(fakeAddress('D')).toScVal()),
    entry('last_update', nativeToScVal(1_700_000_100n, { type: 'u64' })),
    entry('ngo', new Address(fakeAddress('N')).toScVal()),
    entry('rate', nativeToScVal(fields.rate, { type: 'i128' })),
    entry('token', new Address(fakeAddress('T')).toScVal()),
    entry('withdrawn', nativeToScVal(fields.withdrawn, { type: 'i128' })),
  ]);
}

function simulationSuccess(retval: xdr.ScVal | undefined) {
  return { id: '1', latestLedger: 1, result: retval && { auth: [], retval } };
}

describe('readStream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('simulates get_stream(streamId) on the given contract and decodes the stream', async () => {
    const simulate = vi
      .spyOn(rpcServer, 'simulateTransaction')
      .mockResolvedValue(
        simulationSuccess(
          streamScVal({ rate: 10n, balance: 1400n, withdrawn: 100n }),
        ) as unknown as Api.SimulateTransactionResponse,
      );

    const result = await readStream(CONTRACT_ID, 42n);

    expect(result).toEqual({ rate: 10n, balance: 1400n, withdrawn: 100n });

    const tx = simulate.mock.calls[0][0] as Transaction;
    const [operation] = tx.operations;
    expect(operation.type).toBe('invokeHostFunction');
    const invocation = (
      operation as unknown as {
        func: {
          value: {
            contractAddress: { contractId: { value: Uint8Array } };
            functionName: { bytes: Uint8Array };
            args: Array<{ u64: bigint }>;
          };
        };
      }
    ).func.value;
    expect(StrKey.encodeContract(Buffer.from(invocation.contractAddress.contractId.value))).toBe(
      CONTRACT_ID,
    );
    expect(Buffer.from(invocation.functionName.bytes).toString()).toBe('get_stream');
    expect(invocation.args.map((arg) => arg.u64)).toEqual([42n]);
  });

  it('preserves i128 values beyond Number.MAX_SAFE_INTEGER', async () => {
    const big = 170141183460469231731687303715884105727n; // i128 max
    vi.spyOn(rpcServer, 'simulateTransaction').mockResolvedValue(
      simulationSuccess(
        streamScVal({ rate: 1n, balance: big, withdrawn: big - 1n }),
      ) as unknown as Api.SimulateTransactionResponse,
    );

    expect(await readStream(CONTRACT_ID, 1n)).toEqual({
      rate: 1n,
      balance: big,
      withdrawn: big - 1n,
    });
  });

  it('throws when the simulation fails (e.g. the stream does not exist)', async () => {
    vi.spyOn(rpcServer, 'simulateTransaction').mockResolvedValue({
      id: '1',
      latestLedger: 1,
      error: 'HostError: Error(Contract, #3)',
    } as unknown as Api.SimulateTransactionResponse);

    await expect(readStream(CONTRACT_ID, 1n)).rejects.toThrow(
      /get_stream\(1\).*Error\(Contract, #3\)/,
    );
  });

  it('throws when the simulation returns no result', async () => {
    vi.spyOn(rpcServer, 'simulateTransaction').mockResolvedValue(
      simulationSuccess(undefined) as unknown as Api.SimulateTransactionResponse,
    );

    await expect(readStream(CONTRACT_ID, 1n)).rejects.toThrow(/no result/);
  });
});
