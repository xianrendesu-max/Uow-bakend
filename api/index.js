// 利用可能なInvidiousインスタンスのリスト
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

  // ==========================================
  // 1. 指定された8つのAPIエンドポイントのみに厳格に制限
  // ==========================================
  const isTargetApi = 
    /^\/api\/v1\/videos\/[^\/]+$/.test(pathname) ||         // 動画の詳細情報取得
    /^\/api\/v1\/comments\/[^\/]+$/.test(pathname) ||       // 動画のコメント取得
    pathname === '/api/v1/search' ||                        // 検索
    /^\/api\/v1\/channels\/[^\/]+$/.test(pathname) ||       // チャンネル情報取得
    /^\/api\/v1\/channels\/videos\/[^\/]+$/.test(pathname) || // チャンネル内の動画一覧
    /^\/api\/v1\/playlists\/[^\/]+$/.test(pathname) ||      // プレイリストの情報・動画一覧
    pathname === '/api/v1/trending' ||                      // 急上昇（トレンド）動画
    pathname === '/api/v1/popular';                         // 人気動画

  if (!isTargetApi) {
    return new Response(
      JSON.stringify({ error: 'Not Found', message: 'This proxy only supports specific Invidious JSON APIs.' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // クライアントからのリクエストボディをバッファ化（GET/HEAD以外で使い回すため）
  let bodyBuffer = null;
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    bodyBuffer = await request.arrayBuffer();
  }

  // クライアントからの共通ヘッダーのクリーンアップ
  const baseHeaders = new Headers(request.headers);
  baseHeaders.delete('host');
  baseHeaders.delete('x-forwarded-host');
  baseHeaders.delete('x-vercel-deployment-url');

  // ==========================================
  // 2. 全インスタンスへ同時にリクエストを送信（並列処理）
  // ==========================================
  const fetchPromises = INVIDIOUS_INSTANCES.map(async (instance) => {
    const targetUrl = `${instance}${url.pathname}${url.search}`;
    const requestHeaders = new Headers(baseHeaders);

    const res = await fetch(targetUrl, {
      method: request.method,
      headers: requestHeaders,
      body: bodyBuffer,
      duplex: bodyBuffer ? 'half' : undefined,
    });

    // 200系（または正常な404エラーなど）以外のサーバーエラーやアクセス拒否は即座に弾いて脱落させる
    if (!res.ok && [403, 429, 500, 502, 503, 504].includes(res.status)) {
      throw new Error(`Instance ${instance} returned invalid status ${res.status}`);
    }

    // 【超重要】Promise.anyの罠を回避する処理
    // 生のレスポンス（res.bodyストリーム）のまま返すと、最速以外のインスタンスが
    // バックグラウンドでストリームをロックしたり破損させたりしてVercelがエラーを吐きます。
    // 今回は「JSONデータを返すAPI」に特化しているため、ここでテキスト（JSON文字列）として
    // 完全にメモリに吸い上げてからresolve（解決）させます。
    const responseText = await res.text();
    
    return {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      bodyText: responseText
    };
  });

  try {
    // 3. 一番早くJSONデータの取得に成功したインスタンスの結果を採用
    const fastestResult = await Promise.any(fetchPromises);

    // 4. レスポンスヘッダーの再構築
    const responseHeaders = new Headers(fastestResult.headers);
    responseHeaders.delete('content-encoding'); // すでにデコード済みのため削除
    responseHeaders.delete('content-length');   // テキストを再出力するため削除
    
    // APIなので、呼び出し側のフロントエンドから叩きやすいようにCORSヘッダーを付与
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    responseHeaders.set('Content-Type', 'application/json; charset=utf-8');

    // OPTIONSメソッド（プリフライトリクエスト）が来たら200で即レス
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: responseHeaders });
    }

    // 5. 取得したJSON文字列をそのままクライアントへノータイムで返却
    return new Response(fastestResult.bodyText, {
      status: fastestResult.status,
      statusText: fastestResult.statusText,
      headers: responseHeaders,
    });

  } catch (aggregateError) {
    // すべてのインスタンスから拒否された、または全滅した場合
    console.error('All instances failed:', aggregateError.errors);
    
    return new Response(
      JSON.stringify({
        error: 'All Invidious instances failed concurrently.',
        details: aggregateError.errors ? aggregateError.errors.map(e => e.message) : [aggregateError.message]
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      }
    );
  }
}

// Vercel Edge Runtime
export const config = {
  runtime: 'edge',
};
