"""Local web interface for the protein search pipeline."""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
import protein_api_smoke as pipeline
try:
    from .agents import Orchestrator
except ImportError:
    from agents import Orchestrator

MODELS = ("inclusionai/ling-3.0-flash",)


REPLY_STYLE = (
    "Пиши на языке текущего сообщения пользователя, даже если история или источники на другом языке. "
    "Если пользователь явно просит другой язык, используй его. Начинай с ответа по существу. "
    "Не повторяй вопрос и не добавляй приветствие, представление или предложение помощи без повода. "
    "Если спрашивают, кто ты, представься как агент, который помогает находить и объяснять сведения о генах и белках."
)


def find_records(query, progress):
    from urllib.parse import quote
    from urllib.error import HTTPError

    base = "https://rest.ensembl.org"
    encoded = quote(query, safe="")
    rows = {}
    ids = {query.upper()} if re.fullmatch(r"HP:\d{7}", query, re.I) else set()
    associations_by_id = {}
    if not ids:
        progress("Ищу ген в Ensembl")
        route = "id" if query.upper().startswith("ENSG") else "symbol/homo_sapiens"
        try:
            gene = pipeline.request("Ensembl", f"{base}/lookup/{route}/{encoded}")
        except HTTPError as error:
            if error.code in (400, 404):
                return {}, None
            raise
        accession = gene["id"]
        url = f"https://www.ensembl.org/Homo_sapiens/Gene/Summary?g={accession}"
        rows["U1"] = {"term": gene.get("display_name", accession), "text": gene.get("description"), "url": url}
        associations = pipeline.request("Фенотипы Ensembl", f"{base}/phenotype/gene/homo_sapiens/{accession}",
                                        {"non_specified": 0, "tumour": 0})
        for item in associations[:16]:
            phenotype = item.get("description")
            if phenotype:
                rows[f"U{len(rows)+1}"] = {"term": phenotype, "url": url,
                                           "evidence": item.get("source"), "text": json.dumps(item, ensure_ascii=False)}
            for hp_id in re.findall(r"HP[:_]\d{7}", json.dumps(item)):
                hp_id = hp_id.replace("_", ":")
                ids.add(hp_id)
                if phenotype:
                    associations_by_id.setdefault(hp_id, set()).add(phenotype)
    else:
        accession = query.upper()
    for identifier in sorted(ids)[:8]:
        progress("Загружаю определения HPO")
        identifier = identifier.replace("_", ":")
        result = pipeline.request("OLS4", "https://www.ebi.ac.uk/ols4/api/ontologies/hp/terms",
                                  {"iri": "http://purl.obolibrary.org/obo/" + identifier.replace(":", "_")})
        for term in result.get("_embedded", {}).get("terms", []):
            if term.get("obo_id") == identifier:
                description = term.get("description") or []
                rows[f"G{len(rows)+1}"] = {"term": term["label"], "go_id": identifier,
                                          "ensembl_associations": sorted(associations_by_id.get(identifier, ())),
                                          "text": " ".join(description) if isinstance(description, list) else description,
                                          "url": f"https://hpo.jax.org/browse/term/{identifier}"}
                break
    return rows, accession


