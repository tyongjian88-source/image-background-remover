export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 如果带有 code 参数（OAuth 回调）或 /auth/* 路径，转发到 Worker
    if (url.searchParams.get('code') || url.pathname.startsWith('/auth/') || url.pathname === '/credits' || url.pathname.startsWith('/credits/')) {
      const workerUrl = `https://image-bg-remover-api.tyongjian88.workers.dev${url.pathname}${url.search}`;
      return fetch(workerUrl, {
        method: request.method,
        headers: request.headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      });
    }
    
    // 其他路径返回静态文件
    return env.ASSETS.fetch(request);
  }
};
