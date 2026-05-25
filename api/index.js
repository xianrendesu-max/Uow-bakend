const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.f5.si',
  'https://invidious.ritoge.com',
  'https://invidious.ducks.party',
  'https://super8.absturztau.be',
  'https://invidious.darkness.services',
  'https://yt.omada.cafe',
  'https://iv.melmac.space',
  'https://iv.duti.dev'
];

export default async function handler(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  const isTargetApi = 
    /^\/api\/v1\/videos\/[^\/]+$/.test(pathname) ||
    /^\/api\/v1\/comments\/[^\/]+$/.test(pathname) ||
    pathname === '/api/v1/search' ||
    /^\/api\/v1\/channels\/[^\/]+$/.test(pathname) ||
    /^\/api\/v1\/channels\/videos\/[^\/]+$/.test(pathname) ||
    /^\/api\/v1\/playlists\/[^\/]+$/.test(pathname) ||
    pathname === '/api/v1/trending' ||
    pathname === '/api/v1/popular';

  if (!isTargetApi) {
    return new Response(
      JSON.stringify({ error: 'Not Found', message: 'This proxy only supports specific Invidious JSON APIs.' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let bodyBuffer = null;
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    bodyBuffer = await request.arrayBuffer();
  }

  const baseHeaders = new Headers(request.headers);
  baseHeaders.delete('host');
  baseHeaders.delete('x-forwarded-host');
  baseHeaders.delete('x-vercel-deployment-url');

  baseHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  baseHeaders.set('Accept', 'application/json');

  const fetchPromises = INVIDIOUS_INSTANCES.map(async (instance) => {
    const targetUrl = `${instance}${url.pathname}${url.search}`;
    const requestHeaders = new Headers(baseHeaders);

    const res = await fetch(targetUrl, {
      method: request.method,
      headers: requestHeaders,
      body: bodyBuffer,
      duplex: bodyBuffer ? 'half' : undefined,
    });

    if (!res.ok && (res.status === 403 || res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504)) {
      throw new Error(`Instance ${instance} returned invalid status ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let chunkCount = 0;
    let headText = '';
    let hasHtml = false;
    const chunks = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          chunks.push(value);
          if (chunkCount < 3) {
            headText += decoder.decode(value, { stream: true });
            const trimmed = headText.trimStart();
            if (
              (trimmed.length >= 14 && trimmed.substring(0, 14).toLowerCase() === '<!doctype html') || 
              headText.includes('<html')
            ) {
              hasHtml = true;
              break;
            }
            chunkCount++;
          }
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }

    if (hasHtml) {
      throw new Error(`Instance ${instance} returned HTML (Bot Challenge) instead of JSON.`);
    }

    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const combinedArray = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combinedArray.set(chunk, offset);
      offset += chunk.length;
    }
    const responseText = decoder.decode(combinedArray);

    const trimmed = responseText.trimStart();
    if (trimmed.length >= 14 && trimmed.substring(0, 14).toLowerCase() === '<!doctype html' || responseText.includes('<html')) {
      throw new Error(`Instance ${instance} returned HTML (Bot Challenge) instead of JSON.`);
    }
    
    return {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      bodyText: responseText
    };
  });

  try {
    const fastestResult = await Promise.any(fetchPromises);

    const responseHeaders = new Headers(fastestResult.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    responseHeaders.set('Content-Type', 'application/json; charset=utf-8');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: responseHeaders });
    }

    return new Response(fastestResult.bodyText, {
      status: fastestResult.status,
      statusText: fastestResult.statusText,
      headers: responseHeaders,
    });

  } catch (aggregateError) {
    console.error('All instances failed:', aggregateError.errors);
    
    return new Response(
      JSON.stringify({
        error: 'All Invidious instances failed or returned Bot Challenges.',
        details: aggregateError.errors ? aggregateError.errors.map(e => e.message) : [aggregateError.message]
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      }
    );
  }
}

export const config = {
  runtime: 'edge',
};
