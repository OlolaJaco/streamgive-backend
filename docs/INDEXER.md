# Indexer

The indexer polls the Stellar RPC for contract events emitted by the two
StreamGive smart contracts and writes the results into the PostgreSQL database.
It runs as a background loop inside the same Node.js process as the API server
(see [`src/indexer/worker.ts`](../src/indexer/worker.ts)).

## Watched contracts

| Env var | Purpose |
|---|---|
| `NGO_REGISTRY_CONTRACT_ID` | Tracks NGO registrations and admin approvals |
| `DONATION_VAULT_CONTRACT_ID` | Tracks streaming donation lifecycle (create / withdraw / cancel / top up / rate change) |

Both ids are optional. The indexer no-ops until at least one is set.

## Event table

Each row shows one on-chain event topic, whether the indexer handles it, and
which database rows it creates or updates when it does.

### ngo-registry contract

| Topic | Handled | DB writes |
|---|---|---|
| `register` | Yes | Upserts `ngos` row (`ownerAddress`, `name`, `verified = false`). Updates `name` if the row already exists. |
| `approved` | Yes | Sets `verified = true` on the matching `ngos` row via `updateMany` (no-ops if the row does not exist yet — safe for a mid-history start). |

Handler: [`src/indexer/handlers/ngoRegistry.ts`](../src/indexer/handlers/ngoRegistry.ts)

### donation-vault contract

| Topic | Handled | DB writes |
|---|---|---|
| `created` | Yes | Upserts `donors` and `ngos` rows for the involved addresses (creating placeholders if unseen), then upserts a `streams` row with `status = ACTIVE`, initial `balance`, and `withdrawn = 0`. Emits a `stream_created` webhook notification. |
| `withdraw` | Yes | Subtracts the accrued amount from `streams.balance` and adds it to `streams.withdrawn`. No-ops if the stream row does not exist. Emits a `stream_withdrawn` notification. |
| `cancel` | Yes | Adds the settled amount to `streams.withdrawn`, zeroes `balance` and `rate`, sets `status = CANCELLED`. No-ops if the stream row does not exist. Emits a `stream_cancelled` notification. |
| `topup` | Yes | Reads the stream back from the contract with a simulated, read-only `get_stream` call and overwrites `streams.rate`, `balance` and `withdrawn` with the returned values. No-ops if the stream row does not exist. No notification. |
| `ratemod` | Yes | Same as `topup`. |

Both events settle whatever accrued at the old rate to the NGO before applying
the change, but their payloads only carry the new amount or rate, so the
resulting balance and withdrawn total can't be derived from the event. Instead
the handler asks the contract (see
[`src/stellar/vault.ts`](../src/stellar/vault.ts)). The values it writes are
absolute, not deltas.

- **Failed reads are retried.** If the RPC call fails, the handler throws, the
  event is not checkpointed, and it is processed again on the next poll. A read
  that keeps failing (for example the stream no longer exists on-chain) holds
  the indexer at that event until it succeeds.
- **The read is of the latest ledger, not the event's ledger.** If a `withdraw`
  or `cancel` for the same stream was emitted after the `topup` / `ratemod`
  and both are in the same batch, the read already includes it, and the
  delta-based `withdraw` handler then applies it a second time. Simulation
  can't be pinned to an older ledger, so this is a known limitation.

Handler: [`src/indexer/handlers/donationVault.ts`](../src/indexer/handlers/donationVault.ts)

## Checkpoint

The indexer stores the last ledger it successfully processed in the
`indexer_checkpoints` table (a single row with `id = 'main'`).  On startup it
reads this row and resumes from `lastLedger + 1`, so a restart never
re-processes already-seen events.

**First run** — if no checkpoint row exists the indexer writes the current
ledger as the starting point and returns without fetching events. The next poll
picks up from there, so only events emitted *after* the first startup are
indexed; the contract's full history is not back-filled.

**Per-event checkpointing** — the checkpoint is saved after each individual
event, not once per batch. Several handlers apply relative deltas
(`balance -= accrued`, etc.), so replaying an already-applied event after a
crash would double-count it. Saving after each event bounds the damage to "at
most the in-flight event" on a crash.

### Out-of-window behaviour

The Stellar RPC only retains a sliding window of recent ledgers (typically the
last ~17,280 ledgers / ~24 hours on Mainnet). It rejects a `getEvents` call
whose `startLedger` falls outside that window with a JSON-RPC `-32600` error.

Two ways the checkpoint can fall outside the window:

| Scenario | What happens |
|---|---|
| **Ahead of the tip** | The indexer checkpoints at the latest ledger, so the very next poll asks for `latest + 1`, which has not closed yet. The poll returns immediately and waits for the next interval — no action needed. |
| **Behind the retention window** | If the process is down for longer than the RPC's retention period, the saved checkpoint ages out. The indexer detects the `-32600` error, logs a warning that events in the gap were missed, skips the checkpoint forward to the current ledger, and resumes. This keeps the indexer running rather than looping on a permanent error, at the cost of a gap in the indexed history. |

The skip-forward warning is intentionally loud:

```
indexer: checkpoint <N> has aged out of the RPC's retention window —
skipping to ledger <M>. Events in between were missed and will not be indexed.
```

If you need complete history after an outage longer than the retention window,
replay the missed ledger range from an archive node (not currently automated).
