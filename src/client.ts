import { load } from 'cheerio';
import { login, refresh, type LoginOptions } from './auth.js';
import { FactsError, timeoutSignal } from './errors.js';
import type { Tokens } from './types.js';

export type { Tokens } from './types.js';
export { FactsError, type FactsErrorCode } from './errors.js';

export const API_BASE = 'https://nbsmobileapi.renweb.com/api/';

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

export interface ClientOptions {
  /** Previously saved tokens. With only a refresh token, the first request refreshes. */
  tokens?: Partial<Tokens>;
  /**
   * Options for a full login when there are no usable tokens or the refresh token is rejected.
   * Defaults to `FACTS_*` environment variables. `false` disables login; requests then throw `FACTS_LOGIN_REQUIRED`.
   */
  login?: LoginOptions | false;
  /** Called after every login or refresh; persist the tokens here to survive restarts. */
  onTokens?: (tokens: Tokens) => void | Promise<void>;
  /** Refresh this long before the access token expires. Defaults to 60 seconds. */
  refreshMarginMs?: number;
}

export interface RequestOptions { signal?: AbortSignal }

function invalidShape(): never {
  throw new FactsError('FACTS_UNAVAILABLE', 'Unsupported FACTS response.');
}

export class FactsClient {
  #tokens: Partial<Tokens> | undefined;
  #pending: Promise<Tokens> | undefined;
  readonly #login: LoginOptions | false;
  readonly #onTokens: ClientOptions['onTokens'];
  readonly #margin: number;

  constructor(options: ClientOptions = {}) {
    this.#tokens = options.tokens && { ...options.tokens };
    this.#login = options.login ?? {};
    this.#onTokens = options.onTokens;
    this.#margin = options.refreshMarginMs ?? 60_000;
  }

  /** The current tokens, if any have been loaded or issued. */
  get tokens(): Tokens | undefined {
    const tokens = this.#tokens;
    return tokens?.accessToken ? { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? '', expiresAt: tokens.expiresAt ?? 0 } : undefined;
  }

  /** Returns a valid access token, refreshing (or logging in) when needed. */
  async accessToken(): Promise<string> {
    const tokens = this.#tokens;
    if (tokens?.accessToken && (tokens.expiresAt == null || tokens.expiresAt - this.#margin > Date.now())) return tokens.accessToken;
    return (await this.#renew()).accessToken;
  }

  /** Authenticated GET against the FACTS mobile API, relative to {@link API_BASE}. */
  async get<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const token = await this.accessToken();
    try {
      return await this.#fetch<T>(path, token, options.signal);
    } catch (error) {
      if (!(error instanceof FactsError && error.code === 'FACTS_LOGIN_REQUIRED')) throw error;
      // Renew once unless a concurrent request already replaced the rejected token.
      if (this.#tokens?.accessToken === token) await this.#renew();
      return this.#fetch<T>(path, await this.accessToken(), options.signal);
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

  #renew(): Promise<Tokens> {
    if (!this.#pending) {
      const pending = this.#issue();
      this.#pending = pending;
      pending.finally(() => { if (this.#pending === pending) this.#pending = undefined; }).catch(() => {});
    }
    return this.#pending;
  }

  async #issue(): Promise<Tokens> {
    const refreshToken = this.#tokens?.refreshToken;
    if (refreshToken) {
      try {
        return await this.#store(await refresh(refreshToken));
      } catch (error) {
        if (!(error instanceof FactsError && error.code === 'FACTS_LOGIN_REQUIRED') || this.#login === false) throw error;
      }
    }
    if (this.#login === false) throw new FactsError('FACTS_LOGIN_REQUIRED', 'FACTS tokens are missing or expired and login is disabled.');
    return this.#store(await login(this.#login));
  }

  async #store(tokens: Tokens): Promise<Tokens> {
    const next = { ...tokens, refreshToken: tokens.refreshToken || this.#tokens?.refreshToken || '' };
    this.#tokens = next;
    await this.#onTokens?.(next);
    return next;
  }

  async #fetch<T>(path: string, token: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, API_BASE), { redirect: 'error',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: timeoutSignal(signal) });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new FactsError('FACTS_UNAVAILABLE', 'FACTS is unavailable.', { cause });
    }
    if (response.status === 401) throw new FactsError('FACTS_LOGIN_REQUIRED', 'FACTS rejected the access token.');
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
      throw new FactsError('FACTS_UNAVAILABLE', `FACTS API HTTP ${response.status}.`);
    }
    return response.json() as Promise<T>;
  }
}

export function createClient(options: ClientOptions = {}): FactsClient {
  return new FactsClient(options);
}
