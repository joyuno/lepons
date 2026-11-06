package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func reset() {
	mu.Lock()
	defer mu.Unlock()
	rooms = map[string]*room{}
	perIP = map[string]int{}
	conns = 0
}

const id = "0123456789abcdef0123456789abcdef"

func TestPairing(t *testing.T) {
	reset()
	pc := &conn{role: "pc"}
	phone := &conn{role: "phone"}

	if peer, evicted := seat(id, pc); peer != nil || evicted != nil {
		t.Fatalf("처음 들어온 연결에는 상대도 밀려난 소켓도 없어야 한다: peer=%v evicted=%v", peer, evicted)
	}
	if peer, evicted := seat(id, phone); peer != pc || evicted != nil {
		t.Fatalf("폰의 상대는 PC여야 한다: peer=%v evicted=%v", peer, evicted)
	}
	if partner(id, pc) != phone || partner(id, phone) != pc {
		t.Fatal("PC와 폰이 서로를 상대로 찾아야 한다")
	}
	if left := leave(id, phone); left != pc {
		t.Fatalf("폰이 나가면 PC가 peer-left를 받아야 한다: %v", left)
	}
	if partner(id, pc) != nil {
		t.Fatal("나간 폰이 아직 PC의 상대로 남아 있다")
	}
	if leave(id, pc); len(rooms) != 0 {
		t.Fatalf("마지막 연결이 나가면 방이 지워져야 한다: %d개 남음", len(rooms))
	}
}

// 같은 역할로 새로 들어온 쪽이 이기고, 밀려난 소켓이 뒤늦게 정리되면서 새 소켓을
// 지우지 않는지 확인한다. 이게 깨지면 연결된 두 소켓이 서로를 찾지 못해 통신이
// 영영 멈춘다.
func TestNewcomerEvictsAndZombieCannotClearIt(t *testing.T) {
	reset()
	old := &conn{role: "pc"}
	phone := &conn{role: "phone"}
	seat(id, old)
	seat(id, phone)

	fresh := &conn{role: "pc"}
	peer, evicted := seat(id, fresh)
	if evicted != old {
		t.Fatalf("먼저 있던 PC가 밀려나야 한다: %v", evicted)
	}
	if peer != phone {
		t.Fatalf("새 PC의 상대는 폰이어야 한다: %v", peer)
	}

	if left := leave(id, old); left != nil {
		t.Fatalf("밀려난 소켓이 정리될 때는 peer-left를 보내면 안 된다: %v", left)
	}
	if partner(id, phone) != fresh {
		t.Fatalf("폰의 상대는 새 PC여야 한다: %v", partner(id, phone))
	}
	if partner(id, fresh) != phone {
		t.Fatal("새 PC의 상대는 폰이어야 한다")
	}
	if partner(id, old) != nil {
		t.Fatal("밀려난 PC가 보내는 메시지가 폰에게 가면 안 된다")
	}
}

func TestCaps(t *testing.T) {
	reset()
	for i := 0; i < maxPerIP; i++ {
		if !admit("1.2.3.4") {
			t.Fatalf("IP당 한도 안인데 %d번째 연결이 거절됐다", i+1)
		}
	}
	if admit("1.2.3.4") {
		t.Fatal("IP당 한도를 넘었는데 받아들였다")
	}
	if !admit("5.6.7.8") {
		t.Fatal("다른 IP는 영향을 받지 않아야 한다")
	}

	release("5.6.7.8")
	if _, left := perIP["5.6.7.8"]; left {
		t.Fatalf("0이 된 IP는 맵에서 지워져야 한다: %v", perIP)
	}

	mu.Lock()
	conns = maxConns
	mu.Unlock()
	if admit("9.9.9.9") {
		t.Fatal("전체 한도를 넘었는데 받아들였다")
	}
}

func TestRoomIDShape(t *testing.T) {
	reset()
	bad := []string{"", "short", id + "0", "0123456789ABCDEF0123456789abcdef", "../../etc", id[:31] + "g"}
	for _, s := range bad {
		if roomID.MatchString(s) {
			t.Fatalf("통과하면 안 되는 방 ID: %q", s)
		}
	}
	if !roomID.MatchString(id) {
		t.Fatal("128비트 소문자 hex는 통과해야 한다")
	}
}

