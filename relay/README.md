# Lepons 중계 서버

폰과 PC가 각자 밖으로 열어 둔 WebSocket 사이로 바이너리 프레임을 그대로 옮긴다.
Tailscale을 대신하며, 공유기 포트를 열지 않는다.

```
폰 ──wss──▶ Cloudflare(HTTPS) ──Tunnel──▶ cloudflared ──▶ relay(:8787)
PC ──wss──┘
```

서버는 암호문만 본다. 복호화하지 않고, 저장하지 않는다 — 보낼 큐가 아예 없어서
저장할 자리가 없다. 로그에는 시각, 방 ID 앞 6자리, 역할(pc/phone), 바이트 수, close code만 남는다.
로그는 날짜별 파일로 남기고 14일이 지나면 relay가 지운다(개인정보 처리방침과 같은 기간).

## 클라이언트가 지켜야 할 계약

Windows 쪽에서 PC·폰 클라이언트를 만들 때 필요한 전부다.

| | |
|---|---|
| 주소 | `wss://<호스트>/ws?room=<방 ID>&role=pc` 또는 `role=phone` |
| 방 ID | 소문자 hex 32자(128비트). PC가 만들고 QR로 넘긴다. `^[0-9a-f]{32}$`에 안 맞으면 HTTP 400 |
| 페이로드 | **바이너리 프레임**. 그대로 상대에게 전달된다 |
| 제어 메시지 | 서버가 보내는 **텍스트 프레임**: `peer-joined`, `peer-left` |
| 보낼 수 있는 것 | 바이너리뿐. 텍스트를 보내면 **1003**으로 끊긴다 |
| 한 메시지 상한 | **1 MiB**. 넘기면 **1009**로 끊긴다. 더 큰 것은 클라이언트가 나눠 보낸다 |
| 살아 있음 확인 | 서버가 30초마다 ping, 10초 안에 pong이 없으면 끊는다. 대부분의 라이브러리가 자동 응답하지만 확인할 것 |
| 건강 확인 | `GET /health` → `ok` |

**close code**

| 코드 | 뜻 | 클라이언트가 할 일 |
|---|---|---|
| `4000 replaced` | 같은 역할로 다른 소켓이 들어왔다 | 바로 재연결하지 않는다 (다른 기기가 이어받음). PC는 60초부터 10분까지 늘려 가며 다시 걸고, 폰은 앱이 앞으로 돌아올 때 한 번 다시 건다 |
| `4001 no pong` | pong이 10초 안에 안 왔다 | 재연결 |
| `1006` (close 프레임 없이 끊김) | 상대가 메시지를 보내다 끊겼거나, 메시지 하나가 10초 안에 다 전달되지 못했다(보내는 쪽이 느려도 같다). 네트워크가 끊겨도 같다 | 재연결 |
| `1003` | 바이너리가 아닌 프레임을 보냈다 | 버그다. 고친다 |
| `1009` | 1 MiB를 넘겼다 | 나눠 보낸다 |
| HTTP `503` | 서버가 꽉 찼다 (전체 200 / IP당 6, IPv6는 /64당 6) | 잠시 뒤 재시도 |
| HTTP `429` | 새 연결을 너무 빨리 열었다 (IP당 한꺼번에 12개, 그 뒤 2초에 1개) | 잠시 뒤 재시도 |

**페어가 바뀔 때**: 같은 역할로 새로 들어온 쪽이 이긴다. 와이파이에서 LTE로 넘어간 폰은
죽은 소켓이 정리되기를 기다리지 않고 **바로 재연결하면 된다**. 대신 방 ID를 쥔 쪽은
상대를 밀어낼 수 있다 — 방 ID가 곧 유일한 비밀이다.

페어가 없는 동안 보낸 메시지는 **버려진다**. `peer-joined`를 받은 뒤에 보낸다.

**상대가 없다는 이유로는 끊지 않는다.** 방 ID는 계속 쓰이고 폰은 백그라운드로 갈 때마다
연결을 끊으므로, PC가 상대 없이 몇 시간씩 기다리는 것이 정상이다. 폰 앱을 열었는데
`peer-joined`가 오지 않으면 "PC가 꺼져 있거나 연결되어 있지 않아요"로 안내한다.

## 처음 한 번

