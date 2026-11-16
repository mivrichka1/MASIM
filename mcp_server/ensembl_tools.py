import json
from urllib.parse import quote
from urllib.request import Request, urlopen

BASE = "https://rest.ensembl.org"


def _get(url: str):
    request = Request(url, headers={"Accept": "application/json"})
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def ensembl_lookup_gene(query: str) -> dict:
    route = "id" if query.upper().startswith("ENSG") else "symbol/homo_sapiens"
    return _get(f"{BASE}/lookup/{route}/{quote(query, safe='')}?content-type=application/json")


def ensembl_get_gene_phenotypes(ensembl_id: str) -> list[dict]:
    url = f"{BASE}/phenotype/gene/homo_sapiens/{quote(ensembl_id, safe='')}?content-type=application/json&non_specified=0&tumour=0"
    return _get(url)

