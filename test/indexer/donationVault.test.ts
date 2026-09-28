import { xdr } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { handleDonationVaultEvent } from '../../src/indexer/handlers/donationVault.js';
import { readStream } from '../../src/stellar/vault.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import { addressScVal, i128ScVal, makeEvent, symbolScVal, u64ScVal } from '../helpers/events.js';

// topup/ratemod re-read the stream from the contract through the RPC. Mock
// that read so the tests don't hit the network; readStream itself (request
// building and response decoding) is covered in test/stellar/vault.test.ts.
vi.mock('../../src/stellar/vault.js', () => ({ readStream: vi.fn() }));

describe('handleDonationVaultEvent', () => {
  beforeEach(() => {
    vi.mocked(readStream).mockReset();
  });

  afterEach(async () => {
    await resetDb();
  });

  it('creates a stream (and placeholder donor/ngo rows) on a created event', async () => {
    const donor = fakeAddress('A');
    const ngo = fakeAddress('B');
    const token = fakeAddress('C');

    const event = makeEvent(
      [symbolScVal('created'), u64ScVal(1n)],
      xdr.ScVal.scvVec([
        addressScVal(donor),
        addressScVal(ngo),
        addressScVal(token),
        i128ScVal(1000n),
        i128ScVal(10n),
      ]),
    );

    await handleDonationVaultEvent(event);

    const stream = await prisma.stream.findUnique({ where: { onChainId: 1n } });
    expect(stream?.balance).toBe('1000');
    expect(stream?.rate).toBe('10');
    expect(stream?.withdrawn).toBe('0');
    expect(stream?.status).toBe('ACTIVE');

    expect(await prisma.donor.findUnique({ where: { address: donor } })).not.toBeNull();

    // Never went through ngo-registry — placeholder, unverified.
    const ngoRow = await prisma.ngo.findUnique({ where: { ownerAddress: ngo } });
    expect(ngoRow?.verified).toBe(false);
  });

  it('applies a withdraw event as a balance/withdrawn delta', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('D') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('E'), name: 'NGO E' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 2n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('F'),
        rate: '10',
        balance: '1000',
        withdrawn: '0',
      },
    });

    await handleDonationVaultEvent(
      makeEvent([symbolScVal('withdraw'), u64ScVal(2n)], i128ScVal(500n)),
    );

    const stream = await prisma.stream.findUnique({ where: { onChainId: 2n } });
    expect(stream?.balance).toBe('500');
    expect(stream?.withdrawn).toBe('500');
  });

  it('applies a cancel event: settles accrued, zeroes balance/rate, marks cancelled', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('G') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('H'), name: 'NGO H' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 3n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('I'),
        rate: '10',
        balance: '1000',
        withdrawn: '200',
      },
    });

    const event = makeEvent(
      [symbolScVal('cancel'), u64ScVal(3n)],
      xdr.ScVal.scvVec([i128ScVal(300n), i128ScVal(700n)]),
    );
    await handleDonationVaultEvent(event);

    const stream = await prisma.stream.findUnique({ where: { onChainId: 3n } });
    expect(stream?.balance).toBe('0');
    expect(stream?.rate).toBe('0');
    expect(stream?.withdrawn).toBe('500'); // 200 already withdrawn + 300 settled on cancel
    expect(stream?.status).toBe('CANCELLED');
  });

  async function seedStream(onChainId: bigint, letter: string) {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress(letter) } });
    const ngoRow = await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress(letter.toLowerCase() === letter ? 'Z' : letter + 'Z'),
        name: 'NGO',
      },
    });
    return prisma.stream.create({
      data: {
        onChainId,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('T'),
        rate: '10',
        balance: '1000',
        withdrawn: '0',
      },
    });
  }

  it('applies a topup event from the stream read back on-chain', async () => {
    await seedStream(4n, 'J');
    // 100 accrued and settled to the NGO before the 500 top-up landed:
    // 1000 - 100 + 500 = 1400 balance, 100 withdrawn. None of that is in the
    // event payload (just the 500), which is why the handler reads the chain.
    vi.mocked(readStream).mockResolvedValue({ rate: 10n, balance: 1400n, withdrawn: 100n });

    await handleDonationVaultEvent(
      makeEvent([symbolScVal('topup'), u64ScVal(4n)], i128ScVal(500n)),
    );

    expect(readStream).toHaveBeenCalledWith('CTESTCONTRACTID', 4n);
    const stream = await prisma.stream.findUnique({ where: { onChainId: 4n } });
    expect(stream?.balance).toBe('1400');
    expect(stream?.withdrawn).toBe('100');
    expect(stream?.rate).toBe('10');
    expect(stream?.status).toBe('ACTIVE');
  });

  it('applies a ratemod event from the stream read back on-chain', async () => {
    await seedStream(5n, 'K');
    // 50 accrued at the old rate of 10 before the rate became 20.
    vi.mocked(readStream).mockResolvedValue({ rate: 20n, balance: 950n, withdrawn: 50n });

    await handleDonationVaultEvent(
      makeEvent([symbolScVal('ratemod'), u64ScVal(5n)], i128ScVal(20n)),
    );

    expect(readStream).toHaveBeenCalledWith('CTESTCONTRACTID', 5n);
    const stream = await prisma.stream.findUnique({ where: { onChainId: 5n } });
    expect(stream?.rate).toBe('20');
    expect(stream?.balance).toBe('950');
    expect(stream?.withdrawn).toBe('50');
  });

  it('stores i128 values beyond Number.MAX_SAFE_INTEGER without losing precision', async () => {
    await seedStream(6n, 'L');
    const big = 170141183460469231731687303715884105727n; // i128 max
    vi.mocked(readStream).mockResolvedValue({ rate: 1n, balance: big, withdrawn: big - 1n });

    await handleDonationVaultEvent(makeEvent([symbolScVal('topup'), u64ScVal(6n)], i128ScVal(1n)));

    const stream = await prisma.stream.findUnique({ where: { onChainId: 6n } });
    expect(stream?.balance).toBe(big.toString());
    expect(stream?.withdrawn).toBe((big - 1n).toString());
  });

  it('ignores topup/ratemod for a stream that is not indexed, without reading the chain', async () => {
    await handleDonationVaultEvent(
      makeEvent([symbolScVal('topup'), u64ScVal(99n)], i128ScVal(500n)),
    );

    expect(readStream).not.toHaveBeenCalled();
    expect(await prisma.stream.count()).toBe(0);
  });

  it('leaves the row untouched and rejects when the on-chain read fails', async () => {
    await seedStream(7n, 'M');
    vi.mocked(readStream).mockRejectedValue(new Error('rpc unavailable'));

    // Rejecting (rather than swallowing) keeps the worker from checkpointing
    // the event, so it is retried on the next poll.
    await expect(
      handleDonationVaultEvent(makeEvent([symbolScVal('topup'), u64ScVal(7n)], i128ScVal(500n))),
    ).rejects.toThrow('rpc unavailable');

    const stream = await prisma.stream.findUnique({ where: { onChainId: 7n } });
    expect(stream?.balance).toBe('1000');
    expect(stream?.withdrawn).toBe('0');
    expect(stream?.rate).toBe('10');
  });
});
