const ensembl = 'https://rest.ensembl.org';
const ols = 'https://www.ebi.ac.uk/ols4/api';
const hp = /^HP:\d{7}$/;
const parallelRequests = 8;

function createQueue() {
  let active = 0;
  const pending = [];
  function next() {
    while (active < parallelRequests && pending.length) {
      active++;
      pending.shift()().finally(() => {
        active--;
        next();
      });
    }
  }
  return task => new Promise((resolve, reject) => {
    pending.push(() => Promise.resolve().then(task).then(resolve, reject));
    next();
  });
}

async function read(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {Accept: 'application/json'},
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        if (!attempt && response.status >= 500) continue;
        throw new Error(new URL(url).hostname + ' HTTP ' + response.status);
      }
      return await response.json();
    } catch (error) {
      if (attempt || !['TimeoutError', 'TypeError'].includes(error.name)) throw error;
    }
  }
}

async function decide(name, prompt, input, runtime) {
  const {env, model, send} = runtime;
  if (!env.ROUTERAI_API_KEY) {
    send(name, 'Координатор', 'Модель не настроена. Использую правила.', {});
    return {};
  }
  send(name, 'Ling 3.0 Flash', 'Запрашиваю решение', input);
  try {
    const text = await model(env, prompt + ' Верни только JSON-объект.', input);
    const answer = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw Error('Invalid JSON object');
    return answer;
  } catch {
    send(name, 'Координатор', 'Модель не вернула решение. Использую правила.', {});
    return {};
  }
}

async function ensemblAgent(symbol, runtime) {
  const stableId = /^ENSG\d{11}$/.test(symbol);
  const options = stableId ? ['id'] : ['symbol', 'xref'];
  const plan = await decide('Ensembl',
    'Выбери маршрут поиска человеческого гена: symbol — точный официальный символ, xref — вероятный синоним, id — стабильный Ensembl ID. Формат {"route":"symbol"}. Выбирай из options, используй исходный ввод.',
    {symbol, options}, runtime);
  const route = options.includes(plan.route) ? plan.route : options[0];
  runtime.send('Ensembl', 'Ensembl REST', 'Выбран маршрут: ' + route, {symbol, route});
  const encoded = encodeURIComponent(symbol);
  let gene;
  if (route === 'xref') {
    const xrefs = await read(ensembl + '/xrefs/symbol/homo_sapiens/' + encoded);
    const ids = [...new Set(xrefs.filter(row => row.type === 'gene' && /^ENSG\d{11}$/.test(row.id)).map(row => row.id))];
    if (ids.length === 1) gene = await read(ensembl + '/lookup/id/' + ids[0]);
    else runtime.send('Ensembl', 'Ensembl REST', 'Проверяю точный символ', {symbol, candidates: ids});
  }
  gene ??= await read(ensembl + (stableId ? '/lookup/id/' : '/lookup/symbol/homo_sapiens/') + encoded);
  if (gene.object_type !== 'Gene' || gene.species !== 'homo_sapiens') throw new Error('Запись гена человека не найдена.');
  const endpoint = ensembl + '/phenotype/gene/homo_sapiens/' + gene.id + '?non_specified=0&tumour=0';
  const records = await read(endpoint);
  return {gene: gene.display_name || symbol, geneId: gene.id, description: gene.description?.replace(/\s*\[Source:.*\]$/, ''), biotype: gene.biotype, endpoint, records};
}

async function hpoAgent(records, runtime) {
  const classify = record => (record.ontology_accessions || []).some(id => /^(MONDO|Orphanet|OMIM):/i.test(id));
  const textRows = records.flatMap((record, index) => record.description && !classify(record)
      && !(record.ontology_accessions || []).some(id => hp.test(id)) ? [{index, title: record.description}] : []);
  const plan = await decide('HPO',
    'Для записей без HPO ID предложи поисковую фразу для OLS, только если название описывает конкретный наблюдаемый признак. Не подменяй диагноз симптомом. Формат {"queries":{"0":"выражение из исходного названия","1":null}}. Ключи — переданные индексы. Все ID проверяются независимо.',
    {textRows}, runtime);
  const queries = new Map(textRows.map(({index, title}) => {
    const choice = plan.queries?.[index];
    return [index, choice === null ? null : typeof choice === 'string' && choice.trim() && title.toLowerCase().includes(choice.trim().toLowerCase())
      ? choice.trim() : title];
  }));
  const enqueue = createQueue();
  const cache = new Map();
  function lookup(id) {
    if (!cache.has(id)) {
      const iri = 'http://purl.obolibrary.org/obo/' + id.replace(':', '_');
      cache.set(id, enqueue(() => read(ols + '/ontologies/hp/terms?' + new URLSearchParams({iri}))).then(result =>
        result._embedded?.terms?.find(term => term.obo_id === id && !term.is_obsolete)));
    }
    return cache.get(id);
  }
  function term(row) {
    return {id: row.obo_id, label: row.label, description: [].concat(row.description || []).join(' '),
      url: 'https://www.ebi.ac.uk/ols4/ontologies/hp/terms?obo_id=' + encodeURIComponent(row.obo_id)};
  }
  const idsToCheck = new Set(records.flatMap(record => record.ontology_accessions || []).filter(id => hp.test(id)));
  runtime.send('HPO', 'OLS', 'Проверяю уникальные HPO ID: ' + idsToCheck.size, {
    uniqueIds: idsToCheck.size, parallelRequests, titleSearch: Object.fromEntries(queries),
  });
  return Promise.all(records.map(async (record, index) => {
    const ids = [...new Set(record.ontology_accessions || [])].filter(id => hp.test(id));
    const disease = classify(record);
    try {
      if (ids.length) {
        const resolved = await Promise.allSettled(ids.map(lookup));
        return {ids, disease, terms: resolved.flatMap(item => item.value ? [term(item.value)] : []),
          failed: resolved.some(item => item.status === 'rejected')};
      }
      if (!queries.get(index)) return {ids, disease, terms: []};
      const result = await enqueue(() => read(ols + '/search?' + new URLSearchParams({
        q: queries.get(index), ontology: 'hp', rows: '4',
      })));
      return {ids, disease, terms: result.response.docs.filter(row => hp.test(row.obo_id)).map(term)};
    } catch {
      return {ids, disease, terms: [], failed: true};
    }
  }));
}

