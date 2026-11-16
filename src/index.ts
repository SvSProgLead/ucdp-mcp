import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { handleAccessRequest } from "./access-handler";
import { fetchAll, getQuotaUsage, UcdpError, YEARLY_DATASETS, type Filters } from "./ucdp";

const GED_COMPACT_FIELDS = [
	"id",
	"date_start",
	"date_end",
	"year",
	"type_of_violence",
	"conflict_new_id",
	"conflict_name",
	"dyad_new_id",
	"dyad_name",
	"side_a",
	"side_b",
	"country",
	"country_id",
	"region",
	"adm_1",
	"adm_2",
	"where_coordinates",
	"latitude",
	"longitude",
	"where_prec",
	"date_prec",
	"event_clarity",
	"best",
	"low",
	"high",
	"deaths_a",
	"deaths_b",
	"deaths_civilians",
	"deaths_unknown",
	"source_headline",
] as const;

const VIOLENCE_TYPES = "1 = state-based conflict, 2 = non-state conflict, 3 = one-sided violence";

const CITATION =
	"Källa: Uppsala Conflict Data Program (UCDP), https://ucdp.uu.se. GED: Sundberg & Melander (2013), Journal of Peace Research 50(4); Davies et al. (2025). Ange alltid datasetversion. Licens CC BY 4.0.";

const intList = z.array(z.number().int()).optional();
const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
	.optional();

const gedFilterShape = {
	candidate: z
		.boolean()
		.default(false)
		.describe(
			"true = use the preliminary monthly GED Candidate dataset (recent months, not yet in the annual release). false = the stable annual GED release.",
		),
	version: z
		.string()
		.regex(/^[0-9.]+$/)
		.optional()
		.describe("Override the dataset version, e.g. '26.1' or candidate '26.0.9'. Defaults to the server's configured latest."),
	country_ids: intList.describe(
		"Gleditsch & Ward country codes (e.g. 500 = Uganda, 520 = Somalia, 365 = Russia, 369 = Ukraine). Use ucdp_find_country if unsure.",
	),
	start_date: isoDate.describe("Events whose date_end is on or after this date (YYYY-MM-DD)."),
	end_date: isoDate.describe("Events whose date_end is on or before this date (YYYY-MM-DD)."),
	type_of_violence: z.array(z.number().int().min(1).max(3)).optional().describe(VIOLENCE_TYPES),
	dyad_ids: intList.describe("dyad_new_id values."),
	actor_ids: intList.describe("Actor ids (new format); matches side_a_new_id or side_b_new_id."),
	event_ids: intList.describe("Specific GED event ids."),
	bbox: z
		.object({
			south: z.number(),
			west: z.number(),
			north: z.number(),
			east: z.number(),
		})
		.optional()
		.describe("Geographic bounding box in decimal degrees."),
};

const gedFilterSchema = z.object(gedFilterShape);
type GedFilterArgs = z.infer<typeof gedFilterSchema>;

function gedRequest(args: GedFilterArgs) {
	const version = args.version ?? (args.candidate ? env.GED_CANDIDATE_VERSION : env.GED_VERSION);
	const filters: Filters = {
		Country: args.country_ids,
		StartDate: args.start_date,
		EndDate: args.end_date,
		TypeOfViolence: args.type_of_violence,
		Dyad: args.dyad_ids,
		Actor: args.actor_ids,
		Id: args.event_ids,
		Geography: args.bbox
			? `${args.bbox.south} ${args.bbox.west},${args.bbox.north} ${args.bbox.east}`
			: undefined,
	};
	return { version, filters };
}

function pick(record: Record<string, unknown>, fields: readonly string[]) {
	const out: Record<string, unknown> = {};
	for (const f of fields) if (f in record) out[f] = record[f];
	return out;
}

function json(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}

function errorResult(err: unknown) {
	const message = err instanceof UcdpError || err instanceof Error ? err.message : String(err);
	return { content: [{ type: "text" as const, text: `Fel: ${message}` }], isError: true };
}

