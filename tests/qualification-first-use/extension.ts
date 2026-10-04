// Qualification fixture ONLY: an inert provider registration, plus the UNMODIFIED real p2o registration.
// No backendFactory, onboardingFor, planAuthorFor, entry-port or runtime override is permitted here.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerP2O } from '../../extensions/p2o/index.js';

export default function qualificationExtension(pi: ExtensionAPI): void {
  const endpoint = new URL(process.env.P2O_QUALIFICATION_INERT_ENDPOINT ?? '');
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('QUALIFICATION_ENDPOINT_DENIED: only the explicit inert loopback provider is allowed');
  }
  pi.registerProvider('inert-fixture', {
    baseUrl: endpoint.href.replace(/\/$/, ''), api: 'openai-completions',
    apiKey: 'qualification-inert-not-a-live-credential',
    models: [{ id: 'inert-worker', name: 'DETERMINISTIC INERT PROVIDER — NOT LIVE AI',
      api: 'openai-completions', reasoning: false, input: ['text'],
      // Match the EXISTING pinned synthetic fixture quote. Not invented live/zero-cost pricing.
      cost: { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 },
      contextWindow: 128000, maxTokens: 4096 }],
  });
  registerP2O(pi);
  pi.on('session_start', (_event, ctx) => {
    const registry = ctx.modelRegistry as unknown as Record<string, unknown>;
    ctx.ui.notify(JSON.stringify({ qualification: 'installed-host-observation', controllerPid: process.pid,
      mode: ctx.mode, hasUI: ctx.hasUI,
      selection: { provider: ctx.model?.provider, model: ctx.model?.id, thinking: ctx.thinkingLevel },
      registryMethods: Object.fromEntries(['complete', 'streamSimple', 'getAvailable', 'getApiKeyAndHeaders']
        .map(name => [name, typeof registry?.[name]])),
      evidenceClass: 'inert-provider-mechanical-chain-not-live-ai',
      consent: 'automated-human-consent-simulation',
    }), 'info');
  });
}
