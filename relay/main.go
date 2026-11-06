// Lepons 중계 서버.
//
// 폰과 PC가 각자 밖으로 열어 둔 WebSocket 사이로 바이너리 프레임을 그대로 옮긴다.
// 내용은 열어 보지 않고, 복호화하지 않고, 어디에도 쌓아 두지 않는다.
// 큐를 두지 않았으므로 메시지를 저장할 곳 자체가 없다.
package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	// 한 메시지 상한. 메시지를 통째로 메모리에 올리지 않고 copyBuffer 단위로 흘려
	// 보내므로, 이 값은 메모리와 상관없는 클라이언트와의 약속이다. 이보다 큰 데이터는
	// 클라이언트가 나눠 보낸다.
	maxMessage = 1 << 20
	copyBuffer = 32 << 10

	// 설계상 최대 연결 수. 한도를 넘으면 메모리 부족으로 죽는 대신 503으로 거절한다.
	maxConns = 200
	// 한 IP당 동시 연결. 공유기 하나 뒤에서 PC·폰 세 쌍까지 쓸 수 있다.
	// 한 곳에서 연결 200개를 독차지하지 못하게 한다.
	maxPerIP = 6

	// 30초마다 ping을 보내 Cloudflare를 지나는 연결이 유휴 상태로 끊기지 않게 한다. Cloudflare
	// 문서에는 WebSocket 유휴 한도가 따로 없어 짧게 잡았다. pong이 10초 안에 오지 않으면 한
	// 번만으로도 끊는다(4001). 확인하는 쪽이 서버인 이유: 클라이언트가 ping을
	// 보내 줄 거라고 믿을 수 없고, 응답 없는 소켓을 정리하지 않으면 연결 수 한도를 계속
	// 차지하며, 상대는 peer-left를 받지 못해 아직 연결된 줄 안다.
	pingEvery = 30 * time.Second
	pongWait  = 10 * time.Second

	// 상대가 이 시간 안에 받지 못하면 끊긴 것으로 본다. 네트워크 왕복보다 충분히 길고
	// ping 간격보다 짧다.
	writeWait = 10 * time.Second

	// 기록 보관 기간. 개인정보 처리방침(site/privacy.html)의 "최대 14일"과 같아야 한다.
	keepLogs = 14 * 24 * time.Hour
	// 하루 기록 상한. 평소에는 연결 하나에 두 줄(약 120바이트)이라 닿지 않는다. 연결을 열고
	// 닫기만 반복하는 쪽이 있어도 14일 치가 1 GB를 넘지 않는다.
	logPerDay = 64 << 20
)

// 방 ID는 PC가 만든 128비트 난수다. 형식이 틀리면 WebSocket 연결 전에 거절한다.
var roomID = regexp.MustCompile(`^[0-9a-f]{32}$`)

type conn struct {
	ws   *websocket.Conn
	role string // "pc" 또는 "phone"
}

type room struct {
	pc, phone *conn
}

var (
	mu    sync.Mutex
	rooms = map[string]*room{}
	conns int
	perIP = map[string]int{}
)

// admit은 연결 수 한도 안일 때만 받아들인다. WebSocket을 만들기 전에 확인한다.
func admit(ip string) bool {
	mu.Lock()
	defer mu.Unlock()
	if conns >= maxConns || perIP[ip] >= maxPerIP {
		return false
	}
	conns++
	perIP[ip]++
	return true
}

func release(ip string) {
	mu.Lock()
	defer mu.Unlock()
	conns--
	if perIP[ip]--; perIP[ip] <= 0 {
		delete(perIP, ip)
	}
}

// seat은 c를 역할에 맞는 자리에 넣고, 원래 그 자리에 있던 소켓과 상대 소켓을 돌려준다.
// 같은 역할로 새로 들어온 쪽이 이긴다. 그래야 와이파이에서 LTE로 바뀐 폰이 끊긴 소켓이
// 정리되기를(최대 pingEvery+pongWait) 기다리지 않고 바로 연결된다. 먼저 온 쪽을 지키면,
// 방 ID를 먼저 손에 넣은 쪽이 자리를 영영 차지할 수 있다.
func seat(id string, c *conn) (peer, evicted *conn) {
	mu.Lock()
	defer mu.Unlock()
	r := rooms[id]
	if r == nil {
		r = &room{}
		rooms[id] = r
	}
	if c.role == "pc" {
		evicted, r.pc, peer = r.pc, c, r.phone
	} else {
		evicted, r.phone, peer = r.phone, c, r.pc
	}
	return peer, evicted
}