export function createServer() {
	const server = new McpServer({ name: "UCDP (FOI)", version: "1.0.0" });
	const ctx = undefined; // cache writes are awaited inline in the stateless handler

	server.registerTool(
		"ucdp_ged_events",
		{
			description:
				"Fetch individual georeferenced events of organized violence from UCDP GED (annual release) or GED Candidate (preliminary monthly data). " +
				"Each event has a date, location, actors and fatality estimates (best/low/high). Use ucdp_ged_summary instead when you need totals or trends over many events.",
			inputSchema: z.object({
				...gedFilterShape,
				max_results: z.number().int().min(1).max(2000).default(100).describe("Max events to return (1-2000)."),
				full_records: z
					.boolean()
					.default(false)
					.describe("true = return every field incl. source articles. false = a compact set of the most useful fields."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			try {
				const { version, filters } = gedRequest(args);
				const r = await fetchAll(env, ctx, "gedevents", version, filters, args.max_results);
				return json({
					dataset: args.candidate ? "GED Candidate" : "GED",
					version,
					total_matching: r.totalCount,
					returned: r.records.length,
					truncated: r.truncated,
					events: args.full_records ? r.records : r.records.map((e) => pick(e, GED_COMPACT_FIELDS)),
					citation: CITATION,
				});
			} catch (e) {
				return errorResult(e);
			}
		},
	);

	server.registerTool(
		"ucdp_ged_summary",
		{
			description:
				"Aggregate UCDP GED / GED Candidate events server-side and return event counts and fatality sums (best, low, high, civilians) grouped by the chosen dimensions. " +
				"Use for questions like 'fatalities per month in Sudan 2025' or 'which countries had most one-sided violence'.",
			inputSchema: z.object({
				...gedFilterShape,
				group_by: z
					.array(
						z.enum([
							"country",
							"year",
							"month",
							"type_of_violence",
							"conflict_name",
							"dyad_name",
							"side_a",
							"side_b",
							"adm_1",
							"region",
						]),
					)
					.min(1)
					.max(3)
					.default(["country"]),
				max_events: z
					.number()
					.int()
					.min(1)
					.max(100000)
					.default(20000)
					.describe("Safety cap on how many events to read (each 1,000 events = 1 API request)."),
				top: z.number().int().min(1).max(1000).default(100).describe("Return at most this many groups, sorted by best estimate."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			try {
				const { version, filters } = gedRequest(args);
				const r = await fetchAll(env, ctx, "gedevents", version, filters, args.max_events);
				const groups = new Map<string, Record<string, unknown> & { events: number; best: number; low: number; high: number; civilians: number }>();
				for (const e of r.records) {
					const keyParts: Record<string, unknown> = {};
					for (const g of args.group_by) {
						keyParts[g] = g === "month" ? String(e.date_end ?? e.date_start ?? "").slice(0, 7) : e[g];
					}
					const key = JSON.stringify(keyParts);
					const acc = groups.get(key) ?? { ...keyParts, events: 0, best: 0, low: 0, high: 0, civilians: 0 };
					acc.events++;
					acc.best += Number(e.best ?? 0);
					acc.low += Number(e.low ?? 0);
					acc.high += Number(e.high ?? 0);
					acc.civilians += Number(e.deaths_civilians ?? 0);
					groups.set(key, acc);
				}
				const rows = [...groups.values()].sort((a, b) => b.best - a.best);
				return json({
					dataset: args.candidate ? "GED Candidate" : "GED",
					version,
					total_matching: r.totalCount,
					events_aggregated: r.records.length,
					complete: !r.truncated,
					note: r.truncated
						? `Only ${r.records.length} of ${r.totalCount} events were read; raise max_events or narrow filters for complete totals.`
						: undefined,
					groups_total: rows.length,
					groups: rows.slice(0, args.top),
					citation: CITATION,
				});
			} catch (e) {
				return errorResult(e);
			}
		},
	);

	server.registerTool(
		"ucdp_yearly",
		{
			description:
				"Query UCDP's annual (conflict-year / dyad-year / country-year) datasets: " +
				"ucdpprioconflict (UCDP/PRIO Armed Conflict), dyadic, nonstate, onesided, battledeaths, organizedviolencecy (country-year organized violence). " +
				"Filters not supported by the chosen dataset are ignored by UCDP.",
			inputSchema: z.object({
				dataset: z.enum(YEARLY_DATASETS),
				version: z.string().regex(/^[0-9.]+$/).optional().describe("Defaults to the server's configured latest (e.g. 26.1)."),
				country_ids: intList.describe("Gleditsch & Ward codes (Country / Country_Id filter)."),
				years: intList,
				conflict_ids: intList.describe("conflict_id (ucdpprioconflict, dyadic, battledeaths, nonstate)."),
				dyad_ids: intList.describe("dyad_id (dyadic, battledeaths) or actor_id (onesided)."),
				org: z.array(z.number().int().min(1).max(3)).optional().describe("nonstate only: organization level of the sides."),
				incompatibility: z.array(z.number().int().min(1).max(3)).optional().describe("1 = territory, 2 = government, 3 = both."),
				conflict_type: z
					.array(z.number().int().min(1).max(4))
					.optional()
					.describe("1 = extrasystemic, 2 = interstate, 3 = intrastate, 4 = internationalized intrastate."),
				region: z.array(z.string()).optional().describe("organizedviolencecy only: region names."),
				max_results: z.number().int().min(1).max(5000).default(500),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			try {
				const version = args.version ?? env.YEARLY_VERSION;
				const filters: Filters = {
					Year: args.years,
					Conflict: args.conflict_ids,
					Dyad: args.dyad_ids,
					Org: args.org,
					ConflictIncompatibility: args.incompatibility,
					ConflictType: args.conflict_type,
					Region: args.region,
				};
				if (args.dataset === "organizedviolencecy") filters.Country_Id = args.country_ids;
				else filters.Country = args.country_ids;
				const r = await fetchAll(env, ctx, args.dataset, version, filters, args.max_results);
				return json({
					dataset: args.dataset,
					version,
					total_matching: r.totalCount,
					returned: r.records.length,
					truncated: r.truncated,
					rows: r.records,
					citation: CITATION,
				});
			} catch (e) {
				return errorResult(e);
			}
		},
	);

	server.registerTool(
		"ucdp_find_country",
		{
			description:
				"Look up the Gleditsch & Ward country code(s) UCDP uses, by (partial) country name in English. Use before filtering on country_ids.",
			inputSchema: z.object({ name: z.string().min(2) }),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ name }) => {
			try {
				// One cached page of the country-year dataset contains every country for that year.
				const latestYear = Number(env.YEARLY_VERSION.split(".")[0]) + 2000 - 1;
				const r = await fetchAll(env, ctx, "organizedviolencecy", env.YEARLY_VERSION, { Year: [latestYear] }, 1000);
				const needle = name.toLowerCase();
				const seen = new Map<string, unknown>();
				// Detect field names instead of hard-coding them (e.g. country_cy / country_id_cy).
				const sample = r.records[0] ?? {};
				const keys = Object.keys(sample);
				const nameKey = keys.find((k) => /^country(_cy)?$/i.test(k)) ?? keys.find((k) => /country/i.test(k) && !/id/i.test(k));
				const idKey = keys.find((k) => /^country_id(_cy)?$/i.test(k)) ?? keys.find((k) => /country.*id|gwno/i.test(k));
				if (!nameKey || !idKey) throw new UcdpError(`Unexpected organizedviolencecy fields: ${keys.join(", ")}`);
				for (const row of r.records) {
					const country = String(row[nameKey] ?? "");
					if (country.toLowerCase().includes(needle)) seen.set(country, row[idKey]);
				}
				return json({
					query: name,
					matches: [...seen.entries()].map(([country, gw_code]) => ({ country, gw_code })),
					note: seen.size === 0 ? "No match. Try the English name or a shorter fragment." : undefined,
				});
			} catch (e) {
				return errorResult(e);
			}
		},
	);

	server.registerTool(
		"ucdp_status",
		{
			description: "Show which UCDP dataset versions this server uses by default and today's approximate API usage.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async () => {
			try {
				return json({
					default_versions: {
						ged: env.GED_VERSION,
						ged_candidate: env.GED_CANDIDATE_VERSION,
						yearly: env.YEARLY_VERSION,
					},
					quota_today: await getQuotaUsage(env),
					docs: "https://ucdp.uu.se/apidocs/ , codebooks: https://ucdp.uu.se/downloads/",
				});
			} catch (e) {
				return errorResult(e);
			}
		},
	);

	return server;
}

const mcpHandler = createMcpHandler(createServer);

export default new OAuthProvider<Env>({
	apiHandler: {
		fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
			return mcpHandler(request, bindings, ctx);
		},
	} satisfies ExportedHandler<Env>,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: { fetch: handleAccessRequest as any },
	tokenEndpoint: "/token",
	resourceMetadata: { resource: env.MCP_RESOURCE },
});
