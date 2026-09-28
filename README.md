# StreamGive — Backend

Indexer and API for StreamGive, a recurring/streaming donation platform for
verified NGOs on Stellar. Watches the on-chain contracts for events and
serves the data that powers the frontend.

## Stack

- TypeScript, Node.js
- Fastify (API server)
- PostgreSQL

## Local development

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:push                 # sync the schema onto streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev
```

`npm run db:seed` uses upserts, so it is safe to run more than once.

To run the whole stack containerized instead, after `npm run db:push` above: `docker compose up --build`.

To run the integration test suite, additionally:

```
cp .env.test.example .env.test
npm run db:push:test
npm test
```

## Troubleshooting

**"Can't reach database" / connection errors on startup**

Postgres isn't up yet, or `DATABASE_URL` doesn't point at it. Run
`docker compose up -d postgres` and confirm `DATABASE_URL` in `.env` matches
(`postgresql://streamgive:streamgive@localhost:5432/streamgive` when running
`npm run dev` directly — the `postgres` host only resolves inside
`docker compose`, see the override in `docker-compose.yml`). Then run
`npm run db:push` to sync the schema.

**Indexer never picks up events**

If `NGO_REGISTRY_CONTRACT_ID` and `DONATION_VAULT_CONTRACT_ID` are both
unset, this is expected — the indexer no-ops until at least one is set. See
[ENVIRONMENT.md](./ENVIRONMENT.md) for where to get the deployed contract
ids. If they're set and events still aren't showing up, check
`SOROBAN_RPC_URL` is reachable and that the contracts have actually emitted
events since the indexer's checkpoint (a fresh run starts from the current
ledger, not from the contract's history).

**Admin routes return 503**

`ADMIN_ADDRESS` is unset. The admin review endpoints refuse all requests
until it's configured — set it to the Stellar public key (`G...`) that
matches the `admin` configured on the deployed contracts. See
[ENVIRONMENT.md](./ENVIRONMENT.md).
## Indexer

See [docs/INDEXER.md](./docs/INDEXER.md) for a full table of which on-chain
events the indexer handles, which tables each one writes, and how the
checkpoint and out-of-window recovery work.

## Admin authentication

The admin routes (`GET /ngo-applications`, `GET /ngo-applications/:id`,
`POST /ngo-applications/:id/approve` and `POST /ngo-applications/:id/reject`)
don't use passwords or API keys. Each request is signed with the Stellar
keypair whose public key is configured as `ADMIN_ADDRESS`, so no secret ever
crosses the wire. The check lives in
[`src/middleware/adminAuth.ts`](./src/middleware/adminAuth.ts).

### Headers

Send all three headers on every admin request:

| Header | Value |
|---|---|
| `x-admin-address` | The admin's Stellar public key (`G...`). Must equal `ADMIN_ADDRESS` exactly. |
| `x-admin-timestamp` | The time of signing, as Unix time in **milliseconds** (e.g. `Date.now().toString()`). |
| `x-admin-signature` | The signature over the payload below, encoded as base64 or hex. |

### Signed payload

The signed message is the request method, the request URL and the timestamp
header, joined with colons:

```
METHOD:URL:TIMESTAMP
```

- `METHOD` is the upper-case HTTP method, e.g. `POST`.
- `URL` is the request target exactly as sent: the path **plus the query
  string**, with no scheme or host. `/ngo-applications?status=PENDING&limit=10`
  and `/ngo-applications` are different payloads, so sign the same string you
  request. Query parameters are not reordered or normalised.
- `TIMESTAMP` is the exact string sent in `x-admin-timestamp`.

For example: `POST:/ngo-applications/8a1c.../approve:1767225600000`

The signature only covers the method, URL and timestamp, not the request body.

### SEP-53 hashing

The payload is signed as a Stellar message per
[SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md),
not as raw bytes. The signature is an ed25519 signature over

```
SHA-256("Stellar Signed Message:\n" + payload)
```

where `"Stellar Signed Message:\n"` is the fixed SEP-53 prefix (including the
trailing newline) and the payload is UTF-8 encoded. This is what a wallet's
generic message-signing call does, and what `Keypair.signMessage` in
`@stellar/stellar-sdk` does. Signing the raw
payload, or signing it with a wallet's transaction-signing call, will not
verify.

### Accepted signature encodings

SEP-53 fixes what is signed but not how a wallet returns the signature, so the
server accepts either:

- **base64** (88 characters for a 64-byte signature), or
- **hex** (128 characters).

Either way the decoded signature must be exactly 64 bytes, and it still has to
verify against `ADMIN_ADDRESS`. Anything else is rejected.

### Time window

The timestamp must be within **five minutes** of the server's clock, in either
direction. A captured set of headers can be replayed for the same method and URL
within that window, so send requests over HTTPS and keep the client's clock
roughly in sync (NTP).

