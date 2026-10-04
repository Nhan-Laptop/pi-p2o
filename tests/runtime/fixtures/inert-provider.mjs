// Loaded by REAL Pi only in the opt-in inert public-API compatibility test.
import guard from "../../../src/runtime/pi-receipts.js";
import fs from "node:fs";
export default function (pi) {
  const config = JSON.parse(fs.readFileSync(process.env.P2O_CONFIG, "utf8"));
  pi.registerProvider(config.requested.provider, {
    baseUrl: "http://127.0.0.1:1/inert-never-contacted", apiKey: "inert-placeholder", api: "openai-completions",
    models: [{ id: config.requested.model, name: "Inert fixture", reasoning: true,
      thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple: (model) => {
      const message = { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id,
        content: [{ type: "text", text: "Inert public Pi integration result" }], timestamp: Date.now(), stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return {
        result: async () => message,
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: { ...message, content: [] } };
          yield { type: "text_start", contentIndex: 0, partial: message };
          yield { type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message };
          yield { type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message };
          yield { type: "done", reason: "stop", message };
        },
      };
    },
  });
  guard(pi);
}