// serve는 실제 serveWS를 띄우고 그 방에 붙는 함수를 돌려준다. 끊김·교체처럼 소켓이
// 있어야 드러나는 문제를 확인할 때 쓴다. 테스트가 끝나면 핸들러가 모두 끝날 때까지
// 기다린다. 남은 핸들러가 다음 테스트의 연결 수를 건드리지 않게 하기 위해서다.
func serve(t *testing.T) func(role string) *websocket.Conn {
	reset()
	var wg sync.WaitGroup
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wg.Add(1)
		defer wg.Done()
		serveWS(w, r)
	}))
	t.Cleanup(func() { srv.Close(); wg.Wait() })
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?room=" + id + "&role="
	return func(role string) *websocket.Conn {
		c, _, err := websocket.Dial(context.Background(), url+role, nil)
		if err != nil {
			t.Fatal(err)
		}
		c.SetReadLimit(maxMessage) // 기본값 32KiB로는 relay가 허용하는 메시지를 받지 못한다.
		t.Cleanup(func() { c.CloseNow() })
		return c
	}
}

func read(t *testing.T, c *websocket.Conn) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, b, err := c.Read(ctx)
	return string(b), err
}

// 폰이 메시지를 보내다 끊기면(백그라운드 전환, LTE 끊김) PC도 바로 끊겨야 한다.
// 그대로 두면 PC 소켓에 끝나지 않는 메시지가 열린 채 남아, peer-left도 그 뒤의
// 메시지도 받지 못하는 소켓이 자리를 계속 차지한다.
func TestSenderDiesMidMessage(t *testing.T) {
	dial := serve(t)
	pc, phone := dial("pc"), dial("phone")
	read(t, pc)
	read(t, phone)

	w, err := phone.Writer(context.Background(), websocket.MessageBinary)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(make([]byte, 64<<10)); err != nil { // 메시지의 앞부분만 보낸다.
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond) // relay가 PC 쪽으로 쓰기 시작할 시간
	phone.CloseNow()

	// PC 연결이 끝나는지만 본다. 이 테스트의 Go 클라이언트는 프레임 경계에서 끊긴 메시지를
	// 끝난 메시지로 돌려주므로(coder/websocket read.go:447) 잘린 메시지를 하나 먼저 받을 수 있다.
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for err = nil; err == nil; {
		_, _, err = pc.Read(ctx)
	}
	if ctx.Err() != nil || time.Since(start) > time.Second {
		t.Fatalf("PC가 1초 안에 끊겨야 한다: %v, %.1f초", err, time.Since(start).Seconds())
	}
}

// 응답하지 않는 소켓을 밀어낼 때(와이파이에서 LTE로 바뀐 폰의 옛 소켓) 새로 들어온
// 쪽이 close handshake를 기다리느라 멈추면 안 된다. 밀려난 쪽은 그래도 4000을 받아야 한다.
func TestEvictionDoesNotStall(t *testing.T) {
	dial := serve(t)
	old := dial("pc") // 읽지 않으므로 close 프레임에 답하지 못한다.
	phone := dial("phone")
	read(t, phone)

	start := time.Now()
	dial("pc")
	if word, err := read(t, phone); word != "peer-joined" || time.Since(start) > time.Second {
		t.Fatalf("새 PC가 1초 안에 연결돼야 한다: %q %v, %.1f초", word, err, time.Since(start).Seconds())
	}

	read(t, old) // 먼저 받아 둔 peer-joined
	if _, err := read(t, old); websocket.CloseStatus(err) != 4000 {
		t.Fatalf("밀려난 PC는 4000을 받아야 한다: %v", err)
	}
}

