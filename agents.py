import re
from concurrent.futures import ThreadPoolExecutor
try:
    from .mcp_server.ensembl_tools import ensembl_get_gene_phenotypes, ensembl_lookup_gene
    from .mcp_server.hpo_tools import hpo_get_term
    from .router_ai import chat
except ImportError:
    from mcp_server.ensembl_tools import ensembl_get_gene_phenotypes, ensembl_lookup_gene
    from mcp_server.hpo_tools import hpo_get_term
    from router_ai import chat


class ChatAgent:
    def plan(self, question: str, previous: str) -> dict:
        explicit = re.search(r"\b(?:HP:\d{7}|ENSG\d{11}|[A-Z][A-Z0-9-]{1,15})\b", question)
        if explicit:
            return {"intent": "research", "target": explicit.group(0), "sources": ["ensembl", "hpo"], "answer_language": "ru"}
        raw = chat("Верни JSON. Определи intent: research или answer_directly. Для research укажи target.", {"question": question, "previous": previous})
        import json
        return json.loads(raw.replace("```json", "").replace("```", "").strip())


class EnsemblAgent:
    def research(self, query: str) -> dict:
        gene = ensembl_lookup_gene(query)
        return {"gene": gene, "phenotypes": ensembl_get_gene_phenotypes(gene["id"])}


class HPOAgent:
    def research(self, phenotype_ids: list[str]) -> list[dict]:
        with ThreadPoolExecutor(max_workers=4) as pool:
            return [term for term in pool.map(hpo_get_term, phenotype_ids) if term]


class AnswerAgent:
    def answer(self, question: str, records: dict, previous: str) -> str:
        return chat("Ответь на языке пользователя подробно и без воды. Используй только records. "
                    "После каждого факта укажи существующую ссылку [U1] или [G1]. "
                    "Различай заболевание и фенотип. Не добавляй список источников в конце.",
                    {"question": question, "records": records, "previous": previous})


class EvidenceValidator:
    def validate(self, answer: str, sources: dict) -> dict:
        citations = re.findall(r"\[([UG]\d+)\]", answer)
        return {"valid": bool(citations) and all(item in sources for item in citations),
                "citations": citations, "unknown": [item for item in citations if item not in sources]}


class Orchestrator:
    def __init__(self):
        self.chat = ChatAgent()
        self.ensembl = EnsemblAgent()
        self.hpo = HPOAgent()
        self.answer_agent = AnswerAgent()
        self.validator = EvidenceValidator()

    def run(self, question: str, previous: str, emit):
        emit("ChatAgent: строю план")
        plan = self.chat.plan(question, previous)
        if plan.get("intent") == "answer_directly":
            return {"answer": plan.get("answer", "Уточните вопрос."), "sources": {}}
        if str(plan.get("target", "")).upper().startswith("HP:"):
            emit("Orchestrator → HPOAgent")
            term = hpo_get_term(str(plan["target"]).upper())
            if not term:
                return {"answer": "Термин HPO не найден.", "sources": {}}
            source = {"G1": {"term": term.get("label"), "go_id": term.get("obo_id"),
                              "text": term.get("description"), "url": f"https://hpo.jax.org/browse/term/{term.get('obo_id')}"}}
            emit("AnswerAgent: собираю ответ")
            answer = self.answer_agent.answer(question, {"hpo": [term], "sources": source}, previous)
            validation = self.validator.validate(answer, source)
            emit("EvidenceValidator: " + ("цитаты проверены" if validation["valid"] else "нужна повторная генерация"))
            return {"answer": answer, "sources": source, "accession": term.get("obo_id"), "trace": validation}
        emit("Orchestrator → EnsemblAgent")
        result = self.ensembl.research(plan["target"])
        phenotype_ids = sorted(set(re.findall(r"HP[:_]\d{7}", str(result["phenotypes"]))))
        emit(f"EnsemblAgent → {result['gene']['id']}")
        emit("Orchestrator → HPOAgent: параллельный сбор терминов")
        result["hpo"] = self.hpo.research([item.replace("_", ":") for item in phenotype_ids[:8]])
        sources = {"U1": {"term": result["gene"].get("display_name", result["gene"]["id"]), "url": f"https://www.ensembl.org/Homo_sapiens/Gene/Summary?g={result['gene']['id']}"}}
        for index, term in enumerate(result["hpo"], 1):
            sources[f"G{index}"] = {"term": term.get("label"), "go_id": term.get("obo_id"), "text": term.get("description"), "url": f"https://hpo.jax.org/browse/term/{term.get('obo_id')}"}
        emit("AnswerAgent: собираю ответ")
        answer = self.answer_agent.answer(question, {"records": result, "sources": sources}, previous)
        validation = self.validator.validate(answer, sources)
        emit("EvidenceValidator: " + ("цитаты проверены" if validation["valid"] else "нужна повторная генерация"))
        return {"answer": answer, "sources": sources, "accession": result["gene"]["id"], "trace": validation}

