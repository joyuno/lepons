import { inputFor } from "./phone/copied.ts";
import type { CommandSuggestion, Mood, PcAccounts, PcState, PhoneSubagent, PhoneSummary, StepKind, WorkflowItem } from "./phone/types.ts";
import type { PhoneEvents, PhoneFailure, PhoneRoute, ReplyOf, Unproven } from "../../cockpit/src/phone/contract.ts";
import { fmt, locale } from "./i18n.ts";

/** A file to open from the demo's files tab: enough lines to show the code viewer. */
const demoCart = `import { discountFor } from "./discount";

/* One line of the cart: what, how many, at what price. */
export interface CartLine {
  sku: string;
  quantity: number;
  unitPrice: number; // in won
}

export function total(lines: CartLine[], memberSince?: Date): number {
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  if (subtotal === 0) return 0;
  const rate = discountFor(subtotal, memberSince);
  return Math.round(subtotal * (1 - rate));
}

export const emptyCart: CartLine[] = [];
`;
import type { Reply } from "./relay/client.ts";

/** What the pretend PC says, in the app's language: a store shot in English shows no Korean. */
const words = {
  ko: {
    pc: "데모 PC", laptop: "데모 노트북",
    cartAsk: "장바구니 합계가 할인 전 금액으로 나와요. 고쳐 줄래요?",
    cartFound: "원인을 찾았어요. `total()`이 **할인을 빼기 전에** 반올림해요.\n\n- `src/cart.ts`의 계산 순서를 바꿀게요\n- 테스트도 하나 더할게요",
    cartFixing: "장바구니 합계에서 할인이 빠지는 걸 고칠게요.",
    shopReadme: "# shop-web\n\n데모 가게의 웹 화면이에요.\n\n## 실행\n\n```\nnpm install\nnpm run dev\n```\n",
    shopPlan: "# 이번 주 할 일\n\n1. 장바구니 할인 고치기\n2. 결제 화면 문구 다듬기\n",
    ordersAsk: "주문 API에 페이지 나누기를 붙여 줘요",
    apiDocs: "API 문서 형식 확인", apiDocsAsk: "docs/api.md의 응답 형식을 정리해 줘요", apiDocsResult: "cursor와 limit을 쓰고 있어요",
    tests: "기존 테스트 훑어보기", testsAsk: "주문 테스트가 무엇을 확인하는지 정리해 줘요",
    pageSize: "페이지 크기 기본값 조사", pageSizeAsk: "다른 API는 한 번에 몇 개씩 주는지 찾아 줘요",
    apiReadme: "# api-server\n\n주문과 회원 API예요.\n",
    membersAsk: "회원 목록 API가 느려요. 왜 그런지 보고 줄여 줘요",
    membersDone: "응답이 90ms로 줄었어요.",
    membersNote: "N+1 쿼리를 한 번으로 묶었어요. 응답이 340ms에서 90ms로 줄었어요.",
    readmeAsk: "README의 설치 순서를 최신으로 맞춰 줘요",
    readmeDone: "README를 고쳤어요.",
    readmeNote: "README를 고쳤어요. 설치가 세 단계로 줄었어요.",
    loginTask: "로그인 수정", loginAsk: "로그인 실패 문구를 알아듣기 쉽게 바꿔 줘요", loginDone: "로그인 실패 문구를 바꿨어요.",
    docsReadme: "# docs-site\n\n설치는 세 단계예요.\n",
    flickerAsk: "설정 화면으로 넘어갈 때 깜빡이는 걸 없애 줘요",
    flicker: "전환 애니메이션 조사", flickerSubAsk: "깜빡임의 원인을 찾아 줘요", flickerResult: "배경색이 늦게 칠해져요",
    flickerDone: "화면 전환을 다듬었어요.",
    tokensAsk: "디자인 토큰 이름을 한 가지 규칙으로 맞춰 줘요",
    tokensDone: "색 이름을 정리했어요.",
    shellDemo: "(데모: 명령은 실행되지 않아요)",
    tokensNote: "색 이름 열두 개를 ink·card·line 규칙으로 바꿨어요. 옛 이름은 표로 남겼어요.",
    tokensDoc: "# 색 이름\n\n- ink, card, line\n",
    compact: "대화를 요약해서 짧게 줄여요", review: "바뀐 코드를 검토해요", clear: "대화를 새로 시작해요",
    working: "✻ 작업 중…",
    stopped: "멈췄어요. 다음에 할 일을 알려 주세요.",
    menuNo: "알겠어요. 어떻게 고칠지 알려 주세요.",
    menuYes: "고쳤어요. 이제 합계에 할인이 먼저 빠져요.",
    echo: "데모라서 실제로 바뀐 건 없어요. 받은 말: \"{text}\"",
  },
  en: {
    pc: "Demo PC", laptop: "Demo laptop",
    cartAsk: "The cart total shows the price before the discount. Can you fix it?",
    cartFound: "Found it. `total()` rounds **before taking off the discount**.\n\n- I'll reorder the math in `src/cart.ts`\n- and add one more test",
    cartFixing: "I'll fix the cart total dropping the discount.",
    shopReadme: "# shop-web\n\nThe demo shop's web front.\n\n## Run\n\n```\nnpm install\nnpm run dev\n```\n",
    shopPlan: "# This week\n\n1. Fix the cart discount\n2. Polish the checkout wording\n",
    ordersAsk: "Add pagination to the orders API",
    apiDocs: "Check the API docs' format", apiDocsAsk: "Sum up the response format in docs/api.md", apiDocsResult: "It uses cursor and limit",
    tests: "Skim the existing tests", testsAsk: "Sum up what the order tests check",
    pageSize: "Look up the default page size", pageSizeAsk: "Find how many items the other APIs return at once",
    apiReadme: "# api-server\n\nOrders and members API.\n",
    membersAsk: "The members list API is slow. Find out why and speed it up",
    membersDone: "Response time is down to 90ms.",
    membersNote: "Folded the N+1 queries into one. Responses went from 340ms to 90ms.",
    readmeAsk: "Bring the README's install steps up to date",
    readmeDone: "Updated the README.",
    readmeNote: "Updated the README. Install is down to three steps.",
    loginTask: "Fix login", loginAsk: "Make the login error message plainer", loginDone: "Changed the login error message.",
    docsReadme: "# docs-site\n\nInstall takes three steps.\n",
    flickerAsk: "Stop the flicker when going to the settings screen",
    flicker: "Look into the transition animation", flickerSubAsk: "Find what causes the flicker", flickerResult: "The background color is painted late",
    flickerDone: "Smoothed the screen transition.",
    tokensAsk: "Name the design tokens by one rule",
    tokensDone: "Tidied up the color names.",
    shellDemo: "(demo: commands are not run)",
    tokensNote: "Renamed twelve colors to the ink·card·line rule. The old names are kept in a table.",
    tokensDoc: "# Color names\n\n- ink, card, line\n",
    compact: "Summarize the conversation to shorten it", review: "Review the changed code", clear: "Start the conversation over",
    working: "✻ Working…",
    stopped: "Stopped. Tell me what to do next.",
    menuNo: "OK. Tell me how you'd like it fixed.",
    menuYes: "Fixed. The cart total now takes the discount off first.",
    echo: "This is a demo, so nothing actually changed. You said: \"{text}\"",
  },
  zh: {
    pc: "演示电脑", laptop: "演示笔记本",
    cartAsk: "购物车合计显示的是打折前的金额。能修一下吗？",
    cartFound: "找到原因了。`total()` **在减去折扣之前**就做了四舍五入。\n\n- 我会调整 `src/cart.ts` 的计算顺序\n- 再加一个测试",
    cartFixing: "我来修复购物车合计漏掉折扣的问题。",
    shopReadme: "# shop-web\n\n演示商店的网页前端。\n\n## 运行\n\n```\nnpm install\nnpm run dev\n```\n",
    shopPlan: "# 本周待办\n\n1. 修复购物车折扣\n2. 润色结账页面文案\n",
    ordersAsk: "给订单 API 加上分页",
    apiDocs: "确认 API 文档格式", apiDocsAsk: "整理 docs/api.md 里的响应格式", apiDocsResult: "用的是 cursor 和 limit",
    tests: "浏览现有测试", testsAsk: "整理订单测试都检查了什么",
    pageSize: "调查默认分页大小", pageSizeAsk: "查一下其他 API 每次返回多少条",
    apiReadme: "# api-server\n\n订单和会员 API。\n",
    membersAsk: "会员列表 API 很慢。看看原因并加快它",
    membersDone: "响应缩短到了 90ms。",
    membersNote: "把 N+1 查询合并成了一次。响应从 340ms 缩短到 90ms。",
    readmeAsk: "把 README 的安装步骤更新到最新",
    readmeDone: "README 已更新。",
    readmeNote: "README 已更新。安装缩减为三步。",
    loginTask: "修复登录", loginAsk: "把登录失败的提示改得更好懂", loginDone: "已修改登录失败的提示。",
    docsReadme: "# docs-site\n\n安装只需三步。\n",
    flickerAsk: "去掉进入设置页面时的闪烁",
    flicker: "调查切换动画", flickerSubAsk: "找出闪烁的原因", flickerResult: "背景色绘制得太晚",
    flickerDone: "页面切换更顺滑了。",
    tokensAsk: "按同一规则命名设计令牌",
    tokensDone: "整理好了颜色名称。",
    shellDemo: "（演示：不会执行命令）",
    tokensNote: "把十二个颜色改成 ink·card·line 规则。旧名称留在表格里。",
    tokensDoc: "# 颜色名称\n\n- ink, card, line\n",
    compact: "总结对话以缩短它", review: "审查改动的代码", clear: "重新开始对话",
    working: "✻ 正在处理…",
    stopped: "已停止。告诉我下一步做什么。",
    menuNo: "好的。告诉我想怎么修。",
    menuYes: "修好了。现在合计会先减去折扣。",
    echo: "这是演示，实际上什么都没改。收到的话：\"{text}\"",
  },
}[locale];

