import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const quitCleanly = async (_args: string, ctx: { isIdle: () => boolean; abort: () => void; shutdown: () => void }) => {
    if (!ctx.isIdle()) {
      ctx.abort();
    }
    ctx.shutdown();
  };

  pi.registerCommand("exit", {
    description: "Exit Pi cleanly (alias for /quit)",
    handler: quitCleanly,
  });

  pi.registerCommand("q", {
    description: "Exit Pi cleanly (short alias for /quit)",
    handler: quitCleanly,
  });
}
