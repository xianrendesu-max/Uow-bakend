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

  // リクエストボディを並列リクエストで使い回せるように一度バッファ化
  let bodyBuffer = null;
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    bodyBuffer = await request.arrayBuffer();
  }

  // クライアントからの共通リクエストヘッダーを整形
  const baseHeaders = new Headers(request.headers);
  baseHeaders.delete('host');
  baseHeaders.delete('x-forwarded-host');
  baseHeaders.delete('x-vercel-deployment-url');

  // 各インスタンスへのFetch処理をPromiseの配列にする
  const fetchPromises = INVIDIOUS_INSTANCES.map(async (instance) => {
    const targetUrl = `${instance}${url.pathname}${url.search}`;
    
    // ヘッダーはインスタンスごとにインスタンス化（副作用防止）
    const requestHeaders = new Headers(baseHeaders);

    const res = await fetch(targetUrl, {
      method: request.method,
      headers: requestHeaders,
      body: bodyBuffer,
      duplex: bodyBuffer ? 'half' : undefined,
    });

    // 200系（または404などの有効なエラー扱い）ではない拒否ステータスは即座に弾く
    if (!res.ok && [403, 429, 500, 502, 503, 504].includes(res.status)) {
      throw new Error(`Instance ${instance} returned invalid status ${res.status}`);
    }

    // 正常なレスポンス（または確定した404など）ならそのままオブジェクトとして解決
    return res;
  });

  try {
    // 1. Promise.any を使い、一番早く「成功（resolve）」したレスポンスをキャッチする
    // ※エラー（throw）になったインスタンスは自動で無視されます
    const fastestResponse = await Promise.any(fetchPromises);

    // 2. 最速レスポンスのヘッダーを複製・クリーンアップ
    const responseHeaders = new Headers(fastestResponse.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');

    // 3. クライアントへそのまま最速のストリームを返却
    return new Response(fastestResponse.body, {
      status: fastestResponse.status,
      statusText: fastestResponse.statusText,
      headers: responseHeaders,
    });

  } catch (aggregateError) {
    // すべてのインスタンスの非同期処理が失敗（reject）した場合、ここに入ります
    console.error('All instances failed:', aggregateError.errors);
    
    return new Response(
      JSON.stringify({
        error: 'All Invidious instances failed concurrently.',
        details: aggregateError.errors.map(e => e.message)
      }),
      {
        status: 502, // Bad Gateway
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// Vercel Edge Runtime
export const config = {
  runtime: 'edge',
};