function reviewAgent(records, matches, endpoint, recommendations) {
  return records.map((record, index) => {
    const match = matches[index];
    const suggested = recommendations?.[index];
    const recommended = match.terms.some(term => term.id === suggested) ? suggested : null;
    const complete = match.ids.length === match.terms.length;
    let status = 'Нет сопоставления';
    if (match.failed) status = 'OLS ответил не на все запросы';
    else if (match.ids.length && match.terms.length) status = complete ? 'Совпадение по ID' : 'Часть ID проверена';
    else if (match.terms.length) status = 'Нужен выбор';
    else if (match.disease && !match.ids.length) status = 'Запись о заболевании';
    return {title: record.description || 'Без названия', source: record.source, url: endpoint, ...match, recommended, status};
  });
}

export async function audit(request, env, model) {
  const payload = await request.json().catch(() => null);
  const symbol = typeof payload?.symbol === 'string' ? payload.symbol.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9.-]{0,24}$/.test(symbol)) {
    return new Response('Введите символ гена, например FBN1.', {status: 400});
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = event => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      const send = (from, to, summary, data) => emit({message: {from, to, summary, data}});
      try {
        send('Координатор', 'Ensembl', 'Запрошены аннотации ' + symbol, {symbol});
        const runtime = {env, model, send};
        const data = await ensemblAgent(symbol, runtime);
        const geneProfile = {
          description: data.description,
          url: 'https://www.ensembl.org/Homo_sapiens/Gene/Summary?g=' + encodeURIComponent(data.geneId),
        };
        const records = data.records;
        send('Ensembl', 'HPO', 'Передано записей: ' + records.length, records.map(record => ({
          title: record.description, ids: record.ontology_accessions, source: record.source,
        })));
        const matches = await hpoAgent(records, runtime);
        send('HPO', 'Проверка', 'Получены термины. Сверяю их с исходными ID', matches.map(({ids, terms, failed}) => ({
          ids, terms: terms.map(({id, label}) => ({id, label})), failed: Boolean(failed),
        })));
        const ambiguous = matches.flatMap((item, index) => !item.ids.length && item.terms.length > 1
          ? [{index, title: records[index].description, candidates: item.terms}] : []);
        const review = await decide('Проверка',
          'Дай справку на русском о биологической роли продукта гена в 1–2 предложениях. При неуверенности оставь explanation пустым. Для спорных строк рекомендуй только один из переданных HPO ID или null, если совпадение слабое. Формат {"explanation":"...","recommendations":{"0":"HP:0000000"}}. Не делай клинических выводов, не меняй статусы совпадения и не добавляй новые связи.',
          {gene: data.gene, description: data.description, biotype: data.biotype, ambiguous}, runtime);
        geneProfile.explanation = typeof review.explanation === 'string' ? review.explanation.slice(0, 1000) : '';
        const rows = reviewAgent(records, matches, data.endpoint, review.recommendations);
        send('Проверка', 'Пользователь', 'Справка и рекомендации', {
          explanation: geneProfile.explanation,
          recommendations: rows.flatMap((row, index) => row.recommended ? [{index, id: row.recommended}] : []),
        });
        send('Проверка', 'Таблица', 'Статусы рассчитаны по записям источников', rows.map(({title, status}) => ({title, status})));
        const linked = rows.filter(row => row.ids.length && row.terms.length).length;
        const pending = rows.filter(row => row.status === 'Нужен выбор').length;
        const partial = rows.filter(row => row.ids.length > row.terms.length).length;
        const summary = [
          'В Ensembl для ' + data.gene + ' найдено записей: ' + data.records.length + '.',
          rows.length ? 'Термины HPO подтверждены по ID в ' + linked + ' из ' + rows.length + ' записей.' : '',
          partial ? 'В ' + partial + ' записях подтверждены не все ID.' : '',
          pending ? 'Строк для ручного выбора термина: ' + pending + '. Откройте «Выбрать термин», чтобы сравнить варианты.' : '',
        ].filter(Boolean).join(' ');
        send('Проверка', 'Пользователь', 'Подготовлен вывод по всем записям', {summary});
        emit({result: {gene: data.gene, geneId: data.geneId, total: data.records.length, rows, summary, geneProfile}});
      } catch (error) {
        emit({error: 'Не удалось получить аннотации. ' + error.message});
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {headers: {'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store'}});
}
