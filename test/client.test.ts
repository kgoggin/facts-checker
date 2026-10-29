import { afterEach, expect, test, vi } from 'vitest';
import { createClient, type Student } from '../src/client.js';

afterEach(() => { vi.restoreAllMocks(); });
const student: Student = { id: 'school:1', name: 'A', context: { student: '1', school: 'school', year: '2026', term: '1' } };
const hour = () => Date.now() + 3_600_000;

function api(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => handler(new URL(String(input)), init ?? {}));
}
const bearer = (init: RequestInit) => (init.headers as Record<string, string>).authorization;

test('homework keeps all date ranges and converts HTML to inert text', async () => {
  api(() => Response.json({ studentHomeworkDateRangeModels: [
    { notesDetails: [{ classId: 1, courseTitle: 'Math', eventDate: '2026-10-16', homeworkHTML: '<b>Read</b> &amp; write' }] },
    { notesDetails: [{ classId: 2, eventDate: '2026-10-23', homeworkHTML: 'Next week' }] },
    { notesDetails: [{ uid: 'stable-id', classId: 3, eventDate: '2026-10-30', homeworkPlaintext: ' Plain text ', homeworkHTML: '<b>x</b>' }] },
  ] }));
  const rows = await createClient({ tokens: { accessToken: 'a', expiresAt: hour() }, login: false }).homework(student);
  expect(rows.map(row => row.homework)).toEqual(['Read & write', 'Next week', 'Plain text']);
  expect(rows[2]!.id).toBe('stable-id');
});

test('unsupported homework shapes are rejected', async () => {
  const client = createClient({ tokens: { accessToken: 'a', expiresAt: hour() }, login: false });
  api(() => Response.json({}));
  await expect(client.homework(student)).rejects.toMatchObject({ code: 'FACTS_UNAVAILABLE' });
  api(() => Response.json({ studentHomeworkDateRangeModels: [{ notesDetails: [{ eventDate: '2026-02-30', homeworkPlaintext: 'x' }] }] }));
  await expect(client.homework(student)).rejects.toThrow(/response/);
});

test('students are flattened with school default year and term', async () => {
  api(url => {
    expect(url.href).toBe('https://nbsmobileapi.renweb.com/api/SchoolsAndStudents/v1?featureName=10');
    return Response.json({ studentSchools: [{ schoolCode: 'S', pwDefaultYearId: 9, pwDefaultTermId: 2,
      students: [{ id: 5, firstName: 'Sam', nickName: 'Sammy', lastName: 'Lee' }] }] });
  });
  expect(await createClient({ tokens: { accessToken: 'a' }, login: false }).students())
    .toEqual([{ id: 'S:5', name: 'Sammy Lee', context: { student: '5', school: 'S', year: '9', term: '2' } }]);
});

test('expired tokens refresh once for concurrent requests and are reported', async () => {
  const onTokens = vi.fn();
  let refreshes = 0;
  api(async (url, init) => {
    if (url.pathname === '/connect/token') { refreshes++; return Response.json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }); }
    expect(bearer(init)).toBe('Bearer new');
    return Response.json({ ok: true });
  });
  const client = createClient({ tokens: { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 1000 }, onTokens, login: false });
  await Promise.all([client.get('a'), client.get('b')]);
  expect(refreshes).toBe(1);
  expect(onTokens).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'new', refreshToken: 'r2' }));
  expect(client.tokens?.refreshToken).toBe('r2');
});

test('a 401 refreshes and retries once', async () => {
  const seen: string[] = [];
  api(async (url, init) => {
    if (url.pathname === '/connect/token') return Response.json({ access_token: 'new', expires_in: 3600 });
    seen.push(bearer(init)!);
    return bearer(init) === 'Bearer old' ? new Response('', { status: 401 }) : Response.json({ ok: 1 });
  });
  const client = createClient({ tokens: { accessToken: 'old', refreshToken: 'r', expiresAt: hour() }, login: false });
  expect(await client.get('x')).toEqual({ ok: 1 });
  expect(seen).toEqual(['Bearer old', 'Bearer new']);
});

test('a rejected refresh token falls back to login, or fails when login is disabled', async () => {
  api(() => new Response('', { status: 400 }));
  await expect(createClient({ tokens: { refreshToken: 'dead' }, login: false }).get('x')).rejects.toMatchObject({ code: 'FACTS_LOGIN_REQUIRED' });
  await expect(createClient({ tokens: { refreshToken: 'dead' }, login: { env: {} } }).get('x')).rejects.toMatchObject({ code: 'FACTS_CONFIG' });
});
