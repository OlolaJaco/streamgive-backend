import {
  Account,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import { Api } from '@stellar/stellar-sdk/rpc';

import { rpcServer } from './rpc.js';

/** The fields of the donation-vault contract's `Stream` struct the indexer
 * mirrors into the database. */
export interface OnChainStream {
  rate: bigint;
  balance: bigint;
  withdrawn: bigint;
}

/**
 * Reads a stream's current state back from the donation-vault contract by
 * simulating a read-only `get_stream(stream_id)` call through the RPC.
 *
 * This is the state at the RPC's latest ledger, not at the ledger of any
 * particular event. Throws if the RPC is unreachable or the contract call
 * fails (e.g. the stream doesn't exist).
 */
export async function readStream(contractId: string, onChainId: bigint): Promise<OnChainStream> {
  // Simulation never signs, submits or charges anything, so the source
  // account needn't exist and the network passphrase is never checked
  // against a network — a throwaway account is enough for a read-only call.
  // Built per call because TransactionBuilder bumps the account's sequence.
  const source = new Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      new Contract(contractId).call('get_stream', nativeToScVal(onChainId, { type: 'u64' })),
    )
    .setTimeout(30)
    .build();

  const simulation = await rpcServer.simulateTransaction(tx);
  if (Api.isSimulationError(simulation)) {
    throw new Error(`get_stream(${onChainId}) simulation failed: ${simulation.error}`);
  }
  const retval = simulation.result?.retval;
  if (!retval) {
    throw new Error(`get_stream(${onChainId}) simulation returned no result`);
  }

  const { rate, balance, withdrawn } = scValToNative(retval) as OnChainStream;
  return { rate, balance, withdrawn };
}
