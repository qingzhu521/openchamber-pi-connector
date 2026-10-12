import { homedir } from "node:os";
import { join } from "node:path";

function expandLeadingTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** Root directory used by the pi-compatible coding agent. */
export function piAgentDir(): string {
  const configured = [process.env.PI_CODING_AGENT_DIR, process.env.OMO_CODING_AGENT_DIR].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return expandLeadingTilde(configured?.trim() ?? join(homedir(), ".pi", "agent"));
}
