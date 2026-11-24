import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Typed exit words that should quit instead of reaching the model, e.g. `.exit` typed for `/exit`. */
export const EXIT_TYPO = /^(?:[.\\]?(?:exit|quit)|[.\\]q)$/i;

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

  // A lone `.exit`, `exit` or `quit` was sent to the model as a prompt and started a turn.
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || event.images?.length || !EXIT_TYPO.test(event.text.trim())) {
      return { action: "continue" };
    }
    await quitCleanly("", ctx);
    return { action: "handled" };
  });
}
