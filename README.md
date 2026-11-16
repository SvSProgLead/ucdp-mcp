# UCDP MCP-server (FOI)

En fjärr-MCP-server på Cloudflare Workers som ger Claude läsåtkomst till
[UCDP:s API](https://ucdp.uu.se/apidocs/) med FOI:s gemensamma API-token.

- **Token stannar på servern.** Den ligger som Worker-hemlighet (`UCDP_ACCESS_TOKEN`) och visas aldrig för användare eller i prompter.
- **Hemlig adress.** Servern svarar bara på `/mcp/<MCP_PATH_SECRET>`. Alla andra adresser ger 404, så den som inte har adressen kan inte hitta eller använda servern.
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

Deploy sker via Cloudflare Workers Builds (Git-kopplingen), som för övriga FOI-MCP:er. Varje push till `main` deployas, och KV-namespacet `UCDP_KV` skapas automatiskt.

1. **Koppla repot.** Gå till Cloudflare → Workers & Pages → Create → Import a repository → `SvSProgLead/ucdp-mcp`.

2. **Lägg in två hemligheter.** Det görs under Worker → Settings → Variables and Secrets, typ *Secret*:
   - `UCDP_ACCESS_TOKEN`: token från UCDP.
   - `MCP_PATH_SECRET`: en lång slumpsträng med minst 32 tecken, bara bokstäver och siffror. Den kan tas fram med
     ```bash
     openssl rand -hex 32
     ```
     Utan en giltig `MCP_PATH_SECRET` svarar servern 404 på allt.

3. **Lägg till i Claude för hela organisationen.**
   claude.ai → Admin settings → Connectors → Add custom connector. Ange URL:en
   `https://ucdp-mcp.<subdomän>.workers.dev/mcp/<MCP_PATH_SECRET>`.

**Byta ut adressen**, t.ex. om den spridits utanför FOI: ändra `MCP_PATH_SECRET` i Cloudflare och uppdatera connectorns URL i claude.ai.

## Datasetversioner

**Årsversioner** (t.ex. `26.1`) släpps en gång per år. Ändra då `GED_VERSION` och `YEARLY_VERSION` i `wrangler.jsonc` och pusha.

**GED Candidate** (preliminär data för innevarande år) sköts automatiskt:
- UCDP släpper en *månadsfil* varje månad (`26.0.9` = bara september) och en *kumulativ fil* varje kvartal (`26.01.26.09` = januari–september).
- När någon frågar med `candidate: true` kombinerar servern den senaste kumulativa filen med de månadsfiler som kommit efter den.
- Nya versioner hittas automatiskt. Servern provar nästa versionsnummer högst en gång per dygn.
- `GED_CANDIDATE_VERSION` och `GED_CANDIDATE_CUMULATIVE_VERSION` i `wrangler.jsonc` är bara startpunkter och behöver inte uppdateras.

`ucdp_status` visar vilka versioner som används just nu. Användare kan också ange `version` för att fråga exakt en version.

## Lokal test utan inloggning

`test/` innehåller en mock av UCDP-API:t och en testkonfiguration med en känd testhemlighet.
Servern nås då på `http://localhost:8799/mcp/0123456789abcdef0123456789abcdef`.

```bash
node test/mock-ucdp.mjs &
cd test && npx wrangler dev -c wrangler.test.jsonc
```

## Källhänvisning

Data från Uppsala Conflict Data Program (UCDP), CC BY 4.0. Ange alltid datasetversion.
Verktygen skickar med en citeringsrad i varje svar.
