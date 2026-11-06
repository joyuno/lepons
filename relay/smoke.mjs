// relay 실전 점검. 실제로 떠 있는 서버에 WebSocket으로 붙어서
// 페어링 / 전달 / 교체 / peer-left / 한도를 하나씩 확인한다.
//
//   node smoke.mjs                             로컬 (docker run -p 127.0.0.1:8788:8787)
//   node smoke.mjs https://relay.lepons.app    공개 경로 (Cloudflare 터널까지)
const BASE = process.argv[2] ?? "http://127.0.0.1:8788";
const WS = BASE.replace(/^http/, "ws");
const ROOM = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

// 루프백은 즉시 오지만 Cloudflare를 거치면 왕복이 ~1초다. 대기 시간을 경로에
// 맞추지 않으면 정상인 서버도 실패로 나온다(실제로 한 번 오판했다).
const FAR = !BASE.includes("127.0.0.1") && !BASE.includes("localhost");
const SLOW = FAR ? 6 : 1;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const open = (room, role) => new Promise((res, rej) => {
  const ws = new WebSocket(`${WS}/ws?room=${room}&role=${role}`);
  ws.binaryType = "arraybuffer";
  ws.events = [];
  ws.addEventListener("message", (e) => ws.events.push(e.data));
  ws.addEventListener("close", (e) => { ws.closed = { code: e.code, reason: e.reason }; });
  ws.addEventListener("open", () => res(ws));
  ws.addEventListener("error", () => rej(new Error(`연결 실패 ${role}`)));
});

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms * SLOW));
const texts = (ws) => ws.events.filter((d) => typeof d === "string");
const bins = (ws) => ws.events.filter((d) => d instanceof ArrayBuffer).map((b) => Buffer.from(b));

console.log("1. /health와 잘못된 요청");
{
  const h = await fetch(`${BASE}/health`);
  ok("/health가 ok를 돌려준다", h.status === 200 && (await h.text()) === "ok");
  const bad = await fetch(`${BASE}/ws?room=nope&role=pc`);
  ok("형식이 틀린 방 ID는 400", bad.status === 400, `got ${bad.status}`);
  const badRole = await fetch(`${BASE}/ws?room=${ROOM}&role=laptop`);
  ok("없는 role은 400", badRole.status === 400, `got ${badRole.status}`);
  const upper = await fetch(`${BASE}/ws?room=${ROOM.toUpperCase()}&role=pc`);
  ok("대문자 hex는 400(소문자 128비트만 허용)", upper.status === 400, `got ${upper.status}`);
}

console.log("2. 페어링과 전달");
const pc = await open(ROOM, "pc");
await settle();
ok("혼자 있을 때는 제어 메시지가 오지 않는다", pc.events.length === 0, JSON.stringify(pc.events));
const phone = await open(ROOM, "phone");
await settle();
ok("PC가 peer-joined를 받는다", texts(pc).includes("peer-joined"), JSON.stringify(texts(pc)));
ok("폰도 peer-joined를 받는다", texts(phone).includes("peer-joined"), JSON.stringify(texts(phone)));

{
  const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
  pc.send(payload);
  await settle();
  const got = bins(phone);
  ok("바이너리가 그대로 전달된다", got.length === 1 && got[0].equals(payload), JSON.stringify(got));
  const back = Buffer.from("테스트용 바이트", "utf8");
  phone.send(back);
  await settle();
  const got2 = bins(pc);
  ok("반대 방향도 그대로 전달된다", got2.length === 1 && got2[0].equals(back));
}

console.log("3. 큰 메시지(1MiB 경계)");
{
  const big = Buffer.alloc(1024 * 1024, 7);          // 정확히 1MiB: 통과해야 한다
  pc.send(big);
  await settle(1200);
  const got = bins(phone).at(-1);
  ok("1MiB는 통과하고 내용이 같다", got?.length === big.length && got.equals(big), `len=${got?.length}`);
}

console.log("4. 같은 역할로 새 PC가 들어오면 먼저 있던 쪽이 밀려난다");
const pc2 = await open(ROOM, "pc");
await settle();
ok("먼저 있던 PC가 4000 replaced로 닫힌다", pc.closed?.code === 4000 && pc.closed?.reason === "replaced", JSON.stringify(pc.closed));
ok("폰은 새 PC의 peer-joined를 받는다", texts(phone).filter((t) => t === "peer-joined").length === 2, JSON.stringify(texts(phone)));
{
  const after = Buffer.from("새 PC가 보낸 것");
  pc2.send(after);
  await settle();
  ok("새 PC의 메시지가 폰에 도착한다", bins(phone).at(-1)?.equals(after) === true);
  ok("밀려난 소켓이 폰의 자리를 지우지 않았다", phone.closed === undefined, JSON.stringify(phone.closed));
}

console.log("5. 한쪽이 끊기면 상대에게 peer-left");
phone.close();
await settle();
ok("새 PC가 peer-left를 받는다", texts(pc2).includes("peer-left"), JSON.stringify(texts(pc2)));

console.log("6. 계약 위반과 한도");
{
  const t = await open("f".repeat(32), "pc");
  t.send("텍스트 프레임은 허용되지 않는다");
  await settle();
  ok("텍스트 프레임은 1003으로 끊는다", t.closed?.code === 1003, JSON.stringify(t.closed));

  const o = await open("e".repeat(32), "pc");
  o.send(Buffer.alloc(1024 * 1024 + 1, 1));
  await settle(800);
  ok("1MiB를 넘기면 1009로 끊는다", o.closed?.code === 1009, JSON.stringify(o.closed));

  // 앞에서 연 연결을 모두 닫은 뒤에 센다. 남은 소켓이 있으면 한도를 미리 차지한다.
  pc2.close();
  await settle(500);

  const held = [];
  for (let i = 0; i < 6; i++) held.push(await open(String(i).repeat(32), "pc"));
  await settle();
  ok("같은 IP에서 6개까지는 연결된다", held.every((w) => w.readyState === 1 && !w.closed));
  const over = await fetch(`${BASE}/ws?room=${"7".repeat(32)}&role=pc`);
  ok("7번째는 503으로 거절된다", over.status === 503, `got ${over.status}`);
  held.forEach((w) => w.close());
  await settle(500);
  const again = await fetch(`${BASE}/ws?room=${"7".repeat(32)}&role=pc`);
  ok("연결을 닫으면 자리가 다시 생긴다(503이 풀린다)", again.status === 400 || again.status === 426 || again.status === 101, `got ${again.status}`);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail === 0 ? 0 : 1);