1. Cloudflare Zero Trust → Networks → Tunnels → 새 터널 → 토큰 발급.
2. 터널의 Public Hostname: `<호스트> → http://relay:8787` (Service 타입 HTTP).
3. 토큰을 `relay/.env`에 둔다. 이 파일은 gitignore되어 있다.

   ```bash
   echo 'TUNNEL_TOKEN=여기에토큰' > relay/.env
   ```

4. 맥이 자면 중계가 끊긴다. 전원 연결 시 잠자기를 끈다.

   ```bash
   sudo pmset -c sleep 0
   ```

## 매일

```bash
cd relay

docker compose up -d --build     # 시작
# 오늘 기록. 파일 이름은 UTC 날짜라 한국 시각 09:00에 새 파일로 바뀐다(그때 다시 띄운다).
# Docker 로그에는 기록이 없고, cloudflared는 로그를 남기지 않는다
docker run --rm -v lepons-relay_logs:/logs:ro busybox tail -F /logs/relay-$(date -u +%F).log
docker compose ps                # 떠 있는지
docker compose down              # 정리 (남는 것: 이미지, .env, 기록 볼륨)
docker compose down -v           # 기록까지 지운다. 오래 내려 둘 때 (내려가 있는 동안은 14일 정리가 돌지 않는다)

# 건강 확인
curl -sS https://relay.lepons.app/health                 # 공개 경로 (터널까지 통째로)
docker run --rm --network lepons-relay_inside busybox \
  wget -qO- http://relay:8787/health                     # 컨테이너 안에서만

# 전체 점검 — 페어링·전달·교체·peer-left·한도까지 20가지
node smoke.mjs https://relay.lepons.app
```

호스트에 공개된 포트가 없어서(맥의 8787은 다른 프로세스가 쓴다) `curl localhost:8787`은
안 된다. cloudflared 이미지에는 셸도 `wget`도 없으므로 `docker compose exec`로는 확인할 수 없다.

## 한도와 알려진 실패

| | |
|---|---|
| 메모리 / CPU | 128 MB / 0.5 코어. 20연결·3 MiB 트래픽 실측 **2 MiB** |
| 연결 | 전체 200, IP당 6(IPv6는 /64당 6). 넘으면 OOM 대신 503. 새 연결은 IP당 한꺼번에 12개, 그 뒤 2초에 1개(넘으면 429) |
| 맥이 자면 | 전부 끊긴다. `pmset -c sleep 0` |
| 맥을 재부팅하면 | FileVault가 로그인 전까지 디스크를 잠그므로 **사람이 로그인할 때까지 안 올라온다** |
| Docker Desktop 재시작 | `restart: unless-stopped`가 알아서 되살린다 |
| 로그 보관 | `logs` 볼륨에 날짜별 파일. 그날 0시(UTC)부터 14일이 지나면 1분 안에 지운다. 하루 64 MiB까지만 쓴다(넘으면 `log cap reached` 한 줄, 다음 날 첫 줄에 버린 줄 수 `log cap dropped N lines on 날짜`). 터널 상태는 Cloudflare 대시보드(Networks → Tunnels)에서 본다 |
| 로그 시각 | Docker Desktop VM 시계가 호스트에서 수 초~십수 초 어긋난다(실측 5초, 15초). 초 단위로 믿지 않는다 |
| 100명 규모 | 같은 동작을 Cloudflare Workers + Durable Objects로 옮긴다 |

## 왜 이렇게 생겼나

- **호스트 포트를 공개하지 않는다.** 맥의 8787은 이미 다른 프로세스가 쓰고 있고,
  공개 포트가 없어야 `CF-Connecting-IP`를 믿고 IP당 한도를 걸 수 있다.
- **맥 폴더를 하나도 연결하지 않는다.** 볼륨은 Docker VM 안의 `logs`(relay 기록) 하나뿐이다.
  "맥 파일에 접근하지 않는다"가 약속이 아니라 `compose.yaml`에서 확인되는 사실이 된다.
- **`FROM scratch`.** 2.4 MB 이미지. 인터넷에 닿는 컨테이너 안에 셸도 패키지 관리자도 없다.
- **relay는 `internal: true` 네트워크에 있다.** 밖으로 나가는 쪽은 cloudflared뿐이다.
- **큐가 없다.** 상대 쓰기가 막히면 복사가 멈추고 그 멈춤이 TCP를 타고 보낸 쪽까지 간다.
  느린 폰이 메모리를 늘리지 못하고, 동시에 저장할 자리도 없다.
- **압축을 끈다.** 암호문은 압축되지 않고, permessage-deflate는 연결당 수백 KB를 먹는다.
