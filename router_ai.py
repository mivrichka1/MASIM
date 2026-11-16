import json
import os
import time
from urllib.request import Request, urlopen

BASE_URL = "https://routerai.ru/api/v1"
MODEL = "inclusionai/ling-3.0-flash"


def chat(system: str, context: dict, *, timeout: int = 45) -> str:
    key = os.environ["ROUTERAI_API_KEY"]
    payload = {"model": MODEL, "temperature": 0, "messages": [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(context, ensure_ascii=False)},
    ]}
    request = Request(BASE_URL + "/chat/completions", data=json.dumps(payload).encode(),
                      headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=timeout) as response:
                data = json.load(response)
            return data["choices"][0]["message"]["content"].strip()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(0.5 * (attempt + 1))