/**
 * 데모: a pretend PC inside the app, for store reviewers and the curious. It
 * answers the same routes with the same shapes and the same refusals as the
 * real phone API, so every screen runs against it -- and nothing leaves the
 * phone. Nothing it says is real, and the UI labels it 데모 throughout.
 */

interface DemoSession {
  id: string;
  /** Which pretend PC it is on; the first unless named. */
  pc?: string;
  folder: string;
  mood: Mood;
  agent: boolean;
  preview: string;
  screen: string;
  events: WorkflowItem[];
  docs: Record<string, string>;
  pane?: { n: number; tab: number; shown: boolean };
  /** What the PC's forPhone() would say of its record, written out: the map and the sheet show it. */
  summary?: PhoneSummary;
  subagents?: PhoneSubagent[];
  /** A worktree's: its original folder; its folder is the task's name. */
  worktreeOf?: string;
}

const progress = (since: number, files: string[], reads: number, commands: number, subagents = 0, running = 0): NonNullable<PhoneSummary["progress"]> =>
  ({ files: files.length, fileNames: files.slice(0, 3), reads, commands, subagents, running, since });

const menuScreen =
  `● ${words.cartFixing}\r\n\r\n` +
  " Do you want to make this edit to cart.ts?\r\n" +
  " ❯ 1. Yes\r\n" +
  "   2. Yes, and don't ask again this session\r\n" +
  "   3. No, and tell Claude what to do differently (esc)\r\n";

