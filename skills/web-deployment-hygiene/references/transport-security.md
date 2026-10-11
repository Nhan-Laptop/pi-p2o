Tests: wstg-cryp-01, wstg-cryp-03

# Transport security

Cards for [web deployment hygiene](../SKILL.md). Handshake checks use the sandbox network tool and are not origin-filtered, so address only the confirmed host and port. Most TLS weaknesses need an active network position; say so when recording one.

### wstg-cryp-01 TLS configuration
- Trigger: https origin.
- Inputs: host and port of the confirmed origin (N); certificate material in a supplied tree (S).
- Steps: open one handshake per protocol version and note which versions the server accepts; read the negotiated cipher suite, the certificate chain, subject names, validity window, key size and signature algorithm; check that the chain validates against the system trust store; see whether plain HTTP is also served; look for active content loaded over plain HTTP on HTTPS pages. Use the cipher-enumeration script of the network scanner only if it runs in the sandbox; otherwise use the handshake tool.
- Conclude: accepted legacy protocol versions, expired or mismatched certificates, short keys, weak signature algorithms and a chain that fails validation are findings. Weigh them honestly, since most need an active attacker.
- Evidence: handshake output, certificate fields and the plain-HTTP answer.
- Record: cell for wstg-cryp-01 on the host and port service asset, with method family sandbox-network-review.
- Stop: one handshake per version; no renegotiation floods and no heavy enumeration against production.
- Not a finding when: the endpoint is terminated by a CDN you do not control, or is an internal port outside scope.

### wstg-cryp-03 Sensitive data over clear channels
- Trigger: any confirmed origin with login, forms or tokens.
- Inputs: baseline responses, forms and cookies from the entry pages (H); source (S).
- Steps: check that the login form, password change and reset forms, API credentials and token-bearing requests are offered over HTTPS only; read form actions and script URLs for plain-HTTP links; confirm the session cookie carries the Secure attribute; look for basic authentication on a plain-HTTP port; in source search for hard-coded credentials, keys and plain-HTTP URLs.
- Conclude: sensitive data accepted or sent over plain HTTP is a finding. A cookie without the Secure attribute is a finding only if the origin also answers on plain HTTP.
- Evidence: receipts of the HTTP and HTTPS answers, the attribute list and the form action.
- Record: cell for wstg-cryp-03.
- Stop: send no real credential over plain HTTP; use a throwaway marker.
- Not a finding when: the plain-HTTP port only redirects without echoing data.
