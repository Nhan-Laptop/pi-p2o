#!/usr/bin/env python3
"""Controlled offline probe for output contexts.

Run from this directory:  python3 probe.py

The probe renders one inert marker through every exported context and reports whether the marker
survives as text in that context or is emitted as raw markup. The marker is a bold element with a
data attribute; it contains no script and no event handler.
"""
import html
import json
import sys

import render


def main():
    marker = render.INERT_MARKER
    encoded_text = html.escape(marker, quote=False)
    encoded_attr = html.escape(marker)
    failures = []

    search = render.render_search_html(marker)
    search_state = "raw-markup" if marker in search else ("encoded" if encoded_text in search else "missing")
    if search_state != "encoded":
        failures.append("search-html-text")

    attribute = render.render_query_attribute(marker)
    attribute_state = "encoded" if encoded_attr in attribute and marker not in attribute else ("raw-markup" if marker in attribute else "missing")
    if attribute_state != "encoded":
        failures.append("query-quoted-attribute")

    diagnostics = render.render_diagnostics(marker)
    try:
        json_state = "json-string" if json.loads(diagnostics).get("query") == marker else "mismatch"
    except ValueError:
        json_state = "malformed"
    if json_state != "json-string":
        failures.append("diagnostics-json")

    comment = render.render_comment(marker)
    comment_state = "encoded" if encoded_attr in comment and marker not in comment else "raw-markup"
    if comment_state != "encoded":
        failures.append("comment-html-comment")

    print(f"CONTEXT search-html-text observed={search_state}")
    print(f"CONTEXT query-quoted-attribute observed={attribute_state}")
    print(f"CONTEXT diagnostics-json observed={json_state}")
    print(f"CONTEXT comment-html-comment observed={comment_state}")
    if failures:
        print(f"RESULT contexts-without-expected-encoding: {', '.join(failures)}")
        return 1
    print("RESULT all contexts encode the marker for their context")
    return 0


if __name__ == "__main__":
    sys.exit(main())
