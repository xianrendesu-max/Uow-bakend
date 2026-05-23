// 利用可能なInvidiousインスタンスのリスト（Anubis等のボットガードがキツい場所は下位に回すのが安全です）
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

  // 1. 指定された8つのAPIエンドポイントのみに厳格に制限
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

  // クライアントからの共通ヘッダー
  const baseHeaders = new Headers(request.headers);
  baseHeaders.delete('host');
  baseHeaders.delete('x-forwarded-host');
  baseHeaders.delete('x-vercel-deployment-url');

  // 【重要】ボットフィルター（Anubis等）を突破するためにUser-Agentを一般的なブラウザに偽装
  baseHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  baseHeaders.set('Accept', 'application/json'); // JSONを求めていることを明示

  // 2. 全インスタンスへ同時にリクエストを送信
  const fetchPromises = INVIDIOUS_INSTANCES.map(async (instance) => {
    const targetUrl = `${instance}${url.pathname}${url.search}`;
    const requestHeaders = new Headers(baseHeaders);

    const res = await fetch(targetUrl, {
      method: request.method,
      headers: requestHeaders,
      body: bodyBuffer,
      duplex: bodyBuffer ? 'half' : undefined,
    });

    if (!res.ok && [403, 429, 500, 502, 503, 504].includes(res.status)) {
      throw new Error(`Instance ${instance} returned invalid status ${res.status}`);
    }

    // テキストとして吸い上げる
    const responseText = await res.text();

    // 【追加強化】返ってきた中身がJSONではなく「<!doctype html」などのHTML（ボット確認画面）だった場合、
    // 正常なレスポンスではないため、強制的にエラーを発生させて落選させる（Promise.anyで無視させる）
    if (responseText.trim().toLowerCase().startsWith('<!doctype html') || responseText.includes('<html')) {
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
    // 一番早く「ボット確認画面をすり抜けて、本物のJSONデータを返した」インスタンスを採用
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
