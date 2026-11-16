import html from './page.mjs';
import profileHtml from './profile-page.mjs';
import {profile} from './profile.mjs';
import {audit} from './audit.mjs';
const ensembl = 'https://rest.ensembl.org';
async function json(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(new URL(url).hostname + ' HTTP ' + response.status);
  return response.json();
}
async function model(env, prompt, context) {
  const data = await json('https://routerai.ru/api/v1/chat/completions', {
    signal:AbortSignal.timeout(25000), method:'POST', headers:{Authorization:'Bearer '+env.ROUTERAI_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({model:'inclusionai/ling-3.0-flash',temperature:0,messages:[
      {role:'system',content:prompt},{role:'user',content:JSON.stringify(context)}]})
  });
  return data.choices[0].message.content.trim();
}
async function records(query, emit) {
  const sources = {};
  const ids = new Set();
  let accession = query;
  if (/^HP:\d{7}$/i.test(query)) ids.add(query.toUpperCase());
  else {
    emit({stage:'Ищу ген в Ensembl'});
    const id = encodeURIComponent(query);
    const route = /^ENSG/i.test(query) ? 'id' : 'symbol/homo_sapiens';
    const gene = await json(ensembl+'/lookup/'+route+'/'+id+'?content-type=application/json');
    accession = gene.id;
    const url = 'https://www.ensembl.org/Homo_sapiens/Gene/Summary?g='+accession;
    sources.U1 = {term:gene.display_name,text:gene.description,url};
    const traits = await json(ensembl+'/phenotype/gene/homo_sapiens/'+accession+'?content-type=application/json&non_specified=0&tumour=0');
    for (const trait of traits.slice(0,16)) {
      if (trait.description) sources['U'+(Object.keys(sources).length+1)] = {term:trait.description,url,source:trait.source};
      for (const id of JSON.stringify(trait).match(/HP[:_]\d{7}/g) || []) ids.add(id.replace('_',':'));
    }
  }
  if (ids.size) emit({stage:'Загружаю определения HPO'});
  const terms = await Promise.all([...ids].slice(0,8).map(async id => {
    const iri = encodeURIComponent('http://purl.obolibrary.org/obo/'+id.replace(':','_'));
    const data = await json('https://www.ebi.ac.uk/ols4/api/ontologies/hp/terms?iri='+iri);
    return data._embedded?.terms?.find(term=>term.obo_id===id);
  }));
  for (const [index, term] of terms.entries()) {
    if (term) sources['G'+(index+1)] = {term:term.label,text:term.description,url:'https://hpo.jax.org/browse/term/'+term.obo_id};
  }
  return {sources,accession};
}
export default {
  async fetch(request, env) {
    const response = await profile(request, env, model);
    if (response) return response;
    const path = new URL(request.url).pathname;
    if (path === '/audit' && request.method === 'POST') return audit(request, env, model);
    if ((path==='/' || path==='/chat-ui') && request.method==='GET') return new Response(path==='/' ? profileHtml : html,{headers:{'Content-Type':'text/html; charset=utf-8'}});
    if (path!=='/chat' || request.method!=='POST') return new Response('Not found',{status:404});
    const {question, previous} = await request.json();
    if (typeof question!=='string' || !question.trim() || question.length>2000) return new Response('Invalid question',{status:400});
    const stream = new ReadableStream({async start(controller) {
      const emit = value => controller.enqueue(new TextEncoder().encode(JSON.stringify(value)+'\n'));
      try {
        const context = {question,previous:String(previous||'').slice(-8000)};
        const explicit = question.match(/\bHP:\d{7}\b/i)?.[0] || question.match(/\b(?:ENSG\d{11}|[A-Z][A-Z0-9-]{1,15})\b/)?.[0];
        emit({stage:'Разбираю вопрос'});
        const parsed = explicit ? {query:explicit} : JSON.parse((await model(env,
          'Ответь на языке пользователя. Верни JSON с answer для обычного вопроса или query (символ гена, ENSG либо HP ID) для поиска. Используй контекст для уточнений. Экранируй переносы.',context)).replace(/^```(?:json)?\s*|\s*```$/g,''));
        if (!parsed.query) emit({result:{answer:parsed.answer,sources:{}}});
        else {
          const result = await records(parsed.query,emit);
          emit({stage:'Готовлю ответ со ссылками'});
          const instruction = 'Ответь на языке пользователя, подробно и ясно, с короткими абзацами и списком при необходимости. Используй исключительно сведения из sources, не добавляй симптомы, диагнозы или причины из памяти. Различай заболевания Ensembl и термины HPO. Для HPO точно передавай определение. После каждого утверждения обязательно поставь отдельную ссылку в формате [U1] или [G1], выбирая только существующий ключ sources. Не перечисляй все источники в конце, не повторяй факты и не смешивай языки.';
          const answer = await model(env, instruction, {...context,...result});
          const normalized = answer.replace(/\[([UG]\d+(?:\s*[,;]\s*[UG]\d+)+)\]/g,
            (_, group) => group.split(/\s*[,;]\s*/).map(id => '['+id+']').join(' '));
          const cited = [...normalized.matchAll(/\[([UG]\d+)\]/g)].map(match => match[1]);
          const unknown = cited.some(id => !result.sources[id]);
          if (!cited.length || unknown) {
            const first = Object.entries(result.sources).slice(0, 5);
            const fallback = 'Удалось найти следующие записи в источниках. Названия приведены на языке базы.\n\n' +
              first.map(([id, source]) => '• ' + source.term + ' [' + id + ']').join('\n');
            emit({result:{...result,answer:fallback}});
          } else emit({result:{...result,answer:normalized}});
        }
      } catch(error) { emit({error:error.message}); }
      finally { controller.close(); }
    }});
    return new Response(stream,{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'}});
  }
};
