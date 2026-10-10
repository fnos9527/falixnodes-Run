"""把 vless:// 链接转成 sing-box 配置，输出到 stdout。
用法: python gen_singbox.py "<vless链接>" [socks端口]
支持 type=ws / tcp / grpc / http(h2)，security=none / tls / reality
"""
import json
import sys
from urllib.parse import urlparse, parse_qs, unquote


def build_outbound(link: str) -> dict:
    u = urlparse(link.strip())
    if u.scheme != "vless":
        raise ValueError("只支持 vless:// 链接")
    q = {k: unquote(v[0]) for k, v in parse_qs(u.query).items()}

    net = (q.get("type") or "tcp").lower()
    sec = (q.get("security") or "none").lower()
    path = q.get("path") or "/"
    host = q.get("host") or ""

    out = {
        "type": "vless",
        "tag": "proxy",
        "server": u.hostname,
        "server_port": u.port or 443,
        "uuid": unquote(u.username or ""),
    }
    if q.get("flow"):
        out["flow"] = q["flow"]

    # ---- TLS / REALITY ----
    if sec in ("tls", "reality"):
        tls = {"enabled": True, "server_name": q.get("sni") or host or u.hostname}
        if q.get("allowInsecure") in ("1", "true") or q.get("insecure") in ("1", "true"):
            tls["insecure"] = True
        if q.get("alpn"):
            tls["alpn"] = [a for a in q["alpn"].split(",") if a]
        if q.get("fp") or sec == "reality":
            tls["utls"] = {"enabled": True, "fingerprint": q.get("fp") or "chrome"}
        if sec == "reality":
            tls["reality"] = {
                "enabled": True,
                "public_key": q.get("pbk", ""),
                "short_id": q.get("sid", ""),
            }
        out["tls"] = tls

    # ---- 传输层 (wsSettings / tcpSettings / grpcSettings / httpSettings) ----
    if net == "ws":
        t = {"type": "ws", "path": path}
        if "ed=" in path:  # 形如 /xxx?ed=2048
            base, _, ed = path.partition("ed=")
            t["path"] = base.rstrip("?&") or "/"
            if ed.split("&")[0].isdigit():
                t["max_early_data"] = int(ed.split("&")[0])
                t["early_data_header_name"] = "Sec-WebSocket-Protocol"
        if host:
            t["headers"] = {"Host": host}
        out["transport"] = t
    elif net == "grpc":
        out["transport"] = {"type": "grpc", "service_name": q.get("serviceName", "")}
    elif net in ("http", "h2"):
        t = {"type": "http", "path": path}
        if host:
            t["host"] = [h for h in host.split(",") if h]
        out["transport"] = t
    elif net == "tcp":
        pass  # 纯 TCP 无需 transport
    else:
        raise ValueError(f"不支持的传输类型: {net}")
    return out


def main():
    link = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 1080
    cfg = {
        "log": {"level": "warn"},
        "inbounds": [
            {"type": "socks", "tag": "in", "listen": "127.0.0.1", "listen_port": port}
        ],
        "outbounds": [build_outbound(link), {"type": "direct", "tag": "direct"}],
        "route": {"final": "proxy"},
    }
    print(json.dumps(cfg, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"gen_singbox error: {e}", file=sys.stderr)
        sys.exit(1)