def chat(payload, progress):
    question = payload["question"].strip()
    chosen = payload["model"]
    if not question or len(question) > 2000 or chosen not in MODELS:
        raise ValueError("Проверьте вопрос и выбранную модель.")
    if not __import__("os").environ.get("ROUTERAI_API_KEY"):
        raise ValueError("На сервере не задан ROUTERAI_API_KEY.")
    return Orchestrator().run(question, payload.get("previous", "")[-8500:], progress)
    # Legacy pipeline retained below for comparison and migration reference.
    context = {"question": question, "previous_question": payload.get("previous", "")[-8500:]}
    progress("Разбираю вопрос")
    parsed = pipeline.model(
        "Разбор", REPLY_STYLE + ' Ты агент с доступом к Ensembl и Human Phenotype Ontology. '
        'По текущему вопросу и истории выбери действие. Верни один JSON. Экранируй переносы строк внутри строковых значений. '
        'Если в текущем вопросе указан HP ID или ENSG ID и пользователь спрашивает о нём, обязательно выбери search. '
        'Для приветствия, общего объяснения, примеров, обобщения или перефразирования уже сказанного '
        'дай содержательный ответ в {"intent":"reply","answer":"..."}. '
        'Если спрашивают, какие гены или белки ты знаешь, приведи несколько примеров и кратко объясни их роль. Задавай встречный вопрос только '
        'если без уточнения нельзя дать полезный ответ. Не выдумывай ссылки или результаты поиска. '
        'Если вопрос требует новых сведений о конкретном гене человека или термине HPO или пользователь просит '
        'найти его в базе, верни {"intent":"search","query":"символ гена, ENSG ID или HP ID","focus":["function"]}. '
        'Допустимые focus: function, process, location. Для объяснения признака по названию извлеки его HPO ID, только если уверен. Сохраняй неизвестный символ буквально. '
        'Разрешай местоимения по недавним репликам, учитывай исправления пользователя и смену темы. '
        'История служит контекстом, а действие определяет текущий вопрос.',
        context, model_id=chosen)
    try:
        parsed = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", parsed), strict=False)
    except json.JSONDecodeError as error:
        raise ValueError("Модель вернула ответ в неверном формате. Попробуйте ещё раз.") from error
    if not isinstance(parsed, dict):
        raise ValueError("Модель вернула ответ в неверном формате. Попробуйте ещё раз.")
    intent = parsed.get("intent")
    if intent == "reply" and isinstance(parsed.get("answer"), str) and parsed["answer"].strip():
        return {"answer": parsed["answer"].strip(), "sources": {}}
    if intent != "search":
        raise ValueError("Модель не смогла обработать вопрос. Попробуйте ещё раз.")
    query = parsed["query"].strip()
    if not query:
        return {"answer": "Уточните название белка или символ гена.", "sources": {}}
    sources, accession = find_records(query, progress)
    if not sources:
        return {"answer": f"Запись для «{query}» не найдена.", "sources": {}}
    progress("Готовлю ответ со ссылками")
    try:
        answer = pipeline.model(
            "Ответ", REPLY_STYLE + " Для HP ID начни с названия признака и точного перевода определения OLS, затем объясни простыми словами. Не придумывай значения и не смешивай языки внутри слов. Английское название допустимо в скобках. Начни с прямого ответа, затем раскрой существенные детали, которые помогают понять тему. "
            "Подбирай объём под вопрос и данные. Для обзорного вопроса сгруппируй факты по смыслу "
            "и объясни каждый важный пункт в одном или нескольких предложениях. Для точного уточнения "
            "раскрой только запрошенную деталь. Используй жирные названия пунктов там, где они помогают читать. "
            "Убирай повторы, общие фразы и пересказ вопроса. Переводи названия и пояснения на язык пользователя, сохраняя HP ID. Учитывай контекст диалога, но подтверждай факты только текущими записями. "
            "После каждого факта ставь отдельную существующую метку источника в квадратных скобках. Копируй ключ из records точно, без перенумерации. Для HPO указывай HP ID. Отличай фенотип от заболевания и ассоциацию от причинной связи. Названия заболеваний и тип наследования не перечисляй как симптомы. Связывай признак с заболеванием только если оно указано в ensembl_associations именно этой записи HPO. Не добавляй отдельный перечень источников в ответ: интерфейс показывает его сам. "
            "Если данных мало, сообщи об этом. Не добавляй URL.",
            {**context, "records": sources}, model_id=chosen)
        answer = re.sub(r"\[([UG]\d+(?:,\s*[UG]\d+)+)\]",
                        lambda m: " ".join(f"[{tag.strip()}]" for tag in m[1].split(",")), answer)
        # Keep only real citation labels. The source panel also works without inline citations.
        answer = re.sub(r"\[([UG]\d+)\]",
                        lambda match: match[0] if match[1] in sources else "", answer)
    except (RuntimeError, ValueError, OSError, KeyError) as error:
        answer = f"Ответ модели недоступен. {error}\nНайденные записи доступны ниже."
    return {"answer": answer, "sources": sources, "accession": accession}


class Handler(BaseHTTPRequestHandler):
    def send_body(self, status, mime, body):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.partition("?")[0] == "/":
            self.send_body(200, "text/html; charset=utf-8", (ROOT / "index.html").read_bytes())
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != "/chat":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        def emit(event):
            self.wfile.write((json.dumps(event, ensure_ascii=False) + "\n").encode())
            self.wfile.flush()

        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size < 32000:
                raise ValueError("Недопустимый размер запроса.")
            result = chat(json.loads(self.rfile.read(size)), lambda stage: emit({"stage": stage}))
            emit({"result": result})
        except (BrokenPipeError, ConnectionResetError):
            return
        except (ValueError, TypeError, KeyError, AttributeError, RuntimeError, OSError) as error:
            message = "На сервере не задан OPENROUTER_API_KEY." if isinstance(error, KeyError) and error.args == ("OPENROUTER_API_KEY",) else str(error)
            emit({"error": message})



if __name__ == "__main__":
    print("Gene Atlas: http://127.0.0.1:8766", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8766), Handler).serve_forever()
