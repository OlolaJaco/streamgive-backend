import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import { signAdminRequest } from '../helpers/adminAuth.js';

const adminKeypair = Keypair.random();

function validApplicationPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ownerAddress: fakeAddress('A'),
    name: 'Test NGO',
    description: 'A test NGO description.',
    contactEmail: 'ngo@example.com',
    ...overrides,
  };
}

describe('POST /ngo-applications', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    await resetDb();
  });

  it('creates a pending application', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/ngo-applications',
      payload: validApplicationPayload(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe('PENDING');

    await app.close();
  });

  it('rejects invalid input with 400', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/ngo-applications',
      payload: validApplicationPayload({ contactEmail: 'not-an-email' }),
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('rejects a second pending application from the same address with 409', async () => {
    const app = buildServer();
    const payload = validApplicationPayload();

    const first = await app.inject({ method: 'POST', url: '/ngo-applications', payload });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: 'POST', url: '/ngo-applications', payload });
    expect(second.statusCode).toBe(409);

    await app.close();
  });
});

describe('GET /ngo-applications/status', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('returns only status and timestamps for the latest application', async () => {
    const app = buildServer();
    const ownerAddress = fakeAddress('S');

    await prisma.ngoApplication.create({
      data: validApplicationPayload({ ownerAddress, status: 'REJECTED' }),
    });
    const latest = await prisma.ngoApplication.create({
      data: validApplicationPayload({ ownerAddress, status: 'APPROVED' }),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/ngo-applications/status?ownerAddress=${ownerAddress}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('APPROVED');
    expect(body.createdAt).toBe(latest.createdAt.toISOString());
    expect(body.updatedAt).toBe(latest.updatedAt.toISOString());
    // No contact details or other application fields leak out.
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'status', 'updatedAt']);

    await app.close();
  });

  it('returns 404 when the address has no application', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: `/ngo-applications/status?ownerAddress=${fakeAddress('N')}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('not_found');

    await app.close();
  });

  it('rejects a malformed address with 400', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/ngo-applications/status?ownerAddress=not-an-address',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');

    await app.close();
  });

  it('rejects a missing address with 400', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/ngo-applications/status' });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('admin NGO application review', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    await resetDb();
  });

  it('rejects an unsigned request with 401', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/ngo-applications' });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('allows a correctly signed admin request', async () => {
    const app = buildServer();
    const headers = signAdminRequest(adminKeypair, 'GET', '/ngo-applications');

    const response = await app.inject({ method: 'GET', url: '/ngo-applications', headers });
    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it('approves a pending application', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const url = `/ngo-applications/${application.id}/approve`;
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({ method: 'POST', url, headers, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('APPROVED');

    const stored = await prisma.ngoApplication.findUnique({ where: { id: application.id } });
    expect(stored?.status).toBe('APPROVED');

    await app.close();
  });

  it('stores the reviewNote when approving an application', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const url = `/ngo-applications/${application.id}/approve`;
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { reviewNote: 'Documents verified.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().reviewNote).toBe('Documents verified.');

    const stored = await prisma.ngoApplication.findUnique({ where: { id: application.id } });
    expect(stored?.status).toBe('APPROVED');
    expect(stored?.reviewNote).toBe('Documents verified.');

    await app.close();
  });

  it('rejects a pending application and stores the status and reviewNote', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const url = `/ngo-applications/${application.id}/reject`;
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { reviewNote: 'Registration number could not be verified.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('REJECTED');

    const stored = await prisma.ngoApplication.findUnique({ where: { id: application.id } });
    expect(stored?.status).toBe('REJECTED');
    expect(stored?.reviewNote).toBe('Registration number could not be verified.');

    await app.close();
  });

  it('rejects a reviewNote over 2000 characters with 400 and leaves the application pending', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const url = `/ngo-applications/${application.id}/reject`;
    const headers = signAdminRequest(adminKeypair, 'POST', url);

    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { reviewNote: 'x'.repeat(2001) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');

    const stored = await prisma.ngoApplication.findUnique({ where: { id: application.id } });
    expect(stored?.status).toBe('PENDING');
    expect(stored?.reviewNote).toBeNull();

    await app.close();
  });

  it('rejects a signature for a different URL than the one requested', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const realUrl = `/ngo-applications/${application.id}/approve`;
    // Signed for a *different* application's approve endpoint.
    const headers = signAdminRequest(adminKeypair, 'POST', '/ngo-applications/other-id/approve');

    const response = await app.inject({ method: 'POST', url: realUrl, headers, payload: {} });
    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