// leave는 그 자리에 아직 c가 있을 때만 비운다. 밀려난 소켓이 뒤늦게 정리되면서 새 소켓까지
// 지우면, 연결된 두 소켓이 서로를 찾지 못해 통신이 멈춘다.
func leave(id string, c *conn) (peer *conn) {
	mu.Lock()
	defer mu.Unlock()
	r := rooms[id]
	if r == nil {
		return nil
	}
	switch {
	case c.role == "pc" && r.pc == c:
		r.pc, peer = nil, r.phone
	case c.role == "phone" && r.phone == c:
		r.phone, peer = nil, r.pc
	default:
		return nil // 이미 밀려난 소켓이라 비울 자리가 없다.
	}
	if r.pc == nil && r.phone == nil {
		delete(rooms, id) // 마지막 연결이 나가면 방을 지운다. 빈 방이 쌓이지 않는다.
	}
	return peer
}

// partner는 메시지마다 새로 조회한다. 상대는 도중에 들어오거나 나가거나 바뀔 수 있다.
// 밀려난 소켓은 close가 끝날 때까지 메시지를 더 읽으므로, 자리에 없으면 상대가 없는
// 것으로 본다. 그래야 새 소켓과 다시 연결된 상대에게 옛 세션의 메시지가 가지 않는다.
func partner(id string, c *conn) *conn {
	mu.Lock()
	defer mu.Unlock()
	r := rooms[id]
	if r == nil {
		return nil
	}
	if c.role == "pc" && r.pc == c {
		return r.phone
	}
	if c.role == "phone" && r.phone == c {
		return r.pc
	}
	return nil
}

// 제어 메시지는 텍스트 프레임, 전달하는 암호문은 바이너리 프레임이다.
// 클라이언트는 프레임 종류만 보고 둘을 구분하므로 암호문 내용을 볼 필요가 없다.
func notify(c *conn, word string) {
	if c == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), writeWait)
	defer cancel()
	_ = c.ws.Write(ctx, websocket.MessageText, []byte(word)) // 실패해도 무시한다. 곧바로 연결이 닫힐 수 있다.
}

