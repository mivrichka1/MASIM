"""Small JSON-RPC MCP-style tool server for the Gene Atlas demo."""
import json
import sys
from .ensembl_tools import ensembl_get_gene_phenotypes, ensembl_lookup_gene
from .hpo_tools import hpo_get_term, hpo_search_term

TOOLS = {
    "ensembl_lookup_gene": ensembl_lookup_gene,
    "ensembl_get_gene_phenotypes": ensembl_get_gene_phenotypes,
    "hpo_get_term": hpo_get_term,
    "hpo_search_term": hpo_search_term,
}


def serve() -> None:
    for line in sys.stdin:
        request = json.loads(line)
        if request.get("method") == "tools/list":
            result = {"tools": [{"name": name} for name in TOOLS]}
        elif request.get("method") == "tools/call":
            params = request.get("params", {})
            result = {"content": TOOLS[params["name"]](**params.get("arguments", {}))}
        else:
            result = {"error": "unknown method"}
        print(json.dumps({"jsonrpc": "2.0", "id": request.get("id"), "result": result}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    serve()

