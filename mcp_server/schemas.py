from dataclasses import dataclass
from typing import Any


@dataclass
class ToolResult:
    tool: str
    data: Any
    source_url: str | None = None

