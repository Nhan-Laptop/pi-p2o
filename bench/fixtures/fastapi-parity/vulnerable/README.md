# Reporting API (synthetic FastAPI source fixture)

Synthetic FastAPI/Starlette application used to exercise framework enforcement-parity review.
There is no real service and no real data.

## Running the probe

```sh
cd /target && python3 probe.py
```

FastAPI and Starlette are **not** installed in this offline image (see `requirements.txt` for the
versions the application declares). `parity.py` mirrors the effective checks from `app.py` so the
enforcement decisions can be exercised with the standard library only. The mirror exists for the
review; it is not a substitute for observing the installed framework version.

## Layout

- `app.py` - application factory, routers, mount, middleware.
- `security.py` - identity dependencies.
- `routers/` - API routers.
- `internal_app.py` - mounted Starlette sub-application.
- `parity.py` - executable mirror of the effective enforcement decisions.
- `probe.py` - controlled principal/path matrix.
