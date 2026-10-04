import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { checkCancelled, invariant, PolicyError } from '../policy/errors.js';
import { digest, deepFreeze, text, timestamp } from '../policy/validation.js';
import { isForbiddenAddress, isLoopback } from '../policy/network.js';
import { SandboxFilesystem, validateRelativePath } from './filesystem.js';
import { runFixedProcess } from './process.js';
import { sha256 } from './redaction.js';
const PACK_VERSION = '1.0.0';
const NODE_VERSION = 'v22.14.0';
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPO_DIGEST_PATTERN = /^[\w./:-]+@sha256:[a-f0-9]{64}$/;
/** Limits declared in runArgs and re-verified from the kernel inside the container. */
const REQUIRED_LIMITS = Object.freeze({ memoryMax: '268435456', pidsMax: '32', cpuQuota: '50000', cpuPeriod: '100000', nofile: '64', core: '0' });
const hash = (v) => invariant(/^[a-f0-9]{64}$/.test(v), 'INVALID_INPUT', 'Expected SHA-256 digest');
const escapeRegExp = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Docker 28 CLI/daemon wording for an absent container; anything else is NOT absence. */
const containerAbsent = (result, name) => result.code === 1 && new RegExp(`^(?:Error: No such object: |Error response from daemon: No such (?:container|object): )${escapeRegExp(name)}$`).test(result.stderr.trim());
const record = (v) => {
    invariant(v !== null && typeof v === 'object' && !Array.isArray(v), 'UNAVAILABLE', 'Pack evidence was not a JSON object');
    return v;
};
const flag = (evidence, key) => invariant(evidence[key] === true, 'UNAVAILABLE', `Pack constraint not satisfied: ${key}`);
export function createContainerSandbox(settings) {
    const options = deepFreeze({ ...structuredClone({ ...settings, runner: undefined }), runner: settings.runner });
    invariant(['/usr/bin/docker', '/usr/local/bin/docker'].includes(options.enginePath), 'INVALID_INPUT', 'Unapproved engine path');
    text(options.engineVersion, 'engineVersion', 64);
    const imagePin = IMAGE_ID_PATTERN.test(options.image) ? 'local-image-id' : REPO_DIGEST_PATTERN.test(options.image) ? 'repo-digest' : undefined;
    invariant(imagePin, 'INVALID_INPUT', 'A digest-pinned image (name@sha256:<64 hex> or local sha256:<64 hex> image ID) is required');
    hash(options.workerSha256);
    hash(options.sourceSha256);
    hash(options.seccompSha256);
    invariant(isAbsolute(options.seccompPath) && !/[,:\n]/.test(options.seccompPath), 'INVALID_INPUT', 'Absolute pinned seccomp profile required');
    invariant(options.qualification?.acknowledgement === 'containers-share-host-kernel-not-hostile-code-isolation' && options.qualification.dedicatedLab === true && typeof options.qualification.nativeEnabled === 'boolean', 'UNAVAILABLE', 'Explicit dedicated-lab qualification required');
    text(options.qualification.approvedBy, 'qualification.approvedBy');
    timestamp(options.qualification.expiresAt, 'qualification.expiresAt');
    const filesystem = new SandboxFilesystem(options);
    invariant(!/[,:\n]/.test(filesystem.inputRoot), 'FILESYSTEM_DENIED', 'Input mount path contains engine separators');
    const runner = options.runner ?? runFixedProcess;
    invariant(!options.runner || options.fixtureAcknowledgement === 'inert-engine-fixture-not-container-isolation', 'UNAVAILABLE', 'Injected engine runner requires explicit inert-fixture acknowledgement');
    const boundary = options.runner ? 'inert-engine-fixture:no-container-isolation-attestation:loopback-only' : 'dedicated-offline-container:shared-kernel:broker-only-target-egress';
    const configurationDigest = digest({ ...options, runner: undefined, mode: 'container', nodeVersion: NODE_VERSION, packVersion: PACK_VERSION, imagePin });
    let ready = false;
    const assertQualified = () => invariant(Date.now() < Date.parse(options.qualification.expiresAt), 'EXPIRED', 'Lab qualification expired');
    const engine = (args, input, signal) => runner(options.enginePath, args, { input, timeoutMs: 15000, maxOutputBytes: 4194304, signal });
    function runArgs(name) {
        return ['run', '--name', name, '--rm', '--pull=never', '--network=none', '--read-only', '--user=65532:65532', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', `--security-opt=seccomp=${options.seccompPath}`, '--pids-limit=32', '--memory=256m', '--memory-swap=256m', '--cpus=0.5', '--ulimit=nofile=64:64', '--ulimit=core=0:0', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=8388608,mode=1777', '--tmpfs=/outputs:rw,noexec,nosuid,nodev,size=8388608,mode=1777', '--mount', `type=bind,src=${filesystem.inputRoot},dst=/inputs,readonly,bind-propagation=rprivate`, '--env=HOME=/tmp', '--env=NODE_OPTIONS=', '--log-driver=none', '--entrypoint=/usr/local/bin/node', '-i', options.image, '/opt/p2o/offline-worker.mjs'];
    }
    /**
     * Termination proof. Killing the engine CLI does not prove container termination, and a
     * container can still be created by the daemon just after an aborted CLI exits, so removal
     * plus absence must be observed repeatedly, not once.
     */
    async function verifyTerminated(name, rounds = 4) {
        let absentStreak = 0;
        for (let round = 0; round < rounds; round++) {
            let absent = false;
            try {
                const removal = await engine(['rm', '--force', name]);
                const inspection = await engine(['inspect', name]);
                absent = (removal.code === 0 || containerAbsent(removal, name)) && containerAbsent(inspection, name);
            }
            catch {
                absent = false;
            }
            absentStreak = absent ? absentStreak + 1 : 0;
            if (absentStreak >= 2)
                return true;
            if (round < rounds - 1)
                await new Promise(resolve => setTimeout(resolve, 250));
        }
        return false;
    }
    async function invoke(input, signal) {
        checkCancelled(signal);
        assertQualified();
        const stat = await lstat(options.seccompPath);
        invariant(stat.isFile() && !stat.isSymbolicLink() && sha256(await readFile(options.seccompPath)) === options.seccompSha256, 'UNAVAILABLE', 'Pinned seccomp profile changed');
        const name = `p2o-${randomUUID()}`;
        let result, failure;
        try {
            result = await engine(runArgs(name), JSON.stringify(input), signal);
        }
        catch (e) {
            failure = e;
        }
        if (!await verifyTerminated(name)) {
            ready = false;
            throw new PolicyError('UNAVAILABLE', 'Container termination could not be verified');
        }
        if (failure)
            throw failure;
        checkCancelled(signal);
        invariant(result?.code === 0, 'UNAVAILABLE', 'Qualified offline pack failed; no local fallback');
        try {
            return JSON.parse(result.stdout);
        }
        catch {
            throw new PolicyError('UNAVAILABLE', 'Pack did not return valid evidence JSON');
        }
    }
    /** Local image identity and pack labels; never triggers a pull or a build. */
    async function inspectImage(signal) {
        const result = await engine(['image', 'inspect', '--format', '{{json .}}', options.image], undefined, signal);
        invariant(result.code === 0, 'UNAVAILABLE', 'Pinned local image unavailable; implicit pull disabled');
        let image;
        try {
            image = record(JSON.parse(result.stdout));
        }
        catch {
            throw new PolicyError('UNAVAILABLE', 'Image inspection did not return local image metadata');
        }
        const id = typeof image.Id === 'string' ? image.Id : '';
        const digests = Array.isArray(image.RepoDigests) ? image.RepoDigests.filter((d) => typeof d === 'string') : [];
        invariant(imagePin === 'local-image-id' ? id === options.image : digests.includes(options.image), 'UNAVAILABLE', 'Pinned image identity does not match the local image; implicit pull disabled');
        invariant(image.Os === 'linux', 'UNAVAILABLE', 'Pinned image is not a Linux image');
        const config = record(image.Config);
        invariant(config.User === '65532:65532', 'UNAVAILABLE', 'Pinned image does not declare the non-root pack user');
        const labels = record(config.Labels);
        invariant(labels['org.pi-p2o.pack.version'] === PACK_VERSION && labels['org.pi-p2o.node.version'] === '22.14.0', 'UNAVAILABLE', 'Pinned image is not the qualified pack release');
        invariant(labels['org.pi-p2o.worker.sha256'] === options.workerSha256 && labels['org.pi-p2o.source.sha256'] === options.sourceSha256, 'UNAVAILABLE', 'Pinned image bytes do not match the pinned worker/source identities');
        const baseImage = typeof labels['org.pi-p2o.base.image'] === 'string' ? labels['org.pi-p2o.base.image'] : '';
        invariant(REPO_DIGEST_PATTERN.test(baseImage), 'UNAVAILABLE', 'Pinned image does not record a digest-pinned base image');
        return { id, baseImage, platform: `${String(image.Os)}/${String(image.Architecture)}` };
    }
    /** Re-verifies everything the pack reports about the kernel-enforced confinement. */
    function verifyPackEvidence(hello) {
        const evidence = record(hello);
        invariant(evidence.protocol === 1, 'UNAVAILABLE', 'Pack protocol mismatch');
        invariant(evidence.nodeVersion === NODE_VERSION && evidence.packVersion === PACK_VERSION, 'UNAVAILABLE', 'Pack Node/pack release mismatch');
        invariant(evidence.workerSha256 === options.workerSha256 && evidence.sourceSha256 === options.sourceSha256, 'UNAVAILABLE', 'Pack byte identity mismatch');
        invariant(typeof evidence.nodeSha256 === 'string' && /^[a-f0-9]{64}$/.test(evidence.nodeSha256), 'UNAVAILABLE', 'Pack did not report a pinned Node runtime identity');
        invariant(evidence.uid === 65532 && evidence.gid === 65532, 'UNAVAILABLE', 'Pack is not running as the pinned non-root identity');
        flag(evidence, 'nonRoot');
        flag(evidence, 'pid1');
        flag(evidence, 'rootReadOnly');
        flag(evidence, 'rootWriteDenied');
        flag(evidence, 'inputReadOnly');
        flag(evidence, 'inputWriteDenied');
        flag(evidence, 'scratchWritable');
        flag(evidence, 'noNetwork');
        invariant(evidence.seccompMode === 2 && typeof evidence.seccompFilters === 'number' && evidence.seccompFilters >= 1, 'UNAVAILABLE', 'Seccomp filtering is not active in the pack');
        invariant(evidence.noNewPrivileges === 1, 'UNAVAILABLE', 'no_new_privs is not set in the pack');
        invariant(evidence.capabilities === '0'.repeat(16), 'UNAVAILABLE', 'Pack retains capabilities');
        const ulimits = record(evidence.ulimits);
        invariant(ulimits.nofile === REQUIRED_LIMITS.nofile && ulimits.core === REQUIRED_LIMITS.core, 'UNAVAILABLE', 'Pack ulimits do not match the qualified runtime');
        const cgroup = record(evidence.cgroup);
        invariant(cgroup.memoryMax === REQUIRED_LIMITS.memoryMax && cgroup.pidsMax === REQUIRED_LIMITS.pidsMax && cgroup.cpuQuota === REQUIRED_LIMITS.cpuQuota && cgroup.cpuPeriod === REQUIRED_LIMITS.cpuPeriod, 'UNAVAILABLE', 'Pack resource limits do not match the qualified runtime');
        return {
            identity: `node=${String(evidence.nodeVersion)} pack=${String(evidence.packVersion)} nodeSha256=${String(evidence.nodeSha256)} workerSha256=${String(evidence.workerSha256)} sourceSha256=${String(evidence.sourceSha256)} platform=${String(evidence.platform)}/${String(evidence.arch)}`,
            constraints: `uid=${String(evidence.uid)} gid=${String(evidence.gid)} pid1=true root=ro inputs=ro write-denied=root,inputs scratch=rw seccomp=${String(evidence.seccompMode)} filters=${String(evidence.seccompFilters)} no-new-privs=${String(evidence.noNewPrivileges)} caps=${String(evidence.capabilities)} net-sockets=denied pids=${String(cgroup.pidsMax)} memory=${String(cgroup.memoryMax)} cpu=${String(cgroup.cpuQuota)}/${String(cgroup.cpuPeriod)} nofile=${String(ulimits.nofile)} core=${String(ulimits.core)} cgroup=v${String(cgroup.version)}`,
        };
    }
    return Object.freeze({
        mode: 'container', boundary, configurationDigest, filesystem, nativeEnabled: options.qualification.nativeEnabled,
        async preflight(signal) {
            ready = false;
            const checks = [];
            const fs = await filesystem.preflight();
            checks.push(...fs.checks);
            try {
                assertQualified();
                checkCancelled(signal);
                const version = await engine(['version', '--format', '{{.Client.Version}}/{{.Server.Version}}'], undefined, signal);
                invariant(version.code === 0 && version.stdout.trim() === `${options.engineVersion}/${options.engineVersion}`, 'UNAVAILABLE', 'Pinned engine release unavailable');
                checks.push({ name: 'engine-release', ok: true, detail: `client=server=${options.engineVersion} executable=${options.enginePath}` });
                const image = await inspectImage(signal);
                checks.push({ name: 'image-pin', ok: true, detail: `pin=${options.image} (${imagePin}) id=${image.id} platform=${image.platform} base=${image.baseImage} labels=verified` });
                invariant(fs.ok, 'UNAVAILABLE', 'Safe filesystem unavailable');
                const pack = verifyPackEvidence(await invoke({ operation: 'preflight' }, signal));
                checks.push({ name: 'pack-identity', ok: true, detail: pack.identity });
                checks.push({ name: 'execution-constraints', ok: true, detail: pack.constraints });
                checks.push({ name: 'termination-verified', ok: true, detail: 'Removal plus repeated absence verified for the probe container; killed CLI is never treated as termination' });
                checks.push({ name: 'offline-container', ok: true, detail: 'Pinned engine/image/worker/Node; non-root, offline, read-only root+inputs, enforced limits; no fallback' });
                ready = true;
            }
            catch {
                checks.push({ name: 'offline-container', ok: false, detail: 'Qualified pinned engine/image/security pack unavailable; no unsandboxed fallback' });
            }
            return deepFreeze({ ok: ready, boundary, checks });
        },
        assertEgress(address) { assertQualified(); invariant(ready && !isForbiddenAddress(address) && (!options.runner || isLoopback(address)), 'ADDRESS_DENIED', 'Target egress requires the qualified broker; injected fixtures are loopback-only'); },
        async analyzeSource(files, contains, signal) {
            invariant(ready, 'UNAVAILABLE', 'Container preflight failed or not performed');
            return await invoke({ operation: 'source', files, contains }, signal);
        },
        async inspectNative(path, signal) {
            invariant(ready && options.qualification.nativeEnabled, 'UNAVAILABLE', 'Native pack not explicitly qualified');
            validateRelativePath(path);
            const input = await filesystem.readInput(path, signal);
            return invoke({ operation: 'native', path, expectedSha256: input.sha256 }, signal);
        },
    });
}