### Responses

| Status | Body | Meaning |
|---|---|---|
| `503` | `{ "error": "admin_auth_not_configured" }` | `ADMIN_ADDRESS` is not set on the server. |
| `401` | `{ "error": "unauthorized" }` | A header is missing, the address isn't the admin, or the signature didn't verify. |
| `401` | `{ "error": "stale_signature" }` | The timestamp is not a number or is outside the five-minute window. |

The server can't tell a bad signature from a wrong payload, so a `401
unauthorized` from an otherwise well-formed request usually means the signed
`URL` (query string included) or the SEP-53 hashing didn't match. The server logs
the payload it expected.

### Example

Producing the headers with `@stellar/stellar-sdk` (`Keypair.signMessage` applies
the SEP-53 prefix and hash for you):

```ts
import { Keypair } from '@stellar/stellar-sdk';

const adminKeypair = Keypair.fromSecret(process.env.ADMIN_SECRET!); // the ADMIN_ADDRESS keypair

function adminHeaders(method: string, url: string): Record<string, string> {
  const timestamp = Date.now().toString();
  const payload = `${method}:${url}:${timestamp}`;
  const signature = Buffer.from(adminKeypair.signMessage(payload)).toString('base64');

  return {
    'x-admin-address': adminKeypair.publicKey(),
    'x-admin-signature': signature,
    'x-admin-timestamp': timestamp,
  };
}

// The URL you sign must be the URL you request, query string included.
const url = '/ngo-applications?status=PENDING';
const response = await fetch(`https://api.example.com${url}`, {
  headers: adminHeaders('GET', url),
});
```

`signMessage` returns a `Uint8Array`, so wrap it in `Buffer.from(...)` before
calling `.toString('base64')`; calling `toString('base64')` on the array itself
ignores the encoding and yields a string of decimal bytes.

For a browser client, the API's `CORS_ORIGINS` must include your origin, or the
browser will block the `x-admin-*` headers on the preflight request. It is a
comma-separated list of origins and defaults to `http://localhost:3001`.

## Notification events

When `NOTIFY_WEBHOOK_URL` is set, the indexer POSTs a JSON body to that URL
for each on-chain event it processes (see
[src/notifications/service.ts](./src/notifications/service.ts)). The body is
one of the following shapes, discriminated by `type`
(see [src/notifications/types.ts](./src/notifications/types.ts)):

### `stream_created`

Emitted when a donor opens a new donation stream to an NGO.

```json
{
  "type": "stream_created",
  "streamId": "1234",
  "donorAddress": "GABC...",
  "ngoId": "clx1y2z3..."
}
```

- `streamId` — the stream's on-chain id, as a string.
- `donorAddress` — the donor's Stellar account address.
- `ngoId` — the internal (database) id of the receiving NGO.

### `stream_withdrawn`

Emitted when accrued funds are withdrawn to the NGO from an active stream.

```json
{
  "type": "stream_withdrawn",
  "streamId": "1234",
  "amount": "500000000"
}
```

- `streamId` — the stream's on-chain id, as a string.
- `amount` — the amount withdrawn, in the stream's token base units, as a string.

### `stream_cancelled`

Emitted when a stream is cancelled, settling accrued funds to the NGO and
refunding the remaining balance to the donor.

```json
{
  "type": "stream_cancelled",
  "streamId": "1234",
  "settledToNgo": "500000000",
  "refundToDonor": "1500000000"
}
```

- `streamId` — the stream's on-chain id, as a string.
- `settledToNgo` — the amount settled to the NGO at cancellation time, in the stream's token base units, as a string.
- `refundToDonor` — the amount refunded to the donor, in the stream's token base units, as a string.

### `ngo_approved`

Emitted when an admin approves an NGO on-chain.

```json
{
  "type": "ngo_approved",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3..."
}
```

- `ownerAddress` — the NGO owner's Stellar account address.
- `ngoId` — the internal (database) id of the approved NGO.

### `ngo_revoked`

Emitted when a previously-approved NGO has its verified status revoked on-chain.

```json
{
  "type": "ngo_revoked",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3..."
}
```

- `ownerAddress` — the NGO owner's Stellar account address.
- `ngoId` — the internal (database) id of the revoked NGO.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, how to run tests, and
how to open a pull request. The full project-wide contribution guide lives in
[streamgive-docs](https://github.com/streamgive/streamgive-docs).

## Related repositories

- [streamgive-contracts](https://github.com/streamgive/streamgive-contracts) — Soroban smart contracts
- [streamgive-frontend](https://github.com/streamgive/streamgive-frontend) — donor & NGO web app
- [streamgive-docs](https://github.com/streamgive/streamgive-docs) — documentation

## Status

Early development.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
