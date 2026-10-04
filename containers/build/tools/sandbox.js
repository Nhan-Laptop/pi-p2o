import { checkCancelled, invariant, PolicyError } from '../policy/errors.js';
import { digest, deepFreeze } from '../policy/validation.js';
import { isLoopback } from '../policy/network.js';
import { SandboxFilesystem } from './filesystem.js';
import { analyzeSourceFiles } from './source.js';
/** Safe only for inert local fixtures and trusted broker code. Never executes target code. */
export function createLocalFixtureSandbox(options) {
    invariant(options.acknowledgement === 'local-fixtures-only-not-hostile-code-isolation', 'UNAVAILABLE', 'Local fixture mode requires explicit limited-isolation acknowledgement');
    const filesystem = new SandboxFilesystem(options);
    let ready = false;
    const boundary = 'local-fixture:trusted-broker-only:no-hostile-code-isolation';
    return Object.freeze({
        mode: 'local-fixture', boundary, configurationDigest: digest({ mode: 'local-fixture', ...options }), filesystem, nativeEnabled: false,
        async preflight(signal) {
            checkCancelled(signal);
            const report = await filesystem.preflight();
            checkCancelled(signal);
            ready = report.ok;
            return deepFreeze({ ...report, boundary, checks: [...report.checks, { name: 'fixture-limits', ok: true, detail: 'Loopback HTTP only; no process execution, JS browser or hostile workers' }] });
        },
        assertEgress(address) { invariant(ready && isLoopback(address), 'ADDRESS_DENIED', 'Local fixture egress is loopback-only'); },
        async analyzeSource(files, contains, signal) {
            invariant(ready, 'UNAVAILABLE', 'Sandbox has not passed preflight');
            checkCancelled(signal);
            return analyzeSourceFiles(files, contains, signal);
        },
        async inspectNative() { throw new PolicyError('UNAVAILABLE', 'Native tools require an explicitly qualified dedicated container/VM lab'); },
    });
}
