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

1. **KV-namespace**
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```
   Klistra in id:t i `wrangler.jsonc`.

2. **Cloudflare Access for SaaS-app** (Zero Trust → Access → Applications → Add → SaaS → OIDC)
   - Redirect URL: `https://ucdp-mcp.<subdomän>.workers.dev/callback`
   - Policy: tillåt FOI:s identitetsleverantör eller en lämplig grupp.
   - Spara Client ID, Client secret, Token-URL, Authorization-URL och JWKS-URL.

3. **`MCP_RESOURCE`** i `wrangler.jsonc` → `https://ucdp-mcp.<subdomän>.workers.dev/mcp`

4. **Hemligheter**
   ```bash
   npx wrangler secret put UCDP_ACCESS_TOKEN
   npx wrangler secret put ACCESS_CLIENT_ID
   npx wrangler secret put ACCESS_CLIENT_SECRET
   npx wrangler secret put ACCESS_TOKEN_URL
   npx wrangler secret put ACCESS_AUTHORIZATION_URL
   npx wrangler secret put ACCESS_JWKS_URL
   openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY
   ```

5. **Deploy**
   - Antingen med `npm run deploy`,
   - eller automatiskt vid push till `main` via `.github/workflows/deploy.yml`. Det kräver repo-hemligheterna `CLOUDFLARE_API_TOKEN` (behörighet *Edit Cloudflare Workers*) och `CLOUDFLARE_ACCOUNT_ID`.
   - Workers Builds (Cloudflares egen Git-koppling) går också bra. Ta då bort workflow-filen.

6. **Lägg till i Claude för hela organisationen**
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
