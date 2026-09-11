"""Shared bounds for offset pagination on warehouse collections."""

from typing import Annotated

from fastapi import Query

DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 500

PageOffset = Annotated[int, Query(ge=0)]
PageLimit = Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)]