// Cloudflare가 넣어 주는 실제 접속 IP. 원래는 위조할 수 있는 헤더지만, relay는 터널로만
// 접속되므로(호스트에 공개 포트 없음) 믿을 수 있다. 잘못된 값이 맵 키로 쓰이지 않게
// IP로 파싱한다.
func clientIP(r *http.Request) string {
	if ip := net.ParseIP(r.Header.Get("CF-Connecting-IP")); ip != nil {
		return ip.String()
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// 복사 도중 어느 쪽에서 오류가 났는지 기억한다. 읽기 오류와 상대 쪽 쓰기 오류를
// 구분하지 못하면 정상인 쪽을 끊게 된다.
type watchRead struct {
	r   io.Reader
	err error
}

func (w *watchRead) Read(p []byte) (int, error) {
	n, err := w.r.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		w.err = err
	}
	return n, err
}

func serveWS(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("room")
	role := r.URL.Query().Get("role")
	if !roomID.MatchString(id) || (role != "pc" && role != "phone") {
		// 받은 값은 응답에도 로그에도 그대로 쓰지 않는다. 반사 공격과 로그 주입을 막기 위해서다.
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ip := clientIP(r)
	if !admit(ip) {
		http.Error(w, "busy", http.StatusServiceUnavailable)
		return
	}
	defer release(ip)

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin은 검사하지 않는다. 비밀은 방 ID 하나뿐이고, 방 ID를 가진 쪽은 브라우저가
		// 아니어도 접속할 수 있으므로 Origin 검사로는 막을 수 있는 것이 없다.
		OriginPatterns: []string{"*"},
		// 암호문은 압축되지 않는다. permessage-deflate는 연결마다 수백 KB의 메모리와
		// CPU를 쓰면서 줄여 주는 것이 없다.
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(maxMessage)

	me := &conn{ws: ws, role: role}
	short := id[:6] // 로그에는 방 ID 앞 6자리(128비트 중 24비트)만 남긴다.
	log.Printf("conn room=%s role=%s", short, role)

	peer, evicted := seat(id, me)
	if evicted != nil {
		// 밀려난 소켓이 응답하지 않으면 Close는 close handshake를 5초 기다린다. 새로 들어온
		// 쪽이 그동안 멈추지 않게 따로 닫는다. 단, 밀려난 소켓이 상대에게 메시지를 보내던
		// 중이었다면 그 메시지가 끊길 때까지는 상대에게 peer-joined를 보내지 못한다.
		go evicted.ws.Close(4000, "replaced")
	}
	if peer != nil {
		// 새로 들어온 쪽에 먼저 보낸다. 상대 쪽 쓰기는 밀려난 소켓이 보내던 메시지 때문에
		// 막힐 수 있고, 그사이 상대가 끊기면 peer-left가 peer-joined보다 먼저 갈 수 있다.
		// 상대가 새 쪽의 데이터를 peer-joined보다 먼저 받는 일은 없다. 새 쪽의 메시지는 이
		// 핸들러가 아래 루프에서 읽기 시작해야 전달된다.
		notify(me, "peer-joined")
		notify(peer, "peer-joined")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go keepalive(ctx, me)

	in, out := int64(0), int64(0)
	code, why := websocket.StatusNormalClosure, "bye"
	buf := make([]byte, copyBuffer)
	for {
		typ, rd, err := ws.Reader(context.Background())
		if err != nil {
			code, why = websocket.CloseStatus(err), "read"
			break
		}
		if typ != websocket.MessageBinary {
			// 바이너리만 허용한다. 조용히 버리면 클라이언트 쪽 실수를 통합 테스트 전까지 알 수 없다.
			code, why = websocket.StatusUnsupportedData, "binary only"
			break
		}
		to := partner(id, me)
		if to == nil {
			n, _ := io.Copy(io.Discard, rd) // 받을 상대가 없으면 저장하지 않고 버린다.
			in += n
			continue
		}
		src := &watchRead{r: rd}
		wctx, wcancel := context.WithTimeout(context.Background(), writeWait)
		n, cerr := relay(wctx, to, src, buf)
		wcancel()
		in += n
		if cerr == nil {
			out += n
			continue
		}
		// 메시지를 보내다 말았다. 이쪽에서 읽다가 끊겼든 상대에게 쓰다가 실패했든, 상대 소켓에는
		// 끝나지 않은 메시지가 열린 채 남아 peer-left도 그 뒤의 메시지도 쓸 수 없다. 끝을 붙여
		// 정상 종료하면 상대는 형식은 맞지만 잘린 암호문을 받고, 복호화 실패를 자기 쪽 버그로
		// 오해한다. 그래서 상대 연결을 바로 끊는다. 상대가 이미 닫히는 중이면 CloseNow는 그
		// close가 끝날 때까지 기다리므로 따로 닫는다.
		go to.ws.CloseNow()
		if src.err == nil {
			// 상대 쪽이 실패했다. 보내는 쪽 메시지의 나머지를 읽어 버려야 다음 메시지를 읽을 수
			// 있다. 그대로 두면 남은 암호문을 다음 프레임의 머리로 읽어 멀쩡한 보내는 쪽을 끊는다.
			n, _ = io.Copy(io.Discard, src)
			in += n
		}
		if src.err != nil {
			code, why = websocket.CloseStatus(src.err), "read"
			break
		}
	}
	if left := leave(id, me); left != nil {
		notify(left, "peer-left")
	}
	_ = ws.Close(sendable(code), why)
	// 처리방침에 적은 항목만 남긴다. 이유 단어(why)는 close code로 구분되므로 상대에게만 보낸다.
	log.Printf("gone room=%s role=%s in=%d out=%d code=%d", short, role, in, out, code)
}

// 1005(코드 없음), 1006(비정상 종료), -1(close가 아닌 오류)은 RFC 6455가 close 프레임에
// 넣지 못하게 정한 값이다. 로그에는 원래 값을 남기고, 상대에게 보낼 때만 1000으로 바꾼다.
func sendable(code websocket.StatusCode) websocket.StatusCode {
	switch code {
	case websocket.StatusNoStatusRcvd, websocket.StatusAbnormalClosure, -1:
		return websocket.StatusNormalClosure
	}
	return code
}

// relay는 메시지 하나를 상대에게 그대로 흘려 보낸다. 통째로 메모리에 올리지 않으므로
// 1MiB 메시지도 copyBuffer(32KiB)만큼만 쓴다. 상대가 느리면 복사가 멈추고, TCP를 통해
// 보내는 쪽도 함께 느려진다. 큐 없이 생기는 역압(backpressure)이다.
func relay(ctx context.Context, to *conn, src io.Reader, buf []byte) (int64, error) {
	wc, err := to.ws.Writer(ctx, websocket.MessageBinary)
	if err != nil {
		return 0, err
	}
	n, err := io.CopyBuffer(wc, src, buf)
	if err != nil {
		return n, err
	}
	return n, wc.Close()
}

// keepalive는 응답 없는 소켓을 정리한다. Ping은 pong이 올 때까지 기다리며,
// pong은 serveWS의 Reader가 읽는다.
//
// 상대가 없다는 이유로는 끊지 않는다. 방 ID는 계속 쓰이고 폰은 백그라운드로 갈 때마다
// 연결을 끊으므로, PC가 상대 없이 몇 시간씩 기다리는 것이 정상이다. relay는 상대가 잠시
// 없는 방과 쓰이지 않는 방을 구분할 수 없다. 자리만 차지하는 연결은 IP당·전체 연결 수
// 한도로 막는다.
func keepalive(ctx context.Context, c *conn) {
	t := time.NewTicker(pingEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, pongWait)
			err := c.ws.Ping(pctx)
			cancel()
			if err != nil {
				_ = c.ws.Close(4001, "no pong")
				return
			}
		}
	}
}

// dailyLog는 기록을 UTC 날짜별 파일(relay-YYYY-MM-DD.log)에 쓴다. 날짜별로 나눠 두어야
// 오래된 기록을 파일째 지울 수 있다. 하루에 logPerDay까지만 쓰고, 넘으면 안내 한 줄만 남긴다.
// log.Logger가 Write를 한 번에 하나씩 부르므로 잠금은 없다.
type dailyLog struct {
	dir, day string
	f        *os.File
	n        int64 // 오늘 파일의 크기
}

func (d *dailyLog) Write(p []byte) (int, error) {
	if day := time.Now().UTC().Format(time.DateOnly); day != d.day {
		f, err := os.OpenFile(filepath.Join(d.dir, "relay-"+day+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return 0, err
		}
		if d.f != nil {
			_ = d.f.Close()
		}
		d.f, d.day, d.n = f, day, 0
		if st, err := f.Stat(); err == nil {
			d.n = st.Size() // 하루 중간에 다시 시작해도 상한은 하루 기준이다.
		}
	}
	if d.n += int64(len(p)); d.n > logPerDay {
		if d.n-int64(len(p)) <= logPerDay {
			_, _ = d.f.WriteString(time.Now().UTC().Format("2006/01/02 15:04:05") + " log cap reached\n")
		}
		return len(p), nil
	}
	return d.f.Write(p)
}

// prune은 보관 기간이 지난 기록 파일을 지운다. 파일 하나에는 그날 0시(UTC)부터의 기록이
// 들어 있으므로, 그 0시가 keepLogs보다 오래된 파일을 통째로 지운다. 1분마다 부르므로 기록은
// 14일이 지나고 1분 안에 사라진다.
func prune(dir string, now time.Time) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if day, err := time.Parse("relay-2006-01-02.log", e.Name()); err == nil && now.Sub(day) > keepLogs {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	// LOG_DIR이 있으면(compose.yaml) 기록을 날짜별 파일에 쓰고 14일이 지나면 지운다. Docker
	// 로그는 용량으로만 돌아서 기간 상한을 둘 수 없다. 없으면(테스트·로컬 실행) 표준 에러로 쓴다.
	if dir := os.Getenv("LOG_DIR"); dir != "" {
		out := &dailyLog{dir: dir}
		if _, err := out.Write(nil); err != nil {
			log.Fatal(err) // 기록 파일을 열 수 없으면 기록을 잃는 채로 돌지 않는다.
		}
		log.SetOutput(out)
		go func() {
			for {
				prune(dir, time.Now())
				time.Sleep(time.Minute)
			}
		}()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		// 인터넷에 공개되는 경로이므로 연결 수 같은 정보는 내보내지 않는다.
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /ws", serveWS)

	server := &http.Server{
		Addr:              ":8787",
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second, // slowloris
		MaxHeaderBytes:    8 << 10,
		// ReadTimeout/WriteTimeout은 일부러 설정하지 않는다. 설정하면 오래 유지되어야 하는
		// WebSocket이 그 시간에 끊긴다.
	}
	log.Printf("relay listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
