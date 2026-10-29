import { afterEach, expect, test, vi } from 'vitest';
import { API_BASE, createApi, FactsError, type ApiFetch, type Student } from '../src/api.js';

afterEach(() => { vi.restoreAllMocks(); });

const student: Student = { id: 'S:1', name: 'Sam Lee', context: { student: '1', school: 'S', year: '2026', term: '2' } };
const schools = { studentSchools: [{ schoolCode: 'S', pwDefaultYearId: 2026, pwDefaultTermId: 2,
  students: [{ id: 1, firstName: 'Samuel', nickName: 'Sam', lastName: 'Lee' }, { id: 2 }] }] };

test('fetch receives an absolute URL, JSON accept header, timeout and no authorization', async () => {
  const fetch = vi.fn<ApiFetch>().mockResolvedValue(Response.json({ ok: true }));
  expect(await createApi({ fetch }).get('example?key=value')).toEqual({ ok: true });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBeInstanceOf(URL);
  expect(url.href).toBe(`${API_BASE}example?key=value`);
  expect(init.redirect).toBe('error');
  expect([...new Headers(init.headers)]).toEqual([['accept', 'application/json']]);
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(init.signal!.aborted).toBe(false);
});

test('standard global fetch fits the API fetch signature', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
  await expect(createApi({ fetch: globalThis.fetch }).get('example')).resolves.toEqual({ ok: true });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a 401 requires login with exactly one request', async () => {
  const fetch = vi.fn<ApiFetch>().mockResolvedValue(new Response('', { status: 401 }));
  await expect(createApi({ fetch }).get('example')).rejects.toMatchObject({ name: 'FactsError', code: 'FACTS_LOGIN_REQUIRED' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  ['HTTP failure', () => Response.json({ message: 'unavailable' }, { status: 503 })],
  ['non-JSON content', () => new Response('<html>Unavailable</html>', { headers: { 'content-type': 'text/html' } })],
  ['malformed JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
])('%s is unavailable without retries', async (_, response) => {
  const fetch = vi.fn<ApiFetch>().mockImplementation(async () => response());
  await expect(createApi({ fetch }).get('example')).rejects.toMatchObject({ name: 'FactsError', code: 'FACTS_UNAVAILABLE' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a thrown fetch is wrapped as unavailable', async () => {
  const cause = new TypeError('Network failure');
  const fetch = vi.fn<ApiFetch>().mockRejectedValue(cause);
  await expect(createApi({ fetch }).get('example')).rejects.toMatchObject({ name: 'FactsError', code: 'FACTS_UNAVAILABLE', cause });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('caller abort reaches fetch and propagates without being wrapped', async () => {
  const controller = new AbortController();
  const reason = new Error('Caller stopped the request');
  const fetch = vi.fn<ApiFetch>().mockImplementation(async (_, init) => {
    expect(init.signal).not.toBe(controller.signal);
    controller.abort(reason);
    expect(init.signal!.aborted).toBe(true);
    throw init.signal!.reason;
  });
  await expect(createApi({ fetch }).get('example', { signal: controller.signal })).rejects.toBe(reason);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('the 30-second timeout is combined with the caller signal and mapped to unavailable', async () => {
  const timeout = new AbortController();
  const timeoutSignal = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  const fetch = vi.fn<ApiFetch>().mockImplementation(async (_, init) => {
    timeout.abort(new DOMException('Timed out', 'TimeoutError'));
    throw init.signal!.reason;
  });
  const controller = new AbortController();
  await expect(createApi({ fetch }).get('example', { signal: controller.signal })).rejects.toMatchObject({ code: 'FACTS_UNAVAILABLE' });
  expect(timeoutSignal).toHaveBeenCalledWith(30_000);
  expect(controller.signal.aborted).toBe(false);
});

test('students flatten schools, use nicknames and retain each school default context', async () => {
  const fetch = vi.fn<ApiFetch>().mockResolvedValue(Response.json({ studentSchools: [
    ...schools.studentSchools,
    { schoolCode: 'OTHER', pwDefaultYearId: 2027, pwDefaultTermId: 3, students: [{ id: 1, firstName: 'Alex' }] },
  ] }));
  expect(await createApi({ fetch }).students()).toEqual([
    student,
    { id: 'S:2', name: 'Student', context: { student: '2', school: 'S', year: '2026', term: '2' } },
    { id: 'OTHER:1', name: 'Alex', context: { student: '1', school: 'OTHER', year: '2027', term: '3' } },
  ]);
  expect(fetch.mock.calls[0]![0].href).toBe(`${API_BASE}SchoolsAndStudents/v1?featureName=10`);
});

test.each([
  {},
  { studentSchools: [{ schoolCode: '', pwDefaultYearId: 1, pwDefaultTermId: 1, students: [] }] },
  { studentSchools: [{ schoolCode: 'S', students: [] }] },
  { studentSchools: [{ ...schools.studentSchools[0], students: [{}] }] },
  { studentSchools: [...schools.studentSchools, ...schools.studentSchools] },
])('unsupported student shapes are rejected: %j', async payload => {
  const fetch = vi.fn<ApiFetch>().mockResolvedValue(Response.json(payload));
  await expect(createApi({ fetch }).students()).rejects.toMatchObject({ code: 'FACTS_UNAVAILABLE' });
});

test('homework keeps all ranges, dates and identifiers, preferring plain text over HTML', async () => {
  const fetch = vi.fn<ApiFetch>().mockResolvedValue(Response.json({ studentHomeworkDateRangeModels: [
    { notesDetails: [{ classId: 1, courseTitle: 'Math', eventDate: '2026-10-16T00:00:00', homeworkHTML: '<b>Read</b> &amp; write' }] },
    { notesDetails: [{ eventDate: '2026-10-23', homeworkHTML: ' Next week ' }] },
    { notesDetails: [{ uid: 'stable-id', classId: 3, eventDate: '2026-10-30', homeworkPlaintext: ' Plain text ', homeworkHTML: '<b>ignored</b>' }] },
  ] }));
  expect(await createApi({ fetch }).homework(student)).toEqual([
    { id: '1:2026-10-16', classId: '1', course: 'Math', eventDate: '2026-10-16', homework: 'Read & write' },
    { id: ':2026-10-23', classId: '', course: 'Class', eventDate: '2026-10-23', homework: 'Next week' },
    { id: 'stable-id', classId: '3', course: 'Class', eventDate: '2026-10-30', homework: 'Plain text' },
  ]);
  expect(fetch.mock.calls[0]![0].href).toBe(`${API_BASE}Homework/students/1/schoolYearId/2026/legacyTermId/2`);
});

test('homework resolves a student id and forwards the caller signal to both requests', async () => {
  const controller = new AbortController();
  const fetch = vi.fn<ApiFetch>()
    .mockResolvedValueOnce(Response.json(schools))
    .mockResolvedValueOnce(Response.json({ studentHomeworkDateRangeModels: [] }));
  expect(await createApi({ fetch }).homework(student.id, { signal: controller.signal })).toEqual([]);
  expect(fetch.mock.calls.map(([url]) => url.pathname)).toEqual([
    '/api/SchoolsAndStudents/v1', '/api/Homework/students/1/schoolYearId/2026/legacyTermId/2',
  ]);
  controller.abort();
  expect(fetch.mock.calls.every(([, init]) => init.signal!.aborted)).toBe(true);
});

test('homework rejects a missing student without requesting homework', async () => {
  const fetch = vi.fn<ApiFetch>().mockResolvedValue(Response.json(schools));
  await expect(createApi({ fetch }).homework('S:missing')).rejects.toBeInstanceOf(FactsError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('homework encodes context in URL path segments', async () => {
  const fetch = vi.fn<ApiFetch>().mockResolvedValue(Response.json({ studentHomeworkDateRangeModels: [] }));
  await createApi({ fetch }).homework({ ...student, context: { ...student.context, student: 'a/b', year: 'a b', term: 'a?b' } });
  expect(fetch.mock.calls[0]![0].href).toBe(`${API_BASE}Homework/students/a%2Fb/schoolYearId/a%20b/legacyTermId/a%3Fb`);
});

test.each([
  {},
  { studentHomeworkDateRangeModels: [{}] },
  { studentHomeworkDateRangeModels: [{ notesDetails: [null] }] },
  { studentHomeworkDateRangeModels: [{ notesDetails: [{ eventDate: '2026-02-30' }] }] },
  { studentHomeworkDateRangeModels: [{ notesDetails: [{ eventDate: 'tomorrow' }] }] },
  { studentHomeworkDateRangeModels: [{ notesDetails: [{ eventDate: '2026-10-16', homeworkPlaintext: 123 }] }] },
])('unsupported homework shapes are rejected: %j', async payload => {
  const fetch = vi.fn<ApiFetch>().mockResolvedValue(Response.json(payload));
  await expect(createApi({ fetch }).homework(student)).rejects.toMatchObject({ code: 'FACTS_UNAVAILABLE' });
});
