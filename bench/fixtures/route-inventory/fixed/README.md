# Storefront API (synthetic source fixture)

This is a synthetic application used to exercise route, parameter and identity inventory.
It is not a real service and contains no real data, credentials or customer records.

## Deployment notes

- The production gateway for this service is `https://api.storefront.invalid`.
- The finance console is served by the `/admin` router and requires an operator identity.
- The internal mirror is reachable at `http://10.0.0.7:8080` from the office network.
- Health is reported at `/healthz` by the platform ingress, not by this application.

## Running

Dependencies are pinned in `requirements.txt`. A source review must not start the service.