// 받는 쪽이 메시지 도중 실패해도 보내는 쪽은 살아 있어야 한다. 남은 메시지를 읽어 버리지
// 않으면 relay가 다음 메시지를 제대로 읽지 못해 멀쩡한 보내는 쪽을 끊는다.
func TestSenderSurvivesReceiverDrop(t *testing.T) {
	dial := serve(t)
	pc, phone := dial("pc"), dial("phone")
	read(t, pc)
	read(t, phone)

	w, err := phone.Writer(context.Background(), websocket.MessageBinary)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(make([]byte, 64<<10)); err != nil {
		t.Fatal(err)
	}
	// 메시지 도중에 PC를 교체한다. 옛 PC에는 close 프레임이 나가므로 relay가 그쪽으로
	// 쓰는 다음 프레임은 실패한다(coder/websocket write.go:310).
	pc2 := dial("pc")
	read(t, pc2)
	read(t, phone)
	time.Sleep(100 * time.Millisecond) // 옛 PC에 close 프레임이 나갈 시간
	if _, err := w.Write(make([]byte, 64<<10)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	if err := phone.Write(context.Background(), websocket.MessageBinary, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if got, err := read(t, pc2); got != "x" {
		t.Fatalf("폰은 끊기지 않고 새 PC에게 메시지를 보내야 한다: %q %v", got, err)
	}
}

// 밀려난 소켓이 보내던 메시지 때문에 상대 쪽 쓰기가 막혀도, 새로 들어온 쪽은 바로
// peer-joined를 받아야 한다. 늦게 받으면 그사이 상대가 끊겨 peer-left가 먼저 갈 수 있다.
func TestEvictedSenderDoesNotDelayPeerJoined(t *testing.T) {
	dial := serve(t)
	pc, old := dial("pc"), dial("phone")
	read(t, pc)
	read(t, old)

	// 끝나지 않은 메시지를 보낸 채 아무것도 읽지 않는다. close 프레임에도 답하지 못한다.
	w, err := old.Writer(context.Background(), websocket.MessageBinary)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(make([]byte, 40<<10)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond) // relay가 PC 쪽으로 쓰기 시작할 시간

	start := time.Now()
	if word, err := read(t, dial("phone")); word != "peer-joined" || time.Since(start) > time.Second {
		t.Fatalf("새 폰이 1초 안에 peer-joined를 받아야 한다: %q %v, %.1f초", word, err, time.Since(start).Seconds())
	}
}

// 기록은 14일이 지나면 파일째 지워야 한다(개인정보 처리방침). 파일 하나는 그날 0시(UTC)부터의
// 기록이므로, 그 0시가 14일보다 오래된 파일만 지운다. 다른 파일은 건드리지 않는다.
func TestPruneDropsLogsOlderThan14Days(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"relay-2026-10-17.log", "relay-2026-10-18.log", "relay-2026-10-19.log", "relay-2026-11-01.log", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	prune(dir, time.Date(2026, 11, 1, 0, 0, 30, 0, time.UTC)) // 10-18 0시는 14일 30초 전

	var left []string
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		left = append(left, e.Name())
	}
	if got, want := strings.Join(left, " "), "notes.txt relay-2026-10-19.log relay-2026-11-01.log"; got != want {
		t.Fatalf("남은 파일: %s, 기대: %s", got, want)
	}
}

func TestDailyLogWritesTodaysFile(t *testing.T) {
	dir := t.TempDir()
	out := &dailyLog{dir: dir}
	if _, err := out.Write([]byte("gone room=012345\n")); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "relay-"+time.Now().UTC().Format(time.DateOnly)+".log"))
	if err != nil || string(b) != "gone room=012345\n" {
		t.Fatalf("오늘 날짜 파일에 써야 한다: %q %v", b, err)
	}
}

// 연결을 열고 닫기만 반복하는 쪽이 있어도 기록이 디스크를 채우면 안 된다. 하루 상한에
// 닿으면 안내 한 줄만 남기고 그날 나머지는 버린다.
func TestDailyLogStopsAtDailyCap(t *testing.T) {
	dir := t.TempDir()
	out := &dailyLog{dir: dir}
	if _, err := out.Write(nil); err != nil {
		t.Fatal(err)
	}
	out.n = logPerDay - 2
	for _, line := range []string{"a\n", "b\n", "c\n"} {
		if n, err := out.Write([]byte(line)); n != len(line) || err != nil {
			t.Fatalf("버린 줄도 쓴 것처럼 돌려줘야 log가 멈추지 않는다: %d %v", n, err)
		}
	}
	b, _ := os.ReadFile(filepath.Join(dir, "relay-"+time.Now().UTC().Format(time.DateOnly)+".log"))
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 2 || lines[0] != "a" || !strings.HasSuffix(lines[1], "log cap reached") {
		t.Fatalf("상한까지 쓰고 안내 한 줄만 남아야 한다: %q", lines)
	}
}
