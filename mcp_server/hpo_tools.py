import json
from urllib.parse import quote
from urllib.request import Request, urlopen


def hpo_get_term(hpo_id: str) -> dict | None:
    iri = quote("http://purl.obolibrary.org/obo/" + hpo_id.replace(":", "_"), safe="")
    request = Request("https://www.ebi.ac.uk/ols4/api/ontologies/hp/terms?iri=" + iri,
                      headers={"Accept": "application/json"})
    with urlopen(request, timeout=30) as response:
        terms = json.load(response).get("_embedded", {}).get("terms", [])
    return next((term for term in terms if term.get("obo_id") == hpo_id), None)


def hpo_search_term(query: str) -> list[dict]:
    url = "https://www.ebi.ac.uk/ols4/api/search?q=" + quote(query) + "&ontology=hp"
    request = Request(url, headers={"Accept": "application/json"})
    with urlopen(request, timeout=30) as response:
        return json.load(response).get("response", {}).get("docs", [])

