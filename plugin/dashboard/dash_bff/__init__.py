"""dash (``\\``) — Dashboard BFF for a persistent Hermes Agent web companion.

Thin backend-for-frontend mounted by the Hermes Dashboard at ``/api/plugins/dash/``.
Hermes stays the only agent/session authority: every conversation mutation goes through
the Hermes API server; this package only translates, validates and streams.
"""

from .version import __version__

__all__ = ["__version__"]
