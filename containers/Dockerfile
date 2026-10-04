# Build context: containers/. No package downloads or target-controlled build hooks.
# The caller MUST provide a digest-pinned Node 22.14.0 base; no mutable default.
# containers/prepare.mjs compiles the owned TypeScript, hashes the exact bytes that
# this file copies, and passes them as WORKER_SHA256/SOURCE_SHA256. The build refuses
# mismatched bytes and records the verified identities as image labels, so the local
# image ID is the config digest of the verified pack inputs, but neither a tag nor an image ID proves
# the layer bytes: containers/prepare.mjs records the built RootFS.Layers in pack.lock.json and the
# adapter refuses to start a container unless the pinned image's layer content addresses, base descent
# and in-image worker/source/node hashes all match (see containers/QUALIFICATION.md and
# docs/architecture/worklog/T5-sandbox.md; registry RepoDigests are unavailable for unpushed builds).
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG NODE_IMAGE
ARG WORKER_SHA256
ARG SOURCE_SHA256
ARG PACK_VERSION=1.0.0
RUN case "$NODE_IMAGE" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "NODE_IMAGE must be a @sha256-digest-pinned base" >&2; exit 1 ;; esac \
 && test "$(node --version)" = "v22.14.0"
LABEL org.pi-p2o.pack.version="$PACK_VERSION" \
      org.pi-p2o.node.version="22.14.0" \
      org.pi-p2o.base.image="$NODE_IMAGE" \
      org.pi-p2o.worker.sha256="$WORKER_SHA256" \
      org.pi-p2o.source.sha256="$SOURCE_SHA256"
COPY --chown=0:0 offline-worker.mjs /opt/p2o/offline-worker.mjs
COPY --chown=0:0 build/policy/ /opt/p2o/policy/
COPY --chown=0:0 build/tools/source.js /opt/p2o/tools/source.js
COPY --chown=0:0 build/package.json /opt/p2o/package.json
RUN test -n "$WORKER_SHA256" && test -n "$SOURCE_SHA256" \
 && test "$(sha256sum /opt/p2o/offline-worker.mjs | cut -d' ' -f1)" = "$WORKER_SHA256" \
 && test "$(sha256sum /opt/p2o/tools/source.js | cut -d' ' -f1)" = "$SOURCE_SHA256"
WORKDIR /outputs
USER 65532:65532
ENV HOME=/tmp P2O_OFFLINE_PACK=1 NODE_OPTIONS=""
ENTRYPOINT ["/usr/local/bin/node", "/opt/p2o/offline-worker.mjs"]
