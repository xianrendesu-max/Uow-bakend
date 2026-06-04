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

const RE_VIDEO = /^\/api\/v1\/videos\/[^\/]+$/;
const RE_COMMENTS = /^\/api\/v1\/comments\/[^\/]+$/;
const RE_CHANNEL = /^\/api\/v1\/channels\/[^\/]+$/;
const RE_CHANNEL_VIDEOS = /^\/api\/v1\/channels\/videos\/[^\/]+$/;
const RE_CHANNEL_USER_VIDEOS = /^\/api\/v1\/channels\/[^\/]+\/videos$/;
const RE_PLAYLIST = /^\/api\/v1\/playlists\/[^\/]+$/;

export default async function handler(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  const isTargetApi =
    RE_VIDEO.test(pathname) ||
    RE_COMMENTS.test(pathname) ||
    pathname === '/api/v1/search' ||
    RE_CHANNEL.test(pathname) ||
    RE_CHANNEL_VIDEOS.test(pathname) ||
    RE_CHANNEL_USER_VIDEOS.test(pathname) ||
    RE_PLAYLIST.test(pathname) ||
    pathname === '/api/v1/trending' ||
    pathname === '/api/v1/popular';

  if (!isTargetApi) {
    return new Response(
      JSON.stringify({
        error: 'Not Found',
        message: 'This proxy only supports specific Invidious JSON APIs.'
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }

  let bodyBuffer = null;

  if (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.body
  ) {
    bodyBuffer = await request.arrayBuffer();
  }

  const baseHeaders = new Headers(request.headers);

  baseHeaders.delete('host');
  baseHeaders.delete('x-forwarded-host');
  baseHeaders.delete('x-vercel-deployment-url');

  baseHeaders.set(
    'User-Agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  baseHeaders.set('Accept', 'application/json');

  const controllers = [];

  const fetchPromises = INVIDIOUS_INSTANCES.map((instance) => {
    const controller = new AbortController();
    controllers.push(controller);

    return (async () => {
      const targetUrl =
        instance +
        url.pathname +
        url.search;

      const res = await fetch(targetUrl, {
        method: request.method,
        headers: baseHeaders,
        body: bodyBuffer,
        duplex: bodyBuffer ? 'half' : undefined,
        signal: controller.signal
      });

      if (
        !res.ok &&
        (
          res.status === 403 ||
          res.status === 429 ||
          res.status === 500 ||
          res.status === 502 ||
          res.status === 503 ||
          res.status === 504
        )
      ) {
        throw new Error(
          `Instance ${instance} returned invalid status ${res.status}`
        );
      }

      const contentType =
        res.headers.get('content-type') || '';

      if (contentType.includes('text/html')) {
        throw new Error(
          `Instance ${instance} returned HTML Content-Type.`
        );
      }

      const responseText = await res.text();

      const trimmed = responseText.trimStart();

      if (
        trimmed.startsWith('<!DOCTYPE html') ||
        trimmed.startsWith('<!doctype html') ||
        responseText.includes('<html')
      ) {
        throw new Error(
          `Instance ${instance} returned HTML (Bot Challenge) instead of JSON.`
        );
      }

      if (
        responseText.includes('"type": "parse-error"') ||
        responseText.includes('"errorMessage":')
      ) {
        throw new Error(
          `Instance ${instance} returned internal parse-error JSON.`
        );
      }

      if (
        !trimmed.startsWith('{') &&
        !trimmed.startsWith('[')
      ) {
        throw new Error(
          `Instance ${instance} returned invalid JSON structure.`
        );
      }

      return {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        responseText,
        instance
      };
    })();
  });

  try {
    const fastestResult =
      await Promise.any(fetchPromises);

    for (const controller of controllers) {
      controller.abort();
    }

    const responseHeaders =
      new Headers(fastestResult.headers);

    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');

    responseHeaders.set(
      'Access-Control-Allow-Origin',
      '*'
    );

    responseHeaders.set(
      'Access-Control-Allow-Methods',
      'GET, POST, OPTIONS'
    );

    responseHeaders.set(
      'Content-Type',
      'application/json; charset=utf-8'
    );

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: responseHeaders
      });
    }

    return new Response(
      fastestResult.responseText,
      {
        status: fastestResult.status,
        statusText: fastestResult.statusText,
        headers: responseHeaders
      }
    );
  } catch (aggregateError) {
    console.error(
      'All instances failed:',
      aggregateError.errors
    );

    return new Response(
      JSON.stringify({
        error:
          'All Invidious instances failed or returned Bot Challenges.',
        details:
          aggregateError.errors
            ? aggregateError.errors.map(
                (e) => e.message
              )
            : [aggregateError.message]
      }),
      {
        status: 502,
        headers: {
          'Content-Type':
            'application/json; charset=utf-8'
        }
      }
    );
  }
}

export const config = {
  runtime: 'edge'
};
