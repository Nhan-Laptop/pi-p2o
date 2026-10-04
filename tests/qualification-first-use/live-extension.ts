// LIVE qualification fixture ONLY. Registers the UNMODIFIED real p2o command surface and nothing else:
// no provider registration, no backendFactory, no onboardingFor, no planAuthorFor, no entry/runtime override.
// Fails closed when an inert endpoint is present so a live run can never silently use the deterministic fixture.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerP2O } from '../../extensions/p2o/index.js';

export default function liveQualificationExtension(pi: ExtensionAPI): void {
  if (process.env.P2O_QUALIFICATION_INERT_ENDPOINT) {
    throw new Error('LIVE_QUALIFICATION_DENIED: an inert provider endpoint is present; live runs never use the fixture transport');
  }
  registerP2O(pi);
  pi.on('session_start', (_event, ctx) => {
    const registry = ctx.modelRegistry as unknown as Record<string, unknown>;
    ctx.ui.notify(JSON.stringify({ qualification: 'live-host-observation', controllerPid: process.pid,
      mode: ctx.mode, hasUI: ctx.hasUI,
      selection: { provider: ctx.model?.provider, model: ctx.model?.id, thinking: ctx.thinkingLevel },
      registryMethods: Object.fromEntries(['complete', 'streamSimple', 'getAvailable', 'getApiKeyAndHeaders']
        .map(name => [name, typeof registry?.[name]])),
      inertProviderRegistered: false,
      evidenceClass: 'live-real-provider-model-calls-not-independent-verification',
      consent: 'automated-consent-simulation-live-provider-parent-authorized',
    }), 'info');
  });
}
