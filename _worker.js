export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 如果是 /auth/* 路径，转发到 Worker
    if (url.pathname.startsWith('/auth/')) {
      return fetch(`https://image-bg-remover-api.tyongjian88.workers.dev${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    }
    
    // 其他路径返回静态文件
    return env.ASSETS.fetch(request);
  }
};
