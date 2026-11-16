/**
 * Thin client for the UCDP API (https://ucdp.uu.se/apidocs/).
 *
 * - The access token never leaves the Worker: it is read from the UCDP_ACCESS_TOKEN secret.
 * - Responses are cached with the Workers Cache API so repeated questions do not
 *   count against the 5,000 requests/day quota.
 * - Every upstream call (cache misses only) is counted per UTC day in KV.
 */

const DEFAULT_BASE_URL = "https://ucdpapi.pcr.uu.se/api";

export const YEARLY_DATASETS = [
	"ucdpprioconflict",
	"dyadic",
	"nonstate",
	"onesided",
	"battledeaths",
	"organizedviolencecy",
] as const;
export type YearlyDataset = (typeof YEARLY_DATASETS)[number];

export interface UcdpPage<T = Record<string, unknown>> {
	TotalCount: number;
	TotalPages: number;
	PreviousPageUrl: string | null;
	NextPageUrl: string | null;
	Result: T[];
}

export type Filters = Record<string, string | number | Array<string | number> | undefined>;

export class UcdpError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

export interface UcdpEnv {
	UCDP_ACCESS_TOKEN: string;
	UCDP_KV: KVNamespace;
	UCDP_PAGE_SIZE?: string;
	UCDP_CACHE_TTL_SECONDS?: string;
	UCDP_DAILY_SOFT_LIMIT?: string;
	/** Only for local tests against a mock. */
	UCDP_API_BASE?: string;
}

function buildUrl(base: string, resource: string, version: string, filters: Filters, page: number, pageSize: number) {
	if (!/^[a-z]+$/.test(resource)) throw new UcdpError(`Invalid resource: ${resource}`);
	if (!/^[0-9.]+$/.test(version)) throw new UcdpError(`Invalid version: ${version}`);
	const url = new URL(`${base}/${resource}/${version}`);
	url.searchParams.set("pagesize", String(pageSize));
	url.searchParams.set("page", String(page));
	// Sort keys so equivalent queries hit the same cache entry.
	for (const key of Object.keys(filters).sort()) {
		const value = filters[key];
		if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
		url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
	}
	return url;
}

function quotaKey(date = new Date()) {
	return `ucdp-quota:${date.toISOString().slice(0, 10)}`;
}

export async function getQuotaUsage(env: UcdpEnv) {
	const used = Number((await env.UCDP_KV.get(quotaKey())) ?? "0");
	const limit = Number(env.UCDP_DAILY_SOFT_LIMIT ?? "4500");
	return { used, softLimit: limit, upstreamLimit: 5000, resetsAt: "00:00 UTC" };
}

async function countUpstreamCall(env: UcdpEnv) {
	// KV is eventually consistent, so this is an approximate counter. Good enough
	// as a safety net against runaway pagination; UCDP enforces the real limit.
	const key = quotaKey();
	const used = Number((await env.UCDP_KV.get(key)) ?? "0") + 1;
	await env.UCDP_KV.put(key, String(used), { expirationTtl: 60 * 60 * 48 });
	return used;
}

export async function fetchPage<T = Record<string, unknown>>(
	env: UcdpEnv,
	ctx: ExecutionContext | undefined,
	resource: string,
	version: string,
	filters: Filters,
	page = 0,
	pageSize = Number(env.UCDP_PAGE_SIZE ?? "1000"),
): Promise<{ data: UcdpPage<T>; cached: boolean }> {
	const url = buildUrl(env.UCDP_API_BASE || DEFAULT_BASE_URL, resource, version, filters, page, pageSize);
	// Cache key is the URL only; the token is never part of it.
	const cacheKey = new Request(url.toString(), { method: "GET" });
	const cache = (caches as unknown as { default: Cache }).default;

	const hit = await cache.match(cacheKey);
	if (hit) return { data: (await hit.json()) as UcdpPage<T>, cached: true };

	const quota = await getQuotaUsage(env);
	if (quota.used >= quota.softLimit) {
		throw new UcdpError(
			`Daily UCDP request budget reached (${quota.used}/${quota.softLimit}, resets 00:00 UTC). Try again later or narrow the query.`,
			429,
		);
	}

	await countUpstreamCall(env);
	const resp = await fetch(url.toString(), {
		headers: { "x-ucdp-access-token": env.UCDP_ACCESS_TOKEN, accept: "application/json" },
	});
	if (!resp.ok) {
		const body = (await resp.text()).slice(0, 300);
		throw new UcdpError(`UCDP API returned HTTP ${resp.status} for ${url.pathname}${url.search}: ${body}`, resp.status);
	}
	const text = await resp.text();
	let data: UcdpPage<T>;
	try {
		data = JSON.parse(text) as UcdpPage<T>;
	} catch {
		throw new UcdpError(`UCDP API returned non-JSON for ${url.pathname}${url.search}`);
	}

	const ttl = Number(env.UCDP_CACHE_TTL_SECONDS ?? "21600");
	const toCache = new Response(text, {
		headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
	});
	const put = cache.put(cacheKey, toCache);
	if (ctx) ctx.waitUntil(put);
	else await put;

	return { data, cached: false };
}

/**
 * Fetch up to `maxRecords` records, following pages. Returns the records plus
 * metadata about how complete the result is.
 */
export async function fetchAll<T = Record<string, unknown>>(
	env: UcdpEnv,
	ctx: ExecutionContext | undefined,
	resource: string,
	version: string,
	filters: Filters,
	maxRecords: number,
) {
	const pageSize = Math.min(Number(env.UCDP_PAGE_SIZE ?? "1000"), Math.max(1, maxRecords));
	const records: T[] = [];
	let totalCount = 0;
	let totalPages = 0;
	let upstreamCalls = 0;
	let page = 0;

	while (records.length < maxRecords) {
		const { data, cached } = await fetchPage<T>(env, ctx, resource, version, filters, page, pageSize);
		if (!cached) upstreamCalls++;
		totalCount = data.TotalCount;
		totalPages = data.TotalPages;
		records.push(...(data.Result ?? []));
		page++;
		if (page >= totalPages || (data.Result ?? []).length === 0) break;
	}

	return {
		records: records.slice(0, maxRecords),
		totalCount,
		totalPages,
		truncated: totalCount > Math.min(records.length, maxRecords),
		upstreamCalls,
	};
}
