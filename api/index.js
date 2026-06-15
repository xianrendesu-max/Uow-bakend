const INVIDIOUS_INSTANCES = [
  "https://invidious.ritoge.com",
  "https://yt.omada.cafe",
  "https://invidious.darkness.services",
  "https://invidious.f5.si",
  "https://invidious.ducks.party",
  "https://y.com.sb",
  "https://super8.absturztau.be",
  "https://inv.zoomerville.com",
  "https://invidious.nerdvpn.de",
  "https://inv.thepixora.com"
];

const RE_TARGET = /^\/api\/v1\/(videos\/[^\/]+|comments\/[^\/]+|search|channels\/[^\/]+|channels\/videos\/[^\/]+|channels\/[^\/]+\/videos|playlists\/[^\/]+|trending|popular)$/;

export default async function handler(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (!RE_TARGET.test(pathname)) {
    return new Response(
      JSON.stringify({
        error: 'Not Found',
        message: 'This proxy only supports specific Invidious JSON APIs.'
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      }
    });
  }

  let bodyBuffer = null;
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    bodyBuffer = await request.arrayBuffer();
  }

  const baseHeaders = new Headers();
  baseHeaders.set(
    'User-Agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  baseHeaders.set('Accept', 'application/json');

  if (request.headers.has('Authorization')) {
    baseHeaders.set('Authorization', request.headers.get('Authorization'));
  }

  const controllers = [];
  const searchParams = url.search;

  const fetchPromises = INVIDIOUS_INSTANCES.map((instance) => {
    const controller = new AbortController();
    controllers.push(controller);

    return (async () => {
      let timeoutId;
      try {
        timeoutId = setTimeout(() => controller.abort(), 5000);

        const res = await fetch(instance + pathname + searchParams, {
          method: request.method,
          headers: baseHeaders,
          body: bodyBuffer,
          duplex: bodyBuffer ? 'half' : undefined,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          throw new Error(`Instance ${instance} returned status ${res.status}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
          throw new Error(`Instance ${instance} returned HTML instead of JSON.`);
        }

        const responseText = await res.text();
        const trimmed = responseText.trimStart();

        if (trimmed.startsWith('<!DOCTYPE html') || responseText.includes('<html')) {
          throw new Error(`Instance ${instance} returned Bot Challenge (HTML).`);
        }

        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
          throw new Error(`Instance ${instance} returned invalid JSON.`);
        }

        try {
          JSON.parse(trimmed);
        } catch (e) {
          throw new Error(`Instance ${instance} returned malformed JSON.`);
        }

        return {
          status: res.status,
          responseText
        };
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        throw err;
      }
    })();
  });

  try {
    const fastestResult = await Promise.any(fetchPromises);

    for (let i = 0; i < controllers.length; i++) {
      controllers[i].abort();
    }

    return new Response(fastestResult.responseText, {
      status: fastestResult.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Content-Type': 'application/json; charset=utf-8'
      }
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
  runtime: 'edge'
};
