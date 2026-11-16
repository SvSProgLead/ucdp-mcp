// Secrets are set in the Cloudflare dashboard, not in wrangler.jsonc, so
// `wrangler types` does not know about them. Declare them here.
interface __BaseEnv_Env {
	UCDP_ACCESS_TOKEN: string;
	MCP_PATH_SECRET: string;
}
