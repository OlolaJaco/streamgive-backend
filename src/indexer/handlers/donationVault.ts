import { scValToNative } from '@stellar/stellar-sdk';

import { prisma } from '../../db.js';
import { notify } from '../../notifications/service.js';
import { readStream } from '../../stellar/vault.js';
import type { ContractEvent } from '../worker.js';

async function ensureDonor(address: string) {
  return prisma.donor.upsert({
    where: { address },
    create: { address },
    update: {},
  });
}

async function ensureNgo(ownerAddress: string) {
  return prisma.ngo.upsert({
    where: { ownerAddress },
    // A stream can reference an NGO address that hasn't gone through
    // ngo-registry — donation-vault doesn't check registry membership
    // on-chain. Placeholder name until (if) a "register" event arrives;
    // `update: {}` below makes sure we never clobber a real name/verified
    // status that's already on file.
    create: { ownerAddress, name: ownerAddress, verified: false },
    update: {},
  });
}

/**
 * Handles the donation-vault contract's `created` event, emitted when a
 * donor opens a new streaming donation to an NGO.
 *
 * Writes: upserts the `donor` and `ngo` rows (creating them if this is the
 * first time either address has been seen), then upserts a `stream` row
 * with status `ACTIVE`, the initial deposit as `balance`, and `withdrawn`
 * set to `0`. Emits a `stream_created` notification.
 */
async function handleStreamCreated(event: ContractEvent): Promise<void> {
  const [, streamIdVal] = event.topic;
  const onChainId = scValToNative(streamIdVal) as bigint;

  const [donorVal, ngoVal, tokenVal, depositVal, rateVal] = scValToNative(event.value) as [
    { toString(): string },
    { toString(): string },
    { toString(): string },
    bigint,
    bigint,
  ];

  const [donor, ngo] = await Promise.all([
    ensureDonor(donorVal.toString()),
    ensureNgo(ngoVal.toString()),
  ]);

  await prisma.stream.upsert({
    where: { onChainId },
    create: {
      onChainId,
      donorId: donor.id,
      ngoId: ngo.id,
      tokenAddress: tokenVal.toString(),
      rate: rateVal.toString(),
      balance: depositVal.toString(),
      withdrawn: '0',
      status: 'ACTIVE',
    },
    update: {},
  });

  await notify({
    type: 'stream_created',
    streamId: onChainId.toString(),
    donorAddress: donorVal.toString(),
    ngoId: ngo.id,
  });
}

/**
 * Handles the donation-vault contract's `withdraw` event, emitted when
 * accrued funds are withdrawn to the NGO from an active stream.
 *
 * Writes: updates the matching `stream` row, subtracting the accrued
 * amount from `balance` and adding it to `withdrawn`. No-ops if the stream
 * isn't known yet. Emits a `stream_withdrawn` notification.
 *
 * Withdraw's event payload is just the accrued amount, so the new balance
 * and withdrawn total are fully determined by it — no ambiguity.
 */
async function handleWithdraw(event: ContractEvent): Promise<void> {
  const [, streamIdVal] = event.topic;
  const onChainId = scValToNative(streamIdVal) as bigint;
  const accrued = scValToNative(event.value) as bigint;

  const stream = await prisma.stream.findUnique({ where: { onChainId } });
  if (!stream) return;

  await prisma.stream.update({
    where: { onChainId },
    data: {
      balance: (BigInt(stream.balance) - accrued).toString(),
      withdrawn: (BigInt(stream.withdrawn) + accrued).toString(),
    },
  });

  await notify({
    type: 'stream_withdrawn',
    streamId: onChainId.toString(),
    amount: accrued.toString(),
  });
}

/**
 * Handles the donation-vault contract's `cancel` event, emitted when a
 * stream is cancelled, settling accrued funds to the NGO and refunding the
 * remaining balance to the donor.
 *
 * Writes: updates the matching `stream` row — adds the settled amount to
 * `withdrawn`, zeroes `balance` and `rate`, and sets `status` to
 * `CANCELLED`. No-ops if the stream isn't known yet. Emits a
 * `stream_cancelled` notification.
 *
 * Cancel's payload carries both the settled amount and the refund, so —
 * like withdraw — the resulting state is fully determined by the event.
 */
async function handleCancel(event: ContractEvent): Promise<void> {
  const [, streamIdVal] = event.topic;
  const onChainId = scValToNative(streamIdVal) as bigint;
  const [accrued, refund] = scValToNative(event.value) as [bigint, bigint];

  const stream = await prisma.stream.findUnique({ where: { onChainId } });
  if (!stream) return;

  await prisma.stream.update({
    where: { onChainId },
    data: {
      withdrawn: (BigInt(stream.withdrawn) + accrued).toString(),
      balance: '0',
      rate: '0',
      status: 'CANCELLED',
    },
  });

  await notify({
    type: 'stream_cancelled',
    streamId: onChainId.toString(),
    settledToNgo: accrued.toString(),
    refundToDonor: refund.toString(),
  });
}

/**
 * Handles the donation-vault contract's `topup` and `ratemod` events,
 * emitted when a donor adds funds to a stream or changes its rate.
 *
 * Writes: reads the stream back from the contract (`get_stream`, simulated
 * through the RPC) and overwrites the matching `stream` row's `rate`,
 * `balance` and `withdrawn` with what it returns. No-ops if the stream isn't
 * known yet. No notification is emitted.
 *
 * Both events settle whatever accrued at the old rate to the NGO before
 * applying the change, but their payloads only carry the new amount / rate,
 * so the resulting balance and withdrawn total can't be derived from the
 * event. Reading the contract state is the source of truth. The values
 * written are absolute, so retrying after a failed read is safe: if the
 * read throws, the event isn't checkpointed and is picked up again on the
 * next poll.
 */
async function handleStreamModified(event: ContractEvent): Promise<void> {
  const [, streamIdVal] = event.topic;
  const onChainId = scValToNative(streamIdVal) as bigint;

  const stream = await prisma.stream.findUnique({ where: { onChainId } });
  if (!stream) return;

  const contractId = event.contractId?.toString();
  if (!contractId) return;

  const onChain = await readStream(contractId, onChainId);

  await prisma.stream.update({
    where: { onChainId },
    data: {
      rate: onChain.rate.toString(),
      balance: onChain.balance.toString(),
      withdrawn: onChain.withdrawn.toString(),
    },
  });
}

/**
 * Entry point for all donation-vault contract events. Dispatches on the
 * event's topic to the handler for that on-chain event:
 * `created` → {@link handleStreamCreated}, `withdraw` → {@link handleWithdraw},
 * `cancel` → {@link handleCancel}, `topup` / `ratemod` →
 * {@link handleStreamModified}; any other topic is ignored.
 */
export async function handleDonationVaultEvent(event: ContractEvent): Promise<void> {
  const [topicSymbol] = event.topic;
  const topic = scValToNative(topicSymbol) as string;

  switch (topic) {
    case 'created':
      await handleStreamCreated(event);
      break;
    case 'withdraw':
      await handleWithdraw(event);
      break;
    case 'cancel':
      await handleCancel(event);
      break;
    case 'topup':
    case 'ratemod':
      await handleStreamModified(event);
      break;
    default:
      break;
  }
}
