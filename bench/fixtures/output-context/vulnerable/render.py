"""Search result rendering for the storefront."""
import html
import json

# The marker is inert by construction: a bold element with a data attribute, no script,
# no event handler. It only shows whether the sink treats bytes as markup or as text.
INERT_MARKER = '<b data-p2o-marker="inert">p2o-marker</b>'


def render_search_html(query):
    """Render the search section. The template places {query} in an HTML text context."""
    return f'<section class="search"><h2>Results for {query}</h2><p>{query}</p></section>'


def render_query_attribute(query):
    """Render the search input. The value sits in a quoted attribute context."""
    return f'<input name="q" value="{html.escape(query, quote=True)}">'


def render_diagnostics(query):
    """Render the diagnostics payload consumed by the internal dashboard as JSON."""
    return json.dumps({"query": query, "count": 0}, ensure_ascii=False)


def render_comment(query):
    """Render an HTML comment used by the template cache key."""
    return f'<!-- search: {html.escape(query)} -->'
