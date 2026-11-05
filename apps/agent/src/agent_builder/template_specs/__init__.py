"""Industry specs, grouped by file so each can be edited on its own."""

from ..template_library import Industry
from .core import SPECS as _core
from .group_a import SPECS as _a
from .group_b import SPECS as _b
from .group_c import SPECS as _c

SPECS: list[Industry] = [*_core, *_a, *_b, *_c]
