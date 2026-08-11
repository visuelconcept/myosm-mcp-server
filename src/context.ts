import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Small helper mirroring the FastMCP `Context` object from the original
 * Python implementation: `info`/`warning` log messages and progress
 * notifications, all sent on a best-effort basis (a failed notification
 * must never fail the tool call itself).
 */
export class ToolContext {
  constructor(
    private readonly server: McpServer,
    private readonly extra: ToolExtra,
  ) {}

  async info(message: string): Promise<void> {
    await this.log("info", message);
  }

  async warning(message: string): Promise<void> {
    await this.log("warning", message);
  }

  private async log(level: "info" | "warning", message: string): Promise<void> {
    try {
      await this.server.server.sendLoggingMessage(
        { level, data: message },
        this.extra.sessionId,
      );
    } catch {
      // Logging is best-effort; ignore clients that reject notifications.
    }
  }

  async reportProgress(progress: number, total?: number): Promise<void> {
    const progressToken = this.extra._meta?.progressToken;
    if (progressToken === undefined) {
      return;
    }
    try {
      await this.extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total },
      });
    } catch {
      // Progress is best-effort as well.
    }
  }
}