function seed(): DemoSession[] {
  // One clock for the whole seed, so a record and its written-out summary say the same times.
  const start = Date.now();
  const minutes = (n: number) => start - n * 60_000;
  return [
    {
      id: "de00000000000001", folder: "shop-web", mood: "waiting", agent: true, pane: { n: 1, tab: 0, shown: true },
      preview: "Do you want to make this edit to cart.ts?", screen: menuScreen,
      events: [
        { kind: "prompt", at: minutes(14), text: words.cartAsk },
        { kind: "action", at: minutes(13), text: "Read src/cart.ts", labels: ["Read src/cart.ts", "Grep discount", "Read src/discount.ts"] },
        { kind: "note", at: minutes(12), text: words.cartFound },
        { kind: "action", at: minutes(11), text: "Edit src/cart.ts", labels: ["Edit src/cart.ts"] },
      ],
      summary: {
        goal: words.cartAsk,
        now: { at: minutes(11), kind: "action", text: "Edit cart.ts" },
        progress: progress(minutes(14), ["cart.ts"], 2, 0),
      },
      docs: {
        "README.md": words.shopReadme,
        "docs/plan.md": words.shopPlan,
      },
    },
    {
      id: "de00000000000002", folder: "api-server", mood: "working", agent: true, pane: { n: 2, tab: 0, shown: false },
      preview: "✻ Running tests… (12s)", screen: "✻ Running tests… (12s · esc to interrupt)\r\n",
      events: [
        { kind: "prompt", at: minutes(6), text: words.ordersAsk },
        { kind: "action", at: minutes(5), text: "Edit src/orders.ts", labels: ["Edit src/orders.ts", "Write test/orders.test.ts", "Read src/db.ts", "Bash · npm test"] },
        { kind: "subagent", at: minutes(4), description: words.apiDocs, instructions: words.apiDocsAsk, result: words.apiDocsResult, resultAt: minutes(3) },
        { kind: "subagent", at: minutes(3), description: words.tests, instructions: words.testsAsk },
        { kind: "subagent", at: minutes(2), description: words.pageSize, instructions: words.pageSizeAsk },
        { kind: "action", at: minutes(1), text: "Bash · npm test", labels: ["Bash · npm test"] },
      ],
      summary: {
        goal: words.ordersAsk,
        now: { at: minutes(1), kind: "action", text: "Bash" },
        progress: progress(minutes(6), ["orders.ts", "orders.test.ts"], 1, 2, 3, 2),
      },
      subagents: [
        { label: words.tests, running: true, since: minutes(3) },
        { label: words.pageSize, running: true, since: minutes(2) },
        { label: words.apiDocs, running: false, since: minutes(4), doneAt: minutes(3), result: words.apiDocsResult },
      ],
      docs: { "README.md": words.apiReadme },
    },
    {
      id: "de00000000000008", folder: "api-server", mood: "done", agent: true, pane: { n: 3, tab: 0, shown: true },
      preview: words.membersDone, screen: `${words.membersDone}\r\n`,
      events: [
        { kind: "prompt", at: minutes(30), text: words.membersAsk },
        { kind: "action", at: minutes(28), text: "Read src/members.ts", labels: ["Read src/members.ts", "Read src/db.ts", "Edit src/members.ts", "Bash · npm run bench"] },
        { kind: "note", at: minutes(24), text: words.membersNote },
      ],
      summary: {
        goal: words.membersAsk,
        now: { at: minutes(24), kind: "note", text: words.membersNote },
        result: words.membersNote,
        progress: progress(minutes(30), ["members.ts"], 2, 1),
      },
      docs: {},
    },
    // A second AI in a worktree of shop-web: the sessions tab nests it, the map branches it.
    {
      id: "de00000000000009", folder: words.loginTask, worktreeOf: "shop-web", mood: "done", agent: true,
      preview: words.loginDone, screen: `${words.loginDone}
`,
      events: [
        { kind: "prompt", at: minutes(20), text: words.loginAsk },
        { kind: "action", at: minutes(19), text: "Edit src/login.ts", labels: ["Edit src/login.ts"] },
        { kind: "note", at: minutes(18), text: words.loginDone },
      ],
      summary: {
        goal: words.loginAsk,
        now: { at: minutes(18), kind: "note", text: words.loginDone },
        result: words.loginDone,
        progress: progress(minutes(20), ["login.ts"], 0, 0),
      },
      docs: {},
    },
    {
      id: "de00000000000003", folder: "docs-site", mood: "done", agent: true, pane: { n: 2, tab: 1, shown: true },
      preview: words.readmeDone, screen: `${words.readmeDone}\r\n`,
      events: [
        { kind: "prompt", at: minutes(42), text: words.readmeAsk },
        { kind: "action", at: minutes(41), text: "Edit README.md", labels: ["Edit README.md"] },
        { kind: "note", at: minutes(40), text: words.readmeNote },
      ],
      summary: {
        goal: words.readmeAsk,
        now: { at: minutes(40), kind: "note", text: words.readmeNote },
        result: words.readmeNote,
        progress: progress(minutes(42), ["README.md"], 0, 0),
      },
      docs: { "README.md": words.docsReadme },
    },
    {
      id: "de00000000000004", folder: "server-logs", mood: "idle", agent: false,
      preview: "$ tail -f app.log", screen: "$ tail -f app.log\r\n",
      events: [], docs: {},
    },
    // The laptop's, from earlier: there for the map's second PC.
    {
      id: "de00000000000005", pc: words.laptop, folder: "mobile-app", mood: "idle", agent: true,
      preview: words.flickerDone, screen: `${words.flickerDone}\r\n`,
      events: [
        { kind: "prompt", at: minutes(180), text: words.flickerAsk },
        { kind: "action", at: minutes(178), text: "Read src/app/settings.tsx", labels: ["Read src/app/settings.tsx"] },
        { kind: "subagent", at: minutes(176), description: words.flicker, instructions: words.flickerSubAsk, result: words.flickerResult, resultAt: minutes(172) },
        { kind: "action", at: minutes(170), text: "Edit src/app/_layout.tsx", labels: ["Edit src/app/_layout.tsx"] },
        { kind: "note", at: minutes(169), text: words.flickerDone },
      ],
      summary: {
        goal: words.flickerAsk,
        now: { at: minutes(169), kind: "note", text: words.flickerDone },
        result: words.flickerDone,
        progress: progress(minutes(180), ["_layout.tsx"], 1, 0, 1, 0),
      },
      subagents: [{ label: words.flicker, running: false, since: minutes(176), doneAt: minutes(172), result: words.flickerResult }],
      docs: {},
    },
    {
      id: "de00000000000006", pc: words.laptop, folder: "mobile-app", mood: "idle", agent: false,
      preview: "$ npm test", screen: "$ npm test\r\n", events: [], docs: {},
    },
    {
      id: "de00000000000007", pc: words.laptop, folder: "design-notes", mood: "done", agent: true,
      preview: words.tokensDone, screen: `${words.tokensDone}\r\n`,
      events: [
        { kind: "prompt", at: minutes(240), text: words.tokensAsk },
        { kind: "action", at: minutes(238), text: "Edit tokens.md", labels: ["Edit tokens.md"] },
        { kind: "note", at: minutes(236), text: words.tokensNote },
      ],
      summary: {
        goal: words.tokensAsk,
        now: { at: minutes(236), kind: "note", text: words.tokensNote },
        result: words.tokensNote,
        progress: progress(minutes(240), ["tokens.md"], 0, 0),
      },
      docs: { "tokens.md": words.tokensDoc },
    },
  ];
}

