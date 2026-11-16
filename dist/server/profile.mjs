const ols = 'https://www.ebi.ac.uk/ols4/api';
const ensembl = 'https://rest.ensembl.org';
const hpId = /^HP:\d{7}$/;

async function read(url) {
  const response = await fetch(url, {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

export async function profile(request, env, model) {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || !['/profile/terms', '/profile/match'].includes(path)) return null;
  const payload = await request.json().catch(() => null);
  const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
  const ids = Array.isArray(payload?.ids) ? [...new Set(payload.ids)] : [];
  const searching = path.endsWith('/terms');
  const genes = Array.isArray(payload?.genes) ? [...new Set(payload.genes)] : [];
  if (genes.length > 4 || genes.some(gene => typeof gene !== 'string' || !/^[A-Z0-9-]{1,20}$/.test(gene))) {
    return new Response('Введите до четырёх символов генов', {status: 400});
  }
  if (searching ? !query || query.length > 160 : !ids.length || ids.length > 8 || ids.some(id => typeof id !== 'string' || !hpId.test(id))) {
    return new Response('Некорректный запрос', {status: 400});
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = event => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      const send = (from, to, content) => emit({message: {from, to, content}});
      try {
        if (searching) {
          send('Координатор', 'Агент HPO', {query});
          let term = query;
          if (/[а-яё]/i.test(query)) {
            send('Агент HPO', 'Ling 3.0 Flash', {action: 'Перевести запрос для OLS', query});
            term = (await model(env, 'Translate the supplied phenotype search phrase into one concise English search phrase. Output only the phrase.', {query})).slice(0, 160);
            send('Ling 3.0 Flash', 'Агент HPO', {query: term});
          }
          const params = new URLSearchParams({q: term, ontology: 'hp', rows: '12'});
          const result = await read(ols + '/search?' + params);
          const terms = result.response.docs.filter(row => hpId.test(row.obo_id)).map(row => ({
            id: row.obo_id, label: row.label, description: [].concat(row.description || []).join(' '),
          }));
          send('Агент HPO', 'Координатор', {terms: terms.map(({id, label}) => ({id, label}))});
          emit({terms});
          return;
        }
        const found = await Promise.all(ids.map(async id => {
          send('Координатор', 'Агент Ensembl', {phenotype: id});
          try {
            const endpoint = ensembl + '/phenotype/accession/homo_sapiens/' + encodeURIComponent(id);
            const result = await read(endpoint);
            const rows = result.filter(row => row.id && row.type).map(row => ({
              id: String(row.id), type: String(row.type), source: row.source || '', url: endpoint,
            }));
            send('Агент Ensembl', 'Координатор', {phenotype: id, count: rows.length, records: rows.slice(0, 4)});
            return {id, rows};
          } catch (error) {
            send('Агент Ensembl', 'Координатор', {phenotype: id, error: error.message});
            return {id, error: error.message};
          }
        }));
        const geneChecks = await Promise.all(genes.map(async gene => {
          send('Координатор', 'Агент Ensembl', {gene, action: 'Сверить HPO ID в аннотациях'});
          try {
            const endpoint = ensembl + '/phenotype/gene/homo_sapiens/' + encodeURIComponent(gene);
            const annotations = await read(endpoint);
            const matches = ids.filter(id => annotations.some(annotation =>
              (JSON.stringify(annotation).toUpperCase().match(/HP[:_]\d{7}/g) || [])
                .some(value => value.replace('_', ':') === id)));
            send('Агент Ensembl', 'Координатор', {gene, matches});
            return {gene, matches, endpoint};
          } catch (error) {
            send('Агент Ensembl', 'Координатор', {gene, error: error.message});
            return {gene, error: error.message};
          }
        }));
        const merged = new Map();
        for (const {id, rows = []} of found) {
          for (const row of rows) {
            const key = row.type + ':' + row.id;
            if (!merged.has(key)) merged.set(key, {...row, matches: {}});
            merged.get(key).matches[id] = row.url;
          }
        }
        for (const {gene, matches, endpoint} of geneChecks) {
          if (!matches?.length) continue;
          merged.set('gene-panel:' + gene, {
            id: gene, type: 'Ген из панели', matches: Object.fromEntries(matches.map(id => [id, endpoint])),
          });
        }
        const rows = [...merged.values()].sort((a, b) => Object.keys(b.matches).length - Object.keys(a.matches).length);
        send('Координатор', 'Профиль', {records: rows.length, completed: found.filter(item => !item.error).length, total: ids.length});
        emit({rows, geneChecks, status: found.map(({id, rows, error}) => ({id, count: rows?.length, error}))});
      } catch (error) {
        emit({error: error.message});
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {headers: {'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store'}});
}
