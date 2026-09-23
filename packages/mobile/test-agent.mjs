/**
 * 通过 WebSocket 连接到本地服务器，触发 agent，捕获错误。
 */
import { connectViaWebSocket } from "@zcode/client";

const port = process.argv[2] || "14000";
const wsUrl = `ws://127.0.0.1:${port}/ws`;

console.log(`Connecting to ${wsUrl}...`);

try {
  const access = await connectViaWebSocket(wsUrl);
  console.log("Connected.");

  const agent = access.zcodeAgentService;

  console.log("Creating session...");
  const sessionResult = await agent.createSession({
    workspacePath: "/",
    mode: "auto",
  });
  const sessionId = sessionResult.session?.sessionId ?? sessionResult.sessionId;
  console.log("Session:", sessionId);

  console.log("Sending prompt...");
  const result = await agent.sendPrompt({
    sessionId,
    workspacePath: "/",
    content: "Say hello in one word",
    attachments: [],
  });
  console.log("Result:", JSON.stringify(result).slice(0, 800));

} catch (error) {
  console.error("ERROR:", error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
process.exit(0);