const commands: CommandSuggestion[] = [
  { name: "/compact", description: words.compact },
  { name: "/review", description: words.review },
  { name: "/clear", description: words.clear },
];

const accounts: PcAccounts = [
  { pc: words.pc, agents: [{ name: "Claude Code", state: "in" }, { name: "Codex", state: "in" }, { name: "Grok", state: "none" }, { name: "Antigravity", state: "out" }, { name: "Cursor", state: "none" }] },
  { pc: words.laptop, agents: [{ name: "Claude Code", state: "unknown" }, { name: "Codex", state: "unknown" }] },
];

/** Dollars per day, oldest first, at made-up amounts; 0 is a day with no record. Antigravity has none: the phone says 기록 없음. */
const spending: Array<[project: string, agent: ReplyOf<"GET /api/token-stats">["days"][number]["agent"], model: string, usd: number[]]> = [
  ["shop-web", "claude", "claude-opus-5-5", [2.4, 3.5, 2.6, 5.6, 8.4, 4.3, 3]],
  ["shop-web", "claude", "claude-sonnet-5-5", [0.8, 1.3, 1, 1.8, 2.9, 1.6, 1.1]],
  ["shop-web", "codex", "gpt-6.1-terra", [0, 0.9, 1.1, 0, 1.6, 0.8, 0.5]],
  ["api-server", "claude", "claude-opus-5-5", [1.4, 2.2, 1.9, 3.6, 6.2, 3, 2.7]],
  ["api-server", "claude", "claude-sonnet-5-5", [0.5, 1, 0.7, 1.3, 2, 1.2, 0.9]],
  ["api-server", "claude", "claude-haiku-5-5", [0.2, 0.2, 0.1, 0.3, 0.4, 0.2, 0.2]],
  ["docs-site", "codex", "gpt-6.1-sol", [0.4, 0, 0.7, 1.2, 0, 0.6, 0]],
  ["mobile-app", "grok", "grok-4.7", [0, 1.1, 0, 1.8, 1.5, 0, 0.7]],
  ["mobile-app", "grok", "grok-build-0.1", [0, 0.2, 0, 0.3, 0.3, 0, 0.2]],
];
const tokenStats = () => {
  const now = new Date();
  const dayOf = (back: number) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  };
  return {
    today: dayOf(0),
    projects: [...new Set(spending.map(([project]) => project))].map((label) => ({ id: label, label })),
    days: spending.flatMap(([project, agent, model, usd]) => usd.flatMap((amount, i) =>
      amount ? [{ date: dayOf(usd.length - 1 - i), project, agent, model, input: Math.round(amount * 300_000), output: Math.round(amount * 20_000), usd: amount }] : [])),
    incomplete: false,
  };
};

