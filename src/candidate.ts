/**
 * GED Candidate version handling.
 *
 * UCDP publishes two kinds of preliminary (candidate) GED files:
 *  - monthly files "YY.0.M" (e.g. 26.0.9 = September 2026 only), released every month;
 *  - cumulative files "YY.01.YY.MM" (e.g. 26.01.26.09 = Jan–Sep 2026), released quarterly.
 *
 * To answer "year to date" questions we combine the newest cumulative file with
 * every monthly file released after it. New versions are discovered by probing
 * the next expected version number (at most once per day, result kept in KV),
 * so nobody has to bump version numbers by hand.
 */
import { fetchPage, UcdpError, type UcdpEnv } from "./ucdp";

export interface Ym {
	y: number; // two-digit year, e.g. 26
	m: number; // 1-12
}

const ymValue = (v: Ym) => v.y * 12 + (v.m - 1);

export function parseMonthly(v: string): Ym | null {
	const m = v.match(/^(\d{2})\.0\.(\d{1,2})$/);
	return m ? { y: Number(m[1]), m: Number(m[2]) } : null;
}

/** Returns the end month of a cumulative version like 26.01.26.09. */
export function parseCumulative(v: string): Ym | null {
	const m = v.match(/^(\d{2})\.01\.(\d{2})\.(\d{2})$/);
	return m && m[1] === m[2] ? { y: Number(m[2]), m: Number(m[3]) } : null;
}

export const monthlyVersion = (v: Ym) => `${v.y}.0.${v.m}`;
export const cumulativeVersion = (v: Ym) => `${v.y}.01.${v.y}.${String(v.m).padStart(2, "0")}`;

function nextMonth(v: Ym): Ym {
	return v.m === 12 ? { y: v.y + 1, m: 1 } : { y: v.y, m: v.m + 1 };
}


async function versionExists(env: UcdpEnv, version: string) {
	try {
		await fetchPage(env, undefined, "gedevents", version, {}, 0, 1);
		return true;
	} catch (e) {
		// UCDP answers 400 "Invalid object name" for versions that do not exist (yet).
		if (e instanceof UcdpError && (e.status === 400 || e.status === 404)) return false;
		throw e;
	}
}

async function probeForward(env: UcdpEnv, start: Ym, step: (v: Ym) => Ym, toVersion: (v: Ym) => string) {
	let latest = start;
	for (let i = 0; i < 4; i++) {
		const candidate = step(latest);
		if (!(await versionExists(env, toVersion(candidate)))) break;
		latest = candidate;
	}
	return latest;
}

export interface CandidateVersions {
	cumulative: string;
	monthly: string;
	checkedAt: string;
}

const KV_KEY = "ged-candidate-versions";

/** Newest cumulative and monthly candidate versions, rediscovered at most once per day. */
export async function latestCandidateVersions(
	env: UcdpEnv & { GED_CANDIDATE_VERSION: string; GED_CANDIDATE_CUMULATIVE_VERSION: string },
): Promise<CandidateVersions> {
	const floorMonthly = parseMonthly(env.GED_CANDIDATE_VERSION);
	const floorCumulative = parseCumulative(env.GED_CANDIDATE_CUMULATIVE_VERSION);
	if (!floorMonthly || !floorCumulative) {
		throw new UcdpError("GED_CANDIDATE_VERSION / GED_CANDIDATE_CUMULATIVE_VERSION have an unexpected format.");
	}

	// Start from whatever was discovered before (kept without expiry), never below the configured floor.
	let startMonthly = floorMonthly;
	let startCumulative = floorCumulative;
	const stored = await env.UCDP_KV.get(KV_KEY);
	if (stored) {
		const s = JSON.parse(stored) as CandidateVersions;
		const sm = parseMonthly(s.monthly);
		const sc = parseCumulative(s.cumulative);
		if (sm && sc && ymValue(sm) >= ymValue(floorMonthly) && ymValue(sc) >= ymValue(floorCumulative)) {
			if (Date.now() - Date.parse(s.checkedAt) < 24 * 60 * 60 * 1000) return s;
			startMonthly = sm;
			startCumulative = sc;
		}
	}

	const monthly = await probeForward(env, startMonthly, nextMonth, monthlyVersion);
	// Cumulative files have so far come quarterly, but check each of the next six
	// months so an off-cycle release is not missed.
	let cumulative = startCumulative;
	for (let i = 0, cur = startCumulative; i < 6; i++) {
		cur = nextMonth(cur);
		if (await versionExists(env, cumulativeVersion(cur))) cumulative = cur;
	}
	const result: CandidateVersions = {
		monthly: monthlyVersion(monthly),
		cumulative: cumulativeVersion(cumulative),
		checkedAt: new Date().toISOString(),
	};
	await env.UCDP_KV.put(KV_KEY, JSON.stringify(result));
	return result;
}

/**
 * The versions to query for "all candidate data": the cumulative file plus every
 * monthly file released after the cumulative file's last month.
 */
export function candidateVersionSet(v: CandidateVersions): string[] {
	const cum = parseCumulative(v.cumulative)!;
	const mon = parseMonthly(v.monthly)!;
	const versions = [v.cumulative];
	for (let cur = nextMonth(cum); ymValue(cur) <= ymValue(mon); cur = nextMonth(cur)) {
		versions.push(monthlyVersion(cur));
	}
	return versions;
}
