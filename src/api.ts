import { load } from 'cheerio';
import { API_BASE } from './config.js';
import { FactsError, timeoutSignal } from './errors.js';

export { API_BASE, FACTS_OAUTH } from './config.js';
export { FactsError, type FactsErrorCode } from './errors.js';

export type ApiFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface ApiOptions {
  /** Authenticates requests; the API never adds credentials or retries. */
  fetch: ApiFetch;
}

export interface Student {
  /** Stable `school:student` identifier. */
  id: string;
  name: string;
  context: { student: string; school: string; year: string; term: string };
}

export interface Homework {
  id: string;
  classId: string;
  course: string;
  /** `YYYY-MM-DD`. */
  eventDate: string;
  /** Plain text; HTML is converted, never returned. */
  homework: string;
}

export interface RequestOptions { signal?: AbortSignal }

function invalidShape(): never {
  throw new FactsError('FACTS_UNAVAILABLE', 'Unsupported FACTS response.');
}

/** Typed FACTS mobile API access with authentication supplied by the caller. */
export class FactsApi {
  readonly #fetch: ApiFetch;

  constructor(options: ApiOptions) {
    this.#fetch = options.fetch;
  }

  /** GET against the FACTS mobile API, relative to {@link API_BASE}. */
  async get<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const { signal } = options;
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, API_BASE), { redirect: 'error',
        headers: { accept: 'application/json' }, signal: timeoutSignal(signal) });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new FactsError('FACTS_UNAVAILABLE', 'FACTS is unavailable.', { cause });
    }
    if (response.status === 401) throw new FactsError('FACTS_LOGIN_REQUIRED', 'FACTS rejected the access token.');
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
      throw new FactsError('FACTS_UNAVAILABLE', `FACTS API HTTP ${response.status}.`);
    }
    try {
      return await response.json() as T;
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new FactsError('FACTS_UNAVAILABLE', 'Unsupported FACTS response.', { cause });
    }
  }

  /** Every student on the parent account, with the school's default year and term. */
  async students(options: RequestOptions = {}): Promise<Student[]> {
    const payload = await this.get<{ studentSchools?: unknown }>('SchoolsAndStudents/v1?featureName=10', options);
    if (!Array.isArray(payload?.studentSchools)) invalidShape();
    const students: Student[] = [];
    for (const school of payload.studentSchools) {
      if (typeof school?.schoolCode !== 'string' || !school.schoolCode || school.pwDefaultYearId == null || school.pwDefaultTermId == null || !Array.isArray(school.students)) invalidShape();
      for (const student of school.students) {
        if (student?.id == null) invalidShape();
        students.push({ id: `${school.schoolCode}:${student.id}`,
          name: [student.nickName || student.firstName, student.lastName].filter(Boolean).join(' ') || 'Student',
          context: { student: String(student.id), school: school.schoolCode, year: String(school.pwDefaultYearId), term: String(school.pwDefaultTermId) } });
      }
    }
    if (new Set(students.map(student => student.id)).size !== students.length) invalidShape();
    return students;
  }

  /** Homework for a student (or student id from {@link students}) in its default year and term. */
  async homework(student: Student | string, options: RequestOptions = {}): Promise<Homework[]> {
    if (typeof student === 'string') {
      const id = student;
      const found = (await this.students(options)).find(candidate => candidate.id === id);
      if (!found) throw new FactsError('FACTS_UNAVAILABLE', `No FACTS student ${id}.`);
      student = found;
    }
    const { student: id, year, term } = Object.fromEntries(Object.entries(student.context).map(([key, value]) => [key, encodeURIComponent(value)])) as Student['context'];
    const payload = await this.get<{ studentHomeworkDateRangeModels?: unknown }>(`Homework/students/${id}/schoolYearId/${year}/legacyTermId/${term}`, options);
    if (!Array.isArray(payload?.studentHomeworkDateRangeModels)) invalidShape();
    return payload.studentHomeworkDateRangeModels.flatMap(range => {
      if (!Array.isArray(range?.notesDetails)) invalidShape();
      return range.notesDetails.map((note: Record<string, unknown> | null): Homework => {
        if (typeof note?.eventDate !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(note.eventDate) || note.homeworkPlaintext != null && typeof note.homeworkPlaintext !== 'string') invalidShape();
        const date = note.eventDate.slice(0, 10);
        const parsed = new Date(`${date}T12:00:00Z`);
        if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) invalidShape();
        return { id: String(note.uid ?? `${note.classId ?? ''}:${date}`), classId: String(note.classId ?? ''), course: String(note.courseTitle ?? 'Class'),
          eventDate: date, homework: ((note.homeworkPlaintext as string | null | undefined) ?? load(String(note.homeworkHTML ?? '')).text()).trim() };
      });
    });
  }
}

export function createApi(options: ApiOptions): FactsApi {
  return new FactsApi(options);
}