export interface Demo {
  request(method: string, path: string, opts?: { body?: unknown }): Promise<Reply>;
  stop(): void;
}

export function createDemo(emit: <E extends keyof PhoneEvents>(name: E, data: PhoneEvents[E]) => void): Demo {
  const sessions = seed();
  const pcs: Array<{ id: string; label: string; state: PcState }> = [
    { id: "dc00000000000001", label: words.pc, state: "live" },
    { id: "dc00000000000002", label: words.laptop, state: "off" },
  ];
  const reconnectedAt = new Map<string, number>();
  const hours = (n: number) => Math.round(Date.now() / 1000 + n * 3600);
  let watching: string | undefined;
  let live = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };

  /** The pretend PC's folders with nothing open: one tap opens a fresh session there, as the PC would. */
  const closed = [{ id: "de0000000000000f", folder: "landing-page" }];
  const state = (): ReplyOf<"GET /api/state"> => ({
    sessions: sessions.map(({ id, pc, folder, mood, agent, preview, pane, events, summary, subagents, worktreeOf }) => {
      const steps = events.flatMap((event): StepKind[] => (event.kind === "note" ? [] : [event.kind])).slice(-5);
      return {
        id, pc: pc ?? words.pc, folder, mood, agent, preview, ...(pane ? { pane } : {}), ...(steps.length ? { steps } : {}),
        ...(summary ? { summary } : {}), ...(subagents ? { subagents } : {}), ...(agent ? { agentName: "Claude Code" } : {}),
        ...(worktreeOf ? { worktreeOf, worktree: folder } : {}),
      };
    }),
    pcs: pcs.map((pc) => ({ ...pc })),
    folders: closed.map(({ id, folder }) => ({ id, pc: words.pc, folder })),
    usage: [
      { name: "Claude Code", fiveHour: { percent: 38, resetsAt: hours(2.5) }, week: { percent: 72, resetsAt: hours(80) } },
      { name: "Codex", fiveHour: { percent: 12, resetsAt: hours(4) }, week: { percent: 91, resetsAt: hours(30) } },
    ],
  });
  /** The one plain shell among the pretend sessions, for the terminal tab. */
  const shell = sessions.find((session) => !session.agent)!;
  const changed = (session: DemoSession, screen?: string) => {
    emit("state", state());
    if (live && watching === session.id) emit("flow", undefined);
    if (screen === undefined) return;
    session.screen = screen;
    if (watching === session.id) emit("output", `\x1b[2J\x1b[H${screen}`);
  };

  /** What the pretend agent does with an answer: works a moment, then says it is done. */
  const answer = (session: DemoSession, prompt: string | undefined, reply: string) => {
    if (prompt !== undefined) session.events.push({ kind: "prompt", at: Date.now(), text: prompt });
    // A new prompt starts a new turn: its goal, and progress from zero.
    const goal = prompt ?? session.summary?.goal;
    session.summary = {
      ...(goal ? { goal } : {}),
      now: { at: Date.now(), kind: "action", text: words.working },
      progress: prompt === undefined && session.summary?.progress ? session.summary.progress : progress(Date.now(), [], 0, 0),
    };
    session.mood = "working";
    session.preview = words.working;
    changed(session, "✻ Working… (1s · esc to interrupt)\r\n");
    later(2500, () => {
      session.events.push({ kind: "note", at: Date.now(), text: reply });
      session.summary = { ...session.summary, now: { at: Date.now(), kind: "note", text: reply.split("\n")[0]! }, result: reply };
      session.mood = "done";
      session.preview = reply.split("\n")[0]!;
      changed(session, `${reply}\r\n`);
    });
  };

  const ok = <R extends PhoneRoute>(_route: R, body: ReplyOf<R>): Reply => ({ status: 200, body });
  const fail = (status: number, error: string): Reply => ({ status, body: { error } satisfies PhoneFailure });

  const route = (method: string, path: string, body: unknown): Reply => {
    const url = new URL(path, "http://demo");
    // A route not in the contract matches nothing below, and ends at the 404.
    const at = `${method} ${url.pathname}` as PhoneRoute;
    const find = (id: unknown) => sessions.find((session) => session.id === id);
    const session = find(url.searchParams.get("s"));
    const p = url.searchParams.get("p") ?? "";

    if (at === "POST /api/login" || at === "POST /api/logout") return ok(at, { ok: true });
    if (at === "GET /api/state") return ok(at, state());
    if (at === "GET /api/events") {
      watching = session?.id;
      live = url.searchParams.get("live") === "1";
      later(0, () => {
        emit("state", state());
        if (session) emit("screen", { data: session.screen, cols: 80, rows: 24 });
      });
      return ok(at, { ok: true });
    }
    if (at === "GET /api/workflow") {
      if (!session) return fail(404, "session");
      if (!session.events.length) return ok(at, { ok: false, reason: "no_transcript" });
      const events = session.events.slice(-80);
      const asked = url.searchParams.get("v");
      if (asked === null) return ok(at, { ok: true, events });
      // Its rows only ever add up, so this names the list.
      const v = `${session.events.length}-${events.at(-1)!.at}`;
      return asked === v ? ok(at, { same: true }) : ok(at, { events, v });
    }
    if (at === "GET /api/commands") return session ? ok(at, { commands }) : fail(404, "session");
    if (at === "GET /api/files") return session ? ok(at, { files: ["src/cart.ts", "src/discount.ts", ...Object.keys(session.docs)] }) : fail(404, "session");
    if (at === "GET /api/directory") {
      if (!session) return fail(404, "session");
      const prefix = p ? `${p}/` : "";
      const names = new Map<string, boolean>();
      for (const file of ["src/cart.ts", "src/discount.ts", ...Object.keys(session.docs)]) {
        if (!file.startsWith(prefix)) continue;
        const parts = file.slice(prefix.length).split("/");
        if (parts[0]) names.set(parts[0], parts.length > 1);
      }
      return ok(at, { entries: [...names].map(([name, directory]) => ({ name, directory })) });
    }
    if (at === "GET /api/docs") return session ? ok(at, { files: Object.keys(session.docs) }) : fail(404, "session");
    if (at === "GET /api/doc") {
      const text = session?.docs[p];
      return text === undefined ? fail(404, "doc") : ok(at, { text });
    }
    if (at === "GET /api/file") {
      const text = session ? (session.docs[p] ?? (p === "src/cart.ts" ? demoCart : p === "src/discount.ts" ? "export const discount = 0;\n" : undefined)) : undefined;
      return text === undefined ? fail(404, "file") : { status: 200, type: p.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/octet-stream", bin: new TextEncoder().encode(text) };
    }
    // Nothing leaves the phone in the demo: a path as the PC would answer, to see it typed in.
    if (at === "POST /api/upload") return session ? ok(at, { path: `/tmp/lepons-phone-demo-${url.searchParams.get("n") ?? ""}` }) : fail(404, "session");
    if (at === "POST /api/input") {
      const fields = typeof body === "object" && body !== null ? (body as Unproven<typeof at>) : {};
      const target = find(fields.s);
      if (!target) return fail(404, "session");
      if (!target.agent) {
        // The shell: the line and a pretend prompt after it, nothing run.
        const line = typeof fields.text === "string" ? fields.text.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) : "";
        changed(target, `${target.screen}${line}\r\n${words.shellDemo}\r\n$ `);
        return ok(at, { ok: true });
      }
      const pieces = inputFor(fields);
      if (pieces === "bad" || pieces === "long" || pieces === "exit" || pieces === "shell") {
        return fail(pieces === "long" ? 413 : pieces === "exit" ? 422 : pieces === "shell" ? 403 : 400, pieces);
      }
      if (fields.key === "esc") answer(target, undefined, words.stopped);
      else if (typeof fields.key === "string" && target.screen === menuScreen) {
        answer(target, undefined, fields.key === "3" ? words.menuNo : words.menuYes);
      } else if (typeof fields.text === "string") {
        answer(target, pieces[0], fmt(words.echo, { text: pieces[0]! }));
      }
      return ok(at, { ok: true });
    }
    if (at === "GET /api/accounts") return ok(at, { pcs: accounts });
    if (at === "GET /api/token-stats") return ok(at, tokenStats());
    // The PC's own limit: once per 10 s per PC. The pretend laptop comes up after a moment.
    if (at === "POST /api/pc-reconnect") {
      const pc = pcs.find((one) => typeof body === "object" && body !== null && one.id === (body as Unproven<typeof at>).id);
      if (!pc) return fail(404, "pc");
      if (Date.now() - (reconnectedAt.get(pc.id) ?? -Infinity) < 10_000) return fail(429, "busy");
      reconnectedAt.set(pc.id, Date.now());
      if (pc.state === "off" || pc.state === "failed") {
        pc.state = "connecting";
        emit("state", state());
        later(1500, () => {
          pc.state = "live";
          emit("state", state());
        });
      }
      return ok(at, { ok: true });
    }
    // A closed folder: a new session there, idle until spoken to.
    if (at === "POST /api/open") {
      const fields = typeof body === "object" && body !== null ? (body as Unproven<typeof at>) : {};
      const at2 = closed.findIndex((one) => one.id === fields.f);
      if (at2 < 0) return find(fields.f) ? ok(at, { id: fields.f as string }) : fail(404, "folder");
      const [one] = closed.splice(at2, 1);
      later(1200, () => {
        sessions.push({ id: one!.id, folder: one!.folder, mood: "idle", agent: true, preview: "", screen: "", events: [], docs: {} });
        emit("state", state());
      });
      return ok(at, { id: one!.id });
    }
    // The terminal tab: the pretend laptop's one shell, which echoes what is typed (App Review 2.1: the demo shows every tab working).
    if (at === "POST /api/terminal") {
      const fields = typeof body === "object" && body !== null ? (body as Unproven<typeof at>) : {};
      return find(fields.s) ? ok(at, { id: shell.id }) : fail(404, "session");
    }
    // The pretend PC keeps nothing outside its folders.
    if (at === "GET /api/outside") return fail(404, "file");
    // The pretend PC has no pushes to send: every route but this one is answered above.
    at satisfies "POST /api/push-token";
    return fail(404, "not found");
  };

  return {
    // A beat of latency, like a real link, so loading states show.
    request: (method, path, opts) => new Promise((resolve) => later(150, () => resolve(route(method, path, opts?.body)))),
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
