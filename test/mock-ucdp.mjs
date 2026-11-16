// Mock of the UCDP API for local tests. Logs each request and checks the token header.
import http from "node:http";
const ged = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1, year: 2025, type_of_violence: (i % 3) + 1, conflict_name: "Test conflict", dyad_name: "A - B",
  side_a: "Gov", side_b: "Rebels", country: i < 3 ? "Sudan" : "Chad", country_id: i < 3 ? 625 : 483,
  date_start: `2025-0${i + 1}-01`, date_end: `2025-0${i + 1}-02`, best: 10 * (i + 1), low: 5, high: 20,
  deaths_civilians: 1, source_article: "long text",
}));
const cy = [{ country_cy: "Sudan", country_id_cy: 625, year_cy: 2025 }, { country_cy: "South Sudan", country_id_cy: 626, year_cy: 2025 }, { country_cy: "Chad", country_id_cy: 483, year_cy: 2025 }];
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  console.log("REQ", u.pathname + u.search, "token=" + req.headers["x-ucdp-access-token"]);
  // Candidate versions that "exist" in the mock. 26.0.10 simulates a newly released month.
  const ver = u.pathname.split("/").pop();
  const known = ["26.1", "26.0.9", "26.0.10", "26.01.26.09"];
  if (u.pathname.includes("gedevents") && !known.includes(ver)) {
    res.statusCode = 400; return res.end(JSON.stringify({ Message: `Invalid object name 'GEDEvent_v${ver}'` }));
  }
  let rows = u.pathname.includes("organizedviolencecy") ? cy
    : ver === "26.0.10" ? [{ ...ged[0], id: 99, date_end: "2026-10-05", best: 7 }]
    : ver.startsWith("26.0") || ver.startsWith("26.01") ? ged.map(e => ({ ...e, date_end: e.date_end.replace("2025", "2026") }))
    : ged;
  const c = u.searchParams.get("Country"); if (c) rows = rows.filter(r => c.split(",").includes(String(r.country_id)));
  const ps = +u.searchParams.get("pagesize"), p = +u.searchParams.get("page");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ TotalCount: rows.length, TotalPages: Math.ceil(rows.length / ps), PreviousPageUrl: null, NextPageUrl: null, Result: rows.slice(p * ps, p * ps + ps) }));
}).listen(8798, "127.0.0.1");
