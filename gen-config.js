// 把 PROXY_LINKS 里的 vless 链接转换成 sing-box 配置（本地 SOCKS5 127.0.0.1:1080）
const fs = require('fs');

function clean(line) {
  line = line.trim();
  // 兼容被 Markdown 污染的链接: vless://...sni=[www.bing.com&...#aws](https://...)
  const i = line.indexOf('](');
  if (i > 0) line = line.slice(0, i);
  return line.replace(/[\[\]()]/g, '');
}

function parseVless(link, idx) {
  const u = new URL(link);
  const q = u.searchParams;
  const security = q.get('security') || 'none';
  const type = q.get('type') || 'tcp';
  const insecure = q.get('insecure') === '1' || q.get('allowInsecure') === '1';

  const ob = {
    type: 'vless',
    tag: `node-${idx}`,
    server: u.hostname,
    server_port: Number(u.port || 443),
    uuid: decodeURIComponent(u.username),
  };
  if (q.get('flow')) ob.flow = q.get('flow');

  if (security === 'tls' || security === 'reality') {
    ob.tls = {
      enabled: true,
      server_name: q.get('sni') || q.get('host') || u.hostname,
      insecure,
    };
    if (q.get('fp')) ob.tls.utls = { enabled: true, fingerprint: q.get('fp') };
    if (q.get('alpn')) ob.tls.alpn = q.get('alpn').split(',');
    if (security === 'reality') {
      ob.tls.reality = { enabled: true, public_key: q.get('pbk') || '', short_id: q.get('sid') || '' };
      ob.tls.insecure = false;
    }
  }

  if (type === 'ws') {
    let p = decodeURIComponent(q.get('path') || '/');
    const t = { type: 'ws', headers: { Host: q.get('host') || q.get('sni') || u.hostname } };
    const m = p.match(/[?&]ed=(\d+)/);
    if (m) { // 把 ?ed=2048 转成 sing-box 的 early data 参数
      t.max_early_data = Number(m[1]);
      t.early_data_header_name = 'Sec-WebSocket-Protocol';
      p = p.replace(/[?&]ed=\d+/, '') || '/';
    }
    t.path = p;
    ob.transport = t;
  } else if (type === 'grpc') {
    ob.transport = { type: 'grpc', service_name: q.get('serviceName') || '' };
  }
  // type=tcp / headerType=none: 不需要 transport
  return ob;
}

const raw = process.env.PROXY_LINKS || '';
const outbounds = [];
raw.split(/\r?\n/).map(clean).filter(Boolean).forEach((l, i) => {
  if (!l.startsWith('vless://')) { console.warn('跳过不支持的链接:', l.slice(0, 20)); return; }
  try { outbounds.push(parseVless(l, i + 1)); }
  catch (e) { console.warn('解析失败:', e.message); }
});
if (!outbounds.length) { console.error('没有可用的代理节点，请检查 PROXY_LINKS'); process.exit(1); }

const tags = outbounds.map(o => o.tag);
const config = {
  log: { level: 'warn' },
  inbounds: [{ type: 'socks', tag: 'socks-in', listen: '127.0.0.1', listen_port: 1080 }],
  outbounds: [
    ...outbounds,
    { type: 'urltest', tag: 'auto', outbounds: tags, url: 'https://www.gstatic.com/generate_204', interval: '1m' },
    { type: 'direct', tag: 'direct' },
  ],
  route: { final: 'auto' },
};
fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
console.log(`已生成 config.json，节点数: ${outbounds.length}`);
