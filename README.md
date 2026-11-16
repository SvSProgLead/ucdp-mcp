# UCDP MCP-server (FOI)

En fjärr-MCP-server på Cloudflare Workers som ger Claude läsåtkomst till
[UCDP:s API](https://ucdp.uu.se/apidocs/) med FOI:s gemensamma API-token.

- **Token stannar på servern.** Den ligger som Worker-hemlighet (`UCDP_ACCESS_TOKEN`) och visas aldrig för användare eller i prompter.
- **Inloggning med FOI-konto** via Cloudflare Access (OIDC). Claude.ai sköter OAuth-flödet automatiskt.
- **Cache och kvotvakt.** Svar cachas i 6 timmar. Servern slutar anropa UCDP vid 4 500 anrop per UTC-dygn (UCDP:s gräns är 5 000).

## Verktyg

| Verktyg | Vad det gör |
|---|---|
| `ucdp_ged_events` | Enskilda händelser ur GED (årsversion) eller GED Candidate (preliminär månadsdata). Kan filtreras på land, datum, våldstyp, dyad, aktör och geografisk ruta. |
| `ucdp_ged_summary` | Summerar händelser på servern (antal, best, low, high, civila) per land, år, månad, våldstyp, konflikt, aktör eller region. Håller svaren små. |
| `ucdp_yearly` | Årsdataset: `ucdpprioconflict`, `dyadic`, `nonstate`, `onesided`, `battledeaths`, `organizedviolencecy`. |
| `ucdp_find_country` | Slår upp Gleditsch & Ward-landkoder från landnamn. |
| `ucdp_status` | Visar vilka datasetversioner som används och ungefär hur många anrop som gjorts i dag. |

## Driftsättning (första gången)

Deploy sker via Cloudflare Workers Builds (Git-kopplingen), som för övriga FOI-MCP:er. Varje push till `main` deployas.

1. **Koppla repot.** Gå till Cloudflare → Workers & Pages → Create → Import a repository → `SvSProgLead/ucdp-mcp`.
   Om repot inte syns, ge Cloudflares GitHub-app åtkomst till det (GitHub → Settings → Applications → Cloudflare Workers and Pages).
   KV-namespacet `OAUTH_KV` skapas automatiskt vid första deployen.

2. **Skapa en Cloudflare Access for SaaS-app** (Zero Trust → Access → Applications → Add → SaaS → OIDC).
   - Redirect URL: `https://ucdp-mcp.<subdomän>.workers.dev/callback`
   - Policy: tillåt FOI:s identitetsleverantör eller en lämplig grupp.
   - Spara Client ID, Client secret, Token-URL, Authorization-URL och JWKS-URL.

3. **Sätt `MCP_RESOURCE`** i `wrangler.jsonc` till `https://ucdp-mcp.<subdomän>.workers.dev/mcp` och pusha.

4. **Lägg in hemligheter.** Det görs under Worker → Settings → Variables and Secrets, typ *Secret*:
   `UCDP_ACCESS_TOKEN`, `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`,
   `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL` och `COOKIE_ENCRYPTION_KEY` (en slumpsträng, t.ex. `openssl rand -hex 32`).

5. **Lägg till i Claude för hela organisationen.**
   claude.ai → Admin settings → Connectors → Add custom connector. Ange URL:en
   `https://ucdp-mcp.<subdomän>.workers.dev/mcp`. Varje användare loggar sedan in en gång med sitt FOI-konto.

## Uppdatera datasetversioner

UCDP släpper årsversioner (t.ex. `26.1`) en gång per år och GED Candidate varje månad (t.ex. `26.0.9` → `26.0.10`).
Ändra `GED_VERSION`, `GED_CANDIDATE_VERSION` och `YEARLY_VERSION` i `wrangler.jsonc` och pusha.
Användare kan också ange `version` direkt i ett verktygsanrop.

## Lokal test utan inloggning

`test/` innehåller en mock av UCDP-API:t och en ingång utan autentisering. Den får **aldrig** driftsättas.

```bash
node test/mock-ucdp.mjs &
cd test && npx wrangler dev -c wrangler.test.jsonc
```

## Källhänvisning

Data från Uppsala Conflict Data Program (UCDP), CC BY 4.0. Ange alltid datasetversion.
Verktygen skickar med en citeringsrad i varje svar.
