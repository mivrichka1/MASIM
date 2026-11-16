import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import worker from './dist/server/index.js';

createServer(async (incoming, outgoing) => {
  try {
    const options = {method: incoming.method, headers: incoming.headers};
    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
      options.body = Readable.toWeb(incoming);
      options.duplex = 'half';
    }
    const response = await worker.fetch(new Request('http://127.0.0.1:8767' + incoming.url, options), process.env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch {
    outgoing.writeHead(500).end('Gene Atlas: ошибка обработки запроса');
  }
}).listen(8767, '127.0.0.1', () => console.log('Gene Atlas: http://127.0.0.1:8767/'));
