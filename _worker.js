export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /auth/* 和 /credits/* 转发到 Worker API
    if (url.pathname.startsWith('/auth/') || url.pathname === '/credits' || url.pathname.startsWith('/credits/')) {
      return fetch(`https://image-bg-remover-api.tyongjian88.workers.dev${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      });
    }

    return env.ASSETS.fetch(request);
  }
};
