// Local test entry WITHOUT authentication. Never deploy this.
import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "../src/index";
const handler = createMcpHandler(createServer);
export default { fetch: (req: Request, env: Env, ctx: ExecutionContext) => handler(req, env, ctx) };
