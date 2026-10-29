import { afterEach, expect, test, vi } from 'vitest';
import { createClient } from '../src/client.js';

afterEach(() => { vi.restoreAllMocks(); });

test('inherited students and homework share one renewal after concurrent 401s', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/connect/token') return Response.json({ access_token: 'new', expires_in: 3600 });
    if (new Headers(init?.headers).get('authorization') === 'Bearer old') return new Response('', { status: 401 });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer new');
    return Response.json(url.pathname.includes('SchoolsAndStudents')
      ? { studentSchools: [] } : { studentHomeworkDateRangeModels: [] });
  });
  const client = createClient({ tokens: { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }, login: false });
  expect(await Promise.all([
    client.students(),
    client.homework({ id: 'S:1', name: 'A', context: { student: '1', school: 'S', year: '2026', term: '1' } }),
  ])).toEqual([[], []]);
  expect(fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/connect/token')).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(5);
});

test('a second 401 stops after one renewal and one retry', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    return new URL(String(input)).pathname === '/connect/token'
      ? Response.json({ access_token: 'new', expires_in: 3600 }) : new Response('', { status: 401 });
  });
  const client = createClient({ tokens: { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }, login: false });
  await expect(client.students()).rejects.toMatchObject({ code: 'FACTS_LOGIN_REQUIRED' });
  expect(fetch).toHaveBeenCalledTimes(3);
});
