# Search renderer (synthetic source fixture)

Synthetic rendering path used to exercise source-to-sink and output-context review. There is no
real browser, no network and no data.

## Running the probe

```sh
cd /target && python3 probe.py
```

The probe renders one inert marker through each exported function and reports whether the marker
survives as literal text (context-appropriate encoding) or is emitted as raw markup. It never uses
a script tag, event handler or executable payload.

## Layout

- `render.py` — the exported render functions, one per output context.
- `app.py` — the request path that calls the search renderer.
- `templates/search.html` — the template contract for the HTML text context.
- `probe.py` — offline context comparison with the inert marker.
